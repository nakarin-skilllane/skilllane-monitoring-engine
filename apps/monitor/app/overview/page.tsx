import type { Metadata } from 'next'
import Link from 'next/link'
import { AutoRefresh } from '@/components/AutoRefresh'
import { ServiceChip, Tag, Ts } from '@/components/badges'
import type { TimeEvent } from '@/components/charts/TimeCharts'
import { CopyLinkButton } from '@/components/CopyButton'
import { Icon } from '@/components/icons'
import { PageHead } from '@/components/PageHead'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { engine, getMeta } from '@/lib/engine'
import { fmtDuration, fmtPct, fmtRangeShort, fmtRate } from '@/lib/format'
import { latestByEnv } from '@/lib/freshness'
import { buildHref, depAnchor, isPastWindow, type Keep, type ParamProblem, parseScope, type RawSearchParams, withParams } from '@/lib/params'
import { systemLabel } from '@/lib/readable'
import { serviceOrder, serviceSlot } from '@/lib/services'
import type { SystemMapNode } from '@/lib/3d/system-map'
import { dependencyNodeFor, serviceNodeId, systemMapFromTopology, topologyLabels } from '@/lib/topology'
import type { Overview, OverviewRoute, OverviewService, Topology, TopologyNode, TraceListRow } from '@/lib/types'
import { Attention, type SilentRole, type SlowTrace } from './_components/Attention'
import { Health, type HealthRow } from './_components/Health'
import { type CallRow, MapLinkProvider, type NodeRow, OverviewTop } from './_components/MapLink'
import { Routes } from './_components/Routes'
import { Side } from './_components/Side'
import { Trends } from './_components/Trends'
import {
  type DeployInfo,
  ERROR_RATE_BAD,
  SLOW_MS,
  bucketTimes,
  completeCount,
  deployOf,
  depTitle,
  failingRoutes,
  isHttp,
  latestDeploy,
  MAP_KIND_TEXT,
  MAP_RATE_UNIT,
  MAP_STATE_TEXT,
  mapMs,
  mapStates,
  mergeDependencies,
  phoneProblemMap,
  problemNodes,
  quietBefore,
  quietInRange,
  type Silence,
  slowestCall,
  topGroup,
  type Volume,
  volumeOf,
} from './_lib/model'
import { at, atSec, rangeName } from './_lib/text'
import './screen.css'

export const metadata: Metadata = { title: 'ภาพรวม' }

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000
const ROUTES_SHOWN = 8
const iso = (ms: number) => new Date(ms).toISOString()
/** `request`, `job`, `message`: what a silent role stopped getting. */
const silentWhat = (vol: Volume) => (vol.short === 'req' ? 'request' : vol.short === 'msg' ? 'message' : 'job')

/**
 * ภาพรวม (design/monitoring-ui/overview.html): ต้องดูตอนนี้ + 3D system map, service health, trends and routes of
 * the selected service/role (URL service + role), and the env's last 24 h (error groups, dependencies, jobs).
 * Every call uses the same absolute from/to (the range resolved once), so the map, the health table and the
 * call table agree. Rounds: (1) overview, topology, errors 24 h, jobs 24 h, dependencies; (2) the selected
 * service, its pre-deploy hour, the slowest trace of the callout route and the last entries of roles that may have
 * gone quiet (เงียบ: one small /api/traces call each, only for candidates); (3) slowest traces of slow routes.
 * A fixed past window gets no auto refresh.
 */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const metaRes = await getMeta()
  const meta = metaRes.ok ? metaRes.data : null
  const scope = parseScope(sp, 'overview', { envs: meta?.envs, limited: meta?.envsLimited })
  const order = serviceOrder(meta)
  const keep = scope.keep
  const env = scope.env
  const range = { env, from: iso(scope.fromMs), to: iso(scope.toMs) }
  const day = { env, from: iso(scope.nowMs - DAY_MS), to: iso(scope.nowMs) }

  const deploy = latestDeploy(meta, env)
  const head = (
    <PageHead
      scope={scope}
      title="ภาพรวม"
      question={`ตอนนี้ ${env ?? 'ทุก env'} มีอะไรผิดปกติ service ไหน route ไหนต้องดูก่อน`}
      copyLink={false}
      actions={
        <>
          {deploy ? (
            <span className="hint ov-deploy">
              deploy ล่าสุด <ServiceChip service={deploy.service} order={order} /> <Tag>{deploy.version}</Tag>{' '}
              <Ts value={deploy.at} format="date" />
            </span>
          ) : null}
          <CopyLinkButton />
          <Link className="btn" href={buildHref('/logs', keep)}>
            <Icon name="logs" />
            เปิด Log ช่วงนี้
          </Link>
          {/* a fixed past window does not change: no auto refresh */}
          {isPastWindow(scope) ? null : <AutoRefresh />}
        </>
      }
    />
  )

  const [ovRes, topoRes, errRes, jobsRes, depRes] = await Promise.all([
    engine.overview(range),
    engine.topology(range),
    engine.errors({ ...day, limit: 100 }),
    engine.jobs(day),
    engine.dependencies(range),
  ])

  if (!ovRes.ok) {
    return (
      <>
        {head}
        <ParamProblems problems={scope.problems} />
        <EngineErrorState error={ovRes.error} />
      </>
    )
  }
  const ov = ovRes.data
  const problems: ParamProblem[] = [...scope.problems]

  // ---------- services, selected service ----------
  // a fixed order (service slot, then api · worker · persister · others A–Z), so rows never swap on auto refresh
  const services = [...ov.services].sort(
    (a, b) => serviceRank(a.service, order) - serviceRank(b.service, order) || roleRank(a.role) - roleRank(b.role) || a.role.localeCompare(b.role),
  )
  let selected: OverviewService | undefined = services.find((s) => s.service === scope.service && (!scope.role || s.role === scope.role))
  if (!selected && scope.service) {
    problems.push({
      name: 'service',
      value: `${scope.service}${scope.role ? `/${scope.role}` : ''}`,
      message: `ไม่มีข้อมูลของ service นี้ใน ${env ?? 'ทุก env'} ช่วงนี้ จึงแสดง service แรกในตารางแทน`,
    })
  }
  selected ??= services[0]
  const groups24 = errRes.ok ? errRes.data.groups : null
  const jobStats = ov.jobs
  const topo = topoRes.ok ? topoRes.data : null
  const depRows = depRes.ok ? mergeDependencies(depRes.data, scope.fromMs).map((d) => ({ ...d, nodeId: dependencyNodeFor(d, topo) })) : []

  // ---------- silent roles (เงียบ, rule in _lib/model.ts) ----------
  // (a) traffic in the range that stopped before its end; (b) a role of the env (meta releases, a line in the 24 h
  // before the range end) without any entry span in the range. With every env, only envs that have data in the range.
  const roleKey = (x: { service: string; role: string }) => `${x.service}/${x.role}`
  const quiet = services.flatMap((s) => {
    const q = quietInRange(s, ov.range.from, ov.range.stepSeconds, scope.toMs)
    return q ? [{ s, q }] : []
  })
  const listed = new Set(services.map(roleKey))
  const newest = latestByEnv(meta)
  const lastLine = (versions: Array<{ lastSeen: string }>) => Math.max(0, ...versions.map((v) => Date.parse(v.lastSeen) || 0))
  const missing = new Map<string, { service: string; role: string }>()
  for (const r of meta?.releases ?? []) {
    if (env ? r.env !== env : !(Date.parse(newest[r.env] ?? '') >= scope.fromMs)) continue
    for (const ro of r.roles) {
      const m = { service: r.service, role: ro.role }
      if (lastLine(ro.versions) >= scope.toMs - DAY_MS && !listed.has(roleKey(m))) missing.set(roleKey(m), m)
    }
  }
  /** The role's latest entry spans (newest first) in the 24 h up to the range end. */
  const entriesBefore = (service: string, role: string): Promise<TraceListRow[] | null> =>
    engine.traces({ env, service, role, from: iso(scope.toMs - DAY_MS), to: iso(scope.toMs), limit: 20, entries: 'all' }).then((r) => (r.ok ? r.data.rows : null))

  // ---------- round 2 + 3: selected service, pre-deploy hour, slowest traces ----------
  const baselines = new Map<string, Promise<Overview | null>>()
  const baseline = (service: string, role: string, d: DeployInfo | null): Promise<Overview | null> => {
    if (!d) return Promise.resolve(null)
    const key = `${service}/${role}`
    let p = baselines.get(key)
    if (!p) {
      // route_stats_1m counts whole minutes: end at the start of the deploy minute, so no minute of the new version
      const to = Math.floor(d.atMs / 60_000) * 60_000
      p = engine.overview({ env, service, role, from: iso(to - HOUR_MS), to: iso(to) }).then((r) => (r.ok ? r.data : null))
      baselines.set(key, p)
    }
    return p
  }
  const traces = new Map<string, Promise<SlowTrace | null>>()
  const slowest = (r: OverviewRoute): Promise<SlowTrace | null> => {
    const key = `${r.service}/${r.role} ${r.route}`
    let p = traces.get(key)
    if (!p) {
      p = engine.traces({ ...range, service: r.service, role: r.role, route: r.route, sort: 'durationMs', limit: 1 }).then(async (res) => {
        const row = res.ok ? res.data.rows[0] : undefined
        if (!row) return null
        const detail = await engine.trace(row.traceId, { env })
        const span = detail.ok ? slowestCall(detail.data.spans) : null
        return { row, span: span ? { name: span.name, durationMs: span.durationMs } : null }
      })
      traces.set(key, p)
    }
    return p
  }

  const calloutRoute = ov.routes.filter((r) => isHttp(r) && r.p95Ms >= SLOW_MS).sort((a, b) => b.requests - a.requests)[0]
  const calloutDeploy = calloutRoute ? deployOf(meta, env, calloutRoute.service, calloutRoute.role) : null
  const selDeploy = selected ? deployOf(meta, env, selected.service, selected.role) : null

  const [selRes, selBase, calloutBase, calloutTrace, quietEntries, missingEntries] = await Promise.all([
    selected ? engine.overview({ ...range, service: selected.service, role: selected.role }) : Promise.resolve(null),
    selected ? baseline(selected.service, selected.role, selDeploy) : Promise.resolve(null),
    calloutRoute ? baseline(calloutRoute.service, calloutRoute.role, calloutDeploy) : Promise.resolve(null),
    calloutRoute ? slowest(calloutRoute) : Promise.resolve(null),
    Promise.all(quiet.map(async (x) => ({ ...x, rows: await entriesBefore(x.s.service, x.s.role) }))),
    Promise.all([...missing.values()].map(async (m) => ({ ...m, rows: await entriesBefore(m.service, m.role) }))),
  ])
  // (a): the exact last entry from the lookup; an entry after the quiet bucket means it is not quiet after all
  const silence = new Map<string, Silence>()
  for (const { s, q, rows } of quietEntries) {
    const last = rows?.[0] ? Date.parse(rows[0].timestamp) : null
    if (last !== null && last > q.quietFromMs + 60_000) continue
    silence.set(roleKey(s), { lastMs: last ?? q.quietFromMs, rpmBefore: q.rpmBefore })
  }
  // (b): busy until it stopped (≥ 1 per minute over its last entries), else just a rare role
  const silentMissing = missingEntries.flatMap((m) => {
    const q = m.rows ? quietBefore(m.rows.map((r) => Date.parse(r.timestamp))) : null
    return q && m.rows ? [{ service: m.service, role: m.role, kind: m.rows[0].kind === 'SERVER' ? 'SERVER' : 'CONSUMER', silence: q }] : []
  })
  const sel = selRes?.ok ? selRes.data : null
  const selRoutes = (sel?.routes ?? []).filter((r) => r.service === selected?.service && r.role === selected?.role).slice(0, ROUTES_SHOWN)
  const slowRows = selRoutes.filter((r) => isHttp(r) && r.p95Ms >= SLOW_MS && r.errorRate < ERROR_RATE_BAD).slice(0, 4)
  const slowTraces = new Map<string, SlowTrace | null>(await Promise.all(slowRows.map(async (r) => [r.route, await slowest(r)] as const)))

  // ---------- series of the selected service (complete buckets only) ----------
  const step = sel?.range.stepSeconds ?? ov.range.stepSeconds
  const selPoints = sel ? sel.series.slice(0, completeCount(sel.series.length, sel.range.from, step, scope.toMs)) : []
  const vol = selected ? volumeOf(selected, jobStats) : null

  // ---------- health rows ----------
  const sparkN = (n: number) => completeCount(n, ov.range.from, ov.range.stepSeconds, scope.toMs)
  const silentNote = (sil: Silence, vol: Volume) => `ไม่มี ${silentWhat(vol)} ตั้งแต่ ${at(sil.lastMs, scope.nowMs)}`
  const healthRows: HealthRow[] = services.map((s) => {
    const mine = (r: { service: string; role: string }) => r.service === s.service && r.role === s.role
    const sil = silence.get(roleKey(s)) ?? null
    const svol = volumeOf(s, jobStats)
    const routes = ov.routes.filter(mine)
    const newGroups = ov.errorGroups.filter((g) => mine(g) && g.isNew)
    const slow = routes.filter((r) => isHttp(r) && r.p95Ms >= SLOW_MS)
    const bad = routes.filter((r) => r.errorRate >= ERROR_RATE_BAD)
    const jobGroup = s.kind === 'SERVER' ? null : topGroup(ov.errorGroups, mine)
    // a dependency.* group (Redis unreachable) is about the dependency, not a job: its row in the Dependency list
    const depGroup = jobGroup && (jobGroup.eventCode.startsWith('dependency.') || (jobGroup.dependencyName && !jobGroup.jobType)) ? jobGroup : null
    const dep = depGroup
      ? (depRows.find((d) => d.name === depGroup.dependencyName && (!depGroup.dependencyType || d.type === depGroup.dependencyType) && d.users.some(mine)) ?? null)
      : null
    const n = sparkN(s.spark.length)
    return {
      s,
      vol: svol,
      warn: s.errorRate >= ERROR_RATE_BAD || newGroups.length > 0 || slow.length > 0 || !!sil,
      silent: sil ? { ...sil, note: silentNote(sil, svol) } : null,
      newGroups,
      slow,
      bad,
      jobGroup,
      dep: depGroup ? { group: depGroup, row: dep } : null,
      jobStat: jobGroup ? (jobStats.find((j) => mine(j) && j.type === jobGroup.jobType) ?? null) : null,
      spark: s.spark.slice(0, n),
      sparkTimes: bucketTimes(ov.range.from, ov.range.stepSeconds, n),
      selectHref: withParams('/overview', sp, { service: s.service, role: s.role }),
      selected: s === selected,
    }
  })
  // (b) rows: no numbers in the range, never selectable for the charts (nothing to draw); jobs of 24 h name the unit
  const jobs24 = jobsRes.ok ? jobsRes.data.stats : []
  for (const m of silentMissing) {
    const s: OverviewService = { service: m.service, role: m.role, kind: m.kind, requests: 0, errors: 0, errorRate: 0, p95Ms: 0, rpm: 0, spark: [] }
    const vol = volumeOf(s, [...jobStats, ...jobs24])
    healthRows.push({
      s,
      vol,
      warn: true,
      silent: { ...m.silence, note: silentNote(m.silence, vol) },
      newGroups: [],
      slow: [],
      bad: [],
      jobGroup: null,
      dep: null,
      jobStat: null,
      spark: [],
      sparkTimes: [],
      selectHref: null,
      selected: false,
    })
  }
  healthRows.sort((a, b) => serviceRank(a.s.service, order) - serviceRank(b.s.service, order) || roleRank(a.s.role) - roleRank(b.s.role) || a.s.role.localeCompare(b.s.role))
  const silentRoles: SilentRole[] = healthRows.flatMap((h) =>
    h.silent ? [{ service: h.s.service, role: h.s.role, what: silentWhat(h.vol), unit: h.vol.unit, lastMs: h.silent.lastMs, rpmBefore: h.silent.rpmBefore }] : [],
  )

  // ---------- chart marks: deploys and outages of the selected service in range ----------
  const events: TimeEvent[] = []
  const bands: Array<{ from: number; to: number }> = []
  const marks: string[] = []
  if (selected) {
    for (const d of meta?.deploys ?? []) {
      const t = Date.parse(d.at)
      if ((!env || d.env === env) && d.service === selected.service && t >= scope.fromMs && t <= scope.toMs) {
        events.push({ at: t, label: `deploy ${d.version}` })
        marks.push(`เส้นตั้ง = deploy ${d.version} ${atSec(t, scope.nowMs)}`)
      }
    }
    for (const d of depRows) {
      if (!d.users.some((u) => u.service === selected.service && u.role === selected.role)) continue
      const name = depTitle(d, systemLabel)
      if (d.issue === 'recovered' && d.downAtMs !== null && d.upAtMs !== null) {
        events.push({ at: d.downAtMs, label: `${name} down ${fmtDuration(d.lastOutageMs)}` })
        bands.push({ from: d.downAtMs, to: d.upAtMs })
        marks.push(`เส้นตั้ง + แถบแดงจาง = ${name} down ${atSec(d.downAtMs, scope.nowMs)}–${atSec(d.upAtMs, scope.nowMs)}`)
      } else if (d.issue === 'down' && d.since) {
        const t = Math.max(Date.parse(d.since), scope.fromMs)
        events.push({ at: t, label: `${name} down` })
        bands.push({ from: t, to: scope.toMs })
        marks.push(`เส้นตั้ง + แถบแดงจาง = ${name} down ตั้งแต่ ${atSec(d.since, scope.nowMs)}`)
      }
    }
  }

  // ---------- 3D map + call table ----------
  const map = buildMap(topo, scope.keep, order, ov, healthRows)
  const rangeShort = fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)

  const attn = (
    <Attention
      scope={scope}
      meta={meta}
      order={order}
      groups={ov.errorGroups}
      spark={ov.errorGroupsSpark}
      groups24={groups24}
      slow={
        calloutRoute
          ? {
              route: calloutRoute,
              trace: calloutTrace,
              baseP95: calloutBase?.routes.find((r) => r.route === calloutRoute.route)?.p95Ms ?? null,
            }
          : null
      }
      deps={depRows}
      failing={failingRoutes(ov.routes)}
      silent={silentRoles}
      series={selected && sel ? { service: selected.service, role: selected.role, points: sel.series, stepSeconds: step } : null}
    />
  )

  return (
    <MapLinkProvider>
      {head}
      <ParamProblems problems={problems} />
      <OverviewTop
        attn={attn}
        health={<Health scope={scope} rows={healthRows} order={order} stepSeconds={ov.range.stepSeconds} />}
        map={{
          ...map,
          serviceOrder: order,
          ariaLabel: `แผนที่ระบบ ${env ?? 'ทุก env'} ${rangeName(scope)}`,
          meta: `ภาพ 3 มิติ · ${rangeName(scope)}`,
          caption: (
            <>
              ใครเรียกใครใน {env ?? 'ทุก env'} และติดขัดที่ไหน · ทุกตัวเลขในภาพอยู่ใน <a href="#ov-calls">ดูเป็นตาราง</a> ด้านล่าง (ระบบในแผนที่ และการเรียกระหว่างระบบ) ·
              สถานะ service ตรงกับ <a href="#ov-health-t">สุขภาพ service</a> · เส้นไม่มีตัวเลข = รู้ว่าเรียก แต่ยังไม่มีอัตรา
              <span className="ov-map__phone"> · จอเล็กแสดงเฉพาะจุดที่มีปัญหาและ service ที่เรียกจุดนั้น ทั้งหมดอยู่ในตาราง</span>
            </>
          ),
          state: !topoRes.ok ? (
            <EngineErrorState error={topoRes.error} inPanel={false} />
          ) : (
            <EmptyState title="ยังไม่มีการเรียกในช่วงนี้" text="ไม่มี span ใน env และช่วงเวลาที่เลือก ลองขยายช่วงเวลา" />
          ),
          callsCaption: `การเรียกระหว่างระบบใน ${env ?? 'ทุก env'} ช่วง ${rangeShort}: ครั้งต่อนาทีและ error rate ของแต่ละเส้นในแผนที่`,
          nodesCaption: `ระบบในแผนที่ของ ${env ?? 'ทุก env'} ช่วง ${rangeShort}: ครั้งต่อนาที error rate p95 และสถานะของแต่ละจุด เท่ากับที่ภาพแสดง`,
        }}
      />

      <div className="grid grid--main-side ov-body">
        <div className="ov-main">
          {selected && vol ? (
            <>
              {!selRes || selRes.ok ? (
                <Trends
                  scope={scope}
                  order={order}
                  selected={selected}
                  vol={vol}
                  points={selPoints}
                  stepSeconds={step}
                  routes={selRoutes}
                  options={services.map((s) => ({
                    value: `${s.service}/${s.role}`,
                    label: `${s.service}/${s.role}`,
                    href: withParams('/overview', sp, { service: s.service, role: s.role }),
                  }))}
                  events={events}
                  bands={bands}
                  marks={marks}
                  jobSplit={
                    selected.kind === 'SERVER'
                      ? null
                      : jobStats
                          .filter((j) => j.service === selected.service && j.role === selected.role)
                          .reduce((a, j) => ({ retried: a.retried + j.retried, failed: a.failed + j.failed }), { retried: 0, failed: 0 })
                  }
                />
              ) : (
                <section className="section" aria-labelledby="ov-trend-t">
                  <div className="section__head">
                    <h2 className="section__title" id="ov-trend-t">
                      Traffic, error และ latency
                    </h2>
                  </div>
                  <EngineErrorState error={selRes.error} />
                </section>
              )}
              <Routes
                scope={scope}
                order={order}
                selected={selected}
                routes={selRoutes}
                base={selBase ? new Map(selBase.routes.map((r) => [r.route, r])) : null}
                deploy={selBase ? selDeploy : null}
                slowTraces={slowTraces}
                groups={ov.errorGroups}
                groups24={groups24}
              />
            </>
          ) : (
            <section className="section" aria-labelledby="ov-trend-t">
              <div className="section__head">
                <h2 className="section__title" id="ov-trend-t">
                  Traffic, error และ latency
                </h2>
              </div>
              <div className="panel">
                <EmptyState title="ยังไม่มี service ในช่วงนี้" text="กราฟและตาราง route จะแสดงเมื่อมี request, job หรือ message ในช่วงเวลาที่เลือก" />
              </div>
            </section>
          )}
        </div>
        <Side
          scope={scope}
          order={order}
          groups={errRes.ok ? { ok: true, data: errRes.data } : errRes}
          deps={depRes.ok ? { ok: true, data: depRows } : depRes}
          jobs={jobsRes.ok ? { ok: true, data: jobsRes.data } : jobsRes}
        />
      </div>
    </MapLinkProvider>
  )
}

const ROLE_ORDER = ['api', 'worker', 'persister']
/** api, worker, persister, then every other role (alphabetical after these). */
function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role)
  return i < 0 ? ROLE_ORDER.length : i
}

/** Fixed service order first (its slot), others after; same order as the colours. */
function serviceRank(service: string, order: string[]): number {
  const i = order.indexOf(service)
  return i < 0 ? order.length + serviceSlot(service, order) : i
}

/**
 * Map data (friendly labels, states by the page's 1 % rule and the health table; a phone variant of the nodes that
 * are not ok), the node table, the problem list and the call table rows from /api/topology.
 */
function buildMap(topo: Topology | null, keep: Keep, order: string[], ov: Overview, health: HealthRow[]) {
  if (!topo || !topo.nodes.length) return { data: null, dataNarrow: null, calls: [] as CallRow[], nodes: [] as NodeRow[], issues: [] as NodeRow[] }
  const labels = topologyLabels(topo)
  const byId = new Map(topo.nodes.map((n) => [n.id, n]))
  const hasErrors = new Set(ov.errorGroups.map((g) => `${g.service}/${g.role}`))
  const href = (n: TopologyNode): string | undefined => {
    if (n.kind === 'clients') return buildHref('/traces', keep)
    if (n.kind === 'service') {
      // a service with errors opens its error groups, else its traces
      const failing = n.errors > 0 || hasErrors.has(`${n.service}/${n.role}`)
      return buildHref(failing ? '/errors' : '/traces', keep, { service: n.service, role: n.role })
    }
    if (n.kind === 'queue') return `${buildHref('/jobs', keep)}#queues`
    if (n.names.length) return `${buildHref('/jobs', keep)}#${n.names.length === 1 ? depAnchor(n.names[0]) : 'dependencies'}`
    // a database / API without dependency lines: the traces of its busiest caller
    const caller = topo.edges
      .filter((e) => e.target === n.id)
      .map((e) => byId.get(e.source))
      .find((s): s is TopologyNode => !!s && s.kind === 'service')
    return caller ? buildHref('/traces', keep, { service: caller.service, role: caller.role }) : undefined
  }
  // the health table's rule (ต้องดู = error rate ≥ 1 %, NEW group or a slow route) on the map too
  const thresholds = { warn: ERROR_RATE_BAD, error: ERROR_RATE_BAD }
  const rows = new Map(
    health.map((h) => {
      const why = [
        h.silent ? `เงียบ: ${h.silent.note}` : '',
        h.newGroups.length ? `NEW error ตั้งแต่ ${h.newGroups[0].firstSeenVersion}` : '',
        h.slow.length ? `route ช้า ${h.slow.length}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      return [serviceNodeId(h.s.service, h.s.role), { warn: h.warn, note: why || null }] as const
    }),
  )
  const data = mapStates(systemMapFromTopology(topo, { href, thresholds }), rows)
  const dataNarrow = phoneProblemMap(mapStates(systemMapFromTopology(topo, { href, thresholds, hideClients: true }), rows))

  const KIND_RANK: Record<string, number> = { clients: 0, service: 1, queue: 2, dependency: 3 }
  const cell = (id: string) => {
    const n = byId.get(id)
    if (n?.kind === 'service') return <ServiceChip service={n.service} role={n.role} order={order} />
    return <span title={n?.host || undefined}>{labels.get(id) ?? id}</span>
  }
  // every node with the numbers its label / tooltip prints (a number is never only in the 3D view)
  const nodeRow = (n: SystemMapNode): NodeRow => {
    const t = byId.get(n.id)
    const title = n.kind === 'service' || n.kind === 'worker' ? `${n.label}${n.sublabel ?? ''}` : n.label
    return {
      id: n.id,
      href: n.href,
      name: t?.kind === 'service' ? <ServiceChip service={t.service} role={t.role} order={order} /> : <span title={t?.host || undefined}>{n.label}</span>,
      title,
      kind: MAP_KIND_TEXT[n.kind] ?? n.kind,
      rate: n.rpm === null || n.rpm === undefined ? null : `${fmtRate(n.rpm)} ${n.rateUnit ?? MAP_RATE_UNIT[n.kind] ?? ''}`.trim(),
      err: n.errorRate === null || n.errorRate === undefined ? null : fmtPct(n.errorRate),
      errBad: (n.errorRate ?? 0) >= ERROR_RATE_BAD,
      p95: n.p95Ms ? mapMs(n.p95Ms) : null,
      state: n.state,
      stateText: [MAP_STATE_TEXT[n.state], n.note].filter(Boolean).join(' · '),
    }
  }
  // users, then services / workers in the health table's order, then queues and dependencies by traffic
  const NODE_RANK: Record<string, number> = { client: 0, service: 1, worker: 1, queue: 2, dependency: 3, external: 3 }
  const healthAt = new Map(health.map((h, i) => [serviceNodeId(h.s.service, h.s.role), i]))
  const nodes = [...data.nodes]
    .sort(
      (a, b) =>
        (NODE_RANK[a.kind] ?? 9) - (NODE_RANK[b.kind] ?? 9) ||
        (healthAt.get(a.id) ?? 99) - (healthAt.get(b.id) ?? 99) ||
        (b.rpm ?? -1) - (a.rpm ?? -1),
    )
    .map(nodeRow)
  // phones: where it hurts (the users node is a symptom, and the phone map leaves it out)
  const issues = problemNodes(data)
    .filter((n) => n.kind !== 'client')
    .map(nodeRow)

  const calls: CallRow[] = [...topo.edges]
    .sort((a, b) => {
      const sa = byId.get(a.source)
      const sb = byId.get(b.source)
      return (
        (KIND_RANK[sa?.kind ?? ''] ?? 9) - (KIND_RANK[sb?.kind ?? ''] ?? 9) ||
        (labels.get(a.source) ?? '').localeCompare(labels.get(b.source) ?? '') ||
        b.callsPerMin - a.callsPerMin
      )
    })
    .map((e) => ({
      id: e.id,
      node: e.target,
      from: cell(e.source),
      to: cell(e.target),
      rate: e.calls > 0 ? fmtRate(e.callsPerMin) : null,
      err: e.calls > 0 ? fmtPct(e.errorRate) : null,
      bad: e.calls > 0 && e.errorRate >= ERROR_RATE_BAD,
      calls: e.calls,
    }))
  return { data, dataNarrow, calls, nodes, issues }
}
