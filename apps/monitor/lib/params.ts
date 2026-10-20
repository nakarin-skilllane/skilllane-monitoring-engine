/**
 * URL search params: parse and validate (same rules as apps/engine/src/query/params.ts,
 * so a bad value is caught here with a Thai-readable problem instead of an engine 400),
 * defaults per screen, and hrefs that keep env / from / to. Pure: server and client.
 *
 * Page:   const sp = await searchParams
 *         const scope = parseScope(sp, 'logs', { envs: meta?.envs })
 *         const p = new Params(sp); const level = p.levels(); const q = p.str('q')
 *         engine.logs({ ...scopeQuery(scope), level: level?.join(','), q })
 * Link:   buildHref('/traces', scope.keep, { route: 'GET /me' })
 */
import { fmtRange, fmtRangeShort } from './format'
import { type Level, LEVELS, type CommonQuery } from './types'
import { type QueryInput, type QueryValue, toSearch } from './url'

/** `searchParams` of a page, after `await`. */
export type RawSearchParams = Record<string, string | string[] | undefined>
export type SearchInput = RawSearchParams | URLSearchParams | ReadonlyURLSearchParamsLike

/** What `useSearchParams()` returns (ReadonlyURLSearchParams). */
export interface ReadonlyURLSearchParamsLike {
  get(name: string): string | null
  getAll(name: string): string[]
  toString(): string
}

// ---------- screens ----------

export type Screen = 'overview' | 'logs' | 'traces' | 'trace' | 'errors' | 'error' | 'jobs'

export const RANGE_PRESETS = [
  { value: 'now-15m', label: '15 นาทีล่าสุด', ms: 15 * 60_000 },
  { value: 'now-1h', label: '1 ชั่วโมงล่าสุด', ms: 3600_000 },
  { value: 'now-6h', label: '6 ชั่วโมงล่าสุด', ms: 6 * 3600_000 },
  { value: 'now-24h', label: '24 ชั่วโมงล่าสุด', ms: 24 * 3600_000 },
  { value: 'now-7d', label: '7 วันล่าสุด', ms: 7 * 86_400_000 },
] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]['value']

export interface ScreenInfo {
  /** Base path; detail screens live under it. */
  path: string
  /** Thai nav label / crumb. */
  label: string
  /** Range when the URL has no `from`. */
  defaultFrom: RangePreset
}

export const SCREENS: Record<Screen, ScreenInfo> = {
  overview: { path: '/overview', label: 'ภาพรวม', defaultFrom: 'now-1h' },
  logs: { path: '/logs', label: 'Log', defaultFrom: 'now-1h' },
  traces: { path: '/traces', label: 'Trace', defaultFrom: 'now-1h' },
  trace: { path: '/traces', label: 'Trace', defaultFrom: 'now-1h' },
  errors: { path: '/errors', label: 'Error', defaultFrom: 'now-24h' },
  error: { path: '/errors', label: 'Error', defaultFrom: 'now-24h' },
  jobs: { path: '/jobs', label: 'งานเบื้องหลัง', defaultFrom: 'now-24h' },
}

/** /traces/abc → 'trace', /errors → 'errors' …; null outside the screens. */
export function screenFromPath(pathname: string | null | undefined): Screen | null {
  const parts = (pathname ?? '').split('/').filter(Boolean)
  switch (parts[0]) {
    case 'overview':
      return 'overview'
    case 'logs':
      return 'logs'
    case 'traces':
      return parts.length > 1 ? 'trace' : 'traces'
    case 'errors':
      return parts.length > 1 ? 'error' : 'errors'
    case 'jobs':
      return 'jobs'
    default:
      return null
  }
}

// ---------- reading values ----------

/** First value of a param, trimmed; '' and missing → undefined. */
export function get(sp: SearchInput | undefined, key: string): string | undefined {
  if (!sp) return undefined
  let raw: string | null | undefined
  if (typeof (sp as URLSearchParams).get === 'function') raw = (sp as URLSearchParams).get(key)
  else {
    const v = (sp as RawSearchParams)[key]
    raw = Array.isArray(v) ? v[0] : v
  }
  const t = raw?.trim()
  return t ? t : undefined
}

/** A plain object copy of the params (first value of each). */
export function toRecord(sp: SearchInput | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!sp) return out
  if (typeof (sp as URLSearchParams).get === 'function') {
    new URLSearchParams(sp.toString()).forEach((v, k) => {
      if (!(k in out)) out[k] = v
    })
  } else {
    for (const [k, v] of Object.entries(sp as RawSearchParams)) {
      const first = Array.isArray(v) ? v[0] : v
      if (first !== undefined) out[k] = first
    }
  }
  return out
}

export interface ParamProblem {
  name: string
  value: string
  /** Thai, shown in a callout: "ค่า from ใน URL ไม่ถูกต้อง …". */
  message: string
}

const NAME = /^[\w.:/@-]{1,128}$/
const RELATIVE = /^now(?:-(\d{1,4})([smhdw]))?$/
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 604_800_000 }
const MAX_RANGE_MS = 90 * 86_400_000
const TRACE_ID = /^[0-9a-f]{32}$/i
const TRACE_PREFIX = /^[0-9a-f]{4,32}$/i
/** Event code (`job.failed`) or prefix (`job.*`), as the engine's `event` param. */
const EVENT = /^[a-z0-9_.]+(\.\*|\*)?$/i
const EVENT_CODE = /^[a-z0-9_.]+$/i
const STEP = /^(\d{1,7})([smhd])?$/
const MAX_BUCKETS = 2000
const FINGERPRINT = /^\d{1,20}$/

export const isTraceId = (s: string | undefined): boolean => !!s && TRACE_ID.test(s.trim())
export const isFingerprint = (s: string | undefined): boolean =>
  !!s && FINGERPRINT.test(s.trim()) && BigInt(s.trim()) > 0n && BigInt(s.trim()) <= 18446744073709551615n

/** `now`, `now-15m` … or ISO (a time without a zone is UTC, like the engine) → ms; null when invalid. */
export function resolveTime(value: string, nowMs: number): number | null {
  const rel = RELATIVE.exec(value)
  if (rel) return rel[1] ? nowMs - Number(rel[1]) * UNIT_MS[rel[2]] : nowMs
  if (!ISO.test(value)) return null
  const iso = value.includes('T') || value.length === 10 ? value : value.replace(' ', 'T')
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) || iso.length === 10 ? iso : `${iso}Z`
  const ms = Date.parse(zoned)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Typed reads of screen-specific params; every invalid value is skipped (undefined)
 * and recorded in `problems`, so the page can say so instead of sending it to the engine.
 */
export class Params {
  readonly problems: ParamProblem[] = []

  constructor(private readonly sp: SearchInput | undefined) {}

  private bad(name: string, value: string, message: string): undefined {
    this.problems.push({ name, value, message })
    return undefined
  }

  /** Free text (q, route …), at most `max` characters. */
  str(name: string, max = 200): string | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    return v.length > max ? this.bad(name, v, `ค่า ${name} ยาวเกิน ${max} ตัวอักษร`) : v
  }

  /** Identifier-like (env, service, role, category …): letters, digits and . _ - : / @. */
  name(name: string): string | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    return NAME.test(v) ? v : this.bad(name, v, `ค่า ${name} ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ - : / @`)
  }

  int(name: string, min: number, max: number): number | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    const n = Number(v)
    return /^\d+$/.test(v) && n >= min && n <= max ? n : this.bad(name, v, `ค่า ${name} ต้องเป็นจำนวนเต็ม ${min}–${max}`)
  }

  number(name: string, min: number, max: number): number | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    const n = Number(v)
    return /^\d+(\.\d+)?$/.test(v) && n >= min && n <= max ? n : this.bad(name, v, `ค่า ${name} ต้องเป็นตัวเลข ${min}–${max}`)
  }

  /** One of `allowed`, matched case-insensitively and returned as spelled in `allowed` (`sort=durationms` → `durationMs`). */
  oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase())
    return hit ?? this.bad(name, v, `ค่า ${name} ต้องเป็น ${allowed.join(', ')}`)
  }

  /** Event code filter as the engine takes it: one code (`job.failed`), a prefix (`job.*`), or a comma list of codes. */
  event(name = 'event'): string | undefined {
    const v = get(this.sp, name)?.trim()
    if (v === undefined || v === '') return undefined
    const parts = v.split(',').map((x) => x.trim()).filter(Boolean)
    const ok = v.length <= 200 && parts.length > 0 && (parts.length === 1 ? EVENT.test(parts[0]) : parts.every((x) => EVENT_CODE.test(x)))
    return ok ? parts.join(',') : this.bad(name, v, 'ค่า event ต้องเป็นรหัส event เช่น job.failed หรือขึ้นต้นแบบ job.* (หลายค่าคั่นด้วย ,)')
  }

  /** Comma list of log levels (`level=warn,error`). */
  levels(name = 'level'): Level[] | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    const list = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const wrong = list.filter((l) => !(LEVELS as readonly string[]).includes(l))
    if (wrong.length) return this.bad(name, v, `ค่า ${name} ไม่รู้จัก ${wrong.join(', ')} (ใช้ ${LEVELS.join(', ')})`)
    return list.length ? (list as Level[]) : undefined
  }

  /** Comma list of free values (`category=bug,data`). */
  list(name: string): string[] | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    const list = v.split(',').map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }

  traceId(name = 'traceId'): string | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    return isTraceId(v) ? v.toLowerCase() : this.bad(name, v, `ค่า ${name} ต้องเป็นเลขฐานสิบหก 32 ตัว`)
  }

  /** A full trace id or its first 4–31 hex characters (the traces list `traceId` filter), lower-cased. */
  traceIdPrefix(name = 'traceId'): string | undefined {
    const v = get(this.sp, name)?.trim()
    if (v === undefined || v === '') return undefined
    return TRACE_PREFIX.test(v) ? v.toLowerCase() : this.bad(name, v, `ค่า ${name} ต้องเป็นเลขฐานสิบหกอย่างน้อย 4 ตัว (trace id หรือส่วนต้นของมัน)`)
  }

  /** Series bucket `step`: seconds (900) or 1m, 5m, 15m, 1h, 1d; whole minutes, at most 2000 buckets of `rangeMs`. */
  step(rangeMs: number, name = 'step'): string | undefined {
    const v = get(this.sp, name)?.toLowerCase()
    if (v === undefined) return undefined
    const m = STEP.exec(v)
    const seconds = m ? Number(m[1]) * (m[2] ? UNIT_MS[m[2]] / 1000 : 1) : 0
    if (!m || seconds < 60 || seconds % 60 !== 0) return this.bad(name, v, `ค่า ${name} ต้องเป็นนาทีเต็ม เช่น 1m, 5m, 15m, 1h หรือวินาที 900`)
    if (rangeMs / (seconds * 1000) > MAX_BUCKETS) return this.bad(name, v, `ค่า ${name} เล็กเกินไปสำหรับช่วงนี้ (ไม่เกิน ${MAX_BUCKETS} ช่อง)`)
    return v
  }

  fingerprint(name = 'fingerprint'): string | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    return isFingerprint(v) ? v : this.bad(name, v, `ค่า ${name} ต้องเป็นตัวเลข fingerprint จาก /api/errors`)
  }

  /** `now-1h` or ISO time, as given (the engine resolves it again). */
  time(name: string, nowMs = Date.now()): string | undefined {
    const v = get(this.sp, name)
    if (v === undefined) return undefined
    return resolveTime(v, nowMs) !== null ? v : this.bad(name, v, `ค่า ${name} ต้องเป็นเวลา ISO หรือ now, now-15m, now-1h, now-6h, now-24h, now-7d`)
  }

  /** `1`, `true`, `yes` → true; `0`, `false`, `no` → false. */
  flag(name: string): boolean | undefined {
    const v = get(this.sp, name)?.toLowerCase()
    if (v === undefined) return undefined
    if (['1', 'true', 'yes', 'on'].includes(v)) return true
    if (['0', 'false', 'no', 'off'].includes(v)) return false
    return this.bad(name, v, `ค่า ${name} ต้องเป็น 1 หรือ 0`)
  }
}

// ---------- scope: env + range (+ service, role) ----------

/** Params kept when moving between screens (only those present in the URL). */
export const KEEP_KEYS = ['env', 'from', 'to'] as const
export type Keep = Partial<Record<(typeof KEEP_KEYS)[number], string>>

/** Env shown first in the segmented control, in this order; every other env goes to the select. */
export const ENV_SEGMENTS = ['dev', 'staging', 'prod'] as const
/** `env=all` = every env (the engine gets no env). */
export const ALL_ENVS = 'all'

/** prod when the engine knows it, else every env; a user limited to some envs gets the first of them. */
export function defaultEnv(envs?: readonly string[], limited?: boolean): string | undefined {
  if (envs?.includes('prod')) return 'prod'
  return limited ? envs?.[0] : undefined
}

export interface Scope {
  screen: Screen
  /** Env sent to the engine; undefined = every env. */
  env?: string
  /** from / to as sent to the engine (relative or ISO); `to` undefined = now. */
  from: string
  to?: string
  fromMs: number
  toMs: number
  nowMs: number
  /** Preset of the range select, or custom (ISO from, or any `to`). */
  preset: RangePreset | 'custom'
  service?: string
  role?: string
  /** env / from / to exactly as in the URL, for links (see buildHref). */
  keep: Keep
  /** Invalid env / from / to / service / role (each replaced by its default). */
  problems: ParamProblem[]
}

/**
 * env, from, to, service, role of a screen. Defaults: env = prod when /api/meta
 * lists it (pass `envs`), range = the screen's defaultFrom … now.
 */
export function parseScope(
  sp: SearchInput | undefined,
  screen: Screen,
  opts: { envs?: readonly string[]; now?: number; limited?: boolean } = {},
): Scope {
  const nowMs = opts.now ?? Date.now()
  const p = new Params(sp)
  const envRaw = p.name('env')
  // An invalid env is recorded in problems and replaced by the default.
  // A user limited to some envs (Meta.envsLimited) never reads every env at once.
  const env =
    envRaw === ALL_ENVS && !opts.limited ? undefined : ((envRaw === ALL_ENVS ? undefined : envRaw) ?? defaultEnv(opts.envs, opts.limited))
  const fallbackFrom = SCREENS[screen].defaultFrom
  let from = p.time('from', nowMs) ?? fallbackFrom
  let to = p.time('to', nowMs)
  let fromMs = resolveTime(from, nowMs) as number
  let toMs = to ? (resolveTime(to, nowMs) as number) : nowMs
  if (fromMs >= toMs || toMs - fromMs > MAX_RANGE_MS) {
    p.problems.push({
      name: 'from',
      value: `${from} … ${to ?? 'now'}`,
      message: fromMs >= toMs ? 'ช่วงเวลาใน URL: from ต้องมาก่อน to' : 'ช่วงเวลาใน URL ยาวได้ไม่เกิน 90 วัน',
    })
    from = fallbackFrom
    to = undefined
    fromMs = resolveTime(from, nowMs) as number
    toMs = nowMs
  }
  const preset = !to && RANGE_PRESETS.some((r) => r.value === from) ? (from as RangePreset) : 'custom'
  return {
    screen,
    env,
    from,
    to,
    fromMs,
    toMs,
    nowMs,
    preset,
    service: p.name('service'),
    role: p.name('role'),
    keep: keepOf(sp),
    problems: p.problems,
  }
}

/** The common engine params of a scope. */
export function scopeQuery(scope: Scope): CommonQuery {
  return { env: scope.env, from: scope.from, to: scope.to, service: scope.service, role: scope.role }
}

/** `1 ชั่วโมงล่าสุด` or `กำหนดเอง`. */
export function rangeLabel(scope: Pick<Scope, 'preset'>): string {
  return RANGE_PRESETS.find((r) => r.value === scope.preset)?.label ?? 'กำหนดเอง'
}

/**
 * "ใน" + a range label with Thai spacing: a space before a number (`ใน 24 ชั่วโมงล่าสุด`), none before a word
 * (`ในช่วงที่เลือก`, `ในช่วงนี้`).
 */
export function inRange(label: string): string {
  return /^[\d<>]/.test(label) ? `ใน ${label}` : `ใน${label}`
}

/** Top bar `.range-abs`: `17 ต.ค. 13:20–14:20 ICT`. */
export function rangeAbs(scope: Pick<Scope, 'fromMs' | 'toMs'>): string {
  return fmtRange(scope.fromMs, scope.toMs)
}

/** Page subline: `1 ชั่วโมงล่าสุด (13:20–14:20 ICT)`, custom → the absolute range. */
export function rangeText(scope: Pick<Scope, 'preset' | 'fromMs' | 'toMs' | 'nowMs'>): string {
  if (scope.preset === 'custom') return fmtRange(scope.fromMs, scope.toMs)
  return `${rangeLabel(scope)} (${fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)})`
}

// ---------- links ----------

/** env / from / to present in the URL. */
export function keepOf(sp: SearchInput | undefined): Keep {
  const keep: Keep = {}
  for (const key of KEEP_KEYS) {
    const v = get(sp, key)
    if (v !== undefined) keep[key] = v
  }
  return keep
}

/**
 * `path` + kept env/from/to + `extra` (extra wins; null/'' in extra drops a kept key).
 * A screen with another default range (Errors, Jobs: 24 h) keeps its own default
 * unless the user picked a range, because only explicit params are kept.
 */
export function buildHref(path: string, keep: Keep = {}, extra?: QueryInput): string {
  const merged: Record<string, QueryValue> = { ...keep }
  if (extra) for (const [k, v] of Object.entries(extra) as Array<[string, QueryValue]>) merged[k] = v
  return `${path}${toSearch(merged)}`
}

/** Current URL with some params changed (null/'' removes one); for filters on the same screen. */
export function withParams(pathname: string, sp: SearchInput | undefined, changes: QueryInput): string {
  const merged: Record<string, QueryValue> = toRecord(sp)
  for (const [k, v] of Object.entries(changes) as Array<[string, QueryValue]>) merged[k] = v
  return `${pathname}${toSearch(merged)}`
}

/**
 * Anchors other screens link to on /jobs: `#queues`, `#failures`, `#dependencies`, and one row per dependency
 * `#dep-<name>` (lower case, `-` for other characters; jobs adds the host when two rows share a name).
 */
export function depAnchor(nameOrType: string): string {
  return `dep-${nameOrType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'}`
}

/** Params dropped when env or range changes: cursors are only valid for one range. */
export const RANGE_BOUND_KEYS = ['before', 'cursor'] as const

/** Params dropped when a filter changes: paging (`limit` grows with "load more") starts over. */
export const PAGING_KEYS = ['before', 'cursor', 'limit'] as const

/**
 * Where the jump box goes: 32 hex → /traces/<id>; `u_…` → Log of that user;
 * anything else → Log search (`q`). Keeps env/from/to.
 */
export function jumpHref(text: string, keep: Keep): string | null {
  const q = text.trim()
  if (!q) return null
  if (isTraceId(q)) return buildHref(`/traces/${q.toLowerCase()}`, keep)
  if (/^u_[\w-]{1,120}$/.test(q)) return buildHref('/logs', keep, { userId: q })
  return buildHref('/logs', keep, { q: q.slice(0, 200) })
}

/**
 * A window with a fixed end that has passed (an ISO `to` before now: incident review). Its numbers no longer change,
 * so screens show no auto refresh, and "ล่าสุด" / "ยังเกิดอยู่" speak about the window, not about now.
 */
export function isPastWindow(scope: Pick<Scope, 'to' | 'toMs' | 'nowMs'>): boolean {
  return !!scope.to && !scope.to.startsWith('now') && scope.toMs < scope.nowMs
}
