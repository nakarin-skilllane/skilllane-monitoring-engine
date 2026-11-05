import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq'
import IORedis from 'ioredis'
import type { BridgeConfig } from './config'
import type { Forwarder } from './forwarder'
import { Logger, errorMessage } from './log'

/**
 * The engine's BullmqConsumer with the ClickHouse write replaced by an HTTP
 * POST to the ingest: one Worker per stream queue on LOG_BULLMQ_REDIS_URL
 * (prefix LOG_BULLMQ_PREFIX), concurrency ENGINE_CONCURRENCY. The processor
 * resolves after the ingest accepted the envelope and throws when it did not,
 * so BullMQ retries the job with the publisher's attempts/backoff. A job that
 * is not an envelope (or that the ingest answers 400) fails at once
 * (UnrecoverableError) and stays in the failed list for inspection.
 */
export class Bridge {
  private readonly logger = new Logger('Bridge')
  private readonly queueNames: string[]
  private workers: Worker[] = []
  private queues: Queue[] = []
  private connection?: IORedis
  private lastErrorLog = 0

  constructor(
    private readonly config: BridgeConfig,
    private readonly forwarder: Forwarder,
  ) {
    if (!config.redisUrl) throw new Error('LOG_BULLMQ_REDIS_URL is empty')
    this.queueNames = [config.topics.logs, config.topics.spans]
  }

  async start(): Promise<void> {
    // Workers need maxRetriesPerRequest: null (blocking commands).
    const connection = new IORedis(this.config.redisUrl as string, {
      maxRetriesPerRequest: null,
      connectionName: 'skilllane-monitoring-bullmq-bridge',
    })
    connection.on('error', (err) => this.logThrottled(`redis: ${errorMessage(err)}`))
    this.connection = connection
    await connection.ping()

    const { prefix, concurrency } = this.config
    for (const name of this.queueNames) {
      const worker = new Worker(name, (job: Job) => this.forwarder.forward(job), {
        connection,
        prefix,
        concurrency,
        autorun: true,
      })
      // Without an 'error' listener a Redis hiccup would crash the process.
      worker.on('error', (err) => this.logThrottled(`worker ${name}: ${errorMessage(err)}`))
      worker.on('failed', (job, err) => {
        if (!(err instanceof UnrecoverableError)) {
          this.logThrottled(`job ${name}#${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
        }
      })
      this.workers.push(worker)
      const queue = new Queue(name, { connection, prefix })
      queue.on('error', (err) => this.logThrottled(`queue ${name}: ${errorMessage(err)}`))
      this.queues.push(queue)
    }
    this.logger.log(
      `Consuming BullMQ queues ${this.queueNames.join(', ')} (prefix ${prefix}, concurrency ${concurrency}) → ${this.config.ingestUrl}`,
    )
  }

  async stop(): Promise<void> {
    // Worker.close() waits for the active jobs (their POSTs) to finish.
    await Promise.allSettled(this.workers.map((w) => w.close()))
    await Promise.allSettled(this.queues.map((q) => q.close()))
    await this.connection?.quit().catch(() => undefined)
    this.workers = []
    this.queues = []
  }

  /** Redis answers PING. */
  async ping(): Promise<boolean> {
    if (!this.connection) return false
    return (await this.connection.ping()) === 'PONG'
  }

  /** Per-queue lag text for the stats line. */
  async lag(): Promise<string | undefined> {
    try {
      const parts: string[] = []
      for (const queue of this.queues) {
        const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'failed')
        parts.push(`${queue.name}=${counts.wait} wait/${counts.active} active/${counts.delayed} delayed/${counts.failed} failed`)
      }
      return parts.join(' ')
    } catch {
      return undefined
    }
  }

  /** Jobs not yet accepted by the ingest (0 = drained); undefined when Redis cannot be read. */
  async pending(): Promise<number | undefined> {
    try {
      let total = 0
      for (const queue of this.queues) {
        const counts = await queue.getJobCounts('wait', 'active', 'prioritized', 'delayed')
        total += Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0)
      }
      return total
    } catch {
      return undefined
    }
  }

  private logThrottled(message: string): void {
    if (Date.now() - this.lastErrorLog < 5000) return
    this.lastErrorLog = Date.now()
    this.logger.warn(message)
  }
}
