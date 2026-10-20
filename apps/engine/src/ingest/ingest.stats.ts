import { Injectable, Logger } from '@nestjs/common'

export type Table = 'logs' | 'spans'
export const TABLES: readonly Table[] = ['logs', 'spans']

interface TableCounters {
  rows: number
  inserts: number
  failures: number
  lastInsertMs: number
}

/**
 * Ingest counters. The service prints one stats line every 30 s:
 * rows/s per table, last insert latency, failures, bad input, queue lag.
 */
@Injectable()
export class IngestStats {
  private readonly logger = new Logger('IngestStats')
  readonly tables: Record<Table, TableCounters> = {
    logs: { rows: 0, inserts: 0, failures: 0, lastInsertMs: 0 },
    spans: { rows: 0, inserts: 0, failures: 0, lastInsertMs: 0 },
  }
  messages = 0
  badEnvelopes = 0
  badItems = 0
  private firstBadError?: string
  private loggedBad = 0
  private lastTick = { at: Date.now(), logs: 0, spans: 0, failures: 0, bad: 0 }

  inserted(table: Table, rows: number, ms: number): void {
    const t = this.tables[table]
    t.rows += rows
    t.inserts += 1
    t.lastInsertMs = ms
  }

  insertFailed(table: Table): void {
    this.tables[table].failures += 1
  }

  /** A message that is not a v1 envelope. Logged in full for the first few only. */
  badEnvelope(source: string, err: unknown): void {
    this.badEnvelopes += 1
    this.noteBad(`bad envelope from ${source}`, err)
  }

  /** An item inside a valid envelope that could not become a row. */
  badItem(stream: string, err: unknown): void {
    this.badItems += 1
    this.noteBad(`bad ${stream} item`, err)
  }

  private noteBad(what: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.firstBadError ??= `${what}: ${message}`
    if (this.loggedBad < 5) {
      this.loggedBad += 1
      this.logger.warn(`${what} skipped: ${message}${this.loggedBad === 5 ? ' (further ones only counted)' : ''}`)
    }
  }

  /** One line for stdout; `lag` comes from the active consumer when cheap to read. */
  line(buffered: Record<Table, number>, lag?: string): string {
    const now = Date.now()
    const seconds = Math.max((now - this.lastTick.at) / 1000, 0.001)
    const rate = (table: Table) => ((this.tables[table].rows - this.lastTick[table]) / seconds).toFixed(1)
    const failures = this.tables.logs.failures + this.tables.spans.failures
    const bad = this.badEnvelopes + this.badItems
    const parts = [
      `logs ${rate('logs')} rows/s (last insert ${this.tables.logs.lastInsertMs} ms, buffered ${buffered.logs})`,
      `spans ${rate('spans')} rows/s (last insert ${this.tables.spans.lastInsertMs} ms, buffered ${buffered.spans})`,
      `insert failures ${failures} (+${failures - this.lastTick.failures})`,
      `bad envelopes ${this.badEnvelopes}, bad items ${this.badItems} (+${bad - this.lastTick.bad})`,
      `messages ${this.messages}`,
    ]
    if (lag) parts.push(`lag ${lag}`)
    if (this.firstBadError && bad > this.lastTick.bad) parts.push(`first bad: ${this.firstBadError}`)
    this.lastTick = { at: now, logs: this.tables.logs.rows, spans: this.tables.spans.rows, failures, bad }
    return parts.join(' · ')
  }
}
