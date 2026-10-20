import { Logger } from '@nestjs/common'
import * as amqp from 'amqplib'
import { config } from '../../config'
import { BadEnvelopeError, type EnvelopeHandler } from '../envelope-handler'
import { type Consumer, errorMessage, sleep } from './consumer'

const NACK_DELAY_MS = 1_000

/**
 * RabbitMQ: asserts the durable direct exchange and one durable queue per
 * stream (bound with routing key = queue name), prefetch ENGINE_CONCURRENCY.
 * ack after insert · nack + requeue (after a short delay) when the insert
 * failed · nack without requeue for a message that is not an envelope.
 * Reconnects with backoff when the connection closes.
 */
export class RabbitmqConsumer implements Consumer {
  readonly name = 'rabbitmq'
  private readonly logger = new Logger('RabbitmqConsumer')
  private readonly queues = [config.topics.logs, config.topics.spans]
  private connection?: amqp.ChannelModel
  private channel?: amqp.Channel
  private consumerTags: string[] = []
  private readonly inflight = new Set<Promise<void>>()
  private stopping = false
  private reconnecting = false

  constructor(private readonly handler: EnvelopeHandler) {
    if (!config.rabbitmq.url) throw new Error('LOG_RABBITMQ_URL is empty')
  }

  async start(): Promise<void> {
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const channel = this.channel
    if (channel) {
      for (const tag of this.consumerTags) await channel.cancel(tag).catch(() => undefined)
    }
    // Deliveries in progress finish (ack / nack) before the channel closes.
    await Promise.allSettled([...this.inflight])
    await channel?.close().catch(() => undefined)
    await this.connection?.close().catch(() => undefined)
  }

  async lag(): Promise<string | undefined> {
    const channel = this.channel
    if (!channel) return undefined
    try {
      const parts: string[] = []
      for (const queue of this.queues) {
        const { messageCount } = await channel.checkQueue(queue)
        parts.push(`${queue}=${messageCount} ready`)
      }
      return parts.join(' ')
    } catch {
      return undefined
    }
  }

  /** Ready messages in the queues plus deliveries not yet acked. */
  async pending(): Promise<number | undefined> {
    const channel = this.channel
    if (!channel) return undefined
    try {
      let total = this.inflight.size
      for (const queue of this.queues) total += (await channel.checkQueue(queue)).messageCount
      return total
    } catch {
      return undefined
    }
  }

  private async connect(): Promise<void> {
    const connection = await amqp.connect(config.rabbitmq.url as string, {
      clientProperties: { connection_name: 'skilllane-monitoring-engine' },
    })
    connection.on('error', (err) => this.logger.warn(`connection error: ${errorMessage(err)}`))
    connection.on('close', () => {
      if (this.stopping) return
      this.logger.warn('connection closed; reconnecting')
      this.channel = undefined
      void this.reconnect()
    })
    const channel = await connection.createChannel()
    channel.on('error', (err) => this.logger.warn(`channel error: ${errorMessage(err)}`))
    channel.on('close', () => {
      // A channel closed by the broker (e.g. a precondition error) while the connection stays up.
      if (this.stopping || this.channel !== channel) return
      this.logger.warn('channel closed; reconnecting')
      this.channel = undefined
      connection.close().catch(() => undefined)
    })

    const exchange = config.rabbitmq.exchange
    await channel.assertExchange(exchange, 'direct', { durable: true })
    for (const queue of this.queues) {
      await channel.assertQueue(queue, { durable: true })
      await channel.bindQueue(queue, exchange, queue)
    }
    // Per consumer (global = false): each queue may hold this many unacked messages.
    await channel.prefetch(config.concurrency)

    this.connection = connection
    this.channel = channel
    this.consumerTags = []
    for (const queue of this.queues) {
      const { consumerTag } = await channel.consume(queue, (msg) => msg && this.track(this.onMessage(channel, msg)), {
        noAck: false,
      })
      this.consumerTags.push(consumerTag)
    }
    this.logger.log(
      `Consuming ${this.queues.join(', ')} (exchange ${exchange}, prefetch ${config.concurrency})`,
    )
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      for (let attempt = 1; !this.stopping; attempt++) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000))
        if (this.stopping) return
        try {
          await this.connect()
          this.logger.log(`Reconnected after ${attempt} attempt(s)`)
          return
        } catch (err) {
          this.logger.warn(`reconnect attempt ${attempt} failed: ${errorMessage(err)}`)
        }
      }
    } finally {
      this.reconnecting = false
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((err) => this.logger.error(`message handler failed: ${errorMessage(err)}`))
      .finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
  }

  private async onMessage(channel: amqp.Channel, msg: amqp.ConsumeMessage): Promise<void> {
    let envelope
    try {
      envelope = this.handler.parse(msg.content, `rabbitmq ${msg.fields.routingKey}`)
    } catch (err) {
      if (err instanceof BadEnvelopeError) return this.settle(() => channel.nack(msg, false, false))
      throw err
    }
    try {
      await this.handler.write([envelope])
      this.settle(() => channel.ack(msg))
    } catch {
      // The writer logged the failure; redeliver after a short pause.
      await sleep(NACK_DELAY_MS)
      this.settle(() => channel.nack(msg, false, true))
    }
  }

  /** ack/nack on a channel that died throws; the broker redelivers those messages anyway. */
  private settle(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.logger.debug(`ack/nack skipped: ${errorMessage(err)}`)
    }
  }
}
