import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { config } from '../config'
import { ClickhouseWriter } from './clickhouse-writer'
import { BullmqConsumer } from './consumers/bullmq.consumer'
import { type Consumer, errorMessage, sleep } from './consumers/consumer'
import { KafkaConsumer } from './consumers/kafka.consumer'
import { RabbitmqConsumer } from './consumers/rabbitmq.consumer'
import { EnvelopeHandler } from './envelope-handler'
import { IngestStats } from './ingest.stats'

const STATS_EVERY_MS = 30_000

/**
 * Picks the consumer from LOG_EXPORT (contract resolveExportMode, read in
 * config), starts it after the schema is applied, prints a stats line every
 * 30 s and shuts down in order: stop consuming → flush → close.
 */
@Injectable()
export class IngestService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Ingest')
  private consumer?: Consumer
  private starting?: Promise<void>
  private statsTimer?: NodeJS.Timeout
  private stopping = false

  constructor(
    private readonly handler: EnvelopeHandler,
    private readonly writer: ClickhouseWriter,
    private readonly stats: IngestStats,
  ) {}

  onApplicationBootstrap(): void {
    const first = this.createConsumer()
    if (first) {
      this.consumer = first
      // In the background: the HTTP server (health) comes up even while the queue is unreachable.
      this.starting = this.startWithRetry(first)
    }
    if (!first && !config.ingest.enabled) return
    this.statsTimer = setInterval(() => void this.logStats(), STATS_EVERY_MS)
    this.statsTimer.unref()
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.stopping = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (!this.consumer && !config.ingest.enabled) return
    this.logger.log(`Stopping ingest${signal ? ` (${signal})` : ''}`)
    await this.starting?.catch(() => undefined)
    // Rows of the messages still in progress go out now, so their ack/commit can happen.
    const stopped = this.consumer?.stop()
    await this.writer.flushAll()
    await stopped
    await this.writer.close()
    await this.logStats(false)
    this.logger.log('Ingest stopped')
  }

  /**
   * Messages not yet in ClickHouse: queue backlog (Kafka lag, RabbitMQ ready +
   * unacked, BullMQ waiting jobs) plus rows still buffered in the writer.
   * undefined when there is no consumer or the queue cannot be read.
   */
  async pending(): Promise<number | undefined> {
    if (!this.consumer?.pending) return undefined
    const queued = await this.consumer.pending().catch(() => undefined)
    if (queued === undefined) return undefined
    const buffered = this.writer.buffered()
    return queued + buffered.logs + buffered.spans
  }

  private createConsumer(): Consumer | undefined {
    const mode = config.transport
    if (config.transportInvalid) {
      this.logger.warn(`LOG_EXPORT=${config.transportInvalid} is not a mode; using ${mode}`)
    }
    try {
      switch (mode) {
        case 'kafka':
          return new KafkaConsumer(this.handler)
        case 'rabbitmq':
          return new RabbitmqConsumer(this.handler)
        case 'bullmq':
          return new BullmqConsumer(this.handler)
        default:
          if (config.ingest.enabled) {
            this.logger.log(`No queue configured (LOG_EXPORT resolves to ${mode}): HTTP ingest only`)
          } else {
            this.logger.warn(`LOG_EXPORT resolves to ${mode} and ENGINE_INGEST_HTTP=false: nothing to ingest`)
          }
          return undefined
      }
    } catch (err) {
      this.logger.error(`Cannot consume ${mode}: ${errorMessage(err)}`)
      return undefined
    }
  }

  /** A failed start is cleaned up and retried with a fresh consumer instance. */
  private async startWithRetry(first: Consumer): Promise<void> {
    let consumer: Consumer | undefined = first
    for (let attempt = 1; consumer && !this.stopping; attempt++) {
      this.consumer = consumer
      try {
        await consumer.start()
        return
      } catch (err) {
        const delay = Math.min(2000 * attempt, 15_000)
        this.logger.error(`${consumer.name} consumer did not start (attempt ${attempt}): ${errorMessage(err)}; retrying in ${delay} ms`)
        await consumer.stop().catch(() => undefined)
        await sleep(delay)
        consumer = this.stopping ? undefined : this.createConsumer()
      }
    }
  }

  private async logStats(withLag = true): Promise<void> {
    const lag = withLag ? await this.consumer?.lag?.().catch(() => undefined) : undefined
    this.logger.log(this.stats.line(this.writer.buffered(), lag))
  }
}
