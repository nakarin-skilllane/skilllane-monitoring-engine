import { Injectable } from '@nestjs/common'
import {
  type AnyEnvelope,
  type LogEnvelope,
  type SpanEnvelope,
  parseEnvelope,
} from 'skilllane-monitoring-contract'
import { ClickhouseWriter } from './clickhouse-writer'
import { IngestStats } from './ingest.stats'
import { type Row, mapLog, mapSpan } from './mappers'

/** Thrown for a message that is not a v1 envelope: skip it, never retry it. */
export class BadEnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadEnvelopeError'
  }
}

/**
 * Message → envelope → rows → ClickhouseWriter. Shared by the three consumers.
 * The returned promise settles when the rows are inserted (ack/commit on it).
 */
@Injectable()
export class EnvelopeHandler {
  constructor(
    private readonly writer: ClickhouseWriter,
    private readonly stats: IngestStats,
  ) {}

  /**
   * Parses a Kafka/RabbitMQ body or a BullMQ job.data object. Counts and
   * throws BadEnvelopeError when it is not an envelope.
   */
  parse(raw: Buffer | string | object | null | undefined, source: string): AnyEnvelope {
    this.stats.messages += 1
    try {
      if (raw === null || raw === undefined) throw new Error('empty message')
      return parseEnvelope(raw)
    } catch (err) {
      this.stats.badEnvelope(source, err)
      throw new BadEnvelopeError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Writes the rows of several envelopes; resolves once all of them are inserted. */
  async write(envelopes: AnyEnvelope[]): Promise<void> {
    const logs: Row[] = []
    const spans: Row[] = []
    for (const envelope of envelopes) {
      if (envelope.stream === 'logs') this.mapLogs(envelope as LogEnvelope, logs)
      else this.mapSpans(envelope as SpanEnvelope, spans)
    }
    await Promise.all([this.writer.enqueue('logs', logs), this.writer.enqueue('spans', spans)])
  }

  private mapLogs(envelope: LogEnvelope, out: Row[]): void {
    for (const item of envelope.items) {
      try {
        if (!item || typeof item !== 'object') throw new Error('log item is not an object')
        out.push(mapLog(item, envelope.resource, envelope.sentAt))
      } catch (err) {
        this.stats.badItem('logs', err)
      }
    }
  }

  private mapSpans(envelope: SpanEnvelope, out: Row[]): void {
    for (const item of envelope.items) {
      try {
        out.push(mapSpan(item, envelope.resource))
      } catch (err) {
        this.stats.badItem('spans', err)
      }
    }
  }
}
