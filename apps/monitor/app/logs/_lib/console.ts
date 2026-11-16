/**
 * The log console's model (pure: server and client): lines with stable ids, the Timeline view's request blocks
 * (one per trace id, every line it wrote in every service, on a time rail), the raw view's lines, the separators
 * between them (deploy, outage, recovered), and how one line reads in the terminal format (time · level · service ·
 * context · logger message key=value duration).
 */
import { fmtDateTime, fmtDuration, fmtTimeSec } from '@/lib/format'
import { eventTitle, type Kv, logTitle } from '@/lib/readable'
import type { Deploy, LogRow, ServiceRelease } from '@/lib/types'
import { lineKvs, type Outage, routeText, withLineIds } from './lines'

export const RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 }
export const rankOf = (level: string): number => RANK[level] ?? 1

/** One log line of the console. */
export interface LineRec {
  /** Stable id (`<epoch ms>-<hash>`): the same line from two calls gets the same id. */
  id: string
  row: LogRow
  ms: number
}

/** Rows of one engine answer → records, oldest first. */
export function recsOf(rows: readonly LogRow[]): LineRec[] {
  return withLineIds([...rows])
    .map(({ id, row }) => ({ id, row, ms: Date.parse(row.timestamp) }))
    .sort(byTime)
}

export const byTime = (a: LineRec, b: LineRec): number => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Union of two lists of records by id, oldest first. */
export function mergeRecs(a: readonly LineRec[], b: readonly LineRec[]): LineRec[] {
  const seen = new Set(a.map((r) => r.id))
  const out = [...a]
  for (const r of b) if (!seen.has(r.id)) {
    seen.add(r.id)
    out.push(r)
  }
  return out.sort(byTime)
}

export const srcOf = (row: Pick<LogRow, 'service' | 'role'>): string => (row.role ? `${row.service}/${row.role}` : row.service)

// ---------- separators ----------

export interface Separator {
  key: string
  t: number
  kind: 'deploy' | 'outage' | 'recover'
  text: string
}

/**
 * The dependency outages one of `sources` reported (`svc/role`, or a bare `svc` for every role of it); every outage
 * when `sources` is empty (every service). The minute strip's bands and the outage separators.
 */
export function outagesSeenBy(outages: readonly Outage[], sources: readonly string[]): Outage[] {
  if (!sources.length) return [...outages]
  return outages.filter((x) => x.sources.some((s) => sources.includes(s) || sources.includes(s.split('/')[0])))
}

/**
 * Deploys of the shown services in the range (`deploy school-core-api 1.42.0 (จาก 1.41.3)`), the dependency outages
 * given (outagesSeenBy: `Redis "cache" down 13:41:12 → 13:56:14 (15 นาที)` and `… กลับมาแล้ว`), and, at the range
 * start, the version of a shown service that did not deploy in it. `services` empty = every service.
 */
export function separatorsOf(o: {
  deploys: readonly Deploy[]
  releases: readonly ServiceRelease[]
  outages: readonly Outage[]
  env: string | undefined
  fromMs: number
  toMs: number
  services: readonly string[]
}): Separator[] {
  const svcOk = (s: string) => !o.services.length || o.services.includes(s)
  const envOk = (e: string) => !o.env || e === o.env
  const out: Separator[] = []
  const deployed = new Set<string>()
  for (const d of o.deploys) {
    const t = Date.parse(d.at)
    if (!envOk(d.env) || !svcOk(d.service) || t < o.fromMs || t > o.toMs) continue
    deployed.add(d.service)
    out.push({
      key: `deploy:${d.env}:${d.service}:${d.at}`,
      t,
      kind: 'deploy',
      text: `deploy ${d.service} ${d.version}${d.previousVersion ? ` (จาก ${d.previousVersion})` : ''}${o.env ? '' : ` · ${d.env}`}`,
    })
  }
  for (const r of o.releases) {
    if (!envOk(r.env) || !svcOk(r.service) || deployed.has(r.service) || !o.services.length) continue
    out.push({
      key: `release:${r.env}:${r.service}`,
      t: o.fromMs,
      kind: 'deploy',
      text: `${r.service} ไม่มี deploy ในช่วงนี้ · version ${r.currentVersion}${r.deployedAt ? ` ตั้งแต่ ${fmtDateTime(r.deployedAt)}` : ''}`,
    })
  }
  for (const x of o.outages) {
    const len = x.to === null ? '' : ` (${fmtDuration(x.to - x.from)})`
    out.push({
      key: `outage:${x.key}:${x.from}`,
      t: x.from,
      kind: 'outage',
      text: x.to === null ? `${x.dep} down ตั้งแต่ ${fmtTimeSec(x.from)} ยังไม่กลับมา` : `${x.dep} down ${fmtTimeSec(x.from)} → ${fmtTimeSec(x.to)}${len}`,
    })
    if (x.to !== null) out.push({ key: `recover:${x.key}:${x.to}`, t: x.to, kind: 'recover', text: `${x.dep} กลับมาแล้ว` })
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---------- the Timeline view: one block per request ----------

export interface RequestGroup {
  kind: 'group'
  key: string
  t: number
  trace: string
  /** Every line of the request, oldest first. */
  lines: LineRec[]
  /** The request's own `http.request` line that started first (written when the response ended). */
  root: LineRec | null
  job: LogRow['job']
  start: number
  end: number
  total: number
  /** service/role it went through, in order. */
  srcs: string[]
  level: string
  title: string
  status: number | null
  aborted: boolean
  /** First line with an error (its message is in the head). */
  errLine: LineRec | null
  /** The engine returned only the newest lines of it. */
  truncated: boolean
}

export type Item = { kind: 'line'; key: string; t: number; line: LineRec } | { kind: 'sep'; key: string; t: number; sep: Separator } | RequestGroup

/** The request was cut off by the client (status 499, `request aborted`, reason client_closed). */
export const isAborted = (row: LogRow): boolean => row.httpStatus === 499 || row.http?.status === 499 || row.reason === 'client_closed' || /\baborted\b/i.test(row.message)

const startOf = (r: LineRec) => r.ms - (r.row.durationMs ?? 0)

function groupOf(trace: string, lines: LineRec[], truncated: boolean): RequestGroup {
  const reqs = lines.filter((l) => l.row.eventCode === 'http.request')
  const root = reqs.slice().sort((a, b) => startOf(a) - startOf(b))[0] ?? null
  const start = Math.min(lines[0].ms, root ? startOf(root) : Infinity)
  const end = lines[lines.length - 1].ms
  const srcs: string[] = []
  for (const l of lines) if (!srcs.includes(srcOf(l.row))) srcs.push(srcOf(l.row))
  const level = lines.reduce((w, l) => (rankOf(l.row.level) > rankOf(w) ? l.row.level : w), 'debug')
  const job = root ? null : (lines.find((l) => l.row.job)?.row.job ?? null)
  const first = lines[0].row
  const title = root ? routeText(root.row) || logTitle(root.row).title : job ? `${job.type || job.queue}${job.id ? ` #${job.id}` : ''}` : routeText(first) || logTitle(first).title
  const status = root ? (root.row.httpStatus ?? root.row.http?.status ?? null) : null
  return {
    kind: 'group',
    key: `g:${trace}`,
    t: start,
    trace,
    lines,
    root,
    job,
    start,
    end,
    total: Math.max(1, end - start),
    srcs,
    level,
    title,
    status: status || null,
    aborted: !!root && isAborted(root.row),
    errLine: lines.find((l) => l.row.error || l.row.fingerprint) ?? null,
    truncated,
  }
}

/**
 * Timeline items: a request (trace id) is shown when one of its lines is in `matched`, then with every line it
 * wrote (`extra`: the lines of those traces in every service and pod), so the block reads start to end; a line
 * outside a request, or the kept line of a collapsed repeat, stays a single line. Sorted by start time.
 */
export function timelineItems(matched: readonly LineRec[], extra: ReadonlyMap<string, readonly LineRec[]>, seps: readonly Separator[], truncated: ReadonlySet<string>): Item[] {
  const items: Item[] = seps.map((sep) => ({ kind: 'sep', key: sep.key, t: sep.t, sep }))
  const byTrace = new Map<string, LineRec[]>()
  for (const l of matched) {
    const trace = l.row.traceId
    if (!trace || l.row.repeat) {
      items.push({ kind: 'line', key: `l:${l.id}`, t: l.ms, line: l })
      continue
    }
    const list = byTrace.get(trace)
    if (list) list.push(l)
    else byTrace.set(trace, [l])
  }
  for (const [trace, own] of byTrace) {
    const lines = mergeRecs(own, (extra.get(trace) ?? []).filter((l) => !l.row.repeat))
    items.push(groupOf(trace, lines, truncated.has(trace)))
  }
  return items.sort((a, b) => a.t - b.t || (a.kind === 'sep' ? -1 : b.kind === 'sep' ? 1 : 0))
}

/** Raw view: every matched line in time order with the separators between. */
export function rawItems(matched: readonly LineRec[], seps: readonly Separator[]): Item[] {
  const items: Item[] = [...seps.map((sep) => ({ kind: 'sep' as const, key: sep.key, t: sep.t, sep })), ...matched.map((line) => ({ kind: 'line' as const, key: `l:${line.id}`, t: line.ms, line }))]
  return items.sort((a, b) => a.t - b.t || (a.kind === 'sep' ? -1 : b.kind === 'sep' ? 1 : 0))
}

/** One event of an open block: the request arriving (`รับ request …`), or one of its lines. */
export interface BlockEvent {
  t: number
  src: string
  arrive?: LineRec
  line?: LineRec
}

export function eventsOf(g: RequestGroup): BlockEvent[] {
  const ev: BlockEvent[] = g.root ? [{ t: g.start, src: srcOf(g.root.row), arrive: g.root }] : []
  for (const l of g.lines) ev.push({ t: l.ms, src: srcOf(l.row), line: l })
  return ev
}

/** A quiet stretch inside a block worth saying (`⋯ ไม่มี log 3.0 s`): at least 1 s and a quarter of the request. */
export const isGap = (gapMs: number, totalMs: number): boolean => gapMs >= 1000 && gapMs > totalMs * 0.25

/** `+84 ms`, `+1.32 s`, `+12.4 s`. */
export function offText(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  return `+${v < 1000 ? `${v.toLocaleString('en-US')} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`}`
}

// ---------- one line in the terminal format ----------

/** Context column: the request (`GET /classes/:id`), the job (`report:generate #88412`), else where it came from. */
export function ctxOf(row: LogRow): { text: string; life: boolean } {
  if (row.job) return { text: `${row.job.type || row.job.queue}${row.job.id ? ` #${row.job.id}` : ''}`, life: false }
  const route = routeText(row)
  if (route) return { text: route, life: false }
  if (row.origin === 'startup') return { text: '▶ startup', life: true }
  if (row.origin === 'shutdown') return { text: '■ shutdown', life: true }
  if (row.origin === 'dependency' && row.dependency) return { text: `◌ ${[row.dependency.type, row.dependency.name].filter(Boolean).join(' ')}`, life: true }
  return { text: '◌ background', life: true }
}

/** The logger (dim) before the message, except on the SDK's own event lines (`request completed`, `job started`). */
export const loggerOf = (row: LogRow): string => (eventTitle(row) ? '' : row.logger)

/**
 * key=value after the message: what the context column does not say already (method, route, job, id) and what the
 * line's detail shows instead (source, file); the duration has its own place.
 */
export function kvsOf(row: LogRow): Kv[] {
  const ctx = row.job ? ['job', 'id'] : routeText(row) ? ['method', 'route'] : []
  const kvs = lineKvs(row).filter((kv) => !ctx.includes(kv.k) && kv.k !== 'source' && kv.k !== 'file' && kv.k !== 'duration')
  if (row.reason && !kvs.some((kv) => kv.k === 'reason')) kvs.push({ k: 'reason', v: row.reason })
  return kvs
}

/** `s2` / `s4` / `s5`: the colour of an HTTP status. */
export const statusClass = (status: number): string => (status >= 500 ? 's5' : status >= 400 ? 's4' : 's2')

/** A request line of 1 s or more reads slow. */
export const isSlow = (row: LogRow): boolean => row.durationMs !== null && row.durationMs >= 1000 && row.eventCode === 'http.request'

/** `core-api/api` when every service shares a prefix like `school-`; else the full `service/role`. */
export function shortNamer(services: readonly string[]): (src: string) => string {
  const list = [...new Set(services)]
  let prefix = ''
  if (list.length > 1) {
    const first = list[0]
    const dash = first.indexOf('-')
    const head = dash > 0 ? first.slice(0, dash + 1) : ''
    if (head && list.every((s) => s.startsWith(head) && s.length > head.length)) prefix = head
  }
  return (src) => (prefix && src.startsWith(prefix) ? src.slice(prefix.length) : src)
}

/** `7d9f8-x2k4q` of `core-api-7d9f8-x2k4q`: the replica part of a pod name. */
export function podShort(host: string): string {
  const parts = host.split('-')
  return parts.length > 2 ? parts.slice(-2).join('-') : host
}
