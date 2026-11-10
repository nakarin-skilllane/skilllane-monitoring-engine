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
  cronParams,
  FREQUENT_CRON_SQL,
  windowOf,
  type LifeWindow,
  SHUTDOWN_MS,
  STARTUP_MAX_MS,
  STARTUP_TAIL_MS,
  windowParams,
  MESSAGE_SQL,
  NOISE_GROUPS,
  NOISE_SQL,
  CHECK,
  CHECK_CLIENT_SQL,
  CHECK_KEY_SQL,
  CHECK_SPAN_SQL,
  checkLinesSql,
  checkTracesSql,
  parseCheck,
  PATTERN_COLUMN,
  templateSql,
  parseCollapse,
  parseHide,
  parsePattern,
} from './noise'
import { isCatchAllRoute, type LogDb, type LogRow, LOG_SELECT, toLogRow } from './rows'
import { type Params, Reader, Where, bucketExpr, fillSeries, iso, msParam, num, scoped, scopeOnly, seriesParams } from './sql'

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
  hidden: { probe: number; preflight: number; middleware: number; cache: number; cron: number; startup: number; exclude: number; total: number }
  /**
   * `collapse=1`: steady repeats (`patterns`), bursts (`bursts`) and scheduled checks (`checks`) kept to their
   * latest line (its `repeat`); `lines` = the lines they stood for minus those latest lines. The histogram and
   * levelCounts still count every line. null without collapse.
   */
  collapse: { patterns: number; bursts: number; checks: number; lines: number; skipped: 'range' | null } | null
}

/** One scheduled check (logs.checks). */
interface CheckDb {
  id: string
  method: string
  route: string
  client: string
  n: number
  every_s: number
  first_ts: string
  last_ts: string
  latest: string
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

/**
 * timestamp, message and pattern key (the stored `pattern` column) of the collapsible lines the variants match
 * (logs.repeats, logs.bursts). The template text is made from `msg` once per pattern, not per line.
 */
function patternBranches(variants: Where[]): string {
  return variants
    .map(
      (v) => `SELECT timestamp, ${MESSAGE_SQL} AS msg, ${PATTERN_COLUMN} AS pk
       FROM skilllane_monitoring.logs WHERE ${v.sql} AND ${COLLAPSIBLE_SQL}`,
    )
    .join('\n UNION ALL \n')
}

/** `frequentCron` / `startup` = what the `cron` / `startup` groups may hide (LogsService.frequentCron, lifecycle). */
function hidingOf(q: QueryString, frequentCron: string[], startup: LifeWindow[]): Hiding {
  const parts = parseHide(q).map((g) => `(${NOISE_SQL[g]})`)
  const exclude = optString(q, 'exclude', 200)
  if (exclude) parts.push(EXCLUDE_SQL)
  return {
    sql: parts.length ? parts.join(' OR ') : null,
    params: { frequentCron, ...windowParams('su', startup), ...(exclude ? { excludeLike: likePattern(exclude) } : {}) },
    exclude: !!exclude,
  }
}

/** How far after an error line its request's `http.request` line may come (written when the response ends). */
const REQUEST_LINE_AFTER_MS = 10 * 60_000

/**
 * Lines written in a request get `requestRoute` from the `http.request` line of
 * the same trace + service + role, in one query bounded to the given rows' trace
 * ids, envs and time span. Error lines (fingerprint set) also get `httpStatus` /
 * `requestDurationMs` from it. When the line has no HTTP
 * status of its own (or the same one), `http.status` and a missing `durationMs`
 * are filled from it too. An outbound line (`http.domain` set, or
 * `http.outbound_failed`) describes another call: it keeps its own `http` and
 * `durationMs` (a timeout has no status), only httpStatus / requestDurationMs are set.
 */
export async function withRequests(reader: Reader, rows: LogRow[]): Promise<LogRow[]> {
  const targets = rows.filter((r) => r.traceId && r.eventCode !== 'http.request')
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
    // a catch-all route says nothing about the request: its real path instead
    const catchAll = isCatchAllRoute(req.req_route)
    const route = catchAll ? req.path || req.req_route : req.req_route || req.path
    r.requestRoute = route ? `${req.method} ${route}`.trim() : null
    if (catchAll && req.path) r.requestCatchAll = true
    if (!r.fingerprint) continue
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
    const [frequentCron, life] = await Promise.all([this.frequentCron(c), this.lifecycle(c)])
    const hiding = hidingOf(q, frequentCron, life.startup)
    const levels = parseLevels(q)
    const checkId = parseCheck(q)
    // the logs' own scope (env, service, role, fromMs, toMs): the check subqueries read spans with the same params
    const scope = scoped(c).sql
    const only = checkId === undefined ? undefined : new Where().add(checkTracesSql(scope, '= {checkId:UInt64}'), { checkId })
    const variants = this.variants(q, c, true, hiding, only)
    // levelCounts: every level, hidden lines counted apart (countIf)
    const allLevels = this.variants(q, c, false, undefined, only)
    const params: Params = Object.assign({ limit, ...seriesParams(c) }, ...variants.map((v) => v.params))
    const countParams: Params = Object.assign({}, ...allLevels.map((v) => v.params), hiding.params, levels ? { levels } : {})
    if (before !== undefined) params.beforeMs = before
    const cursor = before !== undefined ? ` AND timestamp < ${msParam('beforeMs')}` : ''

    const collapse = parseCollapse(q)
    const tooLong = c.toMs - c.fromMs > COLLAPSE.maxRangeMs
    // scheduled checks first: their quiet lines leave every other fold (one check stands for them)
    const checks = collapse && !tooLong && checkId === undefined ? await this.checks(c) : []
    const checkParams = checks.length ? { checkIds: checks.map((k) => BigInt(k.id)), checkKeep: checks.map((k) => k.latest) } : {}
    const folded = checks.length
      ? variants.map((v) => new Where().add(v.sql, v.params).add(`NOT (${checkLinesSql(scope)})`, checkParams))
      : variants
    const [repeats, allBursts] = collapse && !tooLong ? await Promise.all([this.repeats(folded, c), this.bursts(folded)]) : [[], []]
    // a steady repeat already stands for every line of its pattern
    const steady = new Set(repeats.map((r) => r.pattern))
    const bursts = allBursts.filter((b) => !steady.has(b.pattern))
    Object.assign(params, checkParams)
    if (repeats.length) params.collapsed = repeats.map((r) => BigInt(r.pattern))
    if (bursts.length) Object.assign(params, { bp: bursts.map((b) => BigInt(b.pattern)), bf: bursts.map((b) => b.f_ms), bl: bursts.map((b) => b.l_ms) })

    // One branch per variant, so each LIKE can use its own ngram skip index. A steady repeat or a burst leaves
    // the normal branches and comes back once: its latest line, on the page that line falls on (a burst's last
    // millisecond may hold several of its lines: one of them). `pattern_id`, not `pattern`: an alias named like
    // the column would shadow it in the WHERE.
    const folding = repeats.length > 0 || bursts.length > 0 || checks.length > 0
    const keyCols = folding ? `${PATTERN_COLUMN} AS pk, toString(pk) AS pattern_id` : `0 AS pk, '' AS pattern_id`
    const notSteady = repeats.length ? ' AND pk NOT IN {collapsed:Array(UInt64)}' : ''
    const notInBurst = bursts.length
      ? ' AND NOT arrayExists((p, f, l) -> p = pk AND ms >= f AND ms <= l, {bp:Array(UInt64)}, {bf:Array(Int64)}, {bl:Array(Int64)})'
      : ''
    const normal = folded.map(
      (v) =>
        `SELECT ${LOG_SELECT}, ${keyCols}, toUnixTimestamp64Milli(timestamp) AS ms FROM skilllane_monitoring.logs
         WHERE ${v.sql}${notSteady}${notInBurst}${cursor} ORDER BY timestamp DESC LIMIT {limit:UInt32}`,
    )
    const afterCursor = before !== undefined ? ` WHERE timestamp < ${msParam('beforeMs')}` : ''
    const kept = (where: string, by: string, from = folded) =>
      `SELECT * FROM (SELECT * FROM (${from
        .map((v) => `SELECT ${LOG_SELECT}, ${keyCols}, toUnixTimestamp64Milli(timestamp) AS ms FROM skilllane_monitoring.logs WHERE ${v.sql} AND ${where}`)
        .join('\n UNION ALL \n')}) ORDER BY timestamp DESC LIMIT 1 BY ${by})${afterCursor}`
    const latest = [
      ...(repeats.length ? [kept('pk IN {collapsed:Array(UInt64)}', 'pattern_id')] : []),
      ...(bursts.length ? [kept('arrayExists((p, l) -> p = pk AND ms = l, {bp:Array(UInt64)}, {bl:Array(Int64)})', 'pattern_id, ms')] : []),
      // a check's latest call: its http.request line (a quiet one: a failed call is not part of the check)
      ...(checks.length
        ? [kept("event_code = 'http.request' AND level IN ('debug', 'info') AND trace_id IN {checkKeep:Array(String)}", 'trace_id', variants)]
        : []),
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
                countIf(${lv} AND ${hiding.sql ? `(${hiding.sql})` : '0'}) AS hidden_total,
                countIf(${lv} AND ${shown} AND ${checks.length ? checkLinesSql(scope) : '0'}) AS check_lines
         FROM skilllane_monitoring.logs WHERE ${v.sql}`,
      )
      .join('\n UNION ALL \n')
    const COUNTS = ['debug', 'info', 'warn', 'error', 'fatal', 'request_error', ...NOISE_GROUPS.map((g) => `noise_${g}`), 'noise_exclude', 'hidden_total', 'check_lines']

    Object.assign(countParams, checkParams)
    const [rows, histogram, counts] = await Promise.all([
      this.reader.rows<LogDb & { pattern_id: string; ms: number }>('logs', `SELECT * EXCEPT (pk) FROM (${rowsSql}) ORDER BY timestamp DESC LIMIT {limit:UInt32}`, params),
      this.reader.rows<{ t: number; debug: number; info: number; warn: number; error: number; fatal: number }>(
        'logs.histogram',
        `SELECT t, sum(debug) AS debug, sum(info) AS info, sum(warn) AS warn, sum(error) AS error, sum(fatal) AS fatal
         FROM (${histogramSql}) GROUP BY t ORDER BY t`,
        params,
      ),
      this.reader.rows<Record<string, number>>('logs.levels', `SELECT ${COUNTS.map((k) => `sum(${k}) AS ${k}`).join(', ')} FROM (${countsSql})`, countParams),
    ])
    const byCheck = new Map(checks.map((k) => [k.latest, k]))
    const bySteady = new Map(repeats.map((r) => [r.pattern, r]))
    const byBurstEnd = new Map(bursts.map((b) => [`${b.pattern}@${b.l_ms}`, b]))
    const mapped = await withRequests(
      this.reader,
      rows.map((db) => {
        const row = toLogRow(db)
        const k = db.event_code === 'http.request' ? byCheck.get(db.trace_id) : undefined
        const r = db.pattern_id && !k ? bySteady.get(db.pattern_id) : undefined
        const b = db.pattern_id && !k && !r ? byBurstEnd.get(`${db.pattern_id}@${db.ms}`) : undefined
        if (k) {
          row.repeat = {
            kind: 'check', pattern: k.id, count: num(k.n), firstSeen: iso(k.first_ts) ?? '', lastSeen: iso(k.last_ts) ?? '',
            template: `${k.method} ${k.route}`, everyS: Math.round(num(k.every_s)), client: k.client,
          }
        } else if (r) row.repeat = { kind: 'steady', pattern: r.pattern, count: num(r.total), firstSeen: iso(r.first_ts) ?? '', lastSeen: iso(r.last_ts) ?? '', template: r.template }
        else if (b) row.repeat = { kind: 'burst', pattern: b.pattern, count: num(b.n), firstSeen: iso(b.first_ts) ?? '', lastSeen: iso(b.last_ts) ?? '', template: b.template }
        return row
      }),
    )
    for (const row of mapped) {
      if (row.requestRoute) row.origin = 'request'
      // app.started / app.shutdown lines start as startup / shutdown (toLogRow): they get their window here too
      if (row.origin !== 'background' && row.origin !== 'startup' && row.origin !== 'shutdown') continue
      const ms = Date.parse(row.timestamp)
      const up = windowOf(life.startup, row.service, row.role, row.host, ms)
      const down = up ? undefined : windowOf(life.shutdown, row.service, row.role, row.host, ms)
      const w = up ?? down
      if (!w) continue
      row.origin = up ? 'startup' : 'shutdown'
      row.originWindow = { from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() }
    }
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
        startup: num(lc.noise_startup),
        exclude: num(lc.noise_exclude),
        total: num(lc.hidden_total),
      },
      collapse: collapse
        ? {
            patterns: repeats.length,
            bursts: bursts.length,
            checks: checks.length,
            lines:
              repeats.reduce((a, r) => a + num(r.total) - 1, 0) +
              bursts.reduce((a, b) => a + num(b.n) - 1, 0) +
              Math.max(0, num(lc.check_lines) - checks.length),
            skipped: tooLong ? 'range' : null,
          }
        : null,
    }
  }

  /**
   * Start-up and shutdown windows of the processes in scope around the range: app.started − its duration (the
   * SDK's start-up time, at most STARTUP_MAX_MS) .. app.started + STARTUP_TAIL_MS, and app.shutdown .. + SHUTDOWN_MS.
   */
  private async lifecycle(c: Common): Promise<{ startup: LifeWindow[]; shutdown: LifeWindow[] }> {
    const w = scopeOnly(c).add(`timestamp >= ${msParam('lcFrom')} AND timestamp <= ${msParam('lcTo')}`, {
      lcFrom: c.fromMs - SHUTDOWN_MS,
      lcTo: c.toMs + STARTUP_MAX_MS,
    })
    const rows = await this.reader.rows<{ service: string; role: string; host: string; event_code: string; ms: number; d: number }>(
      'logs.lifecycle',
      `SELECT service, role, host, event_code, toUnixTimestamp64Milli(timestamp) AS ms, ifNull(duration_ms, 0) AS d
       FROM skilllane_monitoring.logs
       WHERE ${w.sql} AND event_code IN ('app.started', 'app.shutdown')
       ORDER BY timestamp LIMIT 2000`,
      w.params,
    )
    const win = (r: (typeof rows)[number], from: number, to: number): LifeWindow => ({ service: r.service, role: r.role, host: r.host, from, to })
    return {
      startup: rows
        .filter((r) => r.event_code === 'app.started')
        // duration_ms may be fractional; the window bounds go to ClickHouse as Int64
        .map((r) => win(r, num(r.ms) - Math.min(Math.round(num(r.d)), STARTUP_MAX_MS), num(r.ms) + STARTUP_TAIL_MS)),
      shutdown: rows.filter((r) => r.event_code === 'app.shutdown').map((r) => win(r, num(r.ms), num(r.ms) + SHUTDOWN_MS)),
    }
  }

  /** The scheduled checks in the range (noise.ts CHECK), most calls first; `latest` = the trace of the last call. */
  private checks(c: Common): Promise<CheckDb[]> {
    const w = scoped(c)
    return this.reader.rows<CheckDb>(
      'logs.checks',
      `SELECT id, method, route, client, n, every_s, first_ts, last_ts, latest FROM (
         SELECT toString(key) AS id, any(http_method) AS method, any(http_route) AS route, any(ua) AS client, count() AS n,
                arrayMap(x -> x / 1000, arrayPopFront(arrayDifference(arraySort(groupArray(toUnixTimestamp64Milli(timestamp)))))) AS gaps,
                arrayReduce('median', gaps) AS every_s,
                min(timestamp) AS first_ts, max(timestamp) AS last_ts, argMax(trace_id, timestamp) AS latest
         FROM (
           SELECT ${CHECK_KEY_SQL} AS key, http_method, http_route, ${CHECK_CLIENT_SQL} AS ua, timestamp, trace_id
           FROM skilllane_monitoring.spans WHERE ${w.sql} AND ${CHECK_SPAN_SQL}
         )
         GROUP BY key
         HAVING n >= {checkMin:UInt32} AND every_s >= {checkMinEvery:Float64}
            AND arrayCount(g -> abs(g - every_s) <= {checkTol:Float64} * every_s, gaps) >= {checkShare:Float64} * length(gaps)
         ORDER BY n DESC LIMIT {checkMax:UInt32}
       )`,
      {
        ...w.params,
        checkMin: CHECK.minCalls,
        checkMinEvery: CHECK.minEveryS,
        checkTol: CHECK.tolerance,
        checkShare: CHECK.regularShare,
        checkMax: CHECK.maxGroups,
      },
    )
  }

  /** `<queue> <type>` of the crons that ran often enough in the range to be noise (noise.ts CRON). */
  private async frequentCron(c: Common): Promise<string[]> {
    const w = scoped(c)
    const rows = await this.reader.rows<{ k: string }>(
      'logs.cron',
      `SELECT concat(job_queue, ' ', job_type) AS k,
              greatest(countIf(event_code = 'job.started'), countIf(event_code = 'job.finished')) AS runs,
              min(timestamp) AS first, max(timestamp) AS last
       FROM skilllane_monitoring.logs
       WHERE ${w.sql} AND event_module = 'cron' AND event_code IN ('job.started', 'job.finished')
       GROUP BY k
       HAVING ${FREQUENT_CRON_SQL}`,
      { ...w.params, ...cronParams },
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
      `SELECT toString(pk) AS pattern, sum(n) AS total, min(f) AS first_ts, max(l) AS last_ts, ${templateSql('any(m)')} AS template
       FROM (
         SELECT pk, toStartOfMinute(timestamp) AS minute, count() AS n, min(timestamp) AS f, max(timestamp) AS l, any(msg) AS m
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
              toUnixTimestamp64Milli(first_ts) AS f_ms, toUnixTimestamp64Milli(last_ts) AS l_ms, ${templateSql('any(msg)')} AS template
       FROM (
         SELECT pk, timestamp, msg, sum(gap) OVER (PARTITION BY pk ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
         FROM (
           SELECT pk, timestamp, msg,
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
  private variants(q: QueryString, c: Common, withLevel = true, hiding?: Hiding, only?: Where): Where[] {
    const base = this.filters(q, c, withLevel)
    if (hiding?.sql) base.add(`NOT (${hiding.sql})`, hiding.params)
    if (only) base.add(only.sql, only.params)
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
    const host = optName(q, 'host')
    if (host) w.add('host = {host:String}', { host })
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
    if (pattern !== undefined) w.add(`${PATTERN_COLUMN} = {pattern:UInt64}`, { pattern })
    return w
  }
}
