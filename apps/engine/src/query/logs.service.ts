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
import {
  BURST,
  COLLAPSE,
  COLLAPSIBLE_SQL,
  frequentRuns,
  NOISE_GROUPS,
  NOISE_SQL,
  PATTERN_SQL,
  TEMPLATE_SQL,
  parseCollapse,
  parseHide,
  parsePattern,
} from './noise'
import { type LogDb, type LogRow, LOG_SELECT, toLogRow } from './rows'
import { type Params, Reader, Where, bucketExpr, fillSeries, iso, msParam, num, scoped, seriesParams } from './sql'

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
  /**
   * Lines of each noise group and of the `exclude` text in the range with every filter (`level` too), hidden
   * or not; `total` = the lines this request hid (a line in two groups counts once). Rows, histogram and
   * levelCounts leave the hidden lines out.
   */
  hidden: { probe: number; preflight: number; middleware: number; cache: number; cron: number; exclude: number; total: number }
  /**
   * `collapse=1`: steady repeats (`patterns`) and bursts (`bursts`) kept to their latest line (its `repeat`);
   * `lines` = the lines they stood for minus those latest lines. The histogram and levelCounts still count
   * every line. null without collapse.
   */
  collapse: { patterns: number; bursts: number; lines: number; skipped: 'range' | null } | null
}

/** One collapsed burst (logs.bursts). */
interface BurstDb {
  pattern: string
  n: number
  f_ms: number
  l_ms: number
  first_ts: string
  last_ts: string
  template: string
}

/** One collapsed repeat (logs.repeats). */
interface RepeatDb {
  pattern: string
  total: number
  first_ts: string
  last_ts: string
  template: string
}

/** What a request hides: the `hide` groups OR the `exclude` text (SQL null = nothing). */
interface Hiding {
  sql: string | null
  params: Params
  exclude: boolean
}

const EXCLUDE_SQL = 'lower(message) LIKE {excludeLike:String}'

/** timestamp, template and pattern key of the collapsible lines the variants match (logs.repeats, logs.bursts). */
function patternBranches(variants: Where[]): string {
  return variants
    .map(
      (v) => `SELECT timestamp, ${TEMPLATE_SQL} AS tpl, cityHash64(service, role, logger, level, event_code, tpl) AS pk
       FROM skilllane_monitoring.logs WHERE ${v.sql} AND ${COLLAPSIBLE_SQL}`,
    )
    .join('\n UNION ALL \n')
}

/** `frequentCron` = the crons the `cron` group may hide (LogsService.frequentCron). */
function hidingOf(q: QueryString, frequentCron: string[]): Hiding {
  const parts = parseHide(q).map((g) => `(${NOISE_SQL[g]})`)
  const exclude = optString(q, 'exclude', 200)
  if (exclude) parts.push(EXCLUDE_SQL)
  return { sql: parts.length ? parts.join(' OR ') : null, params: { frequentCron, ...(exclude ? { excludeLike: likePattern(exclude) } : {}) }, exclude: !!exclude }
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
    const hiding = hidingOf(q, await this.frequentCron(c))
    const levels = parseLevels(q)
    const variants = this.variants(q, c, true, hiding)
    // levelCounts: every level, hidden lines counted apart (countIf)
    const allLevels = this.variants(q, c, false)
    const params: Params = Object.assign({ limit, ...seriesParams(c) }, ...variants.map((v) => v.params))
    const countParams = Object.assign({}, ...allLevels.map((v) => v.params), hiding.params, levels ? { levels } : {})
    if (before !== undefined) params.beforeMs = before
    const cursor = before !== undefined ? ` AND timestamp < ${msParam('beforeMs')}` : ''

    const collapse = parseCollapse(q)
    const tooLong = c.toMs - c.fromMs > COLLAPSE.maxRangeMs
    const [repeats, allBursts] = collapse && !tooLong ? await Promise.all([this.repeats(variants, c), this.bursts(variants)]) : [[], []]
    // a steady repeat already stands for every line of its pattern
    const steady = new Set(repeats.map((r) => r.pattern))
    const bursts = allBursts.filter((b) => !steady.has(b.pattern))
    if (repeats.length) params.collapsed = repeats.map((r) => BigInt(r.pattern))
    if (bursts.length) Object.assign(params, { bp: bursts.map((b) => BigInt(b.pattern)), bf: bursts.map((b) => b.f_ms), bl: bursts.map((b) => b.l_ms) })

    // One branch per variant, so each LIKE can use its own ngram skip index. A steady repeat or a burst leaves
    // the normal branches and comes back once: its latest line, on the page that line falls on (a burst's last
    // millisecond may hold several of its lines: one of them).
    const folding = repeats.length > 0 || bursts.length > 0
    const keyCols = folding ? `${PATTERN_SQL} AS pk, toString(pk) AS pattern` : `0 AS pk, '' AS pattern`
    const notSteady = repeats.length ? ' AND pk NOT IN {collapsed:Array(UInt64)}' : ''
    const notInBurst = bursts.length
      ? ' AND NOT arrayExists((p, f, l) -> p = pk AND ms >= f AND ms <= l, {bp:Array(UInt64)}, {bf:Array(Int64)}, {bl:Array(Int64)})'
      : ''
    const normal = variants.map(
      (v) =>
        `SELECT ${LOG_SELECT}, ${keyCols}, toUnixTimestamp64Milli(timestamp) AS ms FROM skilllane_monitoring.logs
         WHERE ${v.sql}${notSteady}${notInBurst}${cursor} ORDER BY timestamp DESC LIMIT {limit:UInt32}`,
    )
    const afterCursor = before !== undefined ? ` WHERE timestamp < ${msParam('beforeMs')}` : ''
    const kept = (where: string, by: string) =>
      `SELECT * FROM (SELECT * FROM (${variants
        .map((v) => `SELECT ${LOG_SELECT}, ${keyCols}, toUnixTimestamp64Milli(timestamp) AS ms FROM skilllane_monitoring.logs WHERE ${v.sql} AND ${where}`)
        .join('\n UNION ALL \n')}) ORDER BY timestamp DESC LIMIT 1 BY ${by})${afterCursor}`
    const latest = [
      ...(repeats.length ? [kept('pk IN {collapsed:Array(UInt64)}', 'pattern')] : []),
      ...(bursts.length ? [kept('arrayExists((p, l) -> p = pk AND ms = l, {bp:Array(UInt64)}, {bl:Array(Int64)})', 'pattern, ms')] : []),
    ]
    const rowsSql = [...normal, ...latest].join('\n UNION ALL \n')
    const histogramSql = variants
      .map(
        (v) => `SELECT ${bucketExpr('timestamp')} AS t,
                countIf(level = 'debug') AS debug, countIf(level = 'info') AS info,
                countIf(level = 'warn') AS warn, countIf(level = 'error') AS error,
                countIf(level = 'fatal') AS fatal
         FROM skilllane_monitoring.logs WHERE ${v.sql} GROUP BY t`,
      )
      .join('\n UNION ALL \n')
    const shown = hiding.sql ? `NOT (${hiding.sql})` : '1'
    const lv = levels ? 'level IN {levels:Array(String)}' : '1'
    const countsSql = allLevels
      .map(
        (v) => `SELECT countIf(level = 'debug' AND ${shown}) AS debug, countIf(level = 'info' AND ${shown}) AS info,
                countIf(level = 'warn' AND ${shown}) AS warn, countIf(level = 'error' AND ${shown}) AS error,
                countIf(level = 'fatal' AND ${shown}) AS fatal,
                countIf(level = 'error' AND event_code = 'http.request' AND ${shown}) AS request_error,
                ${NOISE_GROUPS.map((g) => `countIf(${lv} AND ${NOISE_SQL[g]}) AS noise_${g}`).join(',\n                ')},
                countIf(${lv} AND ${hiding.exclude ? EXCLUDE_SQL : '0'}) AS noise_exclude,
                countIf(${lv} AND ${hiding.sql ? `(${hiding.sql})` : '0'}) AS hidden_total
         FROM skilllane_monitoring.logs WHERE ${v.sql}`,
      )
      .join('\n UNION ALL \n')
    const COUNTS = ['debug', 'info', 'warn', 'error', 'fatal', 'request_error', ...NOISE_GROUPS.map((g) => `noise_${g}`), 'noise_exclude', 'hidden_total']

    const [rows, histogram, counts] = await Promise.all([
      this.reader.rows<LogDb & { pattern: string; ms: number }>('logs', `SELECT * EXCEPT (pk) FROM (${rowsSql}) ORDER BY timestamp DESC LIMIT {limit:UInt32}`, params),
      this.reader.rows<{ t: number; debug: number; info: number; warn: number; error: number; fatal: number }>(
        'logs.histogram',
        `SELECT t, sum(debug) AS debug, sum(info) AS info, sum(warn) AS warn, sum(error) AS error, sum(fatal) AS fatal
         FROM (${histogramSql}) GROUP BY t ORDER BY t`,
        params,
      ),
      this.reader.rows<Record<string, number>>('logs.levels', `SELECT ${COUNTS.map((k) => `sum(${k}) AS ${k}`).join(', ')} FROM (${countsSql})`, countParams),
    ])
    const bySteady = new Map(repeats.map((r) => [r.pattern, r]))
    const byBurstEnd = new Map(bursts.map((b) => [`${b.pattern}@${b.l_ms}`, b]))
    const mapped = await withRequests(
      this.reader,
      rows.map((db) => {
        const row = toLogRow(db)
        const r = db.pattern ? bySteady.get(db.pattern) : undefined
        const b = db.pattern && !r ? byBurstEnd.get(`${db.pattern}@${db.ms}`) : undefined
        if (r) row.repeat = { kind: 'steady', pattern: r.pattern, count: num(r.total), firstSeen: iso(r.first_ts) ?? '', lastSeen: iso(r.last_ts) ?? '', template: r.template }
        else if (b) row.repeat = { kind: 'burst', pattern: b.pattern, count: num(b.n), firstSeen: iso(b.first_ts) ?? '', lastSeen: iso(b.last_ts) ?? '', template: b.template }
        return row
      }),
    )
    const lc = counts[0] ?? {}
    return {
      rows: mapped,
      histogram: fillSeries(c, histogram, () => ({ debug: 0, info: 0, warn: 0, error: 0, fatal: 0 })),
      levelCounts: {
        debug: num(lc.debug),
        info: num(lc.info),
        warn: num(lc.warn),
        error: num(lc.error),
        fatal: num(lc.fatal),
        requestError: num(lc.request_error),
      },
      nextBefore: mapped.length === limit ? mapped[mapped.length - 1].timestamp : null,
      hidden: {
        probe: num(lc.noise_probe),
        preflight: num(lc.noise_preflight),
        middleware: num(lc.noise_middleware),
        cache: num(lc.noise_cache),
        cron: num(lc.noise_cron),
        exclude: num(lc.noise_exclude),
        total: num(lc.hidden_total),
      },
      collapse: collapse
        ? {
            patterns: repeats.length,
            bursts: bursts.length,
            lines: repeats.reduce((a, r) => a + num(r.total) - 1, 0) + bursts.reduce((a, b) => a + num(b.n) - 1, 0),
            skipped: tooLong ? 'range' : null,
          }
        : null,
    }
  }

  /** `<queue> <type>` of the crons that ran often enough in the range to be noise (noise.ts CRON). */
  private async frequentCron(c: Common): Promise<string[]> {
    const w = scoped(c)
    const rows = await this.reader.rows<{ k: string }>(
      'logs.cron',
      `SELECT concat(job_queue, ' ', job_type) AS k FROM skilllane_monitoring.logs
       WHERE ${w.sql} AND event_module = 'cron' AND event_code IN ('job.started', 'job.finished')
       GROUP BY k
       HAVING greatest(countIf(event_code = 'job.started'), countIf(event_code = 'job.finished')) >= {cronRuns:UInt32}`,
      { ...w.params, cronRuns: frequentRuns(c.toMs - c.fromMs) },
    )
    return rows.map((r) => r.k)
  }

  /**
   * Fast repeats among the lines the variants match (hidden lines are already out), most lines first:
   * `minCount` lines and `perMinute` on average over the range or `peakPerMinute` in one minute.
   */
  private repeats(variants: Where[], c: Common): Promise<RepeatDb[]> {
    const minutes = (c.toMs - c.fromMs) / 60_000
    const branches = patternBranches(variants)
    return this.reader.rows<RepeatDb>(
      'logs.repeats',
      `SELECT toString(pk) AS pattern, sum(n) AS total, min(f) AS first_ts, max(l) AS last_ts, any(t1) AS template
       FROM (
         SELECT pk, toStartOfMinute(timestamp) AS minute, count() AS n, min(timestamp) AS f, max(timestamp) AS l, any(tpl) AS t1
         FROM (${branches}) GROUP BY pk, minute
       )
       GROUP BY pk
       HAVING total >= {minCount:UInt32} AND (total >= {rateCount:UInt32} OR max(n) >= {peakCount:UInt32})
       ORDER BY total DESC LIMIT {maxPatterns:UInt32}`,
      Object.assign({}, ...variants.map((v) => v.params), {
        minCount: COLLAPSE.minCount,
        rateCount: Math.ceil(COLLAPSE.perMinute * minutes),
        peakCount: COLLAPSE.peakPerMinute,
        maxPatterns: COLLAPSE.maxPatterns,
      }),
    )
  }

  /**
   * Bursts among the lines the variants match: runs of one pattern, each line at most `gapMs` after the one
   * before, with at least `minCount` lines; biggest first.
   */
  private bursts(variants: Where[]): Promise<BurstDb[]> {
    return this.reader.rows<BurstDb>(
      'logs.bursts',
      `SELECT toString(pk) AS pattern, count() AS n, min(timestamp) AS first_ts, max(timestamp) AS last_ts,
              toUnixTimestamp64Milli(first_ts) AS f_ms, toUnixTimestamp64Milli(last_ts) AS l_ms, any(tpl) AS template
       FROM (
         SELECT pk, timestamp, tpl, sum(gap) OVER (PARTITION BY pk ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
         FROM (
           SELECT pk, timestamp, tpl,
                  dateDiff('millisecond', lagInFrame(timestamp) OVER (PARTITION BY pk ORDER BY timestamp ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), timestamp) > {gapMs:UInt32} AS gap
           FROM (${patternBranches(variants)})
         )
       )
       GROUP BY pk, run
       HAVING n >= {burstMin:UInt32}
       ORDER BY n DESC LIMIT {maxBursts:UInt32}`,
      Object.assign({}, ...variants.map((v) => v.params), { gapMs: BURST.gapMs, burstMin: BURST.minCount, maxBursts: BURST.maxBursts }),
    )
  }

  /**
   * The filters as one or three WHERE variants. With `q`, a row matches when its
   * message, error_message, error_detail, error_how_to_fix, error_hint, error_target, error_code,
   * `METHOD /route` or url_path contains the text (case-insensitive). An OR
   * across two skip indexes prunes nothing in ClickHouse 25.8, so the two indexed
   * columns get one branch each (one `lower(col) LIKE` the ngrambf_v1 index uses);
   * the unindexed columns share a third. The branches are disjoint, so no row comes twice.
   * `hiding` leaves out the lines `hide` / `exclude` asked to hide.
   */
  private variants(q: QueryString, c: Common, withLevel = true, hiding?: Hiding): Where[] {
    const base = this.filters(q, c, withLevel)
    if (hiding?.sql) base.add(`NOT (${hiding.sql})`, hiding.params)
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
    const pattern = parsePattern(q)
    if (pattern !== undefined) w.add(`${PATTERN_SQL} = {pattern:UInt64}`, { pattern })
    return w
  }
}
