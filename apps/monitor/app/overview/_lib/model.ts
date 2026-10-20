/**
 * Pure data shaping for the overview (design/monitoring-ui/overview.html): thresholds, units per service kind,
 * deploy lookup, merged dependency rows with their outage window, and the helpers the blocks share.
 */
import { depHostAnchor } from '@/app/jobs/_data'
import type { MapNodeState, SystemMapData, SystemMapNode } from '@/lib/3d/system-map'
import { fmtCount } from '@/lib/format'
import { depAnchor } from '@/lib/params'
import { dependencyNodeId, phoneMapData } from '@/lib/topology'
import type { Dependency, DependenciesResponse, ErrorGroup, JobStat, LogRow, Meta, OverviewRoute, OverviewService } from '@/lib/types'

/** "ต้องดู" thresholds (overview design notes): error rate ≥ 1 %, p95 ≥ 1 s, a NEW group after deploy. */
export const ERROR_RATE_BAD = 0.01
export const SLOW_MS = 1000
/** Δ p95 turns amber at +20 % (route table). */
export const P95_WORSE = 0.2

/** HTTP route (`GET /me`); job keys have no method. */
export const isHttp = (r: Pick<OverviewRoute, 'method'>) => r.method !== ''

/**
 * "Route error สูง" in ต้องดูตอนนี้ (decided rule, README "ต้องดูตอนนี้"): an HTTP route of the range with an error
 * rate (5xx or ERROR) ≥ 5 % over ≥ 20 requests. Ranked by impact: most failed requests first, then the higher rate.
 * The 1 % rule of the health table marks a role ต้องดู; this one names the route users are failing on right now.
 */
export const ROUTE_ERROR_RATE = 0.05
export const ROUTE_ERROR_MIN_REQUESTS = 20

/** HTTP routes that pass the "Route error สูง" rule, most failed requests first. */
export function failingRoutes(routes: OverviewRoute[]): OverviewRoute[] {
  return routes
    .filter((r) => isHttp(r) && r.requests >= ROUTE_ERROR_MIN_REQUESTS && r.errorRate >= ROUTE_ERROR_RATE)
    .sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate)
}

/**
 * "เงียบ" (decided rule, README "ต้องดูตอนนี้"): a service / role whose entry spans stopped. No request, job or message
 * for SILENT_MS (5 min) up to the end of the range, after an average of at least SILENT_MIN_RPM (1 per minute) while
 * it had traffic. A role whose traffic is rarer (a nightly batch, a few report jobs an hour) is never flagged: a gap
 * is normal for it. The row stays in the health table (never green with an average) even when the whole range is
 * quiet, and ต้องดูตอนนี้ says since when.
 */
export const SILENT_MS = 5 * 60_000
export const SILENT_MIN_RPM = 1

export interface Silence {
  /** Start of the last entry span (ms): "ไม่มี request ตั้งแต่ HH:mm". */
  lastMs: number
  /** Average per minute while it had traffic; null when not known. */
  rpmBefore: number | null
}

/**
 * A role with traffic in the range that went quiet: the end of its last bucket with entries is SILENT_MS or more
 * before `toMs`, and it averaged ≥ SILENT_MIN_RPM up to there. `quietFromMs` = that bucket end (no entry after it).
 */
export function quietInRange(s: Pick<OverviewService, 'spark'>, rangeFrom: string, stepSeconds: number, toMs: number): { quietFromMs: number; rpmBefore: number } | null {
  const i = s.spark.findLastIndex((v) => v > 0)
  if (i < 0) return null
  const fromMs = Date.parse(rangeFrom)
  const first = Math.floor(fromMs / 60_000) * 60_000
  const quietFromMs = Math.min(toMs, first + (i + 1) * stepSeconds * 1000)
  if (toMs - quietFromMs < SILENT_MS) return null
  const total = s.spark.reduce((a, v) => a + v, 0)
  const rpmBefore = total / Math.max(1, (quietFromMs - fromMs) / 60_000)
  return rpmBefore >= SILENT_MIN_RPM ? { quietFromMs, rpmBefore } : null
}

/**
 * A role without any entry span in the range: silent when its latest entries (newest first, up to 20 before the
 * range end) came at ≥ SILENT_MIN_RPM, i.e. it was busy until it stopped. null for a role that is just rare.
 */
export function quietBefore(times: number[]): Silence | null {
  if (times.length < 2) return null
  const spanMin = (times[0] - times[times.length - 1]) / 60_000
  const rpm = (times.length - 1) / Math.max(1 / 60, spanMin)
  return rpm >= SILENT_MIN_RPM ? { lastMs: times[0], rpmBefore: rpm } : null
}

/**
 * Drop the current, still filling minute at the end of a 1-minute series: drawn as a sudden fall to ~0 it reads
 * as an outage. Wider steps fold the remainder into the last bucket, so they are complete.
 */
export function completeCount(n: number, rangeFrom: string, stepSeconds: number, toMs: number): number {
  if (stepSeconds !== 60 || n === 0) return n
  const first = Math.floor(Date.parse(rangeFrom) / 60_000) * 60_000
  const lastStart = first + (n - 1) * 60_000
  return lastStart + 60_000 > toMs ? n - 1 : n
}

/** Bucket start times (ms) of a range: from rounded down to the minute + i·step. */
export function bucketTimes(rangeFrom: string, stepSeconds: number, n: number): number[] {
  const first = Math.floor(Date.parse(rangeFrom) / 60_000) * 60_000
  return Array.from({ length: n }, (_, i) => first + i * stepSeconds * 1000)
}

/** `นาที`, `5 นาที`, `ชั่วโมง`, `6 ชั่วโมง`, `วัน` — "ต่อ…" of a series step. */
export function stepWord(stepSeconds: number): string {
  if (stepSeconds % 86_400 === 0) return stepSeconds === 86_400 ? 'วัน' : `${stepSeconds / 86_400} วัน`
  if (stepSeconds % 3600 === 0) return stepSeconds === 3600 ? 'ชั่วโมง' : `${stepSeconds / 3600} ชั่วโมง`
  const m = Math.round(stepSeconds / 60)
  return m === 1 ? 'นาที' : `${m} นาที`
}

/** `ต่อนาที`, `ต่อ 15 นาที`, `ต่อชั่วโมง` (Thai puts no space before a word, one before a number). */
export function perStep(stepSeconds: number): string {
  const w = stepWord(stepSeconds)
  return /^\d/.test(w) ? `ต่อ ${w}` : `ต่อ${w}`
}

// ---------- volume units ----------

export interface Volume {
  /** `req/นาที` `job/นาที` `msg/นาที` */
  unit: string
  /** short unit for tooltips: req · job · msg */
  short: string
  /** what one count is: request · job attempt · message */
  word: string
  /** ประเภท column: HTTP API · BullMQ worker · Kafka consumer … */
  type: string
}

/** Unit and type label of a service/role row: SERVER = requests; consumers count job attempts, or messages when only Kafka / RabbitMQ feed them. */
export function volumeOf(s: Pick<OverviewService, 'service' | 'role' | 'kind'>, jobs: JobStat[]): Volume {
  if (s.kind === 'SERVER') return { unit: 'req/นาที', short: 'req', word: 'request', type: 'HTTP API' }
  const modules = new Set(jobs.filter((j) => j.service === s.service && j.role === s.role).map((j) => j.module))
  const type = modules.has('bullmq')
    ? 'BullMQ worker'
    : modules.has('kafka')
      ? 'Kafka consumer'
      : modules.has('rabbitmq')
        ? 'RabbitMQ consumer'
        : modules.has('cron')
          ? 'cron'
          : 'worker'
  const msgOnly = modules.size > 0 && [...modules].every((m) => m === 'kafka' || m === 'rabbitmq')
  return msgOnly
    ? { unit: 'msg/นาที', short: 'msg', word: 'message', type }
    : { unit: 'job/นาที', short: 'job', word: 'job attempt', type }
}

// ---------- deploys ----------

export interface DeployInfo {
  version: string
  previousVersion: string
  /** First line of the current version (ms). */
  atMs: number
}

/** Current deploy of a service/role in an env (meta.releases), only when an earlier version ran before it. */
export function deployOf(meta: Meta | null, env: string | undefined, service: string, role?: string): DeployInfo | null {
  if (!meta || !env) return null
  const rel = meta.releases.find((r) => r.env === env && r.service === service)
  if (!rel) return null
  const r = (role ? rel.roles.find((x) => x.role === role) : null) ?? rel
  if (!r.previousVersion || !r.deployedAt) return null
  return { version: r.currentVersion, previousVersion: r.previousVersion, atMs: Date.parse(r.deployedAt) }
}

/** Latest deploy in the env (page-head "deploy ล่าสุด"). */
export function latestDeploy(meta: Meta | null, env: string | undefined) {
  const list = (meta?.deploys ?? []).filter((d) => !env || d.env === env)
  return list.reduce<(typeof list)[number] | null>((a, d) => (!a || Date.parse(d.at) > Date.parse(a.at) ? d : a), null)
}

// ---------- dependencies ----------

export type DepIssue = 'down' | 'degraded' | 'recovered' | 'ok'

export interface DepRow {
  key: string
  type: string
  name: string
  host: string
  port: number
  nodeId: string
  /** `/jobs#…` anchor of this row: the host anchor when the engine still reports this host, else `dep-<name>`. */
  anchor: string
  state: Dependency['state']
  issue: DepIssue
  since: string | null
  lastEventAt: string | null
  /** Most failure lines one process wrote (an outage seen by two roles is one outage). */
  attempts: number
  /** Failed outbound calls, all callers. */
  outboundFailures: number
  /**
   * Outage window of the last finished outage on this host:port, when it ended inside the range: from the
   * dependency.up lines with a duration (reason recovered, not the first-connect `connected` ones), merged over the
   * processes that saw the same outage.
   */
  downAtMs: number | null
  upAtMs: number | null
  lastOutageMs: number | null
  /** HTTP status of the latest failed outbound call (401). */
  status: number | null
  /** Error code of the latest dependency.down line (ECONNREFUSED). */
  errorCode: string
  users: Array<{ service: string; role: string }>
}

const STATE_RANK: Record<string, number> = { down: 0, degraded: 1, up: 2 }
export const ISSUE_RANK: Record<DepIssue, number> = { down: 0, degraded: 1, recovered: 2, ok: 3 }

type Target = Pick<Dependency, 'type' | 'name' | 'host' | 'port'>
const targetKey = (t: Target) => `${t.type}|${t.name}|${t.host}|${t.port}`
const FAILURE_LINES = new Set(['dependency.down', 'dependency.still_down', 'http.outbound_failed'])

/** A dependency.up line that ends an outage (it carries the outage length); `connected` lines are first connects. */
const isRecovery = (e: LogRow) => e.eventCode === 'dependency.up' && e.reason !== 'connected' && (e.durationMs ?? 0) > 0

interface OutageWindow {
  downAtMs: number
  upAtMs: number
}

/**
 * One finished outage as every screen shows it: the latest window and every other process's window of the same
 * outage (those that overlap it, 1 s slack), merged from the earliest start to the latest recovery. Its length is
 * that union (the 11:40 Redis outage seen by api, api and persister: 11:40:20.906–11:41:06.229 = 45.3 s), not one
 * process's duration (45.2 / 45.1 / 45.0 s). null without a window.
 */
export function outageUnion(windows: OutageWindow[]): { downAtMs: number; upAtMs: number; ms: number } | null {
  const sorted = [...windows].sort((a, b) => b.upAtMs - a.upAtMs)
  const latest = sorted[0]
  if (!latest) return null
  const same = sorted.filter((w) => w.downAtMs <= latest.upAtMs + 1000 && w.upAtMs >= latest.downAtMs - 1000)
  const downAtMs = Math.min(...same.map((w) => w.downAtMs))
  const upAtMs = Math.max(...same.map((w) => w.upAtMs))
  return { downAtMs, upAtMs, ms: upAtMs - downAtMs }
}

/** Outage windows of the recovery lines in events[] (latest 200 lines). */
const lineWindows = (lines: LogRow[]): OutageWindow[] =>
  lines.filter(isRecovery).map((e) => ({ downAtMs: Date.parse(e.timestamp) - (e.durationMs as number), upAtMs: Date.parse(e.timestamp) }))

/** The engine's own window per process (lastRecoveredAt − lastOutageMs … lastRecoveredAt), when it sends lastRecoveredAt. */
const engineWindows = (list: Dependency[]): OutageWindow[] =>
  list.flatMap((d) => (d.lastRecoveredAt && d.lastOutageMs ? [{ downAtMs: Date.parse(d.lastRecoveredAt) - d.lastOutageMs, upAtMs: Date.parse(d.lastRecoveredAt) }] : []))

/** The last finished outage of one target: from the engine's rows when they carry lastRecoveredAt, else from its lines. */
function lastOutage(list: Dependency[], lines: LogRow[]): { downAtMs: number; upAtMs: number; ms: number } | null {
  const fromEngine = engineWindows(list)
  return outageUnion(fromEngine.length ? fromEngine : lineWindows(lines))
}

/**
 * One row per dependency target (type + name + host + port), problems first. An older engine reports a dependency per
 * service / role / name with its latest host, and its `since` / `lastOutageMs` mix hosts (`since` is the latest
 * dependency.up, a first connect included). So the outage is taken from the engine's rows when they carry
 * lastRecoveredAt (rows keyed by host:port), else rebuilt from the target's own lines in events[] (latest 200), and a
 * host the engine no longer reports gets its own row when a finished outage of it is in range. The outage length is
 * outageUnion's, the same on every screen.
 */
export function mergeDependencies(res: DependenciesResponse, fromMs: number): DepRow[] {
  const members = new Map<string, Dependency[]>()
  for (const d of res.dependencies) members.set(targetKey(d), [...(members.get(targetKey(d)) ?? []), d])
  const linesOf = new Map<string, LogRow[]>()
  for (const e of res.events) if (e.dependency) linesOf.set(targetKey(e.dependency), [...(linesOf.get(targetKey(e.dependency)) ?? []), e])
  const targets = new Map<string, Target>([...members].map(([k, list]) => [k, list[0]]))
  for (const [k, lines] of linesOf) {
    const o = lastOutage([], lines)
    if (!targets.has(k) && lines[0].dependency && o && o.upAtMs >= fromMs) targets.set(k, lines[0].dependency)
  }

  const first = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort()[0] ?? null
  const last = (xs: Array<string | null>) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null
  const rows: DepRow[] = []
  for (const [key, t] of targets) {
    const list = members.get(key) ?? []
    const lines = linesOf.get(key) ?? []
    const state: Dependency['state'] = list.length ? list.reduce((a, d) => (STATE_RANK[d.state] < STATE_RANK[a.state] ? d : a)).state : 'up'
    const same = list.filter((d) => d.state === state)
    const outage = state === 'up' ? lastOutage(list, lines) : null
    const recovered = outage !== null && outage.upAtMs >= fromMs
    // down / degraded: since the earliest of them; up: since the latest dependency.up of this host
    const since = state === 'up' ? (last(same.map((d) => d.since)) ?? (outage ? new Date(outage.upAtMs).toISOString() : null)) : first(same.map((d) => d.since))
    const failed = lines.find((e) => e.eventCode === 'http.outbound_failed')
    const downLine = lines.find((e) => e.eventCode === 'dependency.down' || e.eventCode === 'dependency.still_down')
    // failure lines per service/role on this host (an outage seen by two roles is one outage); for a row that is
    // down or degraded now, the engine's own count when events[] (latest 200) holds none of them
    const perUser = new Map<string, number>()
    for (const e of lines) if (FAILURE_LINES.has(e.eventCode)) perUser.set(`${e.service}/${e.role}`, (perUser.get(`${e.service}/${e.role}`) ?? 0) + 1)
    const attempts = perUser.size ? Math.max(...perUser.values()) : state === 'up' ? 0 : Math.max(0, ...list.map((d) => d.attempts))
    const users = list.map((d) => ({ service: d.service, role: d.role }))
    for (const e of lines) if (!users.some((u) => u.service === e.service && u.role === e.role)) users.push({ service: e.service, role: e.role })
    rows.push({
      key,
      type: t.type,
      name: t.name,
      host: t.host,
      port: t.port,
      nodeId: dependencyNodeId(t.type, t.name),
      // /jobs has a row with this host anchor for every host the engine still reports
      anchor: list.length ? depHostAnchor(t) : depAnchor(t.name || t.type),
      state,
      issue: state === 'down' ? 'down' : state === 'degraded' ? 'degraded' : recovered ? 'recovered' : 'ok',
      since,
      lastEventAt: last([...list.map((d) => d.lastEventAt), lines[0]?.timestamp ?? null]),
      attempts,
      outboundFailures: list.length ? list.reduce((a, d) => a + d.outboundFailures, 0) : lines.filter((e) => e.eventCode === 'http.outbound_failed').length,
      downAtMs: recovered ? outage.downAtMs : null,
      upAtMs: recovered ? outage.upAtMs : null,
      lastOutageMs: recovered ? outage.ms : null,
      status: failed?.http?.status || null,
      errorCode: downLine?.error?.code || downLine?.error?.type || '',
      users,
    })
  }
  return rows.sort((a, b) => ISSUE_RANK[a.issue] - ISSUE_RANK[b.issue] || a.name.localeCompare(b.name) || a.host.localeCompare(b.host))
}

// ---------- 3D map ----------

/** The map module's words (lib/3d/system-map.js STATE_TEXT / KIND_TEXT), so a table says what a label says. */
export const MAP_STATE_TEXT: Record<MapNodeState, string> = { ok: 'ปกติ', warn: 'ต้องดู', degraded: 'ทำงานไม่เต็มที่', error: 'มี error', down: 'down' }
export const MAP_KIND_TEXT: Record<string, string> = { service: 'service', worker: 'worker', queue: 'queue', dependency: 'ระบบที่เรียกใช้', external: 'ระบบภายนอก', client: 'ผู้ใช้' }
/** Default rate unit per kind in the module (a node without `rateUnit`). */
export const MAP_RATE_UNIT: Record<string, string> = { service: 'req/min', client: 'req/min', worker: 'job/min', queue: 'msg/min', dependency: 'call/min', external: 'call/min' }
const MAP_STATE_RANK: Record<MapNodeState, number> = { down: 4, error: 3, degraded: 2, warn: 2, ok: 0 }

/** p95 as the map's tooltip prints it: `317 ms`, `2.2 s` (lib/3d/system-map.js fmtMs). */
export function mapMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${fmtCount(Math.round(ms))} ms`
}

/**
 * States on the map by the page's own rule (the health table hint), as the mockup's map data does (DESIGN.md §7c):
 * a service / worker takes its health row's word (ต้องดู or ปกติ, with why as the note), the users node is rated
 * like every other node. Queues and dependencies keep systemMapFromTopology's, built with thresholds at 1 %.
 */
export function mapStates(data: SystemMapData, rows: Map<string, { warn: boolean; note: string | null }>): SystemMapData {
  return {
    ...data,
    nodes: data.nodes.map((n): SystemMapNode => {
      if (n.kind === 'client') return { ...n, state: (n.errorRate ?? 0) >= ERROR_RATE_BAD ? 'error' : 'ok' }
      const row = n.kind === 'service' || n.kind === 'worker' ? rows.get(n.id) : undefined
      if (!row) return n
      return { ...n, state: row.warn ? 'warn' : 'ok', note: row.warn && row.note ? row.note : undefined }
    }),
  }
}

/** Nodes that are not ok, worst first (down, error, degraded / warn), then by error rate and traffic. */
export function problemNodes(data: SystemMapData): SystemMapNode[] {
  return data.nodes
    .filter((n) => n.state !== 'ok')
    .sort((a, b) => MAP_STATE_RANK[b.state] - MAP_STATE_RANK[a.state] || (b.errorRate ?? 0) - (a.errorRate ?? 0) || (b.rpm ?? 0) - (a.rpm ?? 0))
}

/**
 * The phone map (≤ 600 px): the nodes that are not ok and the services / workers on their edges, so a small box
 * shows where it hurts; with nothing failing, lib/topology's phone variant (the busiest parts).
 */
export function phoneProblemMap(data: SystemMapData): SystemMapData {
  const bad = new Set(problemNodes(data).map((n) => n.id))
  if (!bad.size) return phoneMapData(data)
  const kinds = new Map(data.nodes.map((n) => [n.id, n.kind]))
  const isApp = (id: string) => kinds.get(id) === 'service' || kinds.get(id) === 'worker'
  const keep = new Set(bad)
  for (const e of data.edges) {
    if (bad.has(e.from) && isApp(e.to)) keep.add(e.to)
    if (bad.has(e.to) && isApp(e.from)) keep.add(e.from)
  }
  return { nodes: data.nodes.filter((n) => keep.has(n.id)), edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) }
}

/** `Redis "cache"`, `ThaID` — how callouts and chart events name a dependency. */
export function depTitle(d: Pick<DepRow, 'type' | 'name'>, system: (t: string) => string): string {
  return d.type === 'http' ? d.name : `${system(d.type)} "${d.name}"`
}

// ---------- error groups ----------

/** The group with the most occurrences among those matching. */
export function topGroup(groups: ErrorGroup[], match: (g: ErrorGroup) => boolean): ErrorGroup | null {
  return groups.filter(match).sort((a, b) => b.count - a.count)[0] ?? null
}

/** The slowest call inside a trace (CLIENT / PRODUCER spans first: the database or API the time went to). */
export function slowestCall(spans: Array<{ name: string; kind: string; durationMs: number; isEntry: boolean }>) {
  const calls = spans.filter((s) => !s.isEntry && (s.kind === 'CLIENT' || s.kind === 'PRODUCER'))
  const pool = calls.length ? calls : spans.filter((s) => !s.isEntry && s.kind !== 'INTERNAL')
  return pool.sort((a, b) => b.durationMs - a.durationMs)[0] ?? null
}
