import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import { config } from '../config'
import type { AiStatus, DailyPayload, ReportDateItem, ReportStatus, StoredReport } from './types'

interface ReportRow {
  env: string
  report_date: string
  window_start_ms: number
  window_end_ms: number
  generated_at: string
  status: string
  payload: string
  ai_status: string
  ai_message: string
}

const toCh = (iso: string): string => iso.replace('T', ' ').replace('Z', '')
const toIso = (ch: string): string => `${ch.replace(' ', 'T')}Z`

/**
 * Snapshots of the daily report in CLICKHOUSE_CONFIG_DATABASE.daily_reports, written and read
 * with the writer user (as users / roles; the reader has no grant there). A rebuild inserts the
 * whole row again; reads use FINAL. No TTL: a snapshot outlives the raw data.
 */
@Injectable()
export class ReportStore implements OnModuleInit {
  private readonly logger = new Logger('ReportStore')
  private readonly db = config.auth.database
  private lastWrite = 0

  constructor(private readonly clickhouse: ClickhouseService) {}

  async onModuleInit(): Promise<void> {
    if (!config.applySchema) return
    try {
      await this.clickhouse.writer.command({ query: `CREATE DATABASE IF NOT EXISTS ${this.db}` })
      await this.clickhouse.writer.command({
        query: `CREATE TABLE IF NOT EXISTS ${this.db}.daily_reports (
          env            LowCardinality(String),
          report_date    Date,
          window_start   DateTime64(3, 'UTC'),
          window_end     DateTime64(3, 'UTC'),
          generated_at   DateTime64(3, 'UTC'),
          schema_version UInt16,
          status         LowCardinality(String),
          payload        String,
          ai_status      LowCardinality(String),
          ai_message     String,
          updated_at     DateTime64(3, 'UTC')
        ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (env, report_date)`,
      })
    } catch (err) {
      this.logger.error(`daily_reports schema apply failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Strictly increasing version for ReplacingMergeTree, even within one millisecond. */
  private version(): string {
    this.lastWrite = Math.max(Date.now(), this.lastWrite + 1)
    return new Date(this.lastWrite).toISOString()
  }

  async save(r: StoredReport): Promise<void> {
    await this.clickhouse.writer.insert({
      table: `${this.db}.daily_reports`,
      format: 'JSONEachRow',
      values: [
        {
          env: r.env,
          report_date: r.reportDate,
          window_start: toCh(new Date(r.windowStartMs).toISOString()),
          window_end: toCh(new Date(r.windowEndMs).toISOString()),
          generated_at: toCh(r.generatedAt),
          schema_version: r.payload.schemaVersion,
          status: r.status,
          payload: JSON.stringify(r.payload),
          ai_status: r.aiStatus,
          ai_message: r.aiMessage,
          updated_at: toCh(this.version()),
        },
      ],
    })
  }

  /** One report; without a date the latest one of the env. */
  async get(env: string, reportDate?: string): Promise<StoredReport | undefined> {
    const result = await this.clickhouse.writer.query({
      query: `SELECT env, toString(report_date) AS report_date,
                     toUnixTimestamp64Milli(window_start) AS window_start_ms, toUnixTimestamp64Milli(window_end) AS window_end_ms,
                     toString(generated_at) AS generated_at, status, payload, ai_status, ai_message
              FROM ${this.db}.daily_reports FINAL
              WHERE env = {env:String} ${reportDate ? 'AND report_date = {date:Date}' : ''}
              ORDER BY report_date DESC LIMIT 1`,
      query_params: reportDate ? { env, date: reportDate } : { env },
      format: 'JSONEachRow',
      clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
    })
    const row = (await result.json<ReportRow>())[0]
    if (!row) return undefined
    return {
      env: row.env,
      reportDate: row.report_date,
      windowStartMs: Number(row.window_start_ms),
      windowEndMs: Number(row.window_end_ms),
      generatedAt: toIso(row.generated_at),
      status: row.status as ReportStatus,
      payload: JSON.parse(row.payload) as DailyPayload,
      aiStatus: row.ai_status as AiStatus,
      aiMessage: row.ai_message,
    }
  }

  async dates(env: string): Promise<ReportDateItem[]> {
    const result = await this.clickhouse.writer.query({
      query: `SELECT toString(report_date) AS reportDate, status FROM ${this.db}.daily_reports FINAL
              WHERE env = {env:String} ORDER BY report_date DESC LIMIT 400`,
      query_params: { env },
      format: 'JSONEachRow',
    })
    return result.json<ReportDateItem>()
  }
}
