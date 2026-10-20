/**
 * Pure derivations for /jobs: queue groups and outcome segments from JobStat, and dependency rows grouped by
 * target (type, name, host, port) with their outages rebuilt from the dependency.* lines and the
 * http.outbound_failed lines that make a dependency "degraded".
 */
import { depAnchor, RANGE_PRESETS, type Scope } from '@/lib/params'
import { moduleName } from '@/lib/readable'
import type { Dependency, JobStat, LogRow } from '@/lib/types'

// ---------- range wording ----------

/** `24 ชั่วโมงล่าสุด`, or `ช่วงที่เลือก` for a custom range. */
export function rangeLabelOf(scope: Pick<Scope, 'preset'>): string {
  return RANGE_PRESETS.find((r) => r.value === scope.preset)?.label ?? 'ช่วงที่เลือก'
}

/** `24 ชั่วโมง` (the preset without ล่าสุด), or `ช่วงนี้`. */
export function rangeShortOf(scope: Pick<Scope, 'preset'>): string {
  const label = RANGE_PRESETS.find((r) => r.value === scope.preset)?.label
  return label ? label.replace(/ล่าสุด$/, '') : 'ช่วงนี้'
}

/** Range length for the Copy-for-AI counts line: `24 h`, `15 min`, `7 d`. */
export function rangeEnglish(ms: number): string {
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3600_000)} h`
  return `${Math.round(ms / 86_400_000)} d`
}

/** Outage length in words: `45.2 วินาที`, `3.5 นาที`, `1.2 ชั่วโมง`. */
export function durationThai(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} วินาที`
  if (ms < 3600_000) return `${(ms / 60_000).toFixed(1)} นาที`
  return `${(ms / 3600_000).toFixed(1)} ชั่วโมง`
}

// ---------- queues ----------

export const MODULE_ORDER = ['bullmq', 'kafka', 'rabbitmq', 'cron', 'task']
export const moduleLabel = (m: string): string => (m ? moduleName(m) : 'อื่น ๆ')
export const isCronLike = (m: string): boolean => m === 'cron' || m === 'task'

/** `report report:generate`: the job key /api/logs and /api/traces take as `route`. */
export const jobKey = (s: { queue: string; type: string }): string => `${s.queue} ${s.type}`

/** What one `started` counts in this system. */
export function unitOf(module: string): string {
  if (module === 'kafka' || module === 'rabbitmq') return 'message'
  if (isCronLike(module)) return 'รอบ'
  return 'attempt'
}

/** Name used in labels: the topic / queue for consumers, the job type otherwise. */
export function statName(s: JobStat): string {
  return s.module === 'kafka' || s.module === 'rabbitmq' ? s.queue : s.type || s.queue
}

export interface Segment {
  n: number
  label: string
  /** Token of the colour (tooltip key). */
  key: 'bar-neutral' | 'warn-solid' | 'danger-solid'
  cls?: string
}

/** Parts of the outcome bar, in order (zeros are kept for the tooltip, dropped from the bar). */
export function outcome(s: JobStat): Segment[] {
  const fail: Segment = { n: s.failed, label: s.failed > 0 ? 'ล้มเหลวจริง' : 'ล้มเหลว', key: 'danger-solid', cls: 'jb-out__fail' }
  if (s.module === 'rabbitmq') {
    const again = Math.min(s.retried, s.finished)
    return [
      { n: s.finished - again, label: s.retried ? 'สำเร็จรอบแรก' : 'สำเร็จ', key: 'bar-neutral' },
      { n: again, label: 'redeliver แล้วสำเร็จ', key: 'warn-solid', cls: 'jb-out__retry' },
      { ...fail, label: 'ล้มเหลว' },
    ]
  }
  const done: Segment = { n: s.finished, label: 'สำเร็จ', key: 'bar-neutral' }
  if (s.module === 'bullmq' || s.retried > 0) return [done, { n: s.retried, label: 'retry', key: 'warn-solid', cls: 'jb-out__retry' }, fail]
  return [done, { ...fail, label: 'ล้มเหลว' }]
}

export interface QueueGroup {
  module: string
  stats: JobStat[]
  /** service/role pairs of the group, first seen first. */
  owners: Array<{ service: string; role: string }>
}

/** One group per queue system, in the design's order (unknown systems last). */
export function queueGroups(stats: JobStat[]): QueueGroup[] {
  const by = new Map<string, QueueGroup>()
  for (const s of stats) {
    let g = by.get(s.module)
    if (!g) by.set(s.module, (g = { module: s.module, stats: [], owners: [] }))
    g.stats.push(s)
    if (!g.owners.some((o) => o.service === s.service && o.role === s.role)) g.owners.push({ service: s.service, role: s.role })
  }
  const rank = (m: string) => {
    const i = MODULE_ORDER.indexOf(m)
    return i < 0 ? MODULE_ORDER.length : i
  }
  return [...by.values()].sort((a, b) => rank(a.module) - rank(b.module) || a.module.localeCompare(b.module))
}

/**
 * Cron schedule guessed from the number of runs in the range (the library does not log the expression):
 * `ทุก 15 นาที`, `ทุกชั่วโมง`; null when the runs do not fit a round interval.
 */
export function cronEvery(started: number, rangeMs: number): string | null {
  if (started < 3) return null
  const every = rangeMs / started
  const nice = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440].map((m) => m * 60_000)
  const hit = nice.find((n) => Math.abs(every - n) / n < 0.06)
  if (!hit) return null
  const min = hit / 60_000
  if (min < 60) return `ทุก ${min} นาที`
  if (min === 60) return 'ทุกชั่วโมง'
  if (min < 1440) return `ทุก ${min / 60} ชั่วโมง`
  return 'ทุกวัน'
}

/** The queue whose failures get their own section: most real failures, then most retries (redeliveries stay in their row). */
export function featuredStat(stats: JobStat[]): JobStat | null {
  const list = stats.filter((s) => s.failed > 0 || (s.retried > 0 && s.module !== 'rabbitmq'))
  list.sort((a, b) => b.failed - a.failed || b.retried - a.retried)
  return list[0] ?? null
}

/** Label of a consumer.* line in the events column. */
export function consumerEventLabel(row: LogRow): string {
  switch (row.eventCode) {
    case 'consumer.rebalancing':
      return 'consumer group rebalance'
    case 'consumer.joined':
      return 'consumer joined group'
    case 'consumer.crashed':
      return 'consumer crashed'
    default:
      return row.message || row.eventCode
  }
}

/** Partitions of a consumer line (`[0,1,2]` → `0,1,2`), '' when absent. */
export function partitionsOf(row: LogRow): string {
  return (row.fields['partitions'] ?? '').replace(/^\[|\]$/g, '')
}

// ---------- dependencies ----------

export interface Outage {
  start: number
  /** null = still down at `to`. */
  end: number | null
  /** dependency.down / still_down / up lines of it, oldest first. */
  lines: LogRow[]
  /** The library's own length (duration_ms of the up line), else end - start. */
  durationMs: number | null
}

export interface DepRow {
  /**
   * Element id (callouts link to it): `dep-<name>` for the most relevant row of that name (down, degraded, then an
   * outage in range), `dep-<name>-<host>-<port>` for the others.
   */
  id: string
  /** `dep-<name>-<host>-<port>` on every row (depHostAnchor), so a link to one target lands on it. */
  hostId: string
  type: string
  name: string
  host: string
  port: number
  members: Dependency[]
  /** Who wrote lines for this target: the members, then processes whose latest host is another one now. */
  users: Array<{ service: string; role: string }>
  state: Dependency['state']
  since: string | null
  lastEventAt: string | null
  attempts: number
  outboundFailures: number
  /** dependency.* lines in the range, newest first. */
  stateLines: LogRow[]
  /** http.outbound_failed lines in the range, newest first. */
  outbound: LogRow[]
  /** Merged over pods and roles, oldest first. */
  outages: Outage[]
}

const STATE_RANK: Record<string, number> = { down: 2, degraded: 1, up: 0 }

const sameTarget = (r: LogRow, d: Pick<Dependency, 'type' | 'name' | 'host' | 'port'>) =>
  !!r.dependency && r.dependency.type === d.type && r.dependency.name === d.name && r.dependency.host === d.host && r.dependency.port === d.port

/** `host:port`; outside HTTPS / HTTP APIs show the host only. */
export function hostPort(d: { type: string; host: string; port: number }): string {
  if (!d.port || (d.type === 'http' && (d.port === 443 || d.port === 80))) return d.host
  return `${d.host}:${d.port}`
}

/** `Redis`, `Kafka`, `RabbitMQ`, `Oracle`, … for sentences. */
export function typeLabel(type: string): string {
  const known: Record<string, string> = { redis: 'Redis', kafka: 'Kafka', rabbitmq: 'RabbitMQ', oracle: 'Oracle', postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB', http: 'API' }
  return known[type] ?? type
}

/** `Redis "redis"`, `ThaID`: a dependency in a sentence (no `redis redis` when the name repeats the type). */
export function depName(d: { type: string; name: string }): string {
  if (d.type === 'http' || !d.name) return d.name || typeLabel(d.type)
  return `${typeLabel(d.type)} "${d.name}"`
}

/** Outages of one pod's lines (oldest first) by the down → still_down → up sequence. */
function podOutages(lines: LogRow[], member: Dependency | undefined, fromMs: number): Outage[] {
  const out: Outage[] = []
  let open: Outage | null = null
  for (const r of lines) {
    const t = Date.parse(r.timestamp)
    if (r.eventCode === 'dependency.down') {
      if (open) open.lines.push(r)
      else open = { start: t, end: null, lines: [r], durationMs: null }
    } else if (r.eventCode === 'dependency.still_down') {
      if (open) open.lines.push(r)
      else open = { start: Math.max(fromMs, t - (r.durationMs ?? 0)), end: null, lines: [r], durationMs: null }
    } else if (r.eventCode === 'dependency.up') {
      if (open) {
        open.lines.push(r)
        open.end = t
        open.durationMs = r.durationMs ?? t - open.start
        out.push(open)
        open = null
      } else if (r.durationMs) {
        // recovered from an outage that began before the range
        out.push({ start: Math.max(fromMs, t - r.durationMs), end: t, lines: [r], durationMs: r.durationMs })
      }
    }
  }
  if (open) out.push(open)
  // down for the whole range: no lines, but the engine says down since before `from`
  if (!lines.length && member?.state === 'down' && member.since) {
    out.push({ start: Math.max(fromMs, Date.parse(member.since)), end: null, lines: [], durationMs: null })
  }
  return out
}

/** Start of an outage's window as the library measured it: its up line minus its length. */
const windowStart = (o: Outage) => (o.end !== null && o.durationMs !== null ? o.end - o.durationMs : o.start)

function mergeOutages(list: Outage[]): Outage[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Outage[] = []
  for (const o of sorted) {
    const last = out[out.length - 1]
    if (last && (last.end === null || o.start <= last.end + 1000)) {
      // the union of the processes' windows, the length overview, errors and about show (outageUnion)
      const from = Math.min(windowStart(last), windowStart(o))
      last.end = last.end === null || o.end === null ? null : Math.max(last.end, o.end)
      last.lines = [...last.lines, ...o.lines].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      last.durationMs =
        last.durationMs === null || o.durationMs === null
          ? (last.durationMs ?? o.durationMs)
          : last.end === null
            ? Math.max(last.durationMs, o.durationMs)
            : last.end - from
    } else out.push({ ...o, lines: [...o.lines] })
  }
  return out
}

/** `dep-redis-10-0-3-21-6379`: anchor of one target on /jobs (every dependency row carries it; /overview links to it). */
export function depHostAnchor(d: { type: string; name: string; host: string; port: number }): string {
  const host = d.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${depAnchor(d.name || d.type)}-${host || 'x'}-${d.port}`
}

/** Dependency rows, one per target, with the lines that set their state. Down first, then degraded, then by name. */
export function depRows(deps: Dependency[], events: LogRow[], fromMs: number): DepRow[] {
  const by = new Map<string, Dependency[]>()
  for (const d of deps) {
    const key = `${d.type}|${d.name}|${d.host}|${d.port}`
    by.set(key, [...(by.get(key) ?? []), d])
  }
  const rows: DepRow[] = []
  for (const members of by.values()) {
    const d0 = members[0]
    // every line on this target, also from a process whose latest host is another one now (the engine keys a
    // dependency by service / role / name and keeps the latest host, so those lines belong to no other row)
    const mine = events.filter((r) => sameTarget(r, d0))
    const users = members.map((m) => ({ service: m.service, role: m.role }))
    for (const r of mine) if (!users.some((u) => u.service === r.service && u.role === r.role)) users.push({ service: r.service, role: r.role })
    const stateLines = mine.filter((r) => r.eventCode.startsWith('dependency.'))
    const outbound = mine.filter((r) => r.eventCode === 'http.outbound_failed')
    // outages per pod (service / role / host), oldest line first
    const pods = new Map<string, LogRow[]>()
    for (const r of [...stateLines].reverse()) {
      const k = `${r.service}/${r.role}/${r.host}`
      pods.set(k, [...(pods.get(k) ?? []), r])
    }
    let outages: Outage[] = []
    for (const lines of pods.values()) {
      const m = members.find((x) => x.service === lines[0].service && x.role === lines[0].role)
      outages.push(...podOutages(lines, m, fromMs))
    }
    for (const m of members) if (m.state === 'down' && !stateLines.some((r) => r.service === m.service && r.role === m.role)) outages.push(...podOutages([], m, fromMs))
    outages = mergeOutages(outages)

    const state = members.reduce<Dependency['state']>((s, m) => (STATE_RANK[m.state] > STATE_RANK[s] ? m.state : s), 'up')
    const inState = members.filter((m) => m.state === state && m.since)
    const sinces = inState.map((m) => m.since as string).sort()
    const since = state === 'up' ? (sinces[sinces.length - 1] ?? null) : (sinces[0] ?? null)
    const lastEventAt = members.map((m) => m.lastEventAt).filter((x): x is string => !!x).sort().pop() ?? null

    rows.push({
      id: '',
      hostId: depHostAnchor(d0),
      type: d0.type,
      name: d0.name,
      host: d0.host,
      port: d0.port,
      members,
      users,
      state,
      since,
      lastEventAt,
      attempts: members.reduce((n, m) => n + m.attempts, 0),
      outboundFailures: members.reduce((n, m) => n + m.outboundFailures, 0),
      stateLines,
      outbound,
      outages,
    })
  }
  rows.sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || a.name.localeCompare(b.name) || a.host.localeCompare(b.host))
  // `dep-<name>` (map nodes and other screens link by name) goes to the row worth landing on: down, degraded, then
  // the latest outage in range; the other rows of that name keep their host anchor
  const relevance = (r: DepRow) => (r.state === 'down' ? 3 : r.state === 'degraded' ? 2 : r.outages.length ? 1 : 0)
  const latestStart = (r: DepRow) => r.outages[r.outages.length - 1]?.start ?? 0
  const byName = new Map<string, DepRow[]>()
  for (const r of rows) {
    const bare = depAnchor(r.name || r.type)
    byName.set(bare, [...(byName.get(bare) ?? []), r])
  }
  for (const [bare, list] of byName) {
    const best = [...list].sort((a, b) => relevance(b) - relevance(a) || latestStart(b) - latestStart(a))[0]
    for (const r of list) r.id = r === best ? bare : r.hostId
  }
  return rows
}

/** Length shown for an outage: the library's duration, else start → end (or → `toMs` while down). */
export function outageMs(o: Outage, toMs: number): number {
  return o.durationMs ?? (o.end ?? toMs) - o.start
}

/** `401 × 18` per HTTP status of the outbound lines (most frequent first). */
export function statusCounts(lines: LogRow[]): Array<{ status: number; n: number }> {
  const m = new Map<number, number>()
  for (const r of lines) {
    const s = r.http?.status ?? 0
    if (s) m.set(s, (m.get(s) ?? 0) + 1)
  }
  return [...m.entries()].map(([status, n]) => ({ status, n })).sort((a, b) => b.n - a.n)
}

/** Error codes of an outage's lines: `ECONNREFUSED 3 ครั้ง`. */
export function codeCounts(lines: LogRow[]): Array<{ code: string; n: number }> {
  const m = new Map<string, number>()
  for (const r of lines) if (r.error?.code) m.set(r.error.code, (m.get(r.error.code) ?? 0) + 1)
  return [...m.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n)
}

/** `dependency.affects` of a line (`["cache"]` → `cache`). */
export function affectsOf(row: LogRow): string {
  const raw = row.fields['dependency.affects']
  if (!raw) return ''
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.join(', ') : String(v)
  } catch {
    return raw
  }
}

/** Advice for an API that answers 4xx (callout text). */
export function rejectAdvice(name: string, status: number, hint: string): string {
  if (status === 401 || status === 403) return `ตรวจ credentials ของ ${name}`
  if (status === 404) return `ตรวจ URL ที่เรียก ${name}`
  if (status === 429) return `${name} จำกัดจำนวน request`
  return hint
}
