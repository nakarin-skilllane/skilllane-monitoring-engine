import { UnrecoverableError } from 'bullmq'
import { parseEnvelope } from 'skilllane-monitoring/contract'
import type { IngestClient } from './ingest-client'
import { Logger, errorMessage } from './log'
import type { BridgeStats } from './stats'

/** Bad-envelope warnings are logged in full for the first few only, like the engine's IngestStats. */
const LOG_BAD_ENVELOPES = 5
const AUTH_LOG_EVERY_MS = 60_000

/** The shape of a BullMQ job the forwarder needs (a Job, or a stand-in in tests). */
export interface JobLike {
  id?: string
  queueName: string
  data: unknown
}

/**
 * The processor's logic: job.data → v1 envelope → POST to the ingest.
 * Resolves when the ingest answered 202 (the job completes), throws
 * UnrecoverableError for what can never be written (not an envelope, or the
 * ingest answered 400: the job fails at once and stays in the failed list),
 * and throws a plain Error otherwise (BullMQ retries the job with the
 * publisher's attempts/backoff): 401, 503, any other status, no answer.
 */
export class Forwarder {
  private readonly logger = new Logger('Forwarder')
  private loggedBad = 0
  private lastAuthLog = 0

  constructor(
    private readonly client: IngestClient,
    private readonly stats: BridgeStats,
  ) {}

  async forward(job: JobLike): Promise<void> {
    this.stats.jobs += 1
    const source = `bullmq ${job.queueName}#${job.id ?? '?'}`

    let envelope
    try {
      if (job.data === null || job.data === undefined) throw new Error('empty job data')
      envelope = parseEnvelope(job.data as object)
    } catch (err) {
      throw this.unrecoverable(`bad envelope from ${source}: ${errorMessage(err)}`)
    }

    let answer
    try {
      answer = await this.client.post(envelope.stream, envelope)
    } catch (err) {
      this.stats.failed += 1
      throw new Error(`ingest unreachable: ${errorMessage(err)}`)
    }

    const detail = answer.message ? `: ${answer.message}` : ''
    switch (answer.status) {
      case 202:
        this.stats.forwardedRows += envelope.items.length
        return
      case 400:
        throw this.unrecoverable(`ingest rejected ${source}${detail}`)
      case 401:
        this.stats.failed += 1
        if (Date.now() - this.lastAuthLog > AUTH_LOG_EVERY_MS) {
          this.lastAuthLog = Date.now()
          this.logger.warn('ingest rejected the token (ENGINE_INGEST_TOKEN): jobs are retried until it matches')
        }
        throw new Error(`ingest rejected the token${detail}`)
      default:
        // 503 (busy / not written, Retry-After), other 5xx, anything unexpected: retry later.
        this.stats.failed += 1
        throw new Error(`ingest answered ${answer.status}${detail}`)
    }
  }

  private unrecoverable(message: string): UnrecoverableError {
    this.stats.unrecoverable += 1
    if (this.loggedBad < LOG_BAD_ENVELOPES) {
      this.loggedBad += 1
      this.logger.warn(`${message}${this.loggedBad === LOG_BAD_ENVELOPES ? ' (further ones only counted)' : ''}`)
    }
    return new UnrecoverableError(message)
  }
}
