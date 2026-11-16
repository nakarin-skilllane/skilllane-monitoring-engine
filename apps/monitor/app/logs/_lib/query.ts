/**
 * The /logs URL (pure: server and client). The console keeps every filter in the URL, so a copied link opens the
 * same view and links from other screens (`?traceId=`, `?userId=`, `?fingerprint=`, `?jobId=&route=`,
 * `?service=&role=`, `?level=`, `?event=`, `?check=`, `?pattern=`) keep working:
 *
 *   service=school-core-api/api,school-core-api/worker | all     services / roles shown (console form)
 *   service=school-core-api&role=api                                one of them (links from other screens)
 *   service=school-core-api                                         every role of that service
 *   pod=core-api-7d9f8-x2k4q,core-api-7d9f8-m81zt                   pods (hosts); none = every pod
 *   view=raw                                                        raw lines; none = Timeline (or the remembered view)
 *   level=warn,error,fatal  show=all  repeats=all                   level keys, "แสดง noise"
 *   q exclude traceId userId route job jobId event fingerprint category pattern check   the grep box (grepText / parseGrep)
 *   pick=1                                                          the service picker
 *
 * A trace filter shows the whole request: every service and every pod (the selection is kept for later).
 */
import { isFingerprint, isTraceId } from '@/lib/params'
import { LEVELS, type Level, type LogsQuery, type Meta } from '@/lib/types'

export type ConsoleView = 'timeline' | 'raw'
export const CONSOLE_VIEWS: readonly ConsoleView[] = ['timeline', 'raw']

/** One service / role the console can show (`school-core-api/api`). */
export interface Source {
  id: string
  service: string
  role: string
}

export const sourceId = (service: string, role: string): string => `${service}/${role}`

const NAME = /^[\w.:/@-]{1,128}$/
const MAX_SOURCES = 20
const MAX_PODS = 50

/** `service/role` → its parts (split at the last `/`); null when malformed. */
export function splitSource(id: string): Source | null {
  const i = id.lastIndexOf('/')
  if (i <= 0 || i === id.length - 1 || !NAME.test(id)) return null
  return { id, service: id.slice(0, i), role: id.slice(i + 1) }
}

/** Every service / role of the env in /api/meta, in the fixed service order, then by role. */
export function sourcesOf(meta: Pick<Meta, 'services'> | null, env: string | undefined, order: readonly string[]): Source[] {
  const services = (meta?.services ?? []).filter((s) => !env || s.envs.includes(env))
  const rank = (s: string) => {
    const i = order.indexOf(s)
    return i < 0 ? order.length : i
  }
  return services
    .slice()
    .sort((a, b) => rank(a.service) - rank(b.service) || a.service.localeCompare(b.service))
    .flatMap((s) => s.roles.slice().sort().map((role) => ({ id: sourceId(s.service, role), service: s.service, role })))
}

export interface Selection {
  /** Source ids in the URL (known first, then any others the URL names); empty when `all` or nothing. */
  ids: string[]
  /** `service=all`, or no service while another filter narrows the page (links from other screens). */
  all: boolean
  /** The URL names a service at all (else the remembered one or the picker). */
  given: boolean
  problems: Array<{ name: string; value: string; message: string }>
}

/** What `service` (+ `role`) of the URL selects. */
export function parseSelection(service: string | undefined, role: string | undefined, known: readonly Source[]): Selection {
  const problems: Selection['problems'] = []
  if (!service) return { ids: [], all: false, given: false, problems }
  if (service === 'all') return { ids: [], all: true, given: true, problems }
  const ids: string[] = []
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id)
  }
  for (const part of service.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!NAME.test(part)) {
      problems.push({ name: 'service', value: part, message: `ค่า service "${part}" ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ - : / @` })
      continue
    }
    if (role && !part.includes('/')) add(sourceId(part, role))
    else if (part.includes('/')) {
      const s = splitSource(part)
      if (s) add(s.id)
      else problems.push({ name: 'service', value: part, message: `ค่า service "${part}" ต้องเป็น service/role` })
    } else {
      // a bare service: every role of it (meta), else the service itself as the engine reads it
      const roles = known.filter((k) => k.service === part)
      if (roles.length) roles.forEach((k) => add(k.id))
      else add(part)
    }
  }
  const order = (id: string) => {
    const i = known.findIndex((k) => k.id === id)
    return i < 0 ? known.length : i
  }
  ids.sort((a, b) => order(a) - order(b))
  if (ids.length > MAX_SOURCES) {
    problems.push({ name: 'service', value: service, message: `เลือก service ได้ไม่เกิน ${MAX_SOURCES} ตัว` })
    ids.length = MAX_SOURCES
  }
  // every known source selected reads as "ทุก service"
  const all = known.length > 0 && known.every((k) => ids.includes(k.id)) && ids.length === known.length
  return { ids: all ? [] : ids, all, given: true, problems }
}

/** `service` param of a selection (null = every service). */
export function serviceParam(ids: readonly string[], known: readonly Source[]): string | null {
  if (!ids.length) return null
  if (known.length && known.every((k) => ids.includes(k.id)) && ids.length === known.length) return 'all'
  return ids.join(',')
}

/** `pod` param: a comma list of host names. */
export function parsePods(value: string | undefined): { pods: string[] | null; problems: Selection['problems'] } {
  const problems: Selection['problems'] = []
  if (!value) return { pods: null, problems }
  const pods: string[] = []
  for (const p of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!NAME.test(p)) problems.push({ name: 'pod', value: p, message: `ค่า pod "${p}" ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ - : / @` })
    else if (!pods.includes(p)) pods.push(p)
  }
  if (pods.length > MAX_PODS) {
    problems.push({ name: 'pod', value, message: `เลือก pod ได้ไม่เกิน ${MAX_PODS} ตัว` })
    pods.length = MAX_PODS
  }
  return { pods: pods.length ? pods : null, problems }
}

// ---------- level keys ----------

/** The four level keys: ERR stands for error and fatal. */
export const LEVEL_KEYS = ['debug', 'info', 'warn', 'error'] as const
export type LevelKey = (typeof LEVEL_KEYS)[number]
export const LEVEL_KEY_LABEL: Record<LevelKey, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }

/** Keys pressed by a `level` filter (none = every key). */
export function keysOf(levels: readonly Level[] | undefined): Set<LevelKey> {
  if (!levels?.length) return new Set(LEVEL_KEYS)
  return new Set(LEVEL_KEYS.filter((k) => levels.includes(k) || (k === 'error' && levels.includes('fatal'))))
}

/** `level` param of the pressed keys (every key = no param). */
export function levelParam(keys: ReadonlySet<LevelKey>): string | null {
  if (LEVEL_KEYS.every((k) => keys.has(k))) return null
  return LEVELS.filter((l) => keys.has(l === 'fatal' ? 'error' : (l as LevelKey))).join(',')
}

// ---------- the grep box ----------

/** Params the grep box writes (every other filter stays). */
export const GREP_PARAMS = ['q', 'exclude', 'traceId', 'userId', 'route', 'job', 'jobId', 'event', 'fingerprint', 'category', 'pattern', 'check'] as const
export type GrepParam = (typeof GREP_PARAMS)[number]
export type GrepFilters = Partial<Record<GrepParam, string>>

/**
 * `key:value` tokens of the grep box, in the order grepText writes them. `job:` is part of a job's name (`queue type
 * #id`, any case); `job:#<id>` is one job (every attempt), the `jobId` links from Jobs carry.
 */
const TOKENS: Array<[string, GrepParam]> = [
  ['trace', 'traceId'],
  ['user', 'userId'],
  ['route', 'route'],
  ['job', 'job'],
  ['event', 'event'],
  ['group', 'fingerprint'],
  ['category', 'category'],
  ['repeat', 'pattern'],
  ['check', 'check'],
]
const KEY_PARAM = new Map(TOKENS)

/** A token value as typed in the grep box: in quotes when it has a space. */
export const quoteToken = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v)

/** The grep text of the URL filters: `trace:… route:"GET /me" job:#2009 -health ORA-12899`. */
export function grepText(f: GrepFilters): string {
  const parts: string[] = []
  for (const [key, param] of TOKENS) {
    if (f[param]) parts.push(`${key}:${quoteToken(f[param]!)}`)
    if (param === 'job' && f.jobId) parts.push(`job:#${quoteToken(f.jobId)}`)
  }
  if (f.exclude) parts.push(`-${quoteToken(f.exclude)}`)
  if (f.q) parts.push(f.q)
  return parts.join(' ')
}

const EVENT = /^[a-z0-9_.]+(\.\*|\*)?$/i
const EVENT_CODE = /^[a-z0-9_.]+$/i
const ID = /^\d{1,20}$/

/**
 * Grep text → URL params (every GREP_PARAMS key, null = remove) and problems (Thai) for tokens that cannot apply.
 * Free words are one phrase (`q`: text in message, error, `METHOD /route` or path); `-word` hides lines whose
 * message has it (one); a bare 32-hex trace id or `u_…` user id is read as `trace:` / `user:`; a lone `-` (a word
 * still to type) is skipped.
 */
export function parseGrep(text: string): { params: Record<GrepParam, string | null>; problems: string[] } {
  const params = Object.fromEntries(GREP_PARAMS.map((p) => [p, null])) as Record<GrepParam, string | null>
  const problems: string[] = []
  const words: string[] = []
  const excludes: string[] = []
  for (const m of text.matchAll(/(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    const neg = m[1] === '-'
    const key = m[2]?.toLowerCase()
    const value = (m[3] ?? m[4] ?? '').trim()
    const param = key ? KEY_PARAM.get(key) : undefined
    if (key && !param) {
      // not a token of ours (`http://…`, `ORA:12`): plain text
      const raw = m[0].replace(/^-/, '')
      ;(neg ? excludes : words).push(raw.replace(/"/g, ''))
      continue
    }
    if (!value || (!key && value === '-')) continue
    if (neg) {
      excludes.push(key ? `${key}:${value}` : value)
      continue
    }
    if (param === 'job' && value.startsWith('#')) {
      const id = value.slice(1)
      if (id && id.length <= 128) params.jobId = id
      else problems.push(`job:# ต้องตามด้วย id ของ job (ได้ "${value}")`)
      continue
    }
    if (param) {
      const bad = tokenProblem(param, value)
      if (bad) problems.push(bad)
      else params[param] = param === 'traceId' ? value.toLowerCase() : value
      continue
    }
    if (isTraceId(value)) params.traceId = value.toLowerCase()
    else if (/^u_[\w-]{1,120}$/.test(value)) params.userId = value
    else words.push(value)
  }
  if (excludes.length > 1) problems.push(`ซ่อนได้ทีละคำ: ใช้ "-${excludes[excludes.length - 1]}"`)
  if (excludes.length) params.exclude = excludes[excludes.length - 1].slice(0, 200)
  if (words.length) params.q = words.join(' ').slice(0, 200)
  return { params, problems }
}

function tokenProblem(param: GrepParam, v: string): string | null {
  switch (param) {
    case 'traceId':
      return isTraceId(v) ? null : `trace: ต้องเป็น trace id 32 ตัว (ได้ "${v}")`
    case 'fingerprint':
      return isFingerprint(v) ? null : `group: ต้องเป็นเลข fingerprint ของ error group (ได้ "${v}")`
    case 'pattern':
    case 'check':
      return ID.test(v) ? null : `${param === 'pattern' ? 'repeat' : 'check'}: ต้องเป็นเลข id (ได้ "${v}")`
    case 'event': {
      const parts = v.split(',').filter(Boolean)
      const ok = parts.length === 1 ? EVENT.test(parts[0]) : parts.every((x) => EVENT_CODE.test(x))
      return ok ? null : `event: ต้องเป็นรหัส event เช่น job.failed หรือ job.* (ได้ "${v}")`
    }
    case 'category':
      return NAME.test(v) ? null : `category: ใช้ได้เฉพาะตัวอักษร (ได้ "${v}")`
    default:
      return v.length > 200 ? `${param}: ยาวเกิน 200 ตัวอักษร` : null
  }
}

/** The page shows one thing (a trace, job, group, route, user, repeat or check): every line of it is wanted. */
export function isNarrowed(f: GrepFilters): boolean {
  return !!(f.traceId || f.job || f.jobId || f.fingerprint || f.route || f.pattern || f.check || f.userId)
}

// ---------- engine query ----------

export interface ConsoleFilters extends GrepFilters {
  levels?: Level[]
  hide?: string
  collapse?: '1'
}

/**
 * /api/logs query of the console: the selected sources and pods, except under a trace filter (the whole request:
 * every service, every pod).
 */
export function engineQuery(
  base: Pick<LogsQuery, 'env' | 'from' | 'to'>,
  sel: Pick<Selection, 'ids' | 'all'>,
  pods: readonly string[] | null,
  f: ConsoleFilters,
): LogsQuery {
  const byTrace = !!f.traceId
  return {
    ...base,
    sources: byTrace || sel.all || !sel.ids.length ? undefined : sel.ids.join(','),
    host: byTrace || !pods?.length ? undefined : pods.join(','),
    level: f.levels?.join(','),
    q: f.q,
    exclude: f.exclude,
    traceId: f.traceId,
    userId: f.userId,
    route: f.route,
    job: f.job,
    jobId: f.jobId,
    event: f.event,
    fingerprint: f.fingerprint,
    category: f.category,
    pattern: f.pattern,
    check: f.check,
    hide: f.hide,
    collapse: f.collapse,
  }
}
