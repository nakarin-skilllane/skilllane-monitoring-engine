import { Injectable } from '@nestjs/common'
import {
  type Common,
  type QueryString,
  optInt,
  optName,
  optString,
  parseCommon,
  parseFingerprint,
  parseLevels,
  parseTime,
  parseTraceId,
  bad,
} from './params'
import { type LogDb, type LogRow, LOG_SELECT, toLogRow } from './rows'
import { Reader, Where, bucketExpr, fillSeries, msParam, num, scoped, seriesParams } from './sql'

export interface LogsResponse {
  rows: LogRow[]
  histogram: Array<{ t: string; debug: number; info: number; warn: number; error: number; fatal: number }>
  /**
   * Lines per level over the whole range with every filter except `level` (the level chips keep their counts
   * while a level filter is on); `requestError` = the error lines that are `http.request` lines (5xx answers).
   */
  levelCounts: { debug: number; info: number; warn: number; error: number; fatal: number; requestError: number }
  /** Pass as `before` for the next (older) page; null when this page is the last. */
  nextBefore: string | null
}

/** How far after an error line its request's `http.request` line may come (written when the response ends). */
const REQUEST_LINE_AFTER_MS = 10 * 60_000

/**
 * Error lines (fingerprint set) get `httpStatus` / `requestDurationMs` from the
 * `http.request` line of the same trace + service + role, in one query bounded
 * to the given rows' trace ids, envs and time span. When the line has no HTTP
 * status of its own (or the same one), `http.status` and a missing `durationMs`
 * are filled from it too. An outbound line (`http.domain` set, or
 * `http.outbound_failed`) describes another call: it keeps its own `http` and
 * `durationMs` (a timeout has no status), only httpStatus / requestDurationMs are set.
 */
export async function withRequests(reader: Reader, rows: LogRow[]): Promise<LogRow[]> {
  const targets = rows.filter((r) => r.fingerprint && r.traceId && r.eventCode !== 'http.request')
  if (!targets.length) return rows
  const times = targets.map((r) => Date.parse(r.timestamp)).filter(Number.isFinite)
  if (!times.length) return rows
  const found = await reader.rows<{
    trace_id: string
    service: string
    role: string
    status: number
    req_ms: number | null
    method: string
    req_route: string
    path: string
  }>(
    'logs.requests',
    `SELECT trace_id, service, role,
            argMax(http_status, timestamp) AS status, argMax(duration_ms, timestamp) AS req_ms,
            argMax(http_method, timestamp) AS method, argMax(http_route, timestamp) AS req_route,
            argMax(url_path, timestamp) AS path
     FROM skilllane_monitoring.logs
     WHERE env IN {envs:Array(String)} AND event_code = 'http.request'
       AND timestamp >= ${msParam('fromMs')} AND timestamp <= ${msParam('toMs')}
       AND trace_id IN {ids:Array(String)}
     GROUP BY trace_id, service, role`,
    {
      envs: [...new Set(targets.map((r) => r.env))],
      ids: [...new Set(targets.map((r) => r.traceId))],
      fromMs: Math.min(...times) - 60_000,
      toMs: Math.max(...times) + REQUEST_LINE_AFTER_MS,
    },
  )
  const byKey = new Map(found.map((f) => [`${f.trace_id}\u0000${f.service}\u0000${f.role}`, f]))
  for (const r of targets) {
    const req = byKey.get(`${r.traceId}\u0000${r.service}\u0000${r.role}`)
    if (!req) continue
    const reqMs = req.req_ms === null || req.req_ms === undefined ? null : num(req.req_ms)
    r.httpStatus = req.status || null
    r.requestDurationMs = reqMs
    if (r.http?.domain || r.eventCode === 'http.outbound_failed') continue
    const own = r.http?.status ?? 0
    if (own && own !== req.status) continue
    r.http = r.http
      ? { ...r.http, status: req.status }
      : { method: req.method, route: req.req_route, path: req.path, status: req.status, domain: '' }
    if (r.durationMs === null) r.durationMs = reqMs
  }
  return rows
}

/**
 * `route` filter: `GET /classes/:id` (the form every response uses), `/classes/:id`,
 * or a job / consumer key `<queue> <type>` (overview routes[].route of a job):
 * on spans the entry span name, on log lines job_queue + job_type.
 */
export function routeCondition(w: Where, route: string, entryNameColumn?: string): void {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S.*)$/i.exec(route)
  if (m) {
    w.add('http_method = {routeMethod:String} AND http_route = {routePath:String}', {
      routeMethod: m[1].toUpperCase(),
      routePath: m[2],
    })
  } else if (entryNameColumn) {
    w.add(`(http_route = {route:String} OR ${entryNameColumn} = {route:String})`, { route })
  } else {
    w.add(`(http_route = {route:String} OR (job_queue != '' AND concat(job_queue, ' ', job_type) = {route:String}))`, { route })
  }
}

/**
 * Columns `q` also searches (no skip index; the third UNION ALL branch): the error details and the
 * request (`GET /classes/:id/students` as the screens write it, and the real path).
 */
const OTHER_TEXT_COLUMNS = [
  'error_detail',
  'error_how_to_fix',
  'error_hint',
  'error_target',
  'error_code',
  "concat(http_method, ' ', http_route)",
  'url_path',
]

/** `%text%` for LIKE, with LIKE metacharacters escaped. */
export function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

@Injectable()
export class LogsService {
  constructor(private readonly reader: Reader) {}

  async search(q: QueryString): Promise<LogsResponse> {
    const c = parseCommon(q)
    const limit = optInt(q, 'limit', 1, 500, 100)
    const beforeRaw = optString(q, 'before', 40)
    const before = beforeRaw === undefined ? undefined : parseTime('before', beforeRaw, Date.now())
    const variants = this.variants(q, c)
    const allLevels = this.variants(q, c, false)
    const params = Object.assign({ limit, ...seriesParams(c) }, ...variants.map((v) => v.params))
    const countParams = Object.assign({}, ...allLevels.map((v) => v.params))
    if (before !== undefined) params.beforeMs = before
    const cursor = before !== undefined ? ` AND timestamp < ${msParam('beforeMs')}` : ''

    // One branch per variant, so each LIKE can use its own ngram skip index.
    const rowsSql = variants
      .map((v) => `SELECT ${LOG_SELECT} FROM skilllane_monitoring.logs WHERE ${v.sql}${cursor} ORDER BY timestamp DESC LIMIT {limit:UInt32}`)
      .join('\n UNION ALL \n')
    const histogramSql = variants
      .map(
        (v) => `SELECT ${bucketExpr('timestamp')} AS t,
                countIf(level = 'debug') AS debug, countIf(level = 'info') AS info,
                countIf(level = 'warn') AS warn, countIf(level = 'error') AS error,
                countIf(level = 'fatal') AS fatal
         FROM skilllane_monitoring.logs WHERE ${v.sql} GROUP BY t`,
      )
      .join('\n UNION ALL \n')
    const countsSql = allLevels
      .map(
        (v) => `SELECT countIf(level = 'debug') AS debug, countIf(level = 'info') AS info,
                countIf(level = 'warn') AS warn, countIf(level = 'error') AS error,
                countIf(level = 'fatal') AS fatal,
                countIf(level = 'error' AND event_code = 'http.request') AS request_error
         FROM skilllane_monitoring.logs WHERE ${v.sql}`,
      )
      .join('\n UNION ALL \n')

    const [rows, histogram, counts] = await Promise.all([
      this.reader.rows<LogDb>('logs', `SELECT * FROM (${rowsSql}) ORDER BY timestamp DESC LIMIT {limit:UInt32}`, params),
      this.reader.rows<{ t: number; debug: number; info: number; warn: number; error: number; fatal: number }>(
        'logs.histogram',
        `SELECT t, sum(debug) AS debug, sum(info) AS info, sum(warn) AS warn, sum(error) AS error, sum(fatal) AS fatal
         FROM (${histogramSql}) GROUP BY t ORDER BY t`,
        params,
      ),
      this.reader.rows<{ debug: number; info: number; warn: number; error: number; fatal: number; request_error: number }>(
        'logs.levels',
        `SELECT sum(debug) AS debug, sum(info) AS info, sum(warn) AS warn, sum(error) AS error, sum(fatal) AS fatal,
                sum(request_error) AS request_error
         FROM (${countsSql})`,
        countParams,
      ),
    ])
    const mapped = await withRequests(this.reader, rows.map(toLogRow))
    const lc = counts[0]
    return {
      rows: mapped,
      histogram: fillSeries(c, histogram, () => ({ debug: 0, info: 0, warn: 0, error: 0, fatal: 0 })),
      levelCounts: {
        debug: num(lc?.debug),
        info: num(lc?.info),
        warn: num(lc?.warn),
        error: num(lc?.error),
        fatal: num(lc?.fatal),
        requestError: num(lc?.request_error),
      },
      nextBefore: mapped.length === limit ? mapped[mapped.length - 1].timestamp : null,
    }
  }

  /**
   * The filters as one or three WHERE variants. With `q`, a row matches when its
   * message, error_message, error_detail, error_how_to_fix, error_hint, error_target, error_code,
   * `METHOD /route` or url_path contains the text (case-insensitive). An OR
   * across two skip indexes prunes nothing in ClickHouse 25.8, so the two indexed
   * columns get one branch each (one `lower(col) LIKE` the ngrambf_v1 index uses);
   * the unindexed columns share a third. The branches are disjoint, so no row comes twice.
   */
  private variants(q: QueryString, c: Common, withLevel = true): Where[] {
    const base = this.filters(q, c, withLevel)
    const text = optString(q, 'q', 200)
    if (!text) return [base]
    const qLike = likePattern(text)
    const inMessage = 'lower(message) LIKE {qLike:String}'
    const inErrorMessage = 'lower(error_message) LIKE {qLike:String}'
    const inOther = `(${OTHER_TEXT_COLUMNS.map((col) => `lower(${col}) LIKE {qLike:String}`).join(' OR ')})`
    return [
      new Where().add(base.sql, base.params).add(inMessage, { qLike }),
      new Where().add(base.sql, base.params).add(`${inErrorMessage} AND NOT (${inMessage})`, { qLike }),
      new Where()
        .add(base.sql, base.params)
        .add(`${inOther} AND NOT (${inMessage}) AND NOT (${inErrorMessage})`, { qLike }),
    ]
  }

  /**
   * Every filter except `q` and the `before` cursor (the histogram covers the whole range); `withLevel` false
   * leaves out `level` too (levelCounts). `event` = one code (`job.failed`), a prefix (`job.*`) or a comma list
   * of codes (`job.retry,job.failed`); `jobId` = job_id (any queue).
   */
  private filters(q: QueryString, c: Common, withLevel = true): Where {
    const w = scoped(c)
    const levels = withLevel ? parseLevels(q) : undefined
    if (levels) w.add('level IN {levels:Array(String)}', { levels })
    const event = optString(q, 'event', 200)
    if (event) {
      const codes = event.split(',').map((e) => e.trim()).filter(Boolean)
      const help = 'event must be an event code like job.failed, a prefix like job.*, or a comma list of codes'
      if (codes.length > 1) {
        if (codes.some((e) => !/^[a-z0-9_.]+$/i.test(e))) bad(help)
        w.add('event_code IN {events:Array(String)}', { events: codes })
      } else {
        if (!/^[a-z0-9_.]+(\.\*|\*)?$/i.test(event)) bad(help)
        if (event.endsWith('*')) {
          w.add('startsWith(event_code, {eventPrefix:String})', { eventPrefix: event.slice(0, -1) })
        } else {
          w.add('event_code = {event:String}', { event })
        }
      }
    }
    const jobId = optString(q, 'jobId', 128)
    if (jobId) w.add('job_id = {jobId:String}', { jobId })
    const traceId = optString(q, 'traceId', 64)
    if (traceId) w.add('trace_id = {traceId:String}', { traceId: parseTraceId(traceId) })
    const userId = optString(q, 'userId', 128)
    if (userId) w.add('user_id = {userId:String}', { userId })
    const route = optString(q, 'route', 200)
    if (route) routeCondition(w, route)
    const category = optName(q, 'category')
    if (category) w.add('error_category = {category:String}', { category })
    const fingerprint = optString(q, 'fingerprint', 24)
    if (fingerprint) w.add('error_fingerprint = {fp:UInt64}', { fp: parseFingerprint(fingerprint) })
    return w
  }
}
