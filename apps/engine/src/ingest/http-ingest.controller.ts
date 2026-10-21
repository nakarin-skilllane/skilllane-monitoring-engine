import { createHash, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import type { Response } from 'express'
import { INGEST_PATH, type TelemetryStream } from 'skilllane-monitoring/contract'
import { Public } from '../auth/auth.guard'
import { config } from '../config'
import { BadEnvelopeError, EnvelopeHandler } from './envelope-handler'
import { ClickhouseWriter } from './clickhouse-writer'
import { errorMessage } from './consumers/consumer'

/** Seconds a busy engine asks the SDK to wait (its breaker backs off further). */
const RETRY_AFTER_S = 2

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * POST /api/ingest/<stream>: an app without a queue sends its envelopes here
 * (skilllane-monitoring with LOG_HTTP_URL). The answer means what an ack means on a
 * queue: 202 once the rows are in ClickHouse; 503 while ClickHouse fails or
 * the writer is full (the SDK keeps the items and retries); 400 for what can
 * never be written (the SDK drops it). On by default and open: the app needs
 * only the URL. ENGINE_INGEST_TOKEN, when set, makes it ask for a bearer
 * token; ENGINE_INGEST_HTTP=false turns it off (404). The body parser undoes
 * gzip and enforces ENGINE_INGEST_MAX_BYTES (413).
 */
@Public()
@Controller(INGEST_PATH.replace(/^\//, ''))
export class HttpIngestController {
  private readonly logger = new Logger('HttpIngest')
  private readonly tokens = config.ingest.tokens.map(digest)
  private inflight = 0
  private lastAuthLog = 0

  constructor(
    private readonly handler: EnvelopeHandler,
    private readonly writer: ClickhouseWriter,
  ) {
    if (config.ingest.enabled && !this.tokens.length && config.role !== 'api') {
      this.logger.warn('HTTP ingest takes no token: keep the engine port on the internal network (or set ENGINE_INGEST_TOKEN)')
    }
  }

  @Post(':stream')
  @HttpCode(202)
  async ingest(
    @Param('stream') stream: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ items: number }> {
    if (!config.ingest.enabled) throw new NotFoundException('HTTP ingest is off (ENGINE_INGEST_HTTP=false)')
    if (this.tokens.length) this.authorize(authorization)
    if (stream !== 'logs' && stream !== 'spans') throw new BadRequestException(`unknown stream ${stream}`)

    if (this.inflight >= config.ingest.maxInflight || this.writer.saturated(stream as TelemetryStream)) {
      res.setHeader('Retry-After', String(RETRY_AFTER_S))
      throw new ServiceUnavailableException('ingest is busy, retry later')
    }

    let envelope
    try {
      envelope = this.handler.parse(body as object, 'http')
    } catch (err) {
      if (err instanceof BadEnvelopeError) throw new BadRequestException(err.message)
      throw err
    }
    if (envelope.stream !== stream) {
      throw new BadRequestException(`envelope stream ${envelope.stream} posted to /${stream}`)
    }

    this.inflight++
    try {
      await this.handler.write([envelope])
    } catch (err) {
      res.setHeader('Retry-After', String(RETRY_AFTER_S))
      throw new ServiceUnavailableException(`not written: ${errorMessage(err)}`)
    } finally {
      this.inflight--
    }
    return { items: envelope.items.length }
  }

  /** Bearer token against ENGINE_INGEST_TOKEN, in constant time; the token itself is never logged. */
  private authorize(authorization: string | undefined): void {
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '')
    const given = match ? digest(match[1]) : undefined
    if (given && this.tokens.some((token) => timingSafeEqual(token, given))) return
    if (Date.now() - this.lastAuthLog > 60_000) {
      this.lastAuthLog = Date.now()
      this.logger.warn(`Rejected ingest without a valid token (${match ? 'wrong token' : 'no bearer token'})`)
    }
    throw new UnauthorizedException('invalid ingest token')
  }
}
