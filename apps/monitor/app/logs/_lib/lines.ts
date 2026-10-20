/**
 * /logs only: how one log line reads on this screen (chips, terminal copy, raw JSON; the title is lib/readable.ts
 * logTitle), its stable id for
 * `?drawer=<id>`, and the dependency outages drawn on the histogram. Pure: server and client.
 */
import { fmtDuration, fmtTimeMs, fmtTimeSec } from '@/lib/format'
import { type Kv, LEVEL_SHORT, actualError, logDetail, logKvs, logTitle, moduleName, systemLabel } from '@/lib/readable'
import type { LogRow } from '@/lib/types'

// ---------- title ----------

/** Rows whose title is an error hint (bold) and rows with something to expand. */
export const isHintLine = (row: LogRow) => !!row.error?.hint
export const hasErrorDetail = (row: LogRow) => !!(logDetail(row) || actualError(row.error))

/** `.tag` after the title for job lines: the queue system. */
export function moduleLabel(row: LogRow): string {
  if (!row.job && !/^(job|message|consumer)\./.test(row.eventCode)) return ''
  return moduleName(row.eventModule)
}

// ---------- chips ----------

/** `fields["dependency.affects"]` is a JSON array as text. */
export function affectsOf(row: LogRow): string[] {
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
 * The fixed chip order of lib/readable.ts `logKvs`; duration only on error lines (the duration column shows it
 * for the rest), plus the dependency chips of the design (target host:port, affects, retry, reason).
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

/** Duration column text, or '' (shown as a muted dash). */
export const durationText = (row: LogRow) => (row.durationMs === null ? '' : fmtDuration(row.durationMs))

// ---------- line id (?drawer=) ----------

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
 * engine order). The time in it lets the page fetch a line that is not on the current page.
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

/** Id of one line outside a page (no `-2` suffix): `<epoch ms>-<hash>`, as withLineIds gives the first of a kind. */
export const lineId = (row: LogRow) => `${Date.parse(row.timestamp)}-${lineHash(row)}`

export function parseLineId(id: string | undefined): { ms: number } | null {
  const m = id ? /^(\d{12,14})-[0-9a-z]{1,8}(-\d{1,3})?$/.exec(id) : null
  return m ? { ms: Number(m[1]) } : null
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
  const detail = logDetail(row)
  if (detail) lines.push(`${label('error detail:')}${detail}`)
  const actual = actualError(row.error)
  if (actual) lines.push(`${label('actual error:')}${actual}`)
  if (row.traceId) lines.push(`${label('trace id:')}${row.traceId}`)
  return lines.join('\n')
}

/**
 * The error line behind a failed `http.request` line (5xx / ERR, no error group of its own): the first line of the
 * same trace with an error group, same service + role first, with this request's method, route, status and
 * duration joined in like /api/logs does. null for any other line or when the trace has no such line.
 */
export function requestCause(row: LogRow, traceLogs: readonly LogRow[]): LogRow | null {
  if (row.eventCode !== 'http.request' || row.fingerprint) return null
  const status = row.httpStatus ?? row.http?.status ?? 0
  if (status < 500 && row.level !== 'error' && row.level !== 'fatal') return null
  const pool = traceLogs.filter((l) => l.fingerprint && l.eventCode !== 'http.request').sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const bad = (l: LogRow) => l.level === 'error' || l.level === 'fatal'
  const same = (l: LogRow) => l.service === row.service && l.role === row.role
  const hit = pool.find((l) => same(l) && bad(l)) ?? pool.find(same) ?? pool.find(bad) ?? null
  if (!hit || !same(hit) || !row.http) return hit
  const h = hit.http && (hit.http.method || hit.http.route) ? { ...hit.http, status: hit.http.status || status } : { ...row.http, status }
  return {
    ...hit,
    http: h,
    httpStatus: hit.httpStatus ?? (status || null),
    durationMs: hit.durationMs ?? row.durationMs,
    requestDurationMs: hit.requestDurationMs ?? row.durationMs,
  }
}

/** `error_cause` JSON (`{"type":"Error","message":"connect ECONNREFUSED …","code":"ECONNREFUSED"}`) as `Error [ECONNREFUSED] connect ECONNREFUSED …`; other text as is. */
export function causeText(cause: string | undefined | null): string {
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

/**
 * Context line of an expanded job line (logs.html): `งาน report:generate #88412 · ครั้งที่ 2/3 · จะลองใหม่
 * (ครั้งที่ 3/3 สำเร็จ 14:13:15)`. The outcome of later attempts comes from the other lines on the page.
 */
export function jobContext(row: LogRow, others: readonly LogRow[]): string {
  const j = row.job
  if (!j) return ''
  const name = `งาน ${j.type || j.queue}${j.id ? ` #${j.id}` : ''}`
  const attempt = j.attempt ? `ครั้งที่ ${j.attempt}/${j.maxAttempts || '?'}` : ''
  const now =
    row.eventCode === 'job.retry' ? 'จะลองใหม่' : row.eventCode === 'job.failed' ? (j.final || (j.maxAttempts && j.attempt >= j.maxAttempts) ? 'ล้มเหลว ไม่ลองใหม่แล้ว' : 'ล้มเหลว') : row.eventCode === 'job.finished' ? 'สำเร็จ' : ''
  const later = j.id
    ? others.filter((l) => l.job?.id === j.id && l.job.queue === j.queue && l.job.attempt > j.attempt && /^job\.(finished|failed)$/.test(l.eventCode))
    : []
  const last = later.reduce<LogRow | null>((a, b) => (!a || b.job!.attempt > a.job!.attempt ? b : a), null)
  const after = last ? ` (ครั้งที่ ${last.job!.attempt}/${last.job!.maxAttempts || '?'} ${last.eventCode === 'job.finished' ? 'สำเร็จ' : 'ล้มเหลว'} ${fmtTimeSec(last.timestamp)})` : ''
  return [name, attempt, `${now}${after}`].filter(Boolean).join(' · ')
}

/** Was http.status / durationMs of this line filled from the http.request line of its trace (engine join)? */
export function statusFromRequest(row: LogRow): boolean {
  const outbound = !!row.http?.domain || row.eventCode === 'http.outbound_failed'
  return !!row.fingerprint && row.eventCode !== 'http.request' && !outbound && row.httpStatus !== null && !!row.http
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
    put('error.hint_detail', e.hintDetail)
    put('error.fix', e.fix)
  }
  return r
}

// ---------- stack ----------

export interface Frame {
  text: string
  app: boolean
  /** Location part (file:line:col) when the frame has one. */
  loc?: { before: string; loc: string; after: string }
}

/** Shorter paths for reading: …/node_modules/x → node_modules/x, …/dist/src/x.js → src/x.js, …/packages/x → packages/x. */
function shortPath(p: string): string {
  const nm = p.lastIndexOf('/node_modules/')
  if (nm >= 0) return p.slice(nm + 1)
  const src = p.indexOf('/dist/src/')
  if (src >= 0) return p.slice(src + 6)
  const pkg = p.search(/\/(packages|apps)\//)
  if (pkg >= 0) return p.slice(pkg + 1)
  const s = p.indexOf('/src/')
  return s >= 0 ? p.slice(s + 1) : p
}

/** Head line + frames of an error_stack; app frames = not node_modules and not node: internals. */
export function parseStack(stack: string): { head: string; frames: Frame[] } {
  const lines = stack.split('\n').filter((l) => l.trim())
  const head = lines[0] ?? ''
  const frames = lines.slice(1).map((raw) => {
    const app = !/node_modules|\(node:|at node:|\/packages\/logging\//.test(raw)
    const paren = /^(.*\()([^()]+)(\)\s*)$/.exec(raw)
    const bare = paren ? null : /^(\s*at (?:async )?)(\/\S+)$/.exec(raw)
    const text = raw.replace(/\/[^\s():]+/g, (p) => shortPath(p))
    if (paren) return { text, app, loc: { before: paren[1], loc: shortPath(paren[2]), after: paren[3] } }
    if (bare) return { text, app, loc: { before: bare[1], loc: shortPath(bare[2]), after: '' } }
    return { text, app }
  })
  return { head, frames }
}

// ---------- outages on the histogram ----------

export interface Outage {
  from: number
  /** null while still down at the end of the range. */
  to: number | null
  label: string
  /** `<dependency type>|<name or host>` (outageOf matches a line to it). */
  key: string
}

/** The outage a dependency.* line belongs to (same dependency, its time inside the window, 1 s slack). */
export function outageOf(row: LogRow, outages: readonly Outage[]): Outage | null {
  if (!row.dependency || !row.eventCode.startsWith('dependency.')) return null
  const key = `${row.dependency.type}|${row.dependency.name || row.dependency.host}`
  const t = Date.parse(row.timestamp)
  return outages.find((o) => o.key === key && t >= o.from - 1000 && (o.to === null || t <= o.to + 1000)) ?? null
}

/**
 * Dependency outages in the range from /api/dependencies events: a down (or still_down) line opens one per
 * dependency type + name (all roles together), the next up line closes it.
 */
export function outagesOf(events: LogRow[], fromMs: number): Outage[] {
  const sorted = events.filter((e) => e.eventCode.startsWith('dependency.') && e.dependency).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const open = new Map<string, number>()
  const out: Outage[] = []
  const label = (e: LogRow) => `${systemLabel(e.dependency!.type)} "${e.dependency!.name || e.dependency!.host}" down`
  const labels = new Map<string, string>()
  for (const e of sorted) {
    const key = `${e.dependency!.type}|${e.dependency!.name || e.dependency!.host}`
    const t = Date.parse(e.timestamp)
    labels.set(key, label(e))
    if (e.eventCode === 'dependency.down' || e.eventCode === 'dependency.still_down') {
      if (!open.has(key)) open.set(key, e.eventCode === 'dependency.down' ? t : fromMs)
    } else if (e.eventCode === 'dependency.up') {
      const start = open.get(key) ?? (e.reason === 'recovered' && !out.some((o) => o.label.startsWith(label(e)) && o.to !== null && t - o.to < 60_000) ? fromMs : undefined)
      if (start === undefined) continue
      open.delete(key)
      out.push({ from: start, to: t, label: `${label(e)} ${fmtDuration(t - start)}`, key })
    }
  }
  for (const [key, start] of open) out.push({ from: start, to: null, label: labels.get(key) ?? key, key })
  return out
}

