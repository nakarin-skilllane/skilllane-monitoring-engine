/**
 * System map (GET /api/topology): who calls whom in the range, from spans.
 *
 * Nodes: `clients` (callers outside the data), services (service + role),
 * queues (job / message queues), dependencies (databases, caches, external
 * HTTP APIs, cloud APIs; one per type + name, whatever host they were seen on:
 * the name the SDK's dependency.* lines give that host:port, else the database
 * system, the rpc service or the HTTP host). Edges:
 * - clients → service: root SERVER entry spans;
 * - service → service: CLIENT spans whose peer answered with an entry span of
 *   another service (HTTP; a parent that is not a CLIENT span links directly);
 * - service → queue (produce): the distinct parents (in the producing service)
 *   of a consumer's entry spans, so job retries count once, or a PRODUCER span
 *   with a destination (then that span alone, not its consumers' parent link);
 * - queue → service (consume): CONSUMER / INTERNAL entry spans (cron and task
 *   runs use the queue `cron` / `task`);
 * - service → dependency: the other CLIENT / PRODUCER spans, plus the
 *   dependencies the SDK watches (dependency.* lines) even without spans.
 * Errors = span status ERROR or HTTP >= 500 (as everywhere); clientErrors = HTTP 4xx.
 * p95 of an edge and of a queue / dependency / clients node is taken over every
 * span that feeds it (a log-scale duration histogram per row, merged here), never
 * the highest p95 of its parts.
 * The SDK sets status ERROR on an outbound (CLIENT) 4xx, so on service → service
 * and service → dependency edges the 4xx calls are counted in both.
 */
import { Injectable } from '@nestjs/common'
import { type Dependency, OpsService } from './ops.service'
import { type Common, type QueryString, parseCommon } from './params'
import { Reader, Where, msParam, num, ratio, scoped, scopedMinutes } from './sql'

export type TopologyNodeKind = 'clients' | 'service' | 'queue' | 'dependency'
export type TopologyEdgeKind = 'http' | 'db' | 'rpc' | 'produce' | 'consume' | 'call'

export interface TopologyNode {
  /** `clients` · `service:<service>/<role>` · `queue:<name>` · `dependency:<type>:<name>`. */
  id: string
  kind: TopologyNodeKind
  /** dependency: readable name (Oracle, Redis queue, AWS S3, Google Sheets, ThaID, attendance-api); others: service/role, queue name, clients. */
  label: string
  /** service: entry span kind (SERVER, CONSUMER); queue: bullmq, kafka, rabbitmq, cron, task or ''; dependency: oracle, redis, http, aws-api …; clients: ''. */
  type: string
  service: string
  role: string
  /** dependency: the host:port it was seen on, several joined with ', ' (most calls first); '' otherwise. */
  host: string
  /** The name the SDK's dependency.* lines use for it (redis, queue, ThaID); [] when not watched. */
  names: string[]
  /** service: entry spans (route_stats_1m); dependency: calls of its incoming edges; queue: messages consumed (outgoing edges); clients: requests sent. */
  requests: number
  errors: number
  errorRate: number
  callsPerMin: number
  /** service: p95 of entry spans; other nodes: p95 over every span of the edges counted in requests (0 when they have none). */
  p95Ms: number
  /** dependency: the worst Dependency.state of its names (null when the SDK does not watch it); others null. */
  state: Dependency['state'] | null
}

export interface TopologyEdge {
  /** `<source>-><target>`. */
  id: string
  source: string
  target: string
  kind: TopologyEdgeKind
  calls: number
  errors: number
  /**
   * HTTP 4xx answers. On clients → service edges they are not in `errors`; on
   * CLIENT-span edges (service → service / dependency) the SDK marks an outbound
   * 4xx as ERROR, so they are in `errors` too (never add the two).
   */
  clientErrors: number
  callsPerMin: number
  errorRate: number
  /** 0 for produce edges and watched dependencies without spans. */
  avgMs: number
  /** p95 over every span of the edge (all peers merged); 0 like avgMs. */
  p95Ms: number
}

export interface Topology {
  range: { from: string; to: string; minutes: number }
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

const IS_ERROR = `(status_code = 'ERROR' OR http_status >= 500)`
const IS_4XX = `(http_status >= 400 AND http_status < 500)`
const QUEUE_OF = `if(attributes['messaging.destination.name'] != '', attributes['messaging.destination.name'], splitByChar(' ', name)[1])`
/** Log-scale duration buckets: 32 per doubling (±1.1 %) over microseconds, so p95 merges across rows. */
const HIST_PER_DOUBLING = 32
const STATS = `count() AS calls, countIf(${IS_ERROR}) AS errors, countIf(${IS_4XX}) AS client_errors,
       avg(duration_ns) / 1e6 AS avg_ms,
       sumMap([toUInt16(round(log2(greatest(duration_ns, 1000) / 1000) * ${HIST_PER_DOUBLING}))], [toUInt32(1)]) AS hist`
/** A consumer may start a while after its producer's span. */
const PARENT_LOOKBACK_MS = 3600_000
const STATE_RANK: Record<Dependency['state'], number> = { up: 0, degraded: 1, down: 2 }
/** Same lookback as Dependency states. */
const DEPENDENCY_LOOKBACK_MS = 7 * 86_400_000
const NODE_ORDER: Record<TopologyNodeKind, number> = { clients: 0, service: 1, queue: 2, dependency: 3 }

/** Duration histogram: bucket key → spans (see STATS). */
type Hist = Map<number, number>

interface Stats {
  calls: number
  errors: number
  client_errors: number
  avg_ms: number
  /** sumMap result: [bucket keys, counts]. */
  hist: [number[], number[]]
}

function addHist(into: Hist, from: Hist | Stats['hist'] | undefined): void {
  if (!from) return
  if (from instanceof Map) {
    for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v)
    return
  }
  const [keys, counts] = from
  keys.forEach((k, i) => into.set(k, (into.get(k) ?? 0) + Number(counts[i] ?? 0)))
}

/** p95 (ms) of a merged histogram: the bucket holding the 95th-percentile span, 0 when empty. */
function histP95(h: Hist): number {
  let total = 0
  for (const v of h.values()) total += v
  if (!total) return 0
  const rank = Math.ceil(total * 0.95)
  let seen = 0
  for (const k of [...h.keys()].sort((a, b) => a - b)) {
    seen += h.get(k)!
    if (seen >= rank) return num(2 ** (k / HIST_PER_DOUBLING) / 1000, 1)
  }
  return 0
}

const svc = (service: string, role: string) => `service:${service}/${role}`

const SYSTEM_LABEL: Record<string, string> = {
  oracle: 'Oracle', redis: 'Redis', postgresql: 'PostgreSQL', mysql: 'MySQL', mssql: 'SQL Server', mongodb: 'MongoDB',
  kafka: 'Kafka', rabbitmq: 'RabbitMQ', 'aws-api': 'AWS', smtp: 'SMTP', http: 'HTTP',
}
const GOOGLE_API: Record<string, string> = {
  sheets: 'Google Sheets', fcm: 'Firebase Cloud Messaging', drive: 'Google Drive', gmail: 'Gmail', oauth2: 'Google OAuth',
}
const IP_OR_LOCALHOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f]*:[0-9a-f:]+\]?)$/i

/** An HTTP host by what it is: Google Sheets, AWS S3, attendance-api (private DNS), else the host. */
function hostLabel(host: string, system: string): string {
  if (IP_OR_LOCALHOST.test(host)) return `${system} ${host}`
  const bare = host.replace(/^www\./, '')
  const [first, ...rest] = bare.split('.')
  const domain = rest.join('.')
  if (!domain) return bare
  if (domain === 'googleapis.com') return GOOGLE_API[first] ?? `Google ${first}`
  if (domain.endsWith('amazonaws.com')) return `AWS ${first.toUpperCase()}`
  if (/(^|\.)(internal|local|svc|lan)$/.test(domain)) return first
  return bare
}

/** Readable label of a dependency node: Oracle · Redis · Redis queue · AWS S3 · ThaID · Google Sheets. */
export function dependencyLabel(type: string, name: string): string {
  const system = SYSTEM_LABEL[type] ?? type
  if (!name || name === type) return system
  if (type === 'http' || name.includes('.') || IP_OR_LOCALHOST.test(name)) return hostLabel(name, system)
  // the SDK's own names for unnamed clients: redis-db2, redis-cluster
  return `${system} ${name.startsWith(`${type}-`) ? name.slice(type.length + 1) : name}`
}

@Injectable()
export class TopologyService {
  constructor(
    private readonly reader: Reader,
    private readonly ops: OpsService,
  ) {}

  async topology(q: QueryString): Promise<Topology> {
    const c = parseCommon(q)
    // Edges are read for every service; service / role keep the edges touching it.
    const all: Common = { ...c, service: undefined, role: undefined }
    const w = scoped(all)
    const children = `SELECT parent_span_id FROM skilllane_monitoring.spans WHERE ${w.sql} AND is_entry = 1 AND parent_span_id != ''`
    const parents = new Where().add(
      `timestamp >= ${msParam('lookMs')} AND timestamp <= ${msParam('toMs')}`,
      { lookMs: c.fromMs - PARENT_LOOKBACK_MS, toMs: c.toMs },
    )
    if (c.env) parents.add('env = {env:String}', { env: c.env })
    const red = scopedMinutes(all)
    const named = new Where().add(
      `dependency_name != '' AND timestamp >= ${msParam('lookMs')} AND timestamp <= ${msParam('toMs')}`,
      { lookMs: c.toMs - DEPENDENCY_LOOKBACK_MS, toMs: c.toMs },
    )
    if (c.env) named.add('env = {env:String}', { env: c.env })

    const [entries, links, clients, services, queues, dependencies, hostNames] = await Promise.all([
      this.reader.rows<Stats & { service: string; role: string; kind: string; root: number; queue: string; system: string }>(
        'topology.entries',
        `SELECT service, role, kind, parent_span_id = '' AS root,
                if(kind = 'SERVER', '', ${QUEUE_OF}) AS queue,
                anyIf(attributes['messaging.system'], attributes['messaging.system'] != '') AS system,
                ${STATS}
         FROM skilllane_monitoring.spans WHERE ${w.sql} AND is_entry = 1
         GROUP BY service, role, kind, root, queue`,
        w.params,
      ),
      this.reader.rows<{
        from_service: string
        from_role: string
        from_kind: string
        from_peer: string
        to_service: string
        to_role: string
        to_kind: string
        queue: string
        calls: number
        parents: number
      }>(
        'topology.links',
        `SELECT p.service AS from_service, p.role AS from_role, p.kind AS from_kind, p.peer AS from_peer,
                c.service AS to_service, c.role AS to_role, c.kind AS to_kind, c.queue AS queue, count() AS calls,
                uniqExact(c.trace_id, c.parent_span_id) AS parents
         FROM (
           SELECT trace_id, parent_span_id, service, role, kind, if(kind = 'SERVER', '', ${QUEUE_OF}) AS queue
           FROM skilllane_monitoring.spans WHERE ${w.sql} AND is_entry = 1 AND parent_span_id != ''
         ) AS c
         INNER JOIN (
           SELECT trace_id, span_id, service, role, kind, peer
           FROM skilllane_monitoring.spans WHERE ${parents.sql} AND span_id IN (${children})
         ) AS p ON p.trace_id = c.trace_id AND p.span_id = c.parent_span_id
         WHERE p.service != c.service OR p.role != c.role
         GROUP BY from_service, from_role, from_kind, from_peer, to_service, to_role, to_kind, queue`,
        { ...w.params, ...parents.params },
      ),
      this.reader.rows<
        Stats & {
          service: string
          role: string
          kind: string
          peer: string
          db_system: string
          is_http: number
          rpc_system: string
          rpc_service: string
          destination: string
          bull: number
        }
      >(
        'topology.clients',
        `SELECT service, role, kind, peer, db_system, http_method != '' AS is_http,
                attributes['rpc.system'] AS rpc_system, attributes['rpc.service'] AS rpc_service,
                if(kind = 'PRODUCER', attributes['messaging.destination.name'], '') AS destination,
                db_system = 'redis' AND position(db_statement, 'bull:') > 0 AS bull,
                ${STATS}
         FROM skilllane_monitoring.spans WHERE ${w.sql} AND is_entry = 0 AND kind IN ('CLIENT', 'PRODUCER')
         GROUP BY service, role, kind, peer, db_system, is_http, rpc_system, rpc_service, destination, bull`,
        w.params,
      ),
      this.reader.rows<{ service: string; role: string; kind: string; requests: number; errors: number; q: number[] }>(
        'topology.services',
        `SELECT service, role, anyHeavy(kind) AS kind, sum(requests) AS requests, sum(errors) AS errors,
                quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q) AS q
         FROM skilllane_monitoring.route_stats_1m WHERE ${red.sql}
         GROUP BY service, role`,
        red.params,
      ),
      this.reader.rows<{ queue: string; module: string }>(
        'topology.queues',
        `SELECT job_queue AS queue, anyHeavy(event_module) AS module
         FROM skilllane_monitoring.logs WHERE ${scoped(all).sql} AND event_code = 'job.started' AND job_queue != ''
         GROUP BY queue`,
        scoped(all).params,
      ),
      this.ops.dependencyStates(all),
      this.reader.rows<{ type: string; host: string; port: number; name: string; module: string }>(
        'topology.names',
        `SELECT toString(dependency_type) AS type, dependency_host AS host, dependency_port AS port,
                toString(dependency_name) AS name, anyHeavy(toString(event_module)) AS module
         FROM skilllane_monitoring.logs WHERE ${named.sql}
         GROUP BY type, host, port, name`,
        named.params,
      ),
    ])

    const minutes = Math.max(1, (c.toMs - c.fromMs) / 60_000)
    const nodes = new Map<string, TopologyNode>()
    const edges = new Map<string, TopologyEdge & { durationSum: number; hist: Hist }>()
    const nodeHist = new Map<string, Hist>()
    const node = (id: string, init: Partial<TopologyNode> & Pick<TopologyNode, 'kind' | 'label'>): TopologyNode => {
      let n = nodes.get(id)
      if (!n) {
        const { kind, label, ...rest } = init
        n = {
          id, kind, label, type: '', service: '', role: '', host: '', names: [],
          requests: 0, errors: 0, errorRate: 0, callsPerMin: 0, p95Ms: 0, state: null, ...rest,
        }
        nodes.set(id, n)
      }
      return n
    }
    const serviceNode = (service: string, role: string) =>
      node(svc(service, role), { kind: 'service', label: role ? `${service}/${role}` : service, service, role })
    // Dependencies: one node per type + name; the hosts it was seen on, with their calls, for `host`.
    const depHosts = new Map<string, Map<string, number>>()
    const dependencyNode = (type: string, name: string, peer: string, calls: number, watched: boolean) => {
      const n = node(`dependency:${type}:${name}`, { kind: 'dependency', label: dependencyLabel(type, name), type })
      if (watched && !n.names.includes(name)) n.names.push(name)
      const hosts = depHosts.get(n.id) ?? new Map<string, number>()
      if (peer) hosts.set(peer, (hosts.get(peer) ?? 0) + calls)
      depHosts.set(n.id, hosts)
      return n
    }
    // SDK names per host:port; a host with several (the app's Redis as 'redis' and BullMQ's
    // 'queue' on one server) gives BullMQ's own commands (keys bull:…) to the bullmq connection.
    const watchedAt = new Map<string, { type: string; name: string; module: string }[]>()
    for (const h of hostNames) {
      const peer = h.port ? `${h.host}:${h.port}` : h.host
      if (peer) watchedAt.set(peer, [...(watchedAt.get(peer) ?? []), h])
    }
    const watchedName = (type: string, peer: string, bull: boolean): string | undefined => {
      const all = watchedAt.get(peer) ?? []
      const same = all.filter((h) => h.type === type)
      const list = (same.length ? same : all).sort((a, b) => a.name.localeCompare(b.name))
      if (list.length <= 1) return list[0]?.name
      return (list.find((h) => (h.module === 'bullmq') === bull) ?? list[0]).name
    }
    const queueModule = new Map(queues.map((r) => [r.queue, r.module]))
    const queueNode = (name: string, system = '') => {
      const n = node(`queue:${name}`, { kind: 'queue', label: name, type: system || queueModule.get(name) || '' })
      if (!n.type && system) n.type = system
      return n
    }
    const edge = (source: string, target: string, kind: TopologyEdgeKind, s: Partial<Stats> & { calls: number }) => {
      const id = `${source}->${target}`
      const e = edges.get(id) ?? {
        id, source, target, kind, calls: 0, errors: 0, clientErrors: 0, callsPerMin: 0, errorRate: 0, avgMs: 0, p95Ms: 0,
        durationSum: 0, hist: new Map(),
      }
      e.calls += s.calls
      e.errors += s.errors ?? 0
      e.clientErrors += s.client_errors ?? 0
      e.durationSum += (s.avg_ms ?? 0) * s.calls
      addHist(e.hist, s.hist)
      edges.set(id, e)
    }

    for (const s of services) {
      const n = serviceNode(s.service, s.role)
      n.type = s.kind
      n.requests = s.requests
      n.errors = s.errors
      n.errorRate = ratio(s.errors, s.requests)
      n.callsPerMin = num(s.requests / minutes, 2)
      n.p95Ms = num(s.q[1], 1)
    }
    for (const e of entries) {
      const target = serviceNode(e.service, e.role).id
      if (e.kind === 'SERVER') {
        if (e.root) edge(node('clients', { kind: 'clients', label: 'clients' }).id, target, 'http', e)
      } else if (e.queue) {
        edge(queueNode(e.queue, e.system).id, target, 'consume', e)
      }
    }
    // HTTP peers that are another service: (caller, peer) → callee.
    const peerService = new Map<string, string>()
    // PRODUCER spans with a destination make their own produce edge below (BullMQ Queue.add, kafkajs send):
    // a consumer under such a span must not count that message a second time.
    const produced = new Set(
      clients.filter((r) => r.destination).map((r) => `${serviceNode(r.service, r.role).id}\u0000${r.destination}`),
    )
    for (const l of links) {
      const from = serviceNode(l.from_service, l.from_role).id
      const to = serviceNode(l.to_service, l.to_role).id
      if (l.to_kind === 'SERVER') {
        if (l.from_kind === 'CLIENT' && l.from_peer) peerService.set(`${from}\u0000${l.from_peer}`, to)
        else edge(from, to, 'http', { calls: l.calls })
      } else if (l.queue && !(l.from_kind === 'PRODUCER' && produced.has(`${from}\u0000${l.queue}`))) {
        // Every retry attempt is its own consumer span under the same parent: count messages, not attempts.
        edge(from, queueNode(l.queue).id, 'produce', { calls: l.parents })
      }
    }
    for (const r of clients) {
      const from = serviceNode(r.service, r.role).id
      const callee = peerService.get(`${from}\u0000${r.peer}`)
      if (callee) {
        edge(from, callee, 'http', r)
        continue
      }
      if (r.destination) {
        edge(from, queueNode(r.destination).id, 'produce', r)
        continue
      }
      const type = r.db_system || (r.is_http ? 'http' : r.rpc_system || r.kind.toLowerCase())
      const kind: TopologyEdgeKind = r.db_system ? 'db' : r.is_http ? 'http' : r.rpc_system ? 'rpc' : 'call'
      const sdkName = r.peer ? watchedName(type, r.peer, !!r.bull) : undefined
      // Not watched: one node per database system, rpc service (S3) or HTTP host.
      const name = sdkName ?? (r.db_system || r.rpc_service || r.peer.replace(/:\d+$/, '') || type)
      edge(from, dependencyNode(type, name, r.peer, r.calls, !!sdkName).id, kind, r)
    }
    for (const d of dependencies) {
      const n = dependencyNode(d.type, d.name, d.port ? `${d.host}:${d.port}` : d.host, 0, true)
      if (n.state === null || STATE_RANK[d.state] > STATE_RANK[n.state]) n.state = d.state
      const from = serviceNode(d.service, d.role).id
      if (!edges.has(`${from}->${n.id}`)) edge(from, n.id, d.type === 'http' ? 'http' : d.type === 'redis' ? 'db' : 'call', { calls: 0 })
    }
    for (const [id, hosts] of depHosts) {
      const n = nodes.get(id)!
      n.names.sort()
      n.host = [...hosts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h).join(', ')
    }

    // service / role: keep the edges that touch a matching service, and their nodes.
    const keep = (id: string) => {
      const n = nodes.get(id)
      return !!n && n.kind === 'service' && (!c.service || n.service === c.service) && (!c.role || n.role === c.role)
    }
    const kept = [...edges.values()].filter((e) => (!c.service && !c.role) || keep(e.source) || keep(e.target))
    const used = new Set(kept.flatMap((e) => [e.source, e.target]))
    for (const e of kept) {
      e.callsPerMin = num(e.calls / minutes, 2)
      e.errorRate = ratio(e.errors, e.calls)
      e.avgMs = e.calls ? num(e.durationSum / e.calls, 1) : 0
      e.p95Ms = histP95(e.hist)
      // A dependency counts the calls it receives; a queue the messages consumed from it; clients the requests sent.
      const source = nodes.get(e.source)!
      const target = nodes.get(e.target)!
      const counted = target.kind === 'dependency' ? target : source.kind === 'queue' || source.kind === 'clients' ? source : null
      if (counted) {
        counted.requests += e.calls
        counted.errors += e.errors
        const h = nodeHist.get(counted.id) ?? new Map<number, number>()
        addHist(h, e.hist)
        nodeHist.set(counted.id, h)
      }
    }
    for (const [id, h] of nodeHist) nodes.get(id)!.p95Ms = histP95(h)
    const outNodes = [...nodes.values()]
      .filter((n) => used.has(n.id) || (n.kind === 'service' && keep(n.id)))
      .map((n) => {
        if (n.kind !== 'service') {
          n.errorRate = ratio(n.errors, n.requests)
          n.callsPerMin = num(n.requests / minutes, 2)
        }
        return n
      })
      .sort((a, b) => NODE_ORDER[a.kind] - NODE_ORDER[b.kind] || a.label.localeCompare(b.label))
    return {
      range: { from: new Date(c.fromMs).toISOString(), to: new Date(c.toMs).toISOString(), minutes: num(minutes, 2) },
      nodes: outNodes,
      edges: kept
        .map(({ durationSum: _d, hist: _h, ...e }) => e)
        .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id)),
    }
  }
}
