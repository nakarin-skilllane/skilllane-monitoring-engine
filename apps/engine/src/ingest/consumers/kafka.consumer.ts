import { Logger } from '@nestjs/common'
import {
  type Admin,
  type Consumer as KafkaJsConsumer,
  type EachBatchPayload,
  Kafka,
  type KafkaConfig,
  type LogEntry,
  logLevel,
  type SASLOptions,
} from 'kafkajs'
import type { AnyEnvelope } from 'skilllane-monitoring-contract'
import { config } from '../../config'
import { BadEnvelopeError, type EnvelopeHandler } from '../envelope-handler'
import { type Consumer, errorMessage, sleep } from './consumer'

/** kafkajs log lines → Nest logger, WARN and above only. */
function logCreator() {
  const logger = new Logger('kafkajs')
  return ({ level, log }: LogEntry) => {
    const { message, ...extra } = log
    const detail = extra.error ? ` (${extra.error})` : ''
    if (level === logLevel.ERROR || level === logLevel.NOTHING) logger.error(`${message}${detail}`)
    else if (level === logLevel.WARN) logger.warn(`${message}${detail}`)
  }
}

/**
 * Kafka: group ENGINE_CONSUMER_GROUP on both topics, `eachBatch`. Offsets are
 * resolved and committed only after ClickHouse accepted the batch's rows; an
 * insert failure is retried inside the batch (with heartbeats) until it
 * succeeds or the partition is revoked / the consumer stops.
 */
export class KafkaConsumer implements Consumer {
  readonly name = 'kafka'
  private readonly logger = new Logger('KafkaConsumer')
  private readonly kafka: Kafka
  private readonly topics = [config.topics.logs, config.topics.spans]
  private consumer?: KafkaJsConsumer
  private admin?: Admin

  constructor(private readonly handler: EnvelopeHandler) {
    const { brokers, clientId, ssl, sasl } = config.kafka
    if (brokers.length === 0) throw new Error('LOG_KAFKA_BROKERS is empty')
    const options: KafkaConfig = {
      clientId,
      brokers,
      ssl,
      logLevel: logLevel.WARN,
      logCreator,
      retry: { retries: 8, initialRetryTime: 300, maxRetryTime: 15_000 },
    }
    if (sasl) options.sasl = sasl as SASLOptions
    this.kafka = new Kafka(options)
  }

  async start(): Promise<void> {
    this.admin = this.kafka.admin()
    await this.admin.connect()
    await this.createMissingTopics(this.admin)

    const consumer = this.kafka.consumer({
      groupId: config.consumerGroup,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
      maxBytesPerPartition: 2 * 1024 * 1024,
      maxBytes: 20 * 1024 * 1024,
      // Short fetch long-poll: shutdown waits for it.
      maxWaitTimeInMs: 1_000,
    })
    this.consumer = consumer
    consumer.on(consumer.events.CRASH, (event) => {
      this.logger.error(`Consumer crashed: ${errorMessage(event.payload.error)} (restart: ${event.payload.restart})`)
    })
    await consumer.connect()
    await consumer.subscribe({ topics: this.topics, fromBeginning: true })
    await consumer.run({
      autoCommit: true,
      eachBatchAutoResolve: false,
      // Every partition of both topics in parallel: a batch waits for a flush.
      partitionsConsumedConcurrently: Math.max(2, config.kafkaPartitions * this.topics.length),
      eachBatch: (payload) => this.eachBatch(payload),
    })
    this.logger.log(
      `Consuming ${this.topics.join(', ')} as group ${config.consumerGroup} from ${config.kafka.brokers.join(',')}`,
    )
  }

  async stop(): Promise<void> {
    // disconnect() waits for the running eachBatch calls to finish.
    await this.consumer?.disconnect().catch((err) => this.logger.warn(`disconnect: ${errorMessage(err)}`))
    await this.admin?.disconnect().catch(() => undefined)
  }

  /** Sum of (end offset - committed offset) per topic. */
  async lag(): Promise<string | undefined> {
    const lags = await this.topicLags()
    return lags && lags.map(([topic, lag]) => `${topic}=${lag}`).join(' ')
  }

  async pending(): Promise<number | undefined> {
    const lags = await this.topicLags()
    return lags && lags.reduce((sum, [, lag]) => sum + lag, 0)
  }

  private async topicLags(): Promise<Array<[string, number]> | undefined> {
    const admin = this.admin
    if (!admin) return undefined
    try {
      const committed = await admin.fetchOffsets({ groupId: config.consumerGroup, topics: this.topics })
      const lags: Array<[string, number]> = []
      for (const { topic, partitions } of committed) {
        const ends = await admin.fetchTopicOffsets(topic)
        let lag = 0
        for (const end of ends) {
          const c = partitions.find((p) => p.partition === end.partition)
          const committedOffset = c && Number(c.offset) >= 0 ? Number(c.offset) : Number(end.low)
          lag += Math.max(0, Number(end.high) - committedOffset)
        }
        lags.push([topic, lag])
      }
      return lags
    } catch {
      return undefined
    }
  }

  private async createMissingTopics(admin: Admin): Promise<void> {
    const existing = new Set(await admin.listTopics())
    const missing = this.topics.filter((t) => !existing.has(t))
    if (missing.length === 0) return
    try {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions: config.kafkaPartitions })),
        waitForLeaders: true,
      })
      this.logger.log(`Created topics ${missing.join(', ')} (${config.kafkaPartitions} partitions)`)
    } catch (err) {
      // Another engine instance may have created them at the same time.
      this.logger.warn(`createTopics ${missing.join(', ')}: ${errorMessage(err)}`)
    }
  }

  private async eachBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale } = payload
    if (batch.messages.length === 0) return
    const envelopes: AnyEnvelope[] = []
    for (const message of batch.messages) {
      try {
        envelopes.push(this.handler.parse(message.value, `kafka ${batch.topic}[${batch.partition}]@${message.offset}`))
      } catch (err) {
        if (!(err instanceof BadEnvelopeError)) throw err
      }
    }

    // Keep the group membership alive while the insert runs.
    const beat = setInterval(() => heartbeat().catch(() => undefined), 2_000)
    try {
      for (let attempt = 1; ; attempt++) {
        if (!isRunning() || isStale()) return
        try {
          await this.handler.write(envelopes)
          break
        } catch (err) {
          const delay = Math.min(500 * 2 ** attempt, 15_000)
          this.logger.warn(
            `${batch.topic}[${batch.partition}] insert failed (attempt ${attempt}), retrying in ${delay} ms: ${errorMessage(err)}`,
          )
          await sleep(delay)
        }
      }
    } finally {
      clearInterval(beat)
    }

    resolveOffset(batch.messages[batch.messages.length - 1].offset)
    await commitOffsetsIfNecessary()
    await heartbeat()
  }
}
