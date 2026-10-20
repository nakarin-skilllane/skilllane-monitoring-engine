import { Injectable, NotFoundException } from '@nestjs/common'
import {
  type Common,
  type QueryString,
  optEnum,
  optInt,
  optList,
  optName,
  optNumber,
  optString,
  parseCommon,
  parseSpanId,
  parseTraceId,
  parseTraceIdPrefix,
} from './params'
import { routeCondition } from './logs.service'
import {
  type LogDb,
  type LogRow,
  type SpanDb,
  type SpanIoDb,
  type SpanRow,
  LOG_SELECT,
  SPAN_IO_SELECT,
  SPAN_SELECT,
  toLogRow,
  toSpanRow,
} from './rows'
import { type SpanDetail, type SpanDetailDb, SPAN_DETAIL_SELECT, toSpanDetail } from './span-detail'
import { Reader, Where, buckets, iso, micros, msParam, num, scoped } from './sql'

/** Parts of `sample`, in the order they take from the `limit` budget. */
export const SAMPLE_PARTS = ['errors', 'slow', 'spread'] as const
export type SamplePart = (typeof SAMPLE_PARTS)[number]

/** Job / message of a non-HTTP entry span (entry span attributes, else its job.* log lines). */
export interface TraceJob {
  queue: string
  type: string
  /** job.id / message id; '' when unknown (cron, tasks). */
  id: string
  /** 1-based attempt; 0 when unknown (Kafka, RabbitMQ, cron). */
  attempt: number
  /** 0 when unknown. */
  maxAttempts: number
  /** Queue system: event.module of the span (bullmq, kafka, rabbitmq, cron), messaging.system, else its job lines; '' when unknown. */
  module: string
}

export interface TraceListRow {
  traceId: string
  /** The entry span (a trace can have several rows: the request and each job attempt it queued). */
  spanId: string
  timestamp: string
  service: string
  role: string
  name: string
  kind: string
  method: string
  /** `METHOD /path` for HTTP entries, else the span name (`report report:generate`): the overview routes[].route key. */
  route: string
  /** The http.route template alone (`/me`); '' when not HTTP. */
  httpRoute: string
  /** HTTP status of the entry span; 0 when it is not HTTP (jobs, consumers). */
  status: number
  /** OTel status of the entry span: OK | ERROR | UNSET. */
  statusCode: string
  /** ERROR status or HTTP ≥ 500 (same rule as route_stats_1m errors). */
  isError: boolean
  /**
   * An HTTP entry called by another service (a SERVER entry span with a parent
   * span): a hop inside its caller's trace, not work of its own. Listed only
   * with `entries=all` or a `service` / `role` / `route` filter.
   */
  downstream: boolean
  durationMs: number
  spanCount: number
  errorCount: number
  services: string[]
  /** null for HTTP entries, or when nothing names the job. */
  job: TraceJob | null
  /** Which `sample` part picked the row; null without `sample`. */
  sample: SamplePart | null
}

export interface TraceListResponse {
  rows: TraceListRow[]
  /** Entry spans in the range matching every filter (not only the returned rows): requests + job / message attempts. */
  total: number
  /** Of those, isError. */
  totalErrors: number
  /** Distinct traces of those entry spans (a request and the job attempts it queued are one trace). */
  totalTraces: number
  /** Distinct traces with at least one isError entry span. */
  totalErrorTraces: number
  /** HTTP entries (kind SERVER) that are not isError and took ≥ `slowMs` (default 2000, the monitor's slow rule). */
  totalSlow: number
  /** The threshold totalSlow used. */
  slowMs: number
  /** The sample parts used (`spread` alone = all three); null without `sample`. */
  sample: SamplePart[] | null
}

interface TraceIndex {
  start: string
  end: string
  span_count: number
  error_count: number
  services: string[]
  envs: string[]
}

export interface TraceDetail {
  traceId: string
  env: string
  start: string
  durationMs: number
  spanCount: number
  errorCount: number
  services: string[]
  spans: SpanRow[]
  logs: LogRow[]
}

const IS_ERROR = `(status_code = 'ERROR' OR http_status >= 500)`
const ENTRY_ROUTE = `if(http_route != '', concat(http_method, ' ', http_route), name)`
/** An HTTP entry called by another service: its parent is the caller's CLIENT span. */
const IS_DOWNSTREAM = `(kind = 'SERVER' AND parent_span_id != '')`
/** The monitor's slow rule for requests. */
const SLOW_MS = 2000

interface JobLine {
  trace_id: string
  span_id: string
  queue: string
  type: string
  id: string
  attempt: number
  max_attempts: number
  module: string
}

function jobOf(e: SpanDb, line: JobLine | undefined): TraceJob | null {
  if (e.http_method || e.http_route) return null
  const a = e.attributes ?? {}
  const queue = a['job.queue'] || a['messaging.destination.name'] || line?.queue || ''
  const type =
    a['job.type'] || line?.type || (queue && e.name.startsWith(`${queue} `) ? e.name.slice(queue.length + 1) : '')
  const id = a['job.id'] || a['messaging.message.id'] || line?.id || ''
  if (!queue && !type && !id) return null
  return {
    queue,
    type,
    id,
    attempt: Number(a['job.attempt']) || line?.attempt || 0,
    maxAttempts: Number(a['job.max_attempts']) || line?.max_attempts || 0,
    module: a['event.module'] || a['messaging.system'] || line?.module || '',
  }
}

@Injectable()
export class TracesService {
  constructor(private readonly reader: Reader) {}

  /**
   * Entry spans (first span of a service in a trace), newest first or by
   * `sort=durationMs`. Without `entries=all` (or a service / role / route
   * filter), downstream HTTP entries are left out: they are hops of their
   * caller's trace. With `sample`, up to `limit` rows chosen to cover the
   * range instead of the newest: error entries first (at most half the limit,
   * spread over time when there are more), then the slowest (a fifth; HTTP
   * entries first, so long jobs do not take the slots of slow requests), then
   * the rest spread evenly over time buckets; budget the other parts cannot
   * use goes back to more error entries.
   */
  async list(q: QueryString): Promise<TraceListResponse> {
    const c = parseCommon(q)
    const limit = optInt(q, 'limit', 1, 500, 200)
    const slowMs = optNumber(q, 'slowMs', 1, 86_400_000) ?? SLOW_MS
    const sort = optEnum(q, 'sort', ['timestamp', 'durationms'] as const, ['timestamp', 'durationMs']) ?? 'timestamp'
    const listed = optList(q, 'sample', SAMPLE_PARTS)
    const parts: SamplePart[] | null = listed
      ? listed.length === 1 && listed[0] === 'spread'
        ? [...SAMPLE_PARTS]
        : SAMPLE_PARTS.filter((p) => listed.includes(p))
      : null
    const w = this.filters(q, c)

    const totalQuery = this.reader.rows<{ total: number; errors: number; traces: number; error_traces: number; slow: number }>(
      'traces.total',
      `SELECT count() AS total, countIf(${IS_ERROR}) AS errors,
              uniqExact(trace_id) AS traces, uniqExactIf(trace_id, ${IS_ERROR}) AS error_traces,
              countIf(kind = 'SERVER' AND NOT ${IS_ERROR} AND duration_ns >= {slowNs:UInt64}) AS slow
       FROM skilllane_monitoring.spans WHERE ${w.sql}`,
      { ...w.params, slowNs: Math.round(slowMs * 1e6) },
    )
    const picked: Array<{ e: SpanDb; part: SamplePart | null }> = []
    if (!parts) {
      const entries = await this.reader.rows<SpanDb>(
        'traces',
        `SELECT ${SPAN_SELECT}
         FROM skilllane_monitoring.spans
         WHERE ${w.sql}
         ORDER BY ${sort === 'durationms' ? 'duration_ns DESC, timestamp DESC' : 'timestamp DESC'}
         LIMIT {limit:UInt32}`,
        { ...w.params, limit },
      )
      for (const e of entries) picked.push({ e, part: null })
    } else {
      for (const p of await this.sample(c, w, parts, limit)) picked.push(p)
      if (sort === 'durationms') picked.sort((a, b) => b.e.duration_ms - a.e.duration_ms)
      else picked.sort((a, b) => b.e.timestamp.localeCompare(a.e.timestamp))
    }

    const entries = picked.map((p) => p.e)
    const [[total], stats, jobs] = await Promise.all([totalQuery, this.traceStats(c, entries), this.jobLines(entries)])
    const byId = new Map(stats.map((s) => [s.trace_id, s]))
    const jobBy = new Map(jobs.map((j) => [`${j.trace_id}\u0000${j.span_id}`, j]))
    return {
      rows: picked.map(({ e, part }) => {
        const s = byId.get(e.trace_id)
        return {
          traceId: e.trace_id,
          spanId: e.span_id,
          timestamp: iso(e.timestamp) ?? '',
          service: e.service,
          role: e.role,
          name: e.name,
          kind: e.kind,
          method: e.http_method,
          route: e.http_route ? `${e.http_method} ${e.http_route}` : e.name,
          httpRoute: e.http_route,
          status: e.http_status,
          statusCode: e.status_code,
          isError: e.status_code === 'ERROR' || e.http_status >= 500,
          downstream: e.kind === 'SERVER' && e.parent_span_id !== '',
          durationMs: num(e.duration_ms),
          spanCount: s?.span_count ?? 1,
          errorCount: s?.error_count ?? (e.status_code === 'ERROR' ? 1 : 0),
          services: (s?.services ?? [e.service]).sort(),
          job: jobOf(e, jobBy.get(`${e.trace_id}\u0000${e.span_id}`)),
          sample: part,
        }
      }),
      total: total?.total ?? 0,
      totalErrors: total?.errors ?? 0,
      totalTraces: total?.traces ?? 0,
      totalErrorTraces: total?.error_traces ?? 0,
      totalSlow: total?.slow ?? 0,
      slowMs,
      sample: parts,
    }
  }

  /** Every list filter: is_entry, entries, route, status, minMs, kind, traceId (exact or prefix). */
  private filters(q: QueryString, c: Common): Where {
    const w = scoped(c).add('is_entry = 1')
    const route = optString(q, 'route', 200)
    if (route) routeCondition(w, route, ENTRY_ROUTE)
    const entries = optEnum(q, 'entries', ['top', 'all'] as const) ?? 'top'
    // A service / role / route filter asks for that service's own requests, downstream ones included.
    if (entries === 'top' && !route && !c.service && !c.role) w.add(`NOT ${IS_DOWNSTREAM}`)
    const status = optEnum(q, 'status', ['error', 'ok'] as const)
    if (status === 'error') w.add(IS_ERROR)
    if (status === 'ok') w.add(`NOT ${IS_ERROR}`)
    const minMs = optNumber(q, 'minMs', 0, 86_400_000)
    if (minMs) w.add('duration_ns >= {minNs:UInt64}', { minNs: Math.round(minMs * 1e6) })
    const kind = optName(q, 'kind')
    if (kind) w.add('kind = {kind:String}', { kind: kind.toUpperCase() })
    const traceId = optString(q, 'traceId', 64)
    if (traceId) {
      const t = parseTraceIdPrefix(traceId)
      if (t.exact) w.add('trace_id = {traceId:String}', { traceId: t.exact })
      else w.add('startsWith(trace_id, {tracePrefix:String})', { tracePrefix: t.prefix })
    }
    return w
  }

  /** The `sample` parts in order, each taking from what is left of `limit`. */
  private async sample(
    c: Common,
    w: Where,
    parts: SamplePart[],
    limit: number,
  ): Promise<Array<{ e: SpanDb; part: SamplePart }>> {
    const withErrors = parts.includes('errors')
    const others = parts.length > 1
    // With the errors part, slow and spread look only at the rest, so the parts never overlap.
    const rest = withErrors ? new Where().add(w.sql, w.params).add(`NOT ${IS_ERROR}`) : w
    const errorWhere = new Where().add(w.sql, w.params).add(IS_ERROR)
    const errorCap = withErrors ? (others ? Math.ceil(limit / 2) : limit) : 0
    // Without spread, slow takes whatever errors leave (trimmed below).
    const slowCap = parts.includes('slow') ? (parts.includes('spread') ? Math.max(1, Math.ceil(limit / 5)) : limit) : 0
    const [errors, slow] = await Promise.all([
      errorCap ? this.spread(c, errorWhere, errorCap, []) : [],
      slowCap
        ? this.reader.rows<SpanDb>(
            'traces.slow',
            // HTTP entries first: jobs are long by nature and would take every slot of slow requests.
            `SELECT ${SPAN_SELECT} FROM skilllane_monitoring.spans WHERE ${rest.sql}
             ORDER BY kind = 'SERVER' DESC, duration_ns DESC LIMIT {n:UInt32}`,
            { ...rest.params, n: slowCap },
          )
        : [],
    ])
    // The two caps can exceed a tiny limit together; errors win.
    slow.splice(Math.max(0, limit - errors.length))
    const out: Array<{ e: SpanDb; part: SamplePart }> = [
      ...errors.map((e) => ({ e, part: 'errors' as const })),
      ...slow.map((e) => ({ e, part: 'slow' as const })),
    ]
    if (parts.includes('spread') && out.length < limit) {
      const spread = await this.spread(c, rest, limit - out.length, slow.map((e) => e.span_id))
      out.push(...spread.map((e) => ({ e, part: 'spread' as const })))
    }
    // Budget the other parts left unused (few or no other entries, e.g. status=error) goes back to errors.
    if (errors.length === errorCap && errorCap < limit && out.length < limit) {
      const more = await this.spread(c, errorWhere, limit - out.length, errors.map((e) => e.span_id))
      out.push(...more.map((e) => ({ e, part: 'errors' as const })))
    }
    return out
  }

  /**
   * Up to `n` entries spread evenly over the range: the range is cut into
   * min(n, series buckets) time buckets; every bucket gives one entry before
   * any gives a second (a stable pseudo-random pick inside a bucket).
   */
  private spread(c: Common, w: Where, n: number, exclude: string[]): Promise<SpanDb[]> {
    const parts = Math.max(1, Math.min(n, buckets(c).length))
    const bucketMs = Math.max(1, Math.ceil((c.toMs - c.fromMs) / parts))
    return this.reader.rows<SpanDb>(
      'traces.spread',
      `SELECT ${SPAN_SELECT} FROM skilllane_monitoring.spans
       WHERE ${w.sql} AND span_id IN (
         SELECT span_id FROM (
           -- ClickHouse 25.8 does not substitute query parameters inside OVER (…): bucket first.
           SELECT span_id, h, row_number() OVER (PARTITION BY bucket ORDER BY h) AS rn
           FROM (
             SELECT span_id, cityHash64(span_id) AS h,
                    intDiv(toUnixTimestamp64Milli(timestamp) - {fromMs:Int64}, {bucketMs:UInt64}) AS bucket
             FROM skilllane_monitoring.spans
             WHERE ${w.sql} AND NOT has({exclude:Array(String)}, span_id)
           )
         )
         ORDER BY rn, h
         LIMIT {n:UInt32}
       )`,
      { ...w.params, bucketMs, exclude, n },
    )
  }

  /** span / error counts and services of the listed traces (trace_index). */
  private traceStats(c: Common, entries: SpanDb[]) {
    const ids = [...new Set(entries.map((e) => e.trace_id))]
    if (!ids.length) return Promise.resolve([])
    return this.reader.rows<{ trace_id: string; span_count: number; error_count: number; services: string[] }>(
      'traces.index',
      `SELECT trace_id, sum(span_count) AS span_count, sum(error_count) AS error_count,
              groupUniqArrayArray(services) AS services
       FROM skilllane_monitoring.trace_index
       WHERE trace_id IN {ids:Array(String)}
         AND day >= toDate(${msParam('fromMs')}) - 1 AND day <= toDate(${msParam('toMs')}) + 1
       GROUP BY trace_id`,
      { ids, fromMs: c.fromMs, toMs: c.toMs },
    )
  }

  /** job.* log lines of the listed non-HTTP entry spans (the SDK's job spans carry no job attributes). */
  private jobLines(entries: SpanDb[]): Promise<JobLine[]> {
    const jobs = entries.filter((e) => !e.http_method && !e.http_route)
    if (!jobs.length) return Promise.resolve([])
    const startMs = jobs.map((e) => micros(e.timestamp) / 1000)
    const endMs = jobs.map((e, i) => startMs[i] + e.duration_ms)
    return this.reader.rows<JobLine>(
      'traces.jobs',
      `SELECT trace_id, span_id, any(job_queue) AS queue, any(job_type) AS type, anyIf(job_id, job_id != '') AS id,
              max(job_attempt) AS attempt, max(job_max_attempts) AS max_attempts,
              anyIf(event_module, event_module != '') AS module
       FROM skilllane_monitoring.logs
       WHERE env IN {envs:Array(String)} AND job_queue != ''
         AND timestamp >= ${msParam('fromMs')} AND timestamp <= ${msParam('toMs')}
         AND trace_id IN {ids:Array(String)}
       GROUP BY trace_id, span_id`,
      {
        envs: [...new Set(jobs.map((e) => e.env))],
        ids: [...new Set(jobs.map((e) => e.trace_id))],
        fromMs: Math.floor(Math.min(...startMs)) - 5_000,
        toMs: Math.ceil(Math.max(...endMs)) + 60_000,
      },
    )
  }

  /** trace_index row of a trace (time range, counts, envs); 404 when it has none. */
  private async index(traceId: string, env: string | undefined): Promise<TraceIndex> {
    const w = new Where().add('trace_id = {traceId:String}', { traceId })
    if (env) w.add('env = {env:String}', { env })
    const [index] = await this.reader.rows<TraceIndex>(
      'trace.index',
      `SELECT min(start_ts) AS start, max(end_ts) AS end, sum(span_count) AS span_count,
              sum(error_count) AS error_count, groupUniqArrayArray(services) AS services,
              groupUniqArray(env) AS envs
       FROM skilllane_monitoring.trace_index
       WHERE ${w.sql}`,
      w.params,
    )
    if (!index || !index.span_count) throw new NotFoundException(`trace ${traceId} not found`)
    return index
  }

  /** One trace: trace_index bounds the time range, then spans (with their I/O sizes) and logs. */
  async detail(rawId: string, q: QueryString): Promise<TraceDetail> {
    const traceId = parseTraceId(rawId)
    const index = await this.index(traceId, optName(q, 'env'))
    const startUs = micros(index.start)
    const endUs = micros(index.end)
    const bounds = { traceId, envs: index.envs }
    const [spans, logs] = await Promise.all([
      this.reader.rows<SpanDb & SpanIoDb>(
        'trace.spans',
        `SELECT ${SPAN_SELECT}, ${SPAN_IO_SELECT}
         FROM skilllane_monitoring.spans
         WHERE trace_id = {traceId:String} AND env IN {envs:Array(String)}
           AND timestamp >= fromUnixTimestamp64Micro({fromUs:Int64}, 'UTC')
           AND timestamp <= fromUnixTimestamp64Micro({toUs:Int64}, 'UTC')
         ORDER BY timestamp, span_id
         LIMIT 5000`,
        { ...bounds, fromUs: startUs - 1_000_000, toUs: endUs + 1_000_000 },
      ),
      this.reader.rows<LogDb>(
        'trace.logs',
        `SELECT ${LOG_SELECT}
         FROM skilllane_monitoring.logs
         WHERE trace_id = {traceId:String} AND env IN {envs:Array(String)}
           AND timestamp >= ${msParam('fromMs')} AND timestamp <= ${msParam('toMs')}
         ORDER BY timestamp
         LIMIT 1000`,
        // Log lines may be written a little before the first span starts and after it ends.
        { ...bounds, fromMs: Math.floor(startUs / 1000) - 5_000, toMs: Math.ceil(endUs / 1000) + 60_000 },
      ),
    ])
    return {
      traceId,
      env: index.envs[0] ?? '',
      start: iso(index.start) ?? '',
      durationMs: num((endUs - startUs) / 1000),
      spanCount: index.span_count,
      errorCount: index.error_count,
      services: [...index.services].sort(),
      spans: spans.map(toSpanRow),
      logs: logs.map(toLogRow),
    }
  }

  /** One span of a trace with its captured I/O (the Network panel); 404 for an unknown trace or span. */
  async span(rawTraceId: string, rawSpanId: string, q: QueryString): Promise<SpanDetail> {
    const traceId = parseTraceId(rawTraceId)
    const spanId = parseSpanId(rawSpanId)
    const index = await this.index(traceId, optName(q, 'env'))
    const startUs = micros(index.start)
    const [row] = await this.reader.rows<SpanDetailDb>(
      'trace.span',
      `SELECT ${SPAN_DETAIL_SELECT}
       FROM skilllane_monitoring.spans
       WHERE trace_id = {traceId:String} AND span_id = {spanId:String} AND env IN {envs:Array(String)}
         AND timestamp >= fromUnixTimestamp64Micro({fromUs:Int64}, 'UTC')
         AND timestamp <= fromUnixTimestamp64Micro({toUs:Int64}, 'UTC')
       LIMIT 1`,
      { traceId, spanId, envs: index.envs, fromUs: startUs - 1_000_000, toUs: micros(index.end) + 1_000_000 },
    )
    if (!row) throw new NotFoundException(`span ${spanId} not found in trace ${traceId}`)
    return toSpanDetail(row, startUs)
  }
}
