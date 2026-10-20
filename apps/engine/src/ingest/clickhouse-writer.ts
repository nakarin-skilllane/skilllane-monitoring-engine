import { Injectable, Logger } from '@nestjs/common'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import { config } from '../config'
import { errorMessage } from './consumers/consumer'
import { IngestStats, TABLES, type Table } from './ingest.stats'
import type { Row } from './mappers'

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

interface Buffer {
  rows: Row[]
  waiters: Waiter[]
  timer?: NodeJS.Timeout
  inflight?: Promise<void>
  /** A flush was asked for while an insert was running. */
  again: boolean
}

/**
 * Shared by every consumer. Buffers rows per table and inserts them with
 * JSONEachRow when ENGINE_FLUSH_ROWS rows are waiting or ENGINE_FLUSH_MS after
 * the first buffered row; one insert in flight per table. Every enqueue gets a
 * promise that resolves once its rows are in ClickHouse and rejects when the
 * insert failed (the consumer then retries / requeues: at-least-once).
 * Backpressure: enqueue waits while a table holds 4x ENGINE_FLUSH_ROWS rows.
 */
@Injectable()
export class ClickhouseWriter {
  private readonly logger = new Logger('ClickhouseWriter')
  private readonly buffers: Record<Table, Buffer> = {
    logs: { rows: [], waiters: [], again: false },
    spans: { rows: [], waiters: [], again: false },
  }
  private readonly highWater = config.flushRows * 4
  private drainWaiters: Array<() => void> = []
  private lastErrorLog = 0
  private closed = false

  constructor(
    private readonly clickhouse: ClickhouseService,
    private readonly stats: IngestStats,
  ) {}

  /** Rows waiting per table (not counting a running insert). */
  buffered(): Record<Table, number> {
    return { logs: this.buffers.logs.rows.length, spans: this.buffers.spans.rows.length }
  }

  /** At the backpressure mark: an enqueue now would wait (HTTP ingest answers 503 instead). */
  saturated(table: Table): boolean {
    return this.closed || this.buffers[table].rows.length >= this.highWater
  }

  async enqueue(table: Table, rows: Row[]): Promise<void> {
    if (rows.length === 0) return
    if (this.closed) throw new Error('ClickhouseWriter is closed')
    while (this.buffers[table].rows.length >= this.highWater) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
      if (this.closed) throw new Error('ClickhouseWriter is closed')
    }
    const buffer = this.buffers[table]
    const done = new Promise<void>((resolve, reject) => {
      buffer.waiters.push({ resolve, reject })
    })
    for (const row of rows) buffer.rows.push(row)
    if (buffer.rows.length >= config.flushRows) {
      this.flush(table)
    } else if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        buffer.timer = undefined
        this.flush(table)
      }, config.flushMs)
    }
    return done
  }

  /** Starts an insert of everything buffered for `table` (or marks one to follow). */
  flush(table: Table): void {
    const buffer = this.buffers[table]
    if (buffer.timer) {
      clearTimeout(buffer.timer)
      buffer.timer = undefined
    }
    if (buffer.rows.length === 0) return
    if (buffer.inflight) {
      buffer.again = true
      return
    }
    const rows = buffer.rows
    const waiters = buffer.waiters
    buffer.rows = []
    buffer.waiters = []
    buffer.again = false
    buffer.inflight = this.insert(table, rows, waiters).finally(() => {
      buffer.inflight = undefined
      this.wakeDrainWaiters()
      if (buffer.rows.length === 0) return
      if (buffer.again || buffer.rows.length >= config.flushRows || this.closed) this.flush(table)
      else if (!buffer.timer) {
        buffer.timer = setTimeout(() => {
          buffer.timer = undefined
          this.flush(table)
        }, config.flushMs)
      }
    })
  }

  /** Inserts every buffered row of every table; resolves when nothing is left. */
  async flushAll(): Promise<void> {
    for (;;) {
      for (const table of TABLES) this.flush(table)
      const pending = TABLES.map((t) => this.buffers[t].inflight).filter(Boolean)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /** Final flush on shutdown; later enqueues reject. */
  async close(): Promise<void> {
    await this.flushAll()
    this.closed = true
    this.wakeDrainWaiters()
  }

  private async insert(table: Table, rows: Row[], waiters: Waiter[]): Promise<void> {
    const started = Date.now()
    try {
      await this.clickhouse.writer.insert({
        table,
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { date_time_input_format: 'best_effort' },
      })
      this.stats.inserted(table, rows.length, Date.now() - started)
      for (const w of waiters) w.resolve()
    } catch (err) {
      this.stats.insertFailed(table)
      const error = new Error(`ClickHouse insert into ${table} failed: ${errorMessage(err)}`)
      if (Date.now() - this.lastErrorLog > 5000) {
        this.lastErrorLog = Date.now()
        this.logger.error(`Insert of ${rows.length} rows into ${table} failed: ${errorMessage(err)}`)
      }
      for (const w of waiters) w.reject(error)
    }
  }

  private wakeDrainWaiters(): void {
    const waiting = this.drainWaiters
    this.drainWaiters = []
    for (const wake of waiting) wake()
  }
}
