/**
 * The Timeline view of a trace (trace-detail.html, the default view): the trace as a story, top to bottom. One row per
 * thing that happened, at its offset from the start: the request (or job) coming in, every span starting, a call into
 * another service and its answer, the log lines, the failed step with what to fix, long stretches where nothing
 * happened, and the answer. Pure, server and client; TraceView draws the rows.
 *
 * Rules:
 * - Entries (the root, a SERVER or CONSUMER span) get a start and an end row; a CLIENT call answered by another
 *   service's SERVER span gets "เรียก …" and "ได้คำตอบจาก …"; every other span one row at its start.
 * - The entry's own `http.request` / `job.started` / `job.finished|failed|retry` line is folded into its edge row
 *   (linked from it) instead of a row of its own.
 * - Wrapper spans of Express and NestJS (`middleware - …`, `request handler - …`, `router - …`, the Nest handler /
 *   request context) are hidden: their children carry the story, and `alias` points each one at the row of its
 *   nearest shown ancestor. One stays when the failure starts in it.
 * - The failed step (any span but the root: a step, a call, or another service's entry) carries "พังที่นี่" and what
 *   to fix.
 * - A gap row marks a stretch of at least GAP_MIN_MS and GAP_SHARE of the trace without any row.
 */
import { fmtMs, fmtNumber } from '@/lib/format'
import { actualError, type Kv, logKvs, logTitle } from '@/lib/readable'
import type { LogRow } from '@/lib/types'
import { descendants, isoMs, spanWhy, timeSplit, type Waterfall, type WfSpan } from './model'

/** The views of the trace section: `?view=` and the `PREF.traceView` cookie. */
export const TRACE_VIEWS = ['timeline', 'waterfall', 'network'] as const
export type TraceViewName = (typeof TRACE_VIEWS)[number]

/** A stretch without rows of at least this many ms … */
const GAP_MIN_MS = 50
/** … and this share of the trace gets a gap row. */
const GAP_SHARE = 0.1
/** The longest step is flagged ช้าที่สุด from this share of the trace. */
const SLOW_SHARE = 0.2

/** One piece of a row's title or meta line. */
export type TlPart =
  | { t: 'verb'; text: string }
  /** The row's button: selects its span (`verb`: drawn as the verb of an end row). */
  | { t: 'pick'; text: string; verb?: boolean }
  | { t: 'name'; text: string }
  | { t: 'svc'; service: string; role: string }
  /** A line of "Log ของ trace นี้" (`#log-N`); `name` = drawn as the row's name. */
  | { t: 'log'; text: string; anchor: string; mono?: string; name?: boolean }
  | { t: 'link'; text: string; href: string }
  | { t: 'lvl'; level: string }
  | { t: 'status'; status: number }
  | { t: 'kv'; k: string; v: string }
  | { t: 'flag'; text: string }
  | { t: 'danger'; text: string }
  | { t: 'text'; text: string; mono?: string }
  | { t: 'user'; id: string; href: string }

export interface TlRow {
  key: string
  type: 'edge' | 'span' | 'log' | 'gap'
  /** ms from the trace start; null on a gap row. */
  off: number | null
  /** The span the row stands for (both edges of one span share it); null for a log line or a gap. */
  spanId: string | null
  /** The span's first row (its button takes focus back from the I/O panel). */
  first: boolean
  /** Colour of the node, bar and rail. */
  service: string
  /** Runs outside the root service (service-coloured rail). */
  remote: boolean
  error: boolean
  /** Level tone of a log row that is neither info nor error. */
  tone: 'wrn' | 'dbg' | null
  title: TlPart[]
  meta: TlPart[]
  /** Time the step took (ms) and its bar (% of the trace). */
  dur: number | null
  bar: number | null
  /** ต้องแก้อะไร / error จริง of the failed step. */
  fix: { fix: string; actual: string } | null
  /** Text of a gap row. */
  gap: string
}

export interface TlSummary {
  total: number
  /** Share of the trace spent in another service, with its slowest step. */
  hop: { service: string; role: string; pct: number; slowest: { name: string; ms: number } | null } | null
  /** No other service: the slowest step of the trace. */
  slowest: { name: string; pct: number } | null
  failed: { name: string; off: number } | null
  /** How the trace ended when that is worth saying: `ตอบ 500`, `job ล้มเหลว`, `retry สำเร็จ`. */
  ending: string
  recovered: boolean
}

export interface Timeline {
  rows: TlRow[]
  summary: TlSummary
  /** Wrapper spans left out, and what they were (`middleware`, `handler`). */
  hidden: { count: number; labels: string[] }
  /** A hidden span → its nearest shown ancestor, whose row stands for it (`?span=` of a wrapper selects that row). */
  alias: Record<string, string>
  /** Services other than the root's that rows ran in (legend rails). */
  remotes: Array<{ service: string; role: string }>
  /** The root: `request` (HTTP), `job`, or anything else. */
  entry: 'request' | 'job' | 'other'
  hasError: boolean
}

const WRAPPER_NAME = /^(middleware|request handler|router) - /
const NEST_WRAPPERS: Record<string, string> = { handler: 'handler', request_context: 'request context' }
const JOB_END = ['job.finished', 'job.failed', 'job.retry']

/** What wrapper a span is (`middleware`, `handler`), '' when it is none. */
function wrapperKind(w: WfSpan): string {
  const s = w.span
  if (w.n === 1 || w.hop || s.kind !== 'INTERNAL') return ''
  const m = WRAPPER_NAME.exec(s.name)
  if (m) return m[1]
  if (/instrumentation-express$/.test(s.scope)) return (s.attributes['express.type'] || 'express').replace(/_/g, ' ')
  if (/instrumentation-nestjs-core$/.test(s.scope)) return NEST_WRAPPERS[s.attributes['nestjs.type'] ?? ''] ?? ''
  return ''
}

export function buildTimeline(opts: {
  wf: Waterfall
  /** The trace's lines in time order (`#log-N` = index + 1, as the page's log list). */
  logs: LogRow[]
  failed: WfSpan | null
  errLog: LogRow | null
  recovered: boolean
  hrefs: { error: (fingerprint: string) => string; user: (userId: string) => string }
}): Timeline {
  const { wf, logs, errLog, recovered, hrefs } = opts
  const root = wf.root
  const total = wf.total
  const failed = opts.failed && opts.failed.n > 1 ? opts.failed : null
  if (!root) {
    return {
      rows: [],
      summary: { total, hop: null, slowest: null, failed: null, ending: '', recovered },
      hidden: { count: 0, labels: [] },
      alias: {},
      remotes: [],
      entry: 'other',
      hasError: false,
    }
  }

  // wrappers: hidden unless the failure starts in them (an error with nothing failing below it)
  const hiddenIds = new Set<string>()
  const labels = new Set<string>()
  for (const w of wf.spans) {
    const kind = wrapperKind(w)
    if (!kind || w === failed || (w.isError && !descendants(wf, w).some((d) => d.isError))) continue
    hiddenIds.add(w.span.spanId)
    labels.add(kind)
  }
  const shown = wf.spans.filter((w) => !hiddenIds.has(w.span.spanId))
  const byN = new Map(wf.spans.map((w) => [w.n, w]))
  const alias: Record<string, string> = {}
  for (const id of hiddenIds) {
    let up = wf.byId.get(id)
    while (up && hiddenIds.has(up.span.spanId)) up = up.parentN === null ? undefined : byN.get(up.parentN)
    alias[id] = (up ?? root).span.spanId
  }

  // lines folded into an edge row
  const folded = new Set<number>()
  const fold = (w: WfSpan, codes: string[]): number => {
    const i = logs.findIndex((l, j) => !folded.has(j) && l.spanId === w.span.spanId && codes.includes(l.eventCode))
    if (i >= 0) folded.add(i)
    return i
  }
  const anchor = (i: number) => `log-${i + 1}`
  const isJob = (w: WfSpan) => w.span.kind === 'CONSUMER' || logs.some((l) => l.spanId === w.span.spanId && !!l.job)
  const failedEnd = (w: WfSpan) => w.isError || w.span.statusCode === 'ERROR' || (w.span.http?.status ?? 0) >= 500
  const where = (w: WfSpan): TlPart[] => {
    const s = w.span
    if (s.peer && (s.kind === 'CLIENT' || s.kind === 'PRODUCER')) return [{ t: 'text', text: `${w.lib ? `${w.lib} ` : ''}→ `, mono: s.peer }]
    return w.lib ? [{ t: 'text', text: w.lib }] : []
  }
  const attempt = (i: number): TlPart[] => {
    const j = i >= 0 ? logs[i].job : null
    return j?.attempt ? [{ t: 'text', text: `attempt ${j.attempt}${j.maxAttempts ? `/${j.maxAttempts}` : ''}` }] : []
  }
  const lineLink = (i: number): TlPart[] => (i >= 0 ? [{ t: 'log', text: 'log ', mono: logs[i].eventCode, anchor: anchor(i) }] : [])
  const groupLink = (i: number): TlPart[] => {
    const fp = i >= 0 ? logs[i].fingerprint : null
    return fp ? [{ t: 'link', text: 'เปิด error group', href: hrefs.error(fp) }] : []
  }
  const user = logs.find((l) => l.userId)
  const userPart: TlPart[] = user ? [{ t: 'user', id: user.userId, href: hrefs.user(user.userId) }] : []
  const svc = (w: WfSpan): TlPart => ({ t: 'svc', service: w.span.service, role: w.span.role })
  const statusWord = (w: WfSpan): TlPart => (failedEnd(w) ? { t: 'danger', text: 'ล้มเหลว' } : { t: 'verb', text: 'สำเร็จ' })

  /** The failed step's "พังที่นี่" flag, meta suffix and what to fix; nothing for any other span (an entry or call too). */
  const failure = (w: WfSpan): { flag: TlPart[]; step: string; fix: TlRow['fix'] } => {
    if (w !== failed) return { flag: [], step: '', fix: null }
    const s = w.span
    const why = spanWhy(s)
    const fix = errLog?.error?.howToFix || errLog?.error?.detail || ''
    const actual = actualError(errLog?.error) || (s.exception ? actualError({ type: s.exception.type, message: s.exception.message }) : '')
    return { flag: [{ t: 'danger', text: why ? `พังที่นี่ · ${why}` : 'พังที่นี่' }], step: ' · failed step', fix: fix || actual ? { fix, actual } : null }
  }

  // the slowest step of the trace, flagged on its row
  const split = timeSplit(wf)
  const slowId = split.leaf && split.leaf.n > 1 && split.leaf.span.durationMs / total >= SLOW_SHARE ? split.leaf.span.spanId : null

  const base = (w: WfSpan, type: TlRow['type'], at: number, first: boolean): TlRow => ({
    key: `${first ? 's' : 'e'}-${w.span.spanId}`,
    type,
    off: at,
    spanId: w.span.spanId,
    first,
    service: w.span.service,
    remote: w.railAt !== null,
    error: false,
    tone: null,
    title: [],
    meta: [],
    dur: null,
    bar: null,
    fix: null,
    gap: '',
  })

  type Ev = { at: number; rank: number; seq: number; row: TlRow }
  const evs: Ev[] = []
  const start = (row: TlRow, w: WfSpan) => evs.push({ at: w.start, rank: 0, seq: w.n, row })
  // children end before their parent at the same instant
  const end = (row: TlRow, w: WfSpan) => evs.push({ at: w.end, rank: 2, seq: -w.n, row })
  const withDur = (row: TlRow, w: WfSpan): TlRow => ({ ...row, dur: w.span.durationMs, bar: Math.max(0, Math.min(100, (w.span.durationMs / total) * 100)) })

  const entry: Timeline['entry'] = root.span.kind === 'SERVER' && !!root.span.http?.method ? 'request' : isJob(root) ? 'job' : 'other'
  for (const w of shown) {
    const s = w.span
    if (w === root) {
      const startLine = entry === 'job' ? fold(w, ['job.started']) : -1
      const endLine = fold(w, entry === 'request' ? ['http.request'] : entry === 'job' ? JOB_END : [])
      const routeText = entry === 'request' ? `${s.http!.method} ${s.http!.route || s.http!.path || s.name}` : s.name
      start(
        {
          ...base(w, 'edge', w.start, true),
          title: [{ t: 'verb', text: entry === 'request' ? 'รับ request' : entry === 'job' ? 'เริ่ม job' : 'เริ่ม' }, { t: 'pick', text: routeText }],
          meta: [svc(w), { t: 'text', text: `span #1 · ${s.kind}` }, ...attempt(startLine), ...lineLink(startLine), ...userPart],
        },
        w,
      )
      const name: TlPart = endLine >= 0 ? { t: 'log', text: routeText, anchor: anchor(endLine), name: true } : { t: 'name', text: routeText }
      end(
        withDur(
          {
            ...base(w, 'edge', w.end, false),
            error: failedEnd(w),
            title:
              entry === 'request'
                ? [{ t: 'pick', text: 'ตอบ', verb: true }, ...(s.http!.status ? [{ t: 'status', status: s.http!.status } as TlPart] : []), name]
                : entry === 'job'
                  ? [{ t: 'pick', text: 'จบ job', verb: true }, statusWord(w), name]
                  : [{ t: 'pick', text: 'จบ', verb: true }, name],
            meta: [
              {
                t: 'text',
                text: `${entry === 'request' ? 'จบ request หลัง' : entry === 'job' ? 'จบ job หลัง' : 'จบหลัง'} ${fmtMs(s.durationMs)} · span #1${endLine >= 0 ? ' · log ' : ''}`,
                mono: endLine >= 0 ? logs[endLine].eventCode : undefined,
              },
              ...groupLink(endLine),
            ],
          },
          w,
        ),
        w,
      )
      continue
    }
    const f = failure(w)
    if (s.kind === 'SERVER' || s.kind === 'CONSUMER') {
      const job = s.kind === 'CONSUMER' || isJob(w)
      const startLine = job ? fold(w, ['job.started']) : -1
      const endLine = fold(w, job ? JOB_END : ['http.request'])
      start(
        withDur(
          {
            ...base(w, 'edge', w.start, true),
            error: w.isError,
            title: [svc(w), { t: 'verb', text: job ? 'เริ่ม job' : 'รับ request' }, { t: 'pick', text: s.name }, ...f.flag],
            meta: [{ t: 'text', text: `span #${w.n} · ${s.kind}${f.step}` }, ...attempt(startLine), ...lineLink(startLine)],
            fix: f.fix,
          },
          w,
        ),
        w,
      )
      end(
        {
          ...base(w, 'edge', w.end, false),
          error: failedEnd(w),
          title: job
            ? [svc(w), { t: 'pick', text: 'จบ job', verb: true }, statusWord(w)]
            : [svc(w), { t: 'pick', text: 'ตอบ', verb: true }, ...(s.http?.status ? [{ t: 'status', status: s.http.status } as TlPart] : [])],
          meta: [...(job ? [{ t: 'text', text: `หลัง ${fmtMs(s.durationMs)}` } as TlPart] : []), ...lineLink(endLine), ...groupLink(endLine)],
        },
        w,
      )
      continue
    }
    // a call answered by another service: "เรียก <svc> <its route>" … "ได้คำตอบจาก <svc> <status>"
    const callee = s.kind === 'CLIENT' ? shown.find((c) => c.parentN === w.n && c.hop && c.span.kind === 'SERVER') : undefined
    if (callee) {
      start(
        withDur(
          {
            ...base(w, 'span', w.start, true),
            error: w.isError,
            title: [{ t: 'verb', text: 'เรียก' }, svc(callee), { t: 'pick', text: callee.span.name }, ...f.flag],
            meta: [...where(w), { t: 'text', text: `span #${w.n} · รอคำตอบ ${fmtMs(s.durationMs)}${f.step}` }],
            fix: f.fix,
          },
          w,
        ),
        w,
      )
      const status = s.http?.status || callee.span.http?.status || 0
      const answer: TlPart[] = status ? [{ t: 'status', status }] : s.statusCode === 'ERROR' ? [{ t: 'danger', text: 'ERROR' }] : []
      end(
        {
          ...base(w, 'span', w.end, false),
          error: failedEnd(w),
          title: [{ t: 'pick', text: 'ได้คำตอบจาก', verb: true }, svc(callee), ...answer],
          meta: [{ t: 'text', text: `จบ span #${w.n} หลังรอ ${fmtMs(s.durationMs)}` }],
        },
        w,
      )
      continue
    }
    start(
      withDur(
        {
          ...base(w, 'span', w.start, true),
          error: w.isError,
          title: [
            ...(w.isError ? [{ t: 'lvl', level: 'error' } as TlPart] : []),
            ...(s.kind === 'PRODUCER' ? [{ t: 'verb', text: 'ส่งเข้า queue' } as TlPart] : []),
            ...(w.hop ? [svc(w)] : []),
            { t: 'pick', text: s.name },
            ...(w.span.spanId === slowId ? [{ t: 'flag', text: `ช้าที่สุด · ${fmtNumber((s.durationMs / total) * 100, 0)} % ของ trace` } as TlPart] : []),
            ...f.flag,
          ],
          meta: [...where(w), { t: 'text', text: `span #${w.n}${s.kind === 'CLIENT' || s.kind === 'PRODUCER' ? '' : ` · ${s.kind}`}${f.step}` }],
          fix: f.fix,
        },
        w,
      ),
      w,
    )
  }

  // log lines, inside their own span's time (a line stamped in ms can read a little after its span ended)
  const rootKey = `${root.span.service}/${root.span.role}`
  logs.forEach((l, i) => {
    if (folded.has(i)) return
    const off = isoMs(l.timestamp) - wf.t0
    const own = l.spanId ? wf.byId.get(l.spanId) : undefined
    const at = own ? Math.max(own.start, Math.min(own.end, off)) : off
    const t = logTitle(l)
    const kvs: Kv[] = [
      ...logKvs(l),
      ...Object.entries(l.fields ?? {})
        .filter(([k]) => !k.startsWith('dependency.') && !k.startsWith('http.'))
        .map(([k, v]) => ({ k, v: String(v) })),
    ].slice(0, 3)
    const row: TlRow = {
      key: `l-${i}`,
      type: 'log',
      off,
      spanId: null,
      first: false,
      service: l.service,
      remote: own ? own.railAt !== null : `${l.service}/${l.role}` !== rootKey,
      error: l.level === 'error' || l.level === 'fatal',
      tone: l.level === 'warn' ? 'wrn' : l.level === 'debug' ? 'dbg' : null,
      title: [{ t: 'lvl', level: l.level }, { t: 'log', text: t.title, anchor: anchor(i), name: true }, ...kvs.map((kv): TlPart => ({ t: 'kv', k: kv.k, v: kv.v }))],
      meta: [{ t: 'text', text: 'log · ', mono: l.logger || l.eventCode }, ...groupLink(i)],
      dur: null,
      bar: null,
      fix: null,
      gap: '',
    }
    evs.push({ at, rank: 1, seq: i, row })
  })

  evs.sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq)

  // stretches where nothing happened, named after the deepest step running through (nearly) all of it
  const rows: TlRow[] = []
  const gapMs = Math.max(GAP_MIN_MS, total * GAP_SHARE)
  evs.forEach((e, i) => {
    const prev = evs[i - 1]
    const gap = prev ? e.at - prev.at : 0
    if (prev && gap >= gapMs) {
      const waiting = shown
        .filter((w) => w.n > 1 && Math.min(w.end, e.at) - Math.max(w.start, prev.at) >= gap * 0.9)
        .reduce<WfSpan | null>((a, b) => (!a || b.depth > a.depth ? b : a), null)
      rows.push({
        key: `g-${i}`,
        type: 'gap',
        off: null,
        spanId: null,
        first: false,
        service: waiting?.span.service ?? root.span.service,
        remote: !!waiting && waiting.railAt !== null,
        error: false,
        tone: null,
        title: [],
        meta: [],
        dur: null,
        bar: null,
        fix: null,
        gap: `⋯ ${fmtMs(gap)} ไม่มีเหตุการณ์อื่น${waiting ? ` ระหว่างรอ ${waiting.span.name}` : ''}`,
      })
    }
    rows.push(e.row)
  })

  const rs = root.span
  const ending =
    entry === 'request' && (rs.http?.status ?? 0) >= 400
      ? `ตอบ ${rs.http!.status}`
      : recovered
        ? 'retry สำเร็จ'
        : entry === 'job' && failedEnd(root)
          ? 'job ล้มเหลว'
          : ''
  const remotes = new Map<string, { service: string; role: string }>()
  for (const w of shown) if (w.railAt !== null) remotes.set(`${w.span.service}/${w.span.role}`, { service: w.span.service, role: w.span.role })

  return {
    rows,
    summary: {
      total,
      hop: split.hop
        ? {
            service: split.hop.span.service,
            role: split.hop.span.role,
            pct: (split.hopMs / total) * 100,
            slowest: split.hopLeaf ? { name: split.hopLeaf.span.name, ms: split.hopLeaf.span.durationMs } : null,
          }
        : null,
      slowest: !split.hop && split.leaf && split.leaf.n > 1 ? { name: split.leaf.span.name, pct: (split.leaf.span.durationMs / total) * 100 } : null,
      failed: failed ? { name: failed.span.name, off: failed.start } : null,
      ending,
      recovered,
    },
    hidden: { count: hiddenIds.size, labels: Array.from(labels) },
    alias,
    remotes: Array.from(remotes.values()),
    entry,
    hasError: rows.some((r) => r.error),
  }
}
