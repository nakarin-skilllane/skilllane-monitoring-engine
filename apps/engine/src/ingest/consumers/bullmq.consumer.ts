import { Logger } from '@nestjs/common'
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../../config'
import { BadEnvelopeError, type EnvelopeHandler } from '../envelope-handler'
import { type Consumer, errorMessage } from './consumer'

/**
 * BullMQ: one Worker per stream queue on LOG_BULLMQ_REDIS_URL (prefix
 * LOG_BULLMQ_PREFIX), concurrency ENGINE_CONCURRENCY. The processor resolves
 * after the insert and throws when it failed, so BullMQ retries the job with
 * the publisher's attempts/backoff. A job that is not an envelope fails at
 * once (UnrecoverableError) and stays in the failed list for inspection.
 */
export class BullmqConsumer implements Consumer {
  readonly name = 'bullmq'
  private readonly logger = new Logger('BullmqConsumer')
  private readonly queueNames = [config.topics.logs, config.topics.spans]
  private workers: Worker[] = []
  private queues: Queue[] = []
  private connection?: IORedis
  private lastErrorLog = 0

  constructor(private readonly handler: EnvelopeHandler) {
    if (!config.bullmq.redisUrl) throw new Error('LOG_BULLMQ_REDIS_URL is empty')
  }

  async start(): Promise<void> {
    // Workers need maxRetriesPerRequest: null (blocking commands).
    const connection = new IORedis(config.bullmq.redisUrl as string, {
      maxRetriesPerRequest: null,
      connectionName: 'skilllane-monitoring-engine',
    })
    connection.on('error', (err) => this.logThrottled(`redis: ${errorMessage(err)}`))
    this.connection = connection
    await connection.ping()

    const prefix = config.bullmq.prefix
    for (const name of this.queueNames) {
      const worker = new Worker(name, (job) => this.process(job), {
        connection,
        prefix,
        concurrency: config.concurrency,
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
      this.queues.push(new Queue(name, { connection, prefix }))
    }
    this.logger.log(
      `Consuming BullMQ queues ${this.queueNames.join(', ')} (prefix ${prefix}, concurrency ${config.concurrency})`,
    )
  }

  async stop(): Promise<void> {
    // Worker.close() waits for the active jobs (their inserts) to finish.
    await Promise.allSettled(this.workers.map((w) => w.close()))
    await Promise.allSettled(this.queues.map((q) => q.close()))
    await this.connection?.quit().catch(() => undefined)
  }

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

  private async process(job: Job): Promise<void> {
    let envelope
    try {
      envelope = this.handler.parse(job.data, `bullmq ${job.queueName}#${job.id}`)
    } catch (err) {
      if (err instanceof BadEnvelopeError) throw new UnrecoverableError(err.message)
      throw err
    }
    await this.handler.write([envelope])
  }

  private logThrottled(message: string): void {
    if (Date.now() - this.lastErrorLog < 5000) return
    this.lastErrorLog = Date.now()
    this.logger.warn(message)
  }
}
