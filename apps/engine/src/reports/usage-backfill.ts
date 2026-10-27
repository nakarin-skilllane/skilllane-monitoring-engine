import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import { config } from '../config'
import { addDays, bangkokDate } from './rules'

/** Days before today the backfill fills (the feature score reads 30). */
const BACKFILL_DAYS = 30

/**
 * route_usage_1d_mv only sees lines written after it exists. Once, on the instance that applies
 * the schema, the 30 Bangkok days before today are filled from logs when the table has no row
 * before today (today is the view's). A schema step, so it uses the writer; a failure is a warning
 * and the report shows no features until the days fill up.
 */
@Injectable()
export class UsageBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger('UsageBackfill')

  constructor(private readonly clickhouse: ClickhouseService) {}

  onApplicationBootstrap(): void {
    if (!config.applySchema) return
    void this.run(Date.now()).catch((err) =>
      this.logger.warn(`route_usage_1d backfill failed: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  async run(nowMs: number): Promise<number> {
    const db = this.clickhouse.database
    const today = bangkokDate(nowMs)
    const params = { today, first: addDays(today, -BACKFILL_DAYS) }
    const existing = await this.clickhouse.writer.query({
      query: `SELECT count() AS n FROM ${db}.route_usage_1d WHERE day < {today:Date}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    if (Number((await existing.json<{ n: string | number }>())[0]?.n ?? 0) > 0) return 0
    const started = Date.now()
    await this.clickhouse.writer.command({
      query: `INSERT INTO ${db}.route_usage_1d
        SELECT toDate(timestamp, 'Asia/Bangkok') AS day, env, service, concat(http_method, ' ', http_route) AS route,
               count() AS requests, countIf(http_status < 500) AS ok, countIf(user_id != '') AS with_user,
               countIf(http_method IN ('POST', 'PUT', 'PATCH', 'DELETE')) AS writes,
               groupUniqArray(toUInt8(toHour(timestamp, 'Asia/Bangkok'))) AS hours,
               uniqStateIf(user_id, user_id != '') AS users, uniqStateIf(organization_id, organization_id != '') AS orgs
        FROM ${db}.logs
        WHERE event_code = 'http.request' AND http_route != ''
          AND timestamp >= toDateTime({first:Date}, 'Asia/Bangkok') AND timestamp < toDateTime({today:Date}, 'Asia/Bangkok')
        GROUP BY day, env, service, route`,
      query_params: params,
      clickhouse_settings: { max_execution_time: 600 },
    })
    const result = await this.clickhouse.writer.query({
      query: `SELECT count() AS n FROM ${db}.route_usage_1d WHERE day < {today:Date}`,
      query_params: params,
      format: 'JSONEachRow',
    })
    const rows = Number((await result.json<{ n: string | number }>())[0]?.n ?? 0)
    this.logger.log(`route_usage_1d backfilled ${params.first}..${addDays(today, -1)}: ${rows} rows in ${Date.now() - started} ms`)
    return rows
  }
}
