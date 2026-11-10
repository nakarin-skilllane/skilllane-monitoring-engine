/**
 * /api/logs noise and repeats (SPEC.md `hide`, `exclude`, `collapse`, `pattern`). SQL text from constants only.
 *
 * A noise group matches debug / info lines only, so a warn, error or fatal line is never hidden (a probe
 * that answered 5xx is an error line and stays). A repeat pattern = service + role + logger + level +
 * event code + the message with its `[…]` parts, uuids, hex ids and numbers turned into `*`; http.request
 * and job.* lines are never collapsed (one line = one request / one job). A repeat collapses when it is
 * steady (many lines over the range) or a burst (more than 3 in a row, each within 1 s of the one before).
 */
import { PROBE_SEGMENTS } from '../probes'
import { bad, optList, optString, type QueryString } from './params'

export const NOISE_GROUPS = ['probe', 'preflight', 'middleware', 'cache', 'cron', 'startup'] as const
export type NoiseGroup = (typeof NOISE_GROUPS)[number]

const QUIET = "level IN ('debug', 'info')"
const OK_REQUEST = "event_code = 'http.request' AND http_status < 400"
/** A plain logger line: the SDK writes app.log for `new Logger()`. */
const FREE_TEXT = "event_code IN ('', 'app.log')"
const LAST_SEGMENT = "arrayElement(arrayFilter(s -> s != '', splitByChar('/', lower(http_route))), -1)"

const IS_PROBE_ROUTE = `${LAST_SEGMENT} IN (${PROBE_SEGMENTS.map((s) => `'${s}'`).join(', ')})`

export const NOISE_SQL: Record<NoiseGroup, string> = {
  probe: `${QUIET} AND ${OK_REQUEST} AND ${IS_PROBE_ROUTE}`,
  preflight: `${QUIET} AND ${OK_REQUEST} AND http_method = 'OPTIONS'`,
  middleware: `${QUIET} AND ${FREE_TEXT} AND positionCaseInsensitive(message, 'middleware') > 0`,
  cache: `${QUIET} AND ${FREE_TEXT} AND (positionCaseInsensitive(logger, 'cache') > 0 OR match(message, '(?i)^cache (hit|miss|set|get|del)'))`,
  // a run that went fine of a frequent cron (`frequentCron`: CRON); a daily job, job.failed / job.retry and BullMQ,
  // Kafka, RabbitMQ jobs (one per user action) stay
  cron: `${QUIET} AND event_module = 'cron' AND event_code IN ('job.started', 'job.finished') AND concat(job_queue, ' ', job_type) IN {frequentCron:Array(String)}`,
  // what an app writes while it starts (route mapping, module loading), up to its app.started (STARTUP windows)
  startup: `${QUIET} AND ${FREE_TEXT} AND trace_id = '' AND ${IN_WINDOW('su')}`,
}

/**
 * A line of a process inside one of the windows passed as parallel arrays `<p>S` (service), `<p>R` (role),
 * `<p>H` (host), `<p>F` / `<p>T` (from / to, epoch ms).
 */
function IN_WINDOW(p: string): string {
  return `arrayExists((s, r, h, f, t) -> s = service AND r = role AND h = host AND toUnixTimestamp64Milli(timestamp) BETWEEN f AND t, {${p}S:Array(String)}, {${p}R:Array(String)}, {${p}H:Array(String)}, {${p}F:Array(Int64)}, {${p}T:Array(Int64)})`
}

/** A process window (start-up: app.started − its duration .. + STARTUP_TAIL_MS; shutdown: app.shutdown .. + SHUTDOWN_MS). */
export interface LifeWindow {
  service: string
  role: string
  host: string
  from: number
  to: number
}

/** A start-up longer than this is cut to it; lines after an app.shutdown within this are its shutdown. */
export const STARTUP_MAX_MS = 10 * 60_000
/** What a NestJS app still writes right after it listens (queue topology, first broker connects) is its start-up too. */
export const STARTUP_TAIL_MS = 5_000
export const SHUTDOWN_MS = 30_000

/** The `<p>S/R/H/F/T` params of IN_WINDOW. */
export function windowParams(p: string, ws: LifeWindow[]): Record<string, unknown> {
  return {
    [`${p}S`]: ws.map((w) => w.service),
    [`${p}R`]: ws.map((w) => w.role),
    [`${p}H`]: ws.map((w) => w.host),
    [`${p}F`]: ws.map((w) => w.from),
    [`${p}T`]: ws.map((w) => w.to),
  }
}

/** The window of this process that `ms` falls in, if any. */
export const windowOf = (ws: LifeWindow[], service: string, role: string, host: string, ms: number): LifeWindow | undefined =>
  ws.find((w) => w.service === service && w.role === role && w.host === host && ms >= w.from && ms <= w.to)

/**
 * A cron (queue + type) is frequent with at least `minRuns` runs in the range, `maxGapS` apart on average (every
 * 15 min or more often), measured between its own first and last run: a range that starts before the data or an
 * app that was down does not make a 5-minute cron look rare.
 */
export const CRON = { minRuns: 3, maxGapS: 900 } as const

/** HAVING of a cron's runs (`runs`, first / last time `first`, `last`) that make it frequent; params `cronRuns`, `cronGapS`. */
export const FREQUENT_CRON_SQL = "runs >= {cronRuns:UInt32} AND dateDiff('second', first, last) <= {cronGapS:UInt32} * (runs - 1)"
export const cronParams = { cronRuns: CRON.minRuns, cronGapS: CRON.maxGapS }

/** The message, else the error message. */
export const MESSAGE_SQL = "if(message != '', message, error_message)"
/** `expr` (a message) with what changes per occurrence turned into `*` (`[GetUsersHandler]` → `[*]`, uuids, hex ids of 8+, numbers). */
export const templateSql = (expr: string): string =>
  `replaceRegexpAll(replaceRegexpAll(${expr}, '\\\\[[^\\\\]]*\\\\]', '[*]'), '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8,}|[0-9]+', '*')`
/** The template of a line's message. */
export const TEMPLATE_SQL = templateSql(MESSAGE_SQL)
/**
 * The repeat key of a line, as an expression. Queries read PATTERN_COLUMN instead: the `logs.pattern` MATERIALIZED
 * column of clickhouse/schema.sql holds this very expression, computed once at insert (+ a bloom filter index), so
 * repeats, bursts and `pattern=` never run the regexes per row. Keep the two the same (logs.it.test checks).
 */
export const PATTERN_SQL = `cityHash64(service, role, logger, level, event_code, ${TEMPLATE_SQL})`
export const PATTERN_COLUMN = 'pattern'
/** Lines a repeat may collapse. */
export const COLLAPSIBLE_SQL = "event_code != 'http.request' AND NOT startsWith(event_code, 'job.')"

/** A pattern collapses at `minCount` lines and `perMinute` on average over the range or `peakPerMinute` in one minute. */
export const COLLAPSE = { minCount: 20, perMinute: 10, peakPerMinute: 60, maxPatterns: 200, maxRangeMs: 7 * 86_400_000 } as const
/** A burst = lines of one pattern each at most `gapMs` after the one before; it collapses at `minCount` lines. */
export const BURST = { gapMs: 1000, minCount: 4, maxBursts: 500 } as const

/**
 * Scheduled checks: one caller (service + role + method + route + user agent) that got 2xx without signing in (no
 * Authorization or Cookie header), at least `minCalls` times in the range, with at least `regularShare` of the gaps
 * between its calls within `tolerance` of their median, at least `minEveryS` apart (an uptime script, another team's
 * monitor). Nothing names the caller: the schedule is the trait. A signed-in page polling on a timer is a person and
 * stays. /api/logs collapse=1 folds their quiet lines to the latest http.request line (`repeat.kind: 'check'`).
 * Ranges up to COLLAPSE.maxRangeMs, like the other folds.
 */
export const CHECK = { minCalls: 5, tolerance: 0.1, regularShare: 0.8, minEveryS: 1, maxGroups: 50 } as const

/** The span's user agent: the current semconv key, else the older one the SDK's http instrumentation writes. */
const USER_AGENT = "if(attributes['user_agent.original'] != '', attributes['user_agent.original'], attributes['http.user_agent'])"
/** A call that may belong to a scheduled check: a successful HTTP entry made without signing in. */
export const CHECK_SPAN_SQL = `is_entry = 1 AND kind = 'SERVER' AND http_method != '' AND http_status BETWEEN 200 AND 299 AND status_code != 'ERROR' AND NOT match(req_headers, '(?i)"(authorization|cookie)"[[:space:]]*:')`
/** The caller of a span (the check's id). */
export const CHECK_KEY_SQL = `cityHash64(service, role, http_method, http_route, ${USER_AGENT})`
/** The span's user agent, for the check's `client`. */
export const CHECK_CLIENT_SQL = USER_AGENT

/**
 * Lines of the traces of checks: `scope` = a WHERE over the logs' own scope params (env, service, role, fromMs,
 * toMs: the same names on spans), `keys` = the right side for the check id (`IN {checkIds:Array(UInt64)}`).
 * Logs carry no user agent, so a line belongs to a check through its trace; ClickHouse finds the traces itself (a
 * day of a 3-minute check is 480 trace ids, too many to send as a parameter).
 */
export const checkTracesSql = (scope: string, keys: string): string =>
  `trace_id != '' AND trace_id IN (SELECT trace_id FROM skilllane_monitoring.spans WHERE ${scope} AND ${CHECK_SPAN_SQL} AND ${CHECK_KEY_SQL} ${keys})`
/** The lines collapse folds: debug / info only, so a warning or an error written during a check stays. */
export const checkLinesSql = (scope: string): string => `${QUIET} AND ${checkTracesSql(scope, 'IN {checkIds:Array(UInt64)}')}`

export function parseCheck(q: QueryString): bigint | undefined {
  const value = optString(q, 'check', 24)
  if (value === undefined) return undefined
  if (!/^\d{1,20}$/.test(value) || BigInt(value) > MAX_UINT64) bad("check must be a check id (decimal UInt64): a row's repeat.pattern of kind check")
  return BigInt(value)
}

export function parseHide(q: QueryString): NoiseGroup[] {
  return optList(q, 'hide', NOISE_GROUPS) ?? []
}

/**
 * /api/traces noise: entry spans that did not fail (a failure is never hidden). `cron` = runs of a frequent cron
 * (span name `cron <type>`, `frequentCron`), `outside` = a CLIENT span with no parent: a database or HTTP call made
 * outside any request or job (start-up, a connection pool on its own).
 */
export const TRACE_NOISE_GROUPS = ['probe', 'preflight', 'cron', 'outside'] as const
export type TraceNoiseGroup = (typeof TRACE_NOISE_GROUPS)[number]

const SPAN_OK = "NOT (status_code = 'ERROR' OR http_status >= 500)"
const OK_SERVER = `${SPAN_OK} AND kind = 'SERVER' AND http_status < 400`

export const TRACE_NOISE_SQL: Record<TraceNoiseGroup, string> = {
  probe: `${OK_SERVER} AND ${IS_PROBE_ROUTE}`,
  preflight: `${OK_SERVER} AND http_method = 'OPTIONS'`,
  cron: `${SPAN_OK} AND name IN {frequentCron:Array(String)}`,
  outside: `${SPAN_OK} AND kind = 'CLIENT' AND parent_span_id = ''`,
}

export function parseTraceHide(q: QueryString): TraceNoiseGroup[] {
  return optList(q, 'hide', TRACE_NOISE_GROUPS) ?? []
}

export function parseCollapse(q: QueryString): boolean {
  const value = optString(q, 'collapse', 8)
  if (value === undefined || value === '0') return false
  if (value === '1') return true
  return bad('collapse must be 1 or 0')
}

const MAX_UINT64 = 18446744073709551615n

export function parsePattern(q: QueryString): bigint | undefined {
  const value = optString(q, 'pattern', 24)
  if (value === undefined) return undefined
  if (!/^\d{1,20}$/.test(value) || BigInt(value) > MAX_UINT64) bad("pattern must be a pattern id (decimal UInt64): a row's repeat.pattern")
  return BigInt(value)
}
