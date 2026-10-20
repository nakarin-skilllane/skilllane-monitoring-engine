/**
 * GET /api/topology → data for the 3D system map (<SystemMap3D data={…} />, lib/3d/system-map.js).
 * Isomorphic and type-only towards the 3D module, so a server component can build the data.
 *
 *   const topo = await engine.topology(scopeQuery(scope))
 *   const data = topo.ok ? systemMapFromTopology(topo.data, { href: (n) => … }) : null
 *
 * Kinds: clients → 'client' (ผู้ใช้), service SERVER → block, other entry kinds → worker, queue → conveyor,
 * dependency http / aws-api → dome (outside API), others → drum (database, cache).
 * A watched dependency without spans (calls 0) has no known rate: rpm / errorRate null, no number in the scene.
 * Labels: the engine names dependency nodes itself ('Oracle', 'Redis queue', 'AWS S3'); a raw label from older data
 * (SDK names joined with ' / ', a bare host) is made readable here, so the map and any table agree (topologyLabels).
 * Ids: `clients`, `service:<service>/<role>`, `queue:<name>`, `dependency:<type>:<name>` (dependencyNodeFor finds
 * the node of a /api/dependencies row).
 */
import type { MapNodeKind, MapNodeState, SystemMapData, SystemMapEdge, SystemMapNode } from './3d/system-map'
import { moduleName, systemLabel } from './readable'
import type { Dependency, Topology, TopologyNode } from './types'

export interface TopologyMapOptions {
  /** errorRate → state of services, queues and dependencies (default warn ≥ 0.1 %, error ≥ 1 %). */
  thresholds?: { warn?: number; error?: number }
  /** Link of a node (app path); none when it returns undefined. */
  href?: (node: TopologyNode) => string | undefined
  /** Leave out the "ผู้ใช้" node and its edges (default false). */
  hideClients?: boolean
}

const OUTSIDE = new Set(['http', 'aws-api'])
const MESSAGE_QUEUES = new Set(['kafka', 'rabbitmq'])

/** First host of a dependency + how many more ("10.0.3.22:6379 +1"): `host` lists every host it was seen on. */
function hostSummary(host: string): string {
  const hosts = host.split(', ').filter(Boolean)
  return hosts.length > 1 ? `${hosts[0]} +${hosts.length - 1}` : (hosts[0] ?? '')
}

function stateOf(errorRate: number, th: { warn: number; error: number }): MapNodeState {
  return errorRate >= th.error ? 'error' : errorRate >= th.warn ? 'warn' : 'ok'
}

export function systemMapFromTopology(topology: Topology, options: TopologyMapOptions = {}): SystemMapData {
  const th = { warn: 0.001, error: 0.01, ...options.thresholds }
  const labels = topologyLabels(topology)
  const skip = new Set(options.hideClients ? topology.nodes.filter((n) => n.kind === 'clients').map((n) => n.id) : [])
  const byId = new Map(topology.nodes.map((n) => [n.id, n]))
  // a consumer fed only by Kafka / RabbitMQ counts messages; one with any job queue counts jobs
  const consumed = new Map<string, string[]>()
  for (const e of topology.edges) if (e.kind === 'consume') consumed.set(e.target, [...(consumed.get(e.target) ?? []), byId.get(e.source)?.type ?? ''])
  const fedByMessages = new Set([...consumed].filter(([, types]) => types.every((t) => MESSAGE_QUEUES.has(t))).map(([id]) => id))

  const nodes: SystemMapNode[] = []
  for (const n of topology.nodes) {
    if (skip.has(n.id)) continue
    const known = n.requests > 0
    const base = { id: n.id, href: options.href?.(n), p95Ms: n.p95Ms || null }
    if (n.kind === 'clients') {
      nodes.push({ ...base, kind: 'client', label: 'ผู้ใช้', sublabel: 'เว็บ · แอป', rpm: n.callsPerMin, errorRate: n.errorRate, state: 'ok' })
    } else if (n.kind === 'service') {
      const kind: MapNodeKind = n.type === 'SERVER' ? 'service' : 'worker'
      nodes.push({
        ...base,
        kind,
        service: n.service,
        label: n.service || n.label,
        sublabel: n.role ? `/${n.role}` : undefined,
        rpm: n.callsPerMin,
        errorRate: n.errorRate,
        rateUnit: kind === 'service' ? 'req/min' : fedByMessages.has(n.id) ? 'msg/min' : 'job/min',
        state: stateOf(n.errorRate, th),
      })
    } else if (n.kind === 'queue') {
      nodes.push({
        ...base,
        kind: 'queue',
        label: labels.get(n.id) ?? n.label,
        sublabel: n.type || undefined,
        rpm: known ? n.callsPerMin : null,
        errorRate: known ? n.errorRate : null,
        rateUnit: MESSAGE_QUEUES.has(n.type) ? 'msg/min' : n.type === 'cron' ? 'run/min' : 'job/min',
        state: known ? stateOf(n.errorRate, th) : 'ok',
      })
    } else {
      const outside = OUTSIDE.has(n.type)
      const state: MapNodeState = n.state === 'down' ? 'down' : n.state === 'degraded' ? 'degraded' : known ? stateOf(n.errorRate, th) : 'ok'
      nodes.push({
        ...base,
        kind: outside ? 'external' : 'dependency',
        label: labels.get(n.id) ?? n.label,
        sublabel: [n.type, hostSummary(n.host)].filter(Boolean).join(' · ') || undefined,
        rpm: known ? n.callsPerMin : null,
        errorRate: known ? n.errorRate : null,
        state,
        note: n.state === 'down' ? 'down อยู่' : undefined,
      })
    }
  }

  const edges: SystemMapEdge[] = topology.edges
    .filter((e) => !skip.has(e.source) && !skip.has(e.target))
    .map((e) => ({ from: e.source, to: e.target, rpm: e.calls > 0 ? e.callsPerMin : null, errorRate: e.calls > 0 ? e.errorRate : null }))

  return { nodes, edges }
}

// ---------- labels ----------

/** Well-known outside APIs by host (same names as the engine's own labels). */
const HOST_LABEL: Record<string, string> = {
  'sheets.googleapis.com': 'Google Sheets',
  'fcm.googleapis.com': 'Firebase Cloud Messaging',
  'imauth.bora.dopa.go.th': 'ThaID',
}

const INTERNAL_HOST = /\.(internal|local|lan|svc|cluster\.local)$/i
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** Hosts of a topology node (`host` may list several: "localhost:6391, 10.0.3.22:6379"), without ports. */
export function hostsOf(host: string): string[] {
  return host
    .split(',')
    .map((h) => h.trim().replace(/:\d+$/, ''))
    .filter(Boolean)
}

/** A label the engine did not make readable: SDK names joined with ' / ', a bare lower-case SDK name, a host, the type. */
function isRaw(n: Pick<TopologyNode, 'label' | 'type' | 'names'>): boolean {
  const l = n.label.trim()
  if (!l || l.includes(' / ') || /[.:]/.test(l) || l === n.type) return true
  if (n.names.includes(l) && l === l.toLowerCase()) return true
  return n.type === 'aws-api' && /^[A-Z0-9]{2,8}$/.test(l)
}

/** Readable name of a dependency node: the engine's label ('Redis queue', 'AWS S3'), else one made from its names / host. */
export function dependencyLabel(n: Pick<TopologyNode, 'label' | 'type' | 'host' | 'names'>): string {
  if (!isRaw(n)) return n.label
  const host = hostsOf(n.host)[0] ?? ''
  if (HOST_LABEL[host]) return HOST_LABEL[host]
  const sys = systemLabel(n.type)
  const known = sys !== n.type
  if (n.names.length) {
    // SDK names ('cache', 'queue', 'ThaID'); a client named after its own system ('redis') adds nothing
    const names = n.names.filter((x) => x.toLowerCase() !== n.type.toLowerCase())
    if (!names.length) return known ? sys : n.names[0]
    const name = names.join(' / ')
    return n.type === 'http' || !known ? name : `${sys} ${name}`
  }
  if (n.type === 'aws-api') return `AWS ${n.label}`
  if (host && (INTERNAL_HOST.test(host) || !host.includes('.'))) {
    let first = host.split('.')[0]
    if (first.toLowerCase().startsWith(`${n.type.toLowerCase()}-`)) first = first.slice(n.type.length + 1)
    return known && n.type !== 'http' ? `${sys} ${first}` : first
  }
  if (IPV4.test(host) && known) return `${sys} ${host}`
  return n.label || host
}

/**
 * Node id → readable label for every topology node: `ผู้ใช้`, `service/role`, `BullMQ report`, dependencies as
 * dependencyLabel (two with the same label get their first host). The map and the call table both use it.
 */
export function topologyLabels(topology: Topology): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of topology.nodes) {
    if (n.kind === 'clients') out.set(n.id, 'ผู้ใช้')
    else if (n.kind === 'service') out.set(n.id, `${n.service}/${n.role}`)
    else if (n.kind === 'queue') {
      const system = n.type ? moduleName(n.type) : ''
      out.set(n.id, system && system !== n.label ? `${system} ${n.label}` : n.label)
    } else out.set(n.id, dependencyLabel(n))
  }
  const count = new Map<string, number>()
  for (const v of out.values()) count.set(v, (count.get(v) ?? 0) + 1)
  for (const n of topology.nodes) {
    const label = out.get(n.id) ?? ''
    if (n.kind === 'dependency' && (count.get(label) ?? 0) > 1 && n.host) out.set(n.id, `${label} (${hostsOf(n.host)[0]})`)
  }
  return out
}

// ---------- ids ----------

export const serviceNodeId = (service: string, role: string) => `service:${service}/${role}`
export const dependencyNodeId = (type: string, name: string) => `dependency:${type}:${name}`

/**
 * Map node of a /api/dependencies row: the dependency node of the same type that carries its SDK name, else the one
 * seen on its host:port, else the id it would have (`dependency:<type>:<name>`).
 */
export function dependencyNodeFor(d: Pick<Dependency, 'type' | 'name' | 'host' | 'port'>, topology: Topology | null): string {
  const hostPort = d.port ? `${d.host}:${d.port}` : d.host
  const deps = topology?.nodes.filter((n) => n.kind === 'dependency') ?? []
  const hit =
    deps.find((n) => n.id === dependencyNodeId(d.type, d.name)) ??
    deps.find((n) => n.type === d.type && n.names.includes(d.name)) ??
    deps.find((n) => n.host.split(',').map((h) => h.trim()).includes(hostPort))
  return hit?.id ?? dependencyNodeId(d.type, d.name)
}

// ---------- phone variant ----------

const PHONE_QUEUES = 2
const PHONE_DEPENDENCIES = 4

/**
 * The map for phones (≤ 600 px): every service / worker (and the users node when present), the busiest queues and
 * the dependencies that have a problem or the most calls; edges between kept nodes only. A table keeps every line.
 */
export function phoneMapData(data: SystemMapData): SystemMapData {
  const pick = (kinds: string[], max: number) =>
    data.nodes
      .filter((n) => kinds.includes(n.kind))
      .sort((a, b) => Number(b.state !== 'ok') - Number(a.state !== 'ok') || (b.rpm ?? 0) - (a.rpm ?? 0))
      .slice(0, max)
  const keep = new Set([
    ...data.nodes.filter((n) => n.kind === 'service' || n.kind === 'worker' || n.kind === 'client').map((n) => n.id),
    ...pick(['queue'], PHONE_QUEUES).map((n) => n.id),
    ...pick(['dependency', 'external'], PHONE_DEPENDENCIES).map((n) => n.id),
  ])
  return { nodes: data.nodes.filter((n) => keep.has(n.id)), edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) }
}
