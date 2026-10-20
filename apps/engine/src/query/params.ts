/**
 * Query-string parsing and validation for the query API (SPEC.md section 8).
 * Every invalid value throws a 400 with a message that names the parameter.
 * Values only ever reach ClickHouse as query parameters ({name:Type}).
 */
import { BadRequestException } from '@nestjs/common'

export type QueryString = Record<string, unknown>

/** Common params of every endpoint, resolved to absolute times. */
export interface Common {
  env?: string
  service?: string
  role?: string
  fromMs: number
  toMs: number
  /**
   * Series bucket: the `step` param, else ≤1 h → 60, ≤6 h → 300, ≤24 h → 900,
   * ≤30 d → 3600, else 21600 (90 d → 360 buckets, within MAX_BUCKETS, so echoing
   * it back as `step` is always accepted). Always a whole number of minutes
   * (route_stats_1m is per minute).
   */
  stepSeconds: number
  /**
   * Start of the first series bucket: `from` rounded down to the whole minute,
   * so buckets line up with the range start (14:20, 15:20 … for an hourly step).
   */
  originMs: number
}

export const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const
export type Level = (typeof LEVELS)[number]

const MAX_RANGE_MS = 90 * 24 * 3600_000
const NAME = /^[\w.:/@-]{1,128}$/
const RELATIVE = /^now(?:-(\d{1,4})([smhdw]))?$/
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 }
const TIME_HELP = 'must be an ISO time (2026-10-17T07:20:00Z) or now, now-15m, now-1h, now-6h, now-24h, now-7d'
const STEP = /^(\d{1,7})([smhd])?$/
const MAX_BUCKETS = 2000

export function bad(message: string): never {
  throw new BadRequestException(message)
}

/** One optional trimmed string; arrays (?x=a&x=b) and over-long values are rejected. */
export function optString(q: QueryString, name: string, max = 200): string | undefined {
  const value = q[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') bad(`${name} must be given once, as a single value`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > max) bad(`${name} is too long (max ${max} characters)`)
  return trimmed
}

/** An identifier-like value: env, service, role, category … */
export function optName(q: QueryString, name: string): string | undefined {
  const value = optString(q, name, 128)
  if (value !== undefined && !NAME.test(value)) {
    bad(`${name} may contain only letters, digits and . _ - : / @`)
  }
  return value
}

export function optInt(q: QueryString, name: string, min: number, max: number, fallback: number): number {
  const value = optString(q, name, 12)
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) bad(`${name} must be an integer between ${min} and ${max}`)
  const n = Number(value)
  if (n < min || n > max) bad(`${name} must be an integer between ${min} and ${max}`)
  return n
}

export function optNumber(q: QueryString, name: string, min: number, max: number): number | undefined {
  const value = optString(q, name, 20)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(n) || n < min || n > max) {
    bad(`${name} must be a number between ${min} and ${max}`)
  }
  return n
}

/** Case-insensitive; `allowed` in lower case, `labels` (optional) as the message shows them. */
export function optEnum<T extends string>(
  q: QueryString,
  name: string,
  allowed: readonly T[],
  labels: readonly string[] = allowed,
): T | undefined {
  const value = optString(q, name, 32)?.toLowerCase()
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) bad(`${name} must be one of: ${labels.join(', ')}`)
  return value as T
}

/** ISO time or now / now-<n><s|m|h|d|w>. */
export function parseTime(name: string, value: string, nowMs: number): number {
  const rel = RELATIVE.exec(value)
  if (rel) return rel[1] ? nowMs - Number(rel[1]) * UNIT_MS[rel[2]] : nowMs
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    bad(`${name} ${TIME_HELP}`)
  }
  // A time without a zone is read as UTC.
  const iso = value.includes('T') || value.length === 10 ? value : value.replace(' ', 'T')
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) || iso.length === 10 ? iso : `${iso}Z`
  const ms = Date.parse(zoned)
  if (!Number.isFinite(ms)) bad(`${name} ${TIME_HELP}`)
  return ms
}

export function stepFor(rangeMs: number): number {
  if (rangeMs <= 3600_000) return 60
  if (rangeMs <= 6 * 3600_000) return 300
  if (rangeMs <= 24 * 3600_000) return 900
  if (rangeMs <= 30 * 86_400_000) return 3600
  return 21600
}

/** `step`: seconds (900) or 1m, 5m, 15m, 1h, 1d; a whole number of minutes, at most 2000 buckets. */
export function parseStep(q: QueryString, rangeMs: number): number | undefined {
  const value = optString(q, 'step', 12)?.toLowerCase()
  if (value === undefined) return undefined
  const m = STEP.exec(value)
  if (!m) bad('step must be seconds (900) or a duration like 1m, 5m, 15m, 1h, 1d')
  const seconds = Number(m[1]) * (m[2] ? UNIT_MS[m[2]] / 1000 : 1)
  if (seconds < 60 || seconds % 60 !== 0) bad('step must be a whole number of minutes (at least 60 seconds)')
  if (rangeMs / (seconds * 1000) > MAX_BUCKETS) bad(`step is too small for this range (at most ${MAX_BUCKETS} buckets)`)
  return seconds
}

/** env, service, role, from, to (default now-1h .. now), step. */
export function parseCommon(q: QueryString, nowMs = Date.now()): Common {
  const fromRaw = optString(q, 'from', 40) ?? 'now-1h'
  const toRaw = optString(q, 'to', 40) ?? 'now'
  const fromMs = parseTime('from', fromRaw, nowMs)
  const toMs = parseTime('to', toRaw, nowMs)
  if (fromMs >= toMs) bad('from must be earlier than to')
  if (toMs - fromMs > MAX_RANGE_MS) bad('the time range may be at most 90 days')
  return {
    env: optName(q, 'env'),
    service: optName(q, 'service'),
    role: optName(q, 'role'),
    fromMs,
    toMs,
    stepSeconds: parseStep(q, toMs - fromMs) ?? stepFor(toMs - fromMs),
    originMs: Math.floor(fromMs / 60_000) * 60_000,
  }
}

/** A comma list of allowed values (lower case), e.g. sample=errors,slow. */
export function optList<T extends string>(q: QueryString, name: string, allowed: readonly T[]): T[] | undefined {
  const value = optString(q, name, 128)
  if (value === undefined) return undefined
  const items = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const wrong = items.filter((i) => !(allowed as readonly string[]).includes(i))
  if (wrong.length) bad(`${name} has unknown value(s) ${wrong.join(', ')}; use a comma list of ${allowed.join(', ')}`)
  return items.length ? ([...new Set(items)] as T[]) : undefined
}

/** A comma list of log levels, e.g. warn,error. */
export function parseLevels(q: QueryString): Level[] | undefined {
  const value = optString(q, 'level', 64)
  if (value === undefined) return undefined
  const levels = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const wrong = levels.filter((l) => !(LEVELS as readonly string[]).includes(l))
  if (wrong.length) bad(`level has unknown value(s) ${wrong.join(', ')}; use a comma list of ${LEVELS.join(', ')}`)
  return levels.length ? (levels as Level[]) : undefined
}

/** A full trace id (32 hex) or its first 4–31 hex characters, lower-cased. */
export function parseTraceIdPrefix(value: string, name = 'traceId'): { exact?: string; prefix?: string } {
  const id = value.trim().toLowerCase()
  if (/^[0-9a-f]{32}$/.test(id)) return { exact: id }
  if (/^[0-9a-f]{4,31}$/.test(id)) return { prefix: id }
  return bad(`${name} must be a trace id (32 hexadecimal characters) or its first 4 or more characters`)
}

/** 32 lower-case hex characters (W3C / OTel trace id). */
export function parseTraceId(value: string | undefined, name = 'traceId'): string {
  const id = value?.trim().toLowerCase() ?? ''
  if (!/^[0-9a-f]{32}$/.test(id)) bad(`${name} must be 32 hexadecimal characters`)
  return id
}

/** 16 lower-case hex characters (W3C / OTel span id). */
export function parseSpanId(value: string | undefined, name = 'spanId'): string {
  const id = value?.trim().toLowerCase() ?? ''
  if (!/^[0-9a-f]{16}$/.test(id)) bad(`${name} must be 16 hexadecimal characters`)
  return id
}

/** Error-group fingerprint: a UInt64 written as a decimal string. */
export function parseFingerprint(value: string | undefined): bigint {
  const raw = value?.trim() ?? ''
  if (!/^\d{1,20}$/.test(raw)) bad('fingerprint must be a decimal UInt64, as returned by /api/errors')
  const fp = BigInt(raw)
  if (fp === 0n || fp > 18446744073709551615n) bad('fingerprint must be a decimal UInt64 between 1 and 2^64-1')
  return fp
}
