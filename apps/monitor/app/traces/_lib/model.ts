/**
 * Trace data shaped for the two trace screens (list + detail). Pure, server and client:
 * waterfall order (call tree by start time), the failing span, the error line of a trace with its
 * request joined in (/api/traces/:id does no join), and the Copy-for-AI Markdown (DESIGN.md §6b).
 */
import { fmtAiTime, fmtMs, fmtTimeMs, fmtTimeSec } from '@/lib/format'
import { netRowsOf } from '@/lib/io'
import { actualError, aiErrorMarkdown, aiFieldsOfLog, type AiErrorFields, logTitle, moduleName } from '@/lib/readable'
import type { JobStat, LogRow, SpanRow, TraceDetail, TraceListRow } from '@/lib/types'

/** A request at or above this is "ช้า" (jobs are never coloured slow). */
export const SLOW_MS = 2000

const LEVEL_RANK: Record<string, number> = { fatal: 4, error: 3, warn: 2, info: 1, debug: 0 }

/** ms since the epoch of an ISO time, keeping the microseconds of span start times. */
export function isoMs(iso: string): number {
  const m = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso)
  if (!m) return Date.parse(iso)
  return Date.parse(`${m[1]}${m[3] ?? 'Z'}`) + (m[2] ? Number(`0.${m[2]}`) * 1000 : 0)
}

/** `1,390` (ms offsets in the waterfall, no unit). */
export const fmtOff = (ms: number) => fmtMs(ms).replace(/ ms$/, '')

// ---------- list rows ----------

/** One entry span: a trace can have several (the request and the jobs it queued, each retry). */
export const rowKey = (r: Pick<TraceListRow, 'traceId' | 'timestamp' | 'service' | 'role' | 'name'>) => `${r.traceId}:${r.timestamp}:${r.service}/${r.role}:${r.name}`

export type Tone = 'bad' | 'slow' | 'ok'

export const isHttpRow = (r: Pick<TraceListRow, 'kind' | 'httpRoute' | 'status'>) => r.kind === 'SERVER' || r.httpRoute !== '' || r.status > 0

/**
 * bad = the entry span is ERROR / 5xx (the engine's isError, as `status=error` and totalErrors count it;
 * errorCount is trace-wide, so a caller's failure would mark every service it called); slow = a request ≥ 2 s.
 */
export function rowTone(r: TraceListRow): Tone {
  if (r.isError) return 'bad'
  if (isHttpRow(r) && r.durationMs >= SLOW_MS) return 'slow'
  return 'ok'
}

/** Job system of a non-HTTP entry (BullMQ, Kafka, cron …): the row's own job.module, else /api/overview jobs; '' when unknown. */
export function jobModule(r: Pick<TraceListRow, 'route' | 'name' | 'job'>, jobs: JobStat[]): string {
  if (r.job?.module) return moduleName(r.job.module)
  const hit = jobs.find((j) => (r.job ? j.queue === r.job.queue && j.type === r.job.type : `${j.queue} ${j.type}` === r.route))
  const mod = hit?.module ?? (r.route.startsWith('cron ') ? 'cron' : '')
  return moduleName(mod)
}

/** Name shown for a job entry: the job type (`report:generate`), else the span name without its queue. */
export function jobName(r: Pick<TraceListRow, 'route' | 'name' | 'job'>): string {
  if (r.job?.type) return r.job.type
  const i = r.name.indexOf(' ')
  return i > 0 && !/^[A-Z]+ \//.test(r.name) ? r.name.slice(i + 1) : r.name
}

/** Job status text: สำเร็จ / ล้มเหลว (+ attempt n/m). */
export function jobStatus(r: TraceListRow): { failed: boolean; attempt: string } {
  const failed = r.isError
  const attempt = r.job?.attempt ? `${r.job.attempt}/${r.job.maxAttempts || '?'}` : ''
  return { failed, attempt }
}

// ---------- waterfall ----------

export interface WfSpan {
  /** 1-based position in the waterfall (call order). */
  n: number
  span: SpanRow
  depth: number
  /** ms from the trace start. */
  start: number
  end: number
  parentN: number | null
  /** The span that failed: an exception, or ERROR with no failing span below it. */
  isError: boolean
  /** First span of another service/role than its parent (the call crossed a process). */
  hop: boolean
  /** Guide index that turns into the service rail (rows running outside the root service). */
  railAt: number | null
  /** Instrumentation shown after a short name: ioredis, http client. */
  lib: string
  childCount: number
}

export interface Waterfall {
  t0: number
  total: number
  spans: WfSpan[]
  byId: Map<string, WfSpan>
  root: WfSpan | null
}

const svcKey = (s: Pick<SpanRow, 'service' | 'role'>) => `${s.service}/${s.role}`

function libOf(s: SpanRow): string {
  if (s.kind !== 'CLIENT' && s.kind !== 'PRODUCER') return ''
  const m = /instrumentation-([\w.-]+)$/.exec(s.scope ?? '')
  if (!m) return ''
  const lib = ['http', 'undici', 'fetch'].includes(m[1]) ? 'http client' : m[1]
  return s.name.toLowerCase().includes(m[1].toLowerCase()) ? '' : lib
}

/** Spans as a call tree: children by start time, depth-first (the order calls happened). */
export function buildWaterfall(d: TraceDetail): Waterfall {
  const starts = new Map(d.spans.map((s) => [s.spanId, isoMs(s.startTime)]))
  const t0 = Math.min(isoMs(d.start), ...Array.from(starts.values()))
  const ids = new Set(d.spans.map((s) => s.spanId))
  const kids = new Map<string, SpanRow[]>()
  const roots: SpanRow[] = []
  for (const s of d.spans) {
    if (s.parentSpanId && ids.has(s.parentSpanId) && s.parentSpanId !== s.spanId) {
      const list = kids.get(s.parentSpanId) ?? []
      list.push(s)
      kids.set(s.parentSpanId, list)
    } else roots.push(s)
  }
  const byStart = (a: SpanRow, b: SpanRow) => (starts.get(a.spanId) ?? 0) - (starts.get(b.spanId) ?? 0) || b.durationMs - a.durationMs
  roots.sort(byStart)
  for (const list of kids.values()) list.sort(byStart)

  const out: WfSpan[] = []
  const rootKey = roots[0] ? svcKey(roots[0]) : ''
  const failing = new Map<string, boolean>()
  // a span with an exception failed; an ERROR span failed itself only when nothing below it failed
  const markFail = (s: SpanRow): boolean => {
    let below = false
    for (const c of kids.get(s.spanId) ?? []) below = markFail(c) || below
    const self = !!s.exception || (s.statusCode === 'ERROR' && !below)
    failing.set(s.spanId, self)
    return self || below
  }
  roots.forEach(markFail)

  const walk = (s: SpanRow, depth: number, parent: WfSpan | null, railAt: number | null) => {
    const start = (starts.get(s.spanId) ?? t0) - t0
    const hop = !!parent && svcKey(parent.span) !== svcKey(s)
    const rail = svcKey(s) === rootKey ? null : hop ? depth - 1 : railAt
    const w: WfSpan = {
      n: out.length + 1,
      span: s,
      depth,
      start,
      end: start + s.durationMs,
      parentN: parent?.n ?? null,
      isError: failing.get(s.spanId) ?? false,
      hop,
      railAt: rail,
      lib: libOf(s),
      childCount: kids.get(s.spanId)?.length ?? 0,
    }
    out.push(w)
    for (const c of kids.get(s.spanId) ?? []) walk(c, depth + 1, w, rail)
  }
  roots.forEach((r) => walk(r, 0, null, null))
  const total = Math.max(d.durationMs, ...out.map((w) => w.end), 0.001)
  return { t0, total, spans: out, byId: new Map(out.map((w) => [w.span.spanId, w])), root: out[0] ?? null }
}

/** Span label as the table and AI text print it: `GET (ioredis)`. */
export const spanLabel = (w: WfSpan) => (w.lib ? `${w.span.name} (${w.lib})` : w.span.name)

/**
 * What failed, for a status cell: the exception type, or its code when the type is the generic `Error`
 * (`Error: ORA-12899: value too large …` → `ORA-12899`), else the HTTP status or the status message.
 */
export function spanWhy(s: SpanRow): string {
  const type = s.exception?.type ?? ''
  const code = /^([A-Z][A-Z0-9]*-\d+)\b/.exec(s.exception?.message ?? '')?.[1]
  if (code && (type === 'Error' || !type)) return code
  return type || (s.http?.status ? String(s.http.status) : '') || s.statusMessage.slice(0, 40)
}

/** service/role pairs in waterfall order (`school-core-api/api` → `school-etl-api/api`). */
export function servicePath(wf: Waterfall): Array<{ service: string; role: string; version: string }> {
  const seen = new Map<string, { service: string; role: string; version: string }>()
  for (const w of wf.spans) if (!seen.has(svcKey(w.span))) seen.set(svcKey(w.span), { service: w.span.service, role: w.span.role, version: w.span.version })
  return Array.from(seen.values())
}

// ---------- the error of a trace ----------

/** The line that explains the failure: the most severe line with an error (earliest first). */
export function pickErrorLog(logs: LogRow[]): LogRow | null {
  const withError = logs.filter((l) => l.error)
  const pool = withError.length ? withError : logs.filter((l) => (LEVEL_RANK[l.level] ?? 0) >= 3 && l.eventCode !== 'http.request')
  const sorted = [...pool].sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0) || isoMs(a.timestamp) - isoMs(b.timestamp))
  return sorted[0] ?? null
}

/** A span and every span below it (one job attempt, one request). */
export function subtree(wf: Waterfall, w: WfSpan): WfSpan[] {
  return [w, ...descendants(wf, w)]
}

/**
 * The error line of one entry span of the list (a request, or one attempt of a job): picked among the lines
 * written in that span's subtree, so attempt 2/3 shows its own line (time, attempt, duration), not the trace's
 * worst one. Falls back to the whole trace when the subtree has no such line.
 */
export function pickEntryErrorLog(wf: Waterfall, logs: LogRow[], entrySpanId?: string | null): LogRow | null {
  const entry = entrySpanId ? wf.byId.get(entrySpanId) : undefined
  if (entry) {
    const ids = new Set(subtree(wf, entry).map((w) => w.span.spanId))
    const own = pickErrorLog(logs.filter((l) => l.spanId && ids.has(l.spanId)))
    if (own) return own
  }
  return pickErrorLog(logs)
}

/** `sheets.googleapis.com` of a peer `sheets.googleapis.com:443`. */
const peerHost = (peer: string) => peer.replace(/:\d+$/, '')

/** Does this span carry the failed_step name: `oracle INSERT QUESTION_BANK`, or `POST sheets.googleapis.com` = name + peer host. */
const isStep = (w: WfSpan, step: string) => w.span.name === step || (!!w.span.peer && `${w.span.name} ${peerHost(w.span.peer)}` === step)

/**
 * The span the error line names as failed_step, inside that line's own span subtree first (its own attempt of
 * a job that ran three times), failing spans before others; then anywhere in the trace. null without a match.
 */
export function stepOf(wf: Waterfall, log: LogRow | null): WfSpan | null {
  const step = log?.failedStep
  if (!step) return null
  const own = log.spanId ? wf.byId.get(log.spanId) : undefined
  const near = own ? subtree(wf, own) : []
  return (
    near.find((w) => w.isError && isStep(w, step)) ??
    near.find((w) => isStep(w, step)) ??
    wf.spans.find((w) => w.isError && isStep(w, step)) ??
    wf.spans.find((w) => isStep(w, step)) ??
    null
  )
}

/**
 * The span that failed: the one the error line names (failed_step, in the line's own subtree first), else the
 * first failing span below the line's span (then the span itself), else the first failing span of the trace.
 */
export function failedSpan(wf: Waterfall, log: LogRow | null): WfSpan | null {
  const errs = wf.spans.filter((w) => w.isError)
  const named = stepOf(wf, log)
  if (named) return named
  const own = log?.spanId ? wf.byId.get(log.spanId) : undefined
  if (own) {
    const below = descendants(wf, own).find((w) => w.isError) ?? (own.isError ? own : undefined)
    if (below) return below
  }
  return errs.find((w) => w.span.exception) ?? errs[0] ?? null
}

/**
 * The span whose Network panel opens for a span id (`?io=`, a link from a log line): the span itself when it carried
 * I/O, else the nearest span above it that did (a line written in a handler step opens its request). `failure` (the
 * line is about a failure): the failing I/O inside the span comes first, the cause before the span itself (the INSERT
 * that raised ORA-12899 under the handler, the 429 call of a job attempt). null when nothing up the tree has I/O.
 */
export function ioSpanOf(wf: Waterfall, spanId: string, failure = false): WfSpan | null {
  const own = wf.byId.get(spanId)
  if (!own) return null
  const io = new Set(netRowsOf(wf.spans).map((r) => r.id))
  if (failure) {
    const below = descendants(wf, own).filter((w) => io.has(w.span.spanId))
    const hit = below.find((w) => w.isError) ?? below.find((w) => w.span.statusCode === 'ERROR')
    if (hit) return hit
  }
  let w: WfSpan | undefined = own
  while (w && !io.has(w.span.spanId)) w = w.parentN ? wf.spans[w.parentN - 1] : undefined
  return w ?? null
}

/** Spans below `w` (depth-first order keeps them right after it). */
export function descendants(wf: Waterfall, w: WfSpan): WfSpan[] {
  const out: WfSpan[] = []
  for (let i = w.n; i < wf.spans.length && wf.spans[i].depth > w.depth; i++) out.push(wf.spans[i])
  return out
}

/** The failing span is worth naming as the failed step: a step inside the request, or the one the error line names. */
export const namedStep = (failed: WfSpan | null, log: LogRow | null): WfSpan | null => (failed && (failed.n > 1 || !!log?.failedStep) ? failed : null)

/**
 * The line with its request joined in, like /api/logs does: an error line gets the status and duration of the
 * `http.request` line of the same service + role; a plain line without http gets that request's method + route.
 */
export function withRequest(row: LogRow, logs: LogRow[]): LogRow {
  if (row.job || row.http?.domain || row.eventCode === 'http.request') return row
  const req = logs.find((l) => l.eventCode === 'http.request' && l.service === row.service && l.role === row.role && l.http)
  if (!req?.http) return row
  const isErr = !!row.error || row.fingerprint !== null
  const http = row.http
    ? { ...row.http, status: row.http.status || (isErr ? req.http.status : 0) }
    : { method: req.http.method, route: req.http.route, path: '', status: isErr ? req.http.status : 0, domain: '' }
  return {
    ...row,
    http,
    durationMs: row.durationMs ?? (isErr ? req.durationMs : null),
    httpStatus: row.httpStatus ?? (isErr ? req.http.status : null),
    requestDurationMs: row.requestDurationMs ?? (isErr ? req.durationMs : null),
  }
}

/** Later attempts of the same job in this trace: `attempt 2/3 เริ่ม 14:13:11 และสำเร็จ 14:13:15`. */
export function jobFollowUp(row: LogRow, logs: LogRow[]): { attempt: string; startedAt: string; endedAt: string; ok: boolean } | null {
  const j = row.job
  if (!j?.id) return null
  const later = logs.filter((l) => l.job?.id === j.id && l.job.queue === j.queue && l.job.attempt > j.attempt)
  if (!later.length) return null
  const last = later.reduce((a, b) => (b.job!.attempt > a.job!.attempt ? b : a))
  const n = last.job!.attempt
  const started = later.find((l) => l.job!.attempt === n && l.eventCode === 'job.started')
  const end = later.find((l) => l.job!.attempt === n && /^job\.(finished|failed|retry)$/.test(l.eventCode))
  return {
    attempt: `${n}/${last.job!.maxAttempts || '?'}`,
    startedAt: started ? started.timestamp : '',
    endedAt: end ? end.timestamp : '',
    ok: end?.eventCode === 'job.finished',
  }
}

// ---------- Copy for AI ----------

const sp = (w: WfSpan) => `${fmtOff(w.start)} → ${fmtOff(w.end)}`

/** service/role path with the root's version: `school-core-api/api 31.4.0 → school-etl-api/api`. */
function servicesLine(wf: Waterfall, withVersion: boolean): string {
  return servicePath(wf)
    .map((s, i) => `${s.service}/${s.role}${withVersion && i === 0 && s.version ? ` ${s.version}` : ''}`)
    .join(' → ')
}

function baseFields(log: LogRow | null, wf: Waterfall, d: TraceDetail, failed: WfSpan | null, moduleLabel: string): AiErrorFields {
  if (!log) {
    // no error line: describe the failing span
    const s = failed?.span ?? wf.root?.span
    return {
      hint: s?.exception?.message || s?.statusMessage || (s ? `${s.name} failed` : 'trace error'),
      code: s?.exception?.type,
      level: 'error',
      service: s?.service,
      role: s?.role,
      version: s?.version,
      env: d.env,
      when: s ? fmtAiTime(isoMs(s.startTime)) : undefined,
      error: s?.exception ? actualError({ type: s.exception.type, message: s.exception.message }) : undefined,
      traceId: d.traceId,
    }
  }
  const f = aiFieldsOfLog(log)
  f.stack = undefined
  f.fingerprint = undefined
  // a job line without event_module: the queue system the overview's job stats name
  if (log.job && f.job && moduleLabel && !log.eventModule) f.job = f.job.replace(/^\S+ queue/, `${moduleLabel} queue`)
  // §6b (traces.html ai-trace-c): `… attempt 2/3 → retry in 10,040 ms (attempt 3/3 finished OK at 14:13:15)`
  if (log.job && f.job) {
    if (log.durationMs !== null && / → (retry|failed)$/.test(f.job)) f.job += ` in ${fmtMs(log.durationMs)}`
    const next = jobFollowUp(log, d.logs)
    if (next?.endedAt) f.job += ` (attempt ${next.attempt} ${next.ok ? 'finished OK' : 'failed'} at ${fmtTimeSec(next.endedAt)})`
  }
  return f
}

/** The Markdown of one trace row in the list (expanded error). */
export function aiListMarkdown(opts: { log: LogRow | null; wf: Waterfall; detail: TraceDetail; failed: WfSpan | null; newSince?: string; moduleLabel?: string }): string {
  const { log, wf, detail, failed } = opts
  const f = baseFields(log, wf, detail, failed, opts.moduleLabel ?? '')
  f.newSince = opts.newSince
  const step = namedStep(failed, log)
  if (step) f.failedStep = `${log?.failedStep || spanLabel(step)} (span #${step.n}, ${sp(step)} ms)`
  f.extra = [['spans', `${detail.spanCount} (${detail.errorCount} error) · services: ${servicesLine(wf, false)}`]]
  return aiErrorMarkdown(f)
}

/** The Markdown of the trace page: error + failed span + span tree + the trace's logs. */
export function aiTraceMarkdown(opts: {
  log: LogRow | null
  wf: Waterfall
  detail: TraceDetail
  failed: WfSpan | null
  newSince?: string
  moduleLabel?: string
  counts?: string
}): string {
  const { log, wf, detail, failed } = opts
  const f = baseFields(log, wf, detail, failed, opts.moduleLabel ?? '')
  f.newSince = opts.newSince
  const step = namedStep(failed, log)
  if (step) {
    const s = step.span
    f.failedStep = `${spanLabel(step)} (span #${step.n} · ${s.kind} · +${fmtMs(step.start)} · ${fmtMs(s.durationMs)}${s.peer && s.kind !== 'SERVER' ? ` · peer ${s.peer}` : ''})`
  }
  // per remote service: time in it; per db system: calls and time
  const parts = [`${detail.spanCount} (${detail.errorCount} error) · services: ${servicesLine(wf, true)}`]
  for (const w of wf.spans.filter((x) => x.hop)) {
    const top = descendants(wf, w)
      .filter((x) => x.childCount === 0)
      .sort((a, b) => b.span.durationMs - a.span.durationMs)
      .slice(0, 3)
      .sort((a, b) => a.n - b.n)
    parts.push(`${w.span.service} ${fmtOff(w.span.durationMs)} of ${fmtMs(wf.total)}${top.length ? ` (${top.map((x) => `${x.span.name} ${fmtMs(x.span.durationMs)}`).join(', ')})` : ''}`)
  }
  const db = new Map<string, { calls: number; ms: number }>()
  for (const w of wf.spans) {
    if (!w.span.db?.system) continue
    const cur = db.get(w.span.db.system) ?? { calls: 0, ms: 0 }
    db.set(w.span.db.system, { calls: cur.calls + 1, ms: cur.ms + w.span.durationMs })
  }
  for (const [sys, v] of db) parts.push(`${sys} ${v.calls} call${v.calls === 1 ? '' : 's'} ${fmtMs(v.ms)}`)
  const tree = wf.spans.map((w) => {
    const s = w.span
    const status = w.isError || s.statusCode === 'ERROR' ? ` · ERROR ${spanWhy(s)}`.trimEnd() : ''
    const svc = w.n === 1 || w.hop ? ` · ${s.service}/${s.role}` : ''
    const peer = s.peer && (s.kind === 'CLIENT' || s.kind === 'PRODUCER') ? ` · peer ${s.peer}` : ''
    return `  ${'  '.repeat(Math.min(w.depth, 8))}${w.n} ${spanLabel(w)} · ${s.kind}${svc} · ${sp(w)}${peer}${status}`
  })
  const logs = [...detail.logs]
    .sort((a, b) => isoMs(a.timestamp) - isoMs(b.timestamp))
    .map((l) => {
      const t = logTitle(l)
      const lvl = ({ debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' } as Record<string, string>)[l.level] ?? l.level
      const tail = l.error ? ` · ${[l.error.type, l.error.code ? `[${l.error.code}]` : ''].filter(Boolean).join(' ')}` : l.eventCode === 'http.request' && l.http ? ` ${l.http.method} ${l.http.route} ${l.http.status}${l.durationMs !== null ? ` ${fmtMs(l.durationMs)}` : ''}` : ''
      return `  - ${fmtTimeMs(l.timestamp)} ${lvl} ${l.service}/${l.role} ${t.prefix ? `${t.prefix}: ` : ''}${t.title}${tail}`
    })
  f.extra = [
    ['spans', parts.join(' · ')],
    ['span_tree (start → end ms)', `\n${tree.join('\n')}`],
    ['logs', logs.length ? `\n${logs.join('\n')}` : ''],
  ]
  f.counts = opts.counts
  return aiErrorMarkdown(f).replace(/: \n/g, ':\n')
}
