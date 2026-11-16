/**
 * /logs only: what one log line says besides its title (key=value, the request it was written in), its stable id in
 * the console, the terminal copy and raw JSON of it, and the dependency outages of the range (separators and the
 * minute strip). The title is lib/readable.ts logTitle. Pure: server and client.
 */
import { fmtTimeMs } from '@/lib/format'
import { type Kv, LEVEL_SHORT, actualError, logKvs, logTitle, systemLabel } from '@/lib/readable'
import type { LogRow } from '@/lib/types'

// ---------- key=value ----------

/** `fields["dependency.affects"]` is a JSON array as text. */
function affectsOf(row: LogRow): string[] {
  const raw = row.fields['dependency.affects']
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.map(String) : [String(v)]
  } catch {
    return [raw]
  }
}

/**
 * The fixed key order of lib/readable.ts `logKvs`; duration only on error lines (the line shows it apart for the
 * rest), plus the dependency keys of the design (target host:port, affects, retry, reason).
 */
export function lineKvs(row: LogRow): Kv[] {
  const kvs = logKvs(row).filter((kv) => kv.k !== 'duration' || !!row.error)
  if (row.dependency && row.eventCode.startsWith('dependency.')) {
    const d = row.dependency
    const extra: Kv[] = []
    if (!kvs.some((kv) => kv.k === 'target') && (d.host || d.name)) extra.push({ k: 'target', v: d.host ? `${d.host}${d.port ? `:${d.port}` : ''}` : d.name })
    const affects = affectsOf(row)
    if (affects.length) extra.push({ k: 'affects', v: affects.join(', ') })
    const attempt = row.fields['dependency.attempt']
    if (attempt && row.eventCode !== 'dependency.down') extra.push({ k: 'retry', v: attempt })
    if (row.reason) extra.push({ k: 'reason', v: row.reason })
    const at = kvs.findIndex((kv) => kv.k === 'duration')
    kvs.splice(at < 0 ? kvs.length : at, 0, ...extra)
  }
  return kvs
}

/**
 * A route that matches every path (Express 5 `/{*path}`, `*`, `(.*)`): the request ended in a middleware (auth
 * answering 401) before a controller, so no template is known (engine rows.ts isCatchAllRoute).
 */
const isCatchAll = (route: string): boolean => /\{\*|\(\.\*\)|(^|\/)\*$/.test(route)

/**
 * Context of a line: `GET /classes/:id` of the request it was written in (its own http, else the engine's
 * requestRoute; the real path when the route is a catch-all), `type · queue` of a job line, else ''.
 */
export function routeText(row: LogRow): string {
  const h = row.http
  // an outbound call (http.domain) is not the request the line was written in
  if (h && !h.domain && (h.route || h.path)) return `${h.method} ${h.route && !isCatchAll(h.route) ? h.route : h.path || h.route}`.trim()
  if (row.job) return row.job.type && row.job.queue ? `${row.job.type} · ${row.job.queue}` : row.job.type || row.job.queue
  return row.requestRoute ?? ''
}

// ---------- line id ----------

/** FNV-1a 32 bit, base 36. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const lineHash = (row: LogRow) => hash([row.env, row.service, row.role, row.spanId, row.eventCode, row.level, row.message].join('\u0001'))

/**
 * Stable id of a line: `<epoch ms>-<hash>` (`-2`, `-3` … for identical lines in the same millisecond, in
 * engine order), so the same line from two engine answers gets the same id.
 */
export function withLineIds(rows: LogRow[]): Array<{ id: string; row: LogRow }> {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = `${Date.parse(row.timestamp)}-${lineHash(row)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return { id: n > 1 ? `${base}-${n}` : base, row }
  })
}

// ---------- copies ----------

/** Line of the SDK pretty format (LOG_PRETTY=true), for "คัดลอกแบบ terminal". No user id (PII rule). */
export function prettyText(row: LogRow): string {
  const svc = row.role ? `${row.service}/${row.role}` : row.service
  const width = row.service.length + 1 + 'persister'.length
  const { title } = logTitle(row)
  const kv = lineKvs(row)
    .map((x) => `${x.k}=${x.v}`)
    .join(' ')
  const head = `${fmtTimeMs(row.timestamp)} ${LEVEL_SHORT[row.level] ?? row.level.toUpperCase()} ${svc.padEnd(width)}  ${kv ? title.toLowerCase().padEnd(27) : title.toLowerCase()}${kv ? ` ${kv}` : ''}`
  const label = (t: string) => `    ${t.padEnd(14)}`
  const lines = [head.trimEnd()]
  const e = row.error
  for (const [name, value] of [
    ['error code:', e?.code],
    ['error detail:', e?.detail],
    ['how to fix:', e?.howToFix],
  ] as const) {
    if (value) lines.push(`${label(name)}${value}`)
  }
  if (e?.message) lines.push(`${label('actual error:')}${e.type || 'Error'}: ${e.message.replace(/\s*\n\s*/g, ' ')}`)
  if (row.traceId) lines.push(`${label('trace id:')}${row.traceId}`)
  return lines.join('\n')
}

/** `error_cause` JSON (`{"type":"Error","message":"connect ECONNREFUSED …","code":"ECONNREFUSED"}`) as `Error [ECONNREFUSED] connect ECONNREFUSED …`; other text as is. */
function causeText(cause: string | undefined | null): string {
  if (!cause) return ''
  if (!/^\s*\{/.test(cause)) return cause
  try {
    const c = JSON.parse(cause) as { type?: unknown; name?: unknown; code?: unknown; message?: unknown }
    const type = String(c.type ?? c.name ?? '')
    const code = c.code ? `[${String(c.code)}]` : ''
    const text = [type, code, c.message ? String(c.message) : ''].filter(Boolean).join(' ')
    return text || cause
  } catch {
    return cause
  }
}

/** "error จริง" of a line; when the error has no message of its own, its cause says what happened (AggregateError of a refused connection). */
export function actualText(row: LogRow): string {
  const base = actualError(row.error)
  const cause = row.error && !row.error.message ? causeText(row.error.cause) : ''
  return cause ? `${base ? `${base} · ` : ''}cause: ${cause}` : base
}

/** Parse JSON-looking field values back (arrays, objects, numbers, booleans); else the text. */
function fieldValue(v: string): unknown {
  if (!/^[[{]|^-?\d+(\.\d+)?$|^(true|false)$/.test(v)) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Was http.status / durationMs of this line filled from the http.request line of its trace (engine join)? */
function statusFromRequest(row: LogRow): boolean {
  const outbound = !!row.http?.domain || row.eventCode === 'http.outbound_failed'
  return !!row.fingerprint && row.eventCode !== 'http.request' && !outbound && row.httpStatus !== null && !!row.http
}

/**
 * The ECS record as skilllane-monitoring wrote it, rebuilt from the columns + labels + fields (key order and some
 * types may differ from the original line; values the engine joined in from the request line are left out).
 */
export function rawRecord(row: LogRow): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '' || v === 0 || (Array.isArray(v) && !v.length)) return
    r[k] = v
  }
  const joined = statusFromRequest(row)
  const e = row.error
  put('@timestamp', row.timestamp)
  put('log.level', row.level)
  put('service.name', row.role ? `${row.service}/${row.role}` : row.service)
  put('service.version', row.version)
  put('service.environment', row.env)
  put('log.logger', row.logger)
  put('event.code', row.eventCode)
  put('event.module', row.eventModule)
  put('message', row.message)
  put('trace.id', row.traceId)
  put('span.id', row.spanId)
  put('user.id', row.userId)
  put('user.roles', row.userRoles)
  put('organization.id', row.organizationId)
  put('host.name', row.host)
  if (!joined) put('duration_ms', row.durationMs)
  if (e) {
    put('error.type', e.type)
    put('error.message', e.message)
    put('error.code', e.code)
    put('error.stack_trace', e.stack)
    put('log.origin.function', e.originFunction)
    put('log.origin.file.name', e.originFile)
    put('error.cause', e.cause ? fieldValue(e.cause) : '')
  }
  const labels: Record<string, string> = { ...row.labels }
  if (row.usecase) labels.usecase = row.usecase
  if (row.failedStep) labels.failed_step = row.failedStep
  if (e?.category) labels.error_category = e.category
  if (e?.target) labels.error_target = e.target
  if (Object.keys(labels).length) r.labels = labels
  if (row.http) {
    put('http.request.method', row.http.method)
    put('http.route', row.http.route)
    put('url.path', row.http.path)
    put('url.domain', row.http.domain)
    if (!joined) put('http.response.status_code', row.http.status)
  }
  put('db.statement', row.dbStatement)
  if (row.dependency) {
    put('dependency.type', row.dependency.type)
    put('dependency.name', row.dependency.name)
    put('dependency.host', row.dependency.host)
    put('dependency.port', row.dependency.port)
  }
  if (row.job) {
    put('job.queue', row.job.queue)
    put('job.type', row.job.type)
    put('job.id', row.job.id)
    put('job.attempt', row.job.attempt)
    put('job.max_attempts', row.job.maxAttempts)
    if (row.job.final) r['job.final'] = true
    put('job.inflight', row.job.inflight)
  }
  put('reason', row.reason)
  for (const [k, v] of Object.entries(row.fields)) put(k, fieldValue(v))
  if (e) {
    put('error.hint', e.hint)
    put('error.detail', e.detail)
    put('error.how_to_fix', e.howToFix)
  }
  return r
}

// ---------- dependency outages ----------

export interface Outage {
  from: number
  /** null while still down at the end of the range. */
  to: number | null
  /** `Redis "cache"`. */
  dep: string
  /** `<dependency type>|<name or host>`. */
  key: string
  /** service/role of the processes that reported it. */
  sources: string[]
}

/**
 * Dependency outages in the range from /api/dependencies events: a down (or still_down) line opens one per
 * dependency type + name (all roles together), the next up line closes it.
 */
export function outagesOf(events: LogRow[], fromMs: number): Outage[] {
  const sorted = events.filter((e) => e.eventCode.startsWith('dependency.') && e.dependency).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const open = new Map<string, { from: number; sources: Set<string> }>()
  const out: Outage[] = []
  const depOf = (e: LogRow) => `${systemLabel(e.dependency!.type)} "${e.dependency!.name || e.dependency!.host}"`
  const deps = new Map<string, string>()
  for (const e of sorted) {
    const key = `${e.dependency!.type}|${e.dependency!.name || e.dependency!.host}`
    const t = Date.parse(e.timestamp)
    const src = e.role ? `${e.service}/${e.role}` : e.service
    deps.set(key, depOf(e))
    if (e.eventCode === 'dependency.down' || e.eventCode === 'dependency.still_down') {
      const o = open.get(key)
      if (o) o.sources.add(src)
      else open.set(key, { from: e.eventCode === 'dependency.down' ? t : fromMs, sources: new Set([src]) })
    } else if (e.eventCode === 'dependency.up') {
      const o = open.get(key)
      // an up line with no down in the range: the outage started before it, unless another one just closed
      const start = o?.from ?? (e.reason === 'recovered' && !out.some((x) => x.key === key && x.to !== null && t - x.to < 60_000) ? fromMs : undefined)
      if (start === undefined) {
        out.find((x) => x.key === key && x.to !== null && t - x.to < 60_000)?.sources.push(src)
        continue
      }
      open.delete(key)
      out.push({ from: start, to: t, dep: depOf(e), key, sources: [...new Set([...(o?.sources ?? []), src])] })
    }
  }
  for (const [key, o] of open) out.push({ from: o.from, to: null, dep: deps.get(key) ?? key, key, sources: [...o.sources] })
  return out
}

