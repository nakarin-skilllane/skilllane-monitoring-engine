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

/** The window of `ms` among `ws` for this process, if any. */
export const inWindow = (ws: LifeWindow[], service: string, role: string, host: string, ms: number): boolean =>
  ws.some((w) => w.service === service && w.role === role && w.host === host && ms >= w.from && ms <= w.to)

/**
 * A cron (queue + type) is frequent with at least `minRuns` runs in the range, `maxGapS` apart on average (every
 * 15 min or more often), measured between its own first and last run: a range that starts before the data or an
 * app that was down does not make a 5-minute cron look rare.
 */
export const CRON = { minRuns: 3, maxGapS: 900 } as const

/** HAVING of a cron's runs (`runs`, first / last time `first`, `last`) that make it frequent; params `cronRuns`, `cronGapS`. */
export const FREQUENT_CRON_SQL = "runs >= {cronRuns:UInt32} AND dateDiff('second', first, last) <= {cronGapS:UInt32} * (runs - 1)"
export const cronParams = { cronRuns: CRON.minRuns, cronGapS: CRON.maxGapS }

/** The message (else the error message) with what changes per occurrence turned into `*` (`[GetUsersHandler]` → `[*]`). */
export const TEMPLATE_SQL =
  "replaceRegexpAll(replaceRegexpAll(if(message != '', message, error_message), '\\\\[[^\\\\]]*\\\\]', '[*]'), '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{8,}|[0-9]+', '*')"
export const PATTERN_SQL = `cityHash64(service, role, logger, level, event_code, ${TEMPLATE_SQL})`
/** Lines a repeat may collapse. */
export const COLLAPSIBLE_SQL = "event_code != 'http.request' AND NOT startsWith(event_code, 'job.')"

/** A pattern collapses at `minCount` lines and `perMinute` on average over the range or `peakPerMinute` in one minute. */
export const COLLAPSE = { minCount: 20, perMinute: 10, peakPerMinute: 60, maxPatterns: 200, maxRangeMs: 7 * 86_400_000 } as const
/** A burst = lines of one pattern each at most `gapMs` after the one before; it collapses at `minCount` lines. */
export const BURST = { gapMs: 1000, minCount: 4, maxBursts: 500 } as const

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
