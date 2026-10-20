/**
 * Small SQL helpers. User input only ever enters a query as a ClickHouse
 * query parameter ({name:Type}); the SQL text is built from constants.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import type { Common } from './params'

export type Params = Record<string, unknown>

/** AND-joined conditions plus the parameters they reference. */
export class Where {
  private readonly parts: string[] = []
  readonly params: Params = {}

  add(sql: string, params: Params = {}): this {
    this.parts.push(sql)
    Object.assign(this.params, params)
    return this
  }

  get sql(): string {
    return this.parts.length ? this.parts.join('\n    AND ') : '1'
  }
}

/** Time literal of a millisecond parameter. */
export const msParam = (name: string): string => `fromUnixTimestamp64Milli({${name}:Int64}, 'UTC')`

/** `column` within [from, to] plus env / service / role equality. */
export function scoped(c: Common, timeColumn = 'timestamp', w = new Where()): Where {
  w.add(`${timeColumn} >= ${msParam('fromMs')} AND ${timeColumn} <= ${msParam('toMs')}`, {
    fromMs: c.fromMs,
    toMs: c.toMs,
  })
  return scopeOnly(c, w)
}

/** env / service / role only (no time). */
export function scopeOnly(c: Pick<Common, 'env' | 'service' | 'role'>, w = new Where()): Where {
  if (c.env) w.add('env = {env:String}', { env: c.env })
  if (c.service) w.add('service = {service:String}', { service: c.service })
  if (c.role) w.add('role = {role:String}', { role: c.role })
  return w
}

/**
 * route_stats_1m rows of the range (minute granularity): the minute `from` is in
 * up to the minutes that start before `to` (a `to` on a minute boundary does not
 * pull in the minute after it; to=now keeps the current partial minute).
 */
export function scopedMinutes(c: Common): Where {
  const w = new Where().add(
    `minute >= toStartOfMinute(${msParam('fromMs')}) AND minute < ${msParam('toMs')}`,
    { fromMs: c.fromMs, toMs: c.toMs },
  )
  return scopeOnly(c, w)
}

/**
 * Bucket start (Unix seconds) of a DateTime / DateTime64 expression. Buckets
 * are `step` seconds wide and start at `origin` (`from` rounded down to the
 * minute), so they line up with the range start; rows past the last bucket
 * start count in the last bucket. Needs `seriesParams(c)`.
 */
export const bucketExpr = (column: string): string =>
  `({origin:Int64} + least(intDiv(toInt64(toUnixTimestamp(toDateTime(${column}))) - {origin:Int64}, {step:UInt32}), {lastBucket:Int64}) * {step:UInt32})`

/**
 * Number of series buckets: enough to reach `to`. With a step above one minute,
 * a remainder shorter than a minute (the seconds of now-24h) joins the last
 * bucket instead of opening one, so 24 h at 1 h gives 24 buckets.
 */
function bucketCount(c: Common): number {
  const step = c.stepSeconds
  const span = c.toMs / 1000 - Math.floor(c.originMs / 1000)
  let n = Math.max(1, Math.ceil(span / step))
  if (n > 1 && step > 60 && span - (n - 1) * step < 60) n -= 1
  return n
}

/** The parameters `bucketExpr` references. */
export const seriesParams = (c: Common): { step: number; origin: number; lastBucket: number } => ({
  step: c.stepSeconds,
  origin: Math.floor(c.originMs / 1000),
  lastBucket: bucketCount(c) - 1,
})

/** Every bucket start (Unix seconds) of the range, so series have no gaps. */
export function buckets(c: Common): number[] {
  const origin = Math.floor(c.originMs / 1000)
  return Array.from({ length: bucketCount(c) }, (_, i) => origin + i * c.stepSeconds)
}

/** Fills a series keyed by bucket start; missing buckets get `empty()`. */
export function fillSeries<T>(c: Common, rows: Array<{ t: number } & T>, empty: () => T): Array<{ t: string } & T> {
  const byT = new Map(rows.map((r) => [Number(r.t), r]))
  return buckets(c).map((t) => {
    const row = byT.get(t)
    const { t: _t, ...rest } = (row ?? { t, ...empty() }) as { t: number } & T
    return { t: new Date(t * 1000).toISOString(), ...(rest as T) }
  })
}

/** ClickHouse DateTime64 text (UTC) → ISO, keeping the fraction digits. */
export function iso(value: string | null | undefined): string | null {
  if (!value || value.startsWith('1970-01-01 00:00:00')) return null
  return `${value.replace(' ', 'T')}Z`
}

/** ClickHouse DateTime64 text (UTC) → microseconds since the epoch. */
export function micros(value: string): number {
  const [whole, fraction = ''] = value.split('.')
  return Date.parse(`${whole.replace(' ', 'T')}Z`) * 1000 + Number(fraction.padEnd(6, '0').slice(0, 6))
}

/** A finite number, else 0 (ClickHouse sends nan for empty quantiles). */
export function num(value: unknown, digits = 3): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function ratio(part: number, whole: number): number {
  return whole > 0 ? num(part / whole, 5) : 0
}

/** Reads with the read-only ClickHouse user. */
@Injectable()
export class Reader {
  private readonly logger = new Logger('Query')

  constructor(private readonly clickhouse: ClickhouseService) {}

  async rows<T>(name: string, query: string, params: Params = {}): Promise<T[]> {
    const started = Date.now()
    try {
      const result = await this.clickhouse.reader.query({
        query,
        query_params: params,
        format: 'JSONEachRow',
        // Counts as JSON numbers; fingerprints are selected with toString().
        clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
      })
      const rows = await result.json<T>()
      const ms = Date.now() - started
      if (ms > 500) this.logger.warn(`${name} took ${ms} ms (${rows.length} rows)`)
      return rows
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`${name} failed: ${message}`)
      throw new InternalServerErrorException(`ClickHouse query ${name} failed: ${message.split('\n')[0]}`)
    }
  }
}
