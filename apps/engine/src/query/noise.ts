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

export const NOISE_GROUPS = ['probe', 'preflight', 'middleware', 'cache'] as const
export type NoiseGroup = (typeof NOISE_GROUPS)[number]

const QUIET = "level IN ('debug', 'info')"
const OK_REQUEST = "event_code = 'http.request' AND http_status < 400"
/** A plain logger line: the SDK writes app.log for `new Logger()`. */
const FREE_TEXT = "event_code IN ('', 'app.log')"
const LAST_SEGMENT = "arrayElement(arrayFilter(s -> s != '', splitByChar('/', lower(http_route))), -1)"

export const NOISE_SQL: Record<NoiseGroup, string> = {
  probe: `${QUIET} AND ${OK_REQUEST} AND ${LAST_SEGMENT} IN (${PROBE_SEGMENTS.map((s) => `'${s}'`).join(', ')})`,
  preflight: `${QUIET} AND ${OK_REQUEST} AND http_method = 'OPTIONS'`,
  middleware: `${QUIET} AND ${FREE_TEXT} AND positionCaseInsensitive(message, 'middleware') > 0`,
  cache: `${QUIET} AND ${FREE_TEXT} AND (positionCaseInsensitive(logger, 'cache') > 0 OR match(message, '(?i)^cache (hit|miss|set|get|del)'))`,
}

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
