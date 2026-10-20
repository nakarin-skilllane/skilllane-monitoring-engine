import type { Metadata } from 'next'
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { HttpStatus, Method, ServiceChip, ServiceDots, Tag, Ts } from '@/components/badges'
import { PageHead } from '@/components/PageHead'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { DurBar, SortTh } from '@/components/table'
import { TimeAxisPlot } from '@/components/ScrollToEnd'
import { engine, getMeta } from '@/lib/engine'
import { fmtCount, fmtDateTimeMs, fmtDuration, fmtMs, fmtRange, fmtTimeSec, sameDay, shortId } from '@/lib/format'
import { buildHref, Params, parseScope, rangeText, type RawSearchParams, type Scope, scopeQuery, withParams } from '@/lib/params'
import { serviceOrder, svcColor } from '@/lib/services'
import { type JobStat, type LogRow, SAMPLE_PARTS, type SamplePart, type TraceDetail, type TraceListRow } from '@/lib/types'
import { RowNav } from './_components/RowNav'
import type { ErrorBlockContext } from './_components/TraceErrorBlock'
import { TraceErrorRow } from './_components/TraceErrorRow'
import { type RouteGroup, TraceFilters } from './_components/TraceFilters'
import { type ScatterBand, type ScatterPoint, scatterDesc, TraceScatter } from './_components/TraceScatter'
import {
  buildWaterfall,
  failedSpan,
  isHttpRow,
  isoMs,
  jobFollowUp,
  jobModule,
  jobName,
  jobStatus,
  namedStep,
  pickEntryErrorLog,
  rowKey,
  rowTone,
  spanLabel,
  type Tone,
} from './_lib/model'
import './screen.css'

export const metadata: Metadata = { title: 'Trace' }

const SAMPLE_LIMIT = 100
const FIRST_ROWS = 18
const MORE_ROWS = 50
const COLS = 10

/**
 * The trace detail the client row gets for its first render (it lands in the page's RSC payload): only what
 * TraceErrorBlock reads. No span attributes / events, SQL, stacks, fields, hosts or ids in paths; user roles and
 * organization only on the line the block shows (it prints them, as the mockup does).
 */
function slimDetail(d: TraceDetail, shown: LogRow | null): TraceDetail {
  return {
    ...d,
    spans: d.spans.map((s) => ({
      ...s,
      host: '',
      attributes: {},
      events: [],
      db: s.db ? { system: s.db.system, statement: '' } : null,
      http: s.http ? { ...s.http, path: s.http.route ? '' : s.http.path } : null,
    })),
    logs: d.logs.map((l) => ({
      ...l,
      host: '',
      fields: {},
      labels: {},
      dbStatement: '',
      userRoles: l === shown ? l.userRoles : [],
      organizationId: l === shown ? l.organizationId : '',
      error: l.error ? { ...l.error, stack: '', cause: '' } : null,
      http: l.http ? { ...l.http, path: l.http.route ? '' : l.http.path } : null,
    })),
  }
}

/** `1 ชั่วโมง` for a preset range, else the absolute range. */
function rangeWords(scope: Scope): string {
  const words: Record<string, string> = { 'now-15m': '15 นาที', 'now-1h': '1 ชั่วโมง', 'now-6h': '6 ชั่วโมง', 'now-24h': '24 ชั่วโมง', 'now-7d': '7 วัน' }
  return words[scope.preset] ?? fmtRange(scope.fromMs, scope.toMs)
}

const DEP_TYPE: Record<string, string> = { redis: 'Redis', oracle: 'Oracle', http: 'HTTP', kafka: 'Kafka', rabbitmq: 'RabbitMQ', mongodb: 'MongoDB', postgres: 'Postgres' }

/** Outage windows (dependency.down → the first dependency.up after it) that overlap the range. */
function outages(events: LogRow[], fromMs: number, toMs: number): Array<ScatterBand & { text: string }> {
  const open = new Map<string, number>()
  const out: Array<ScatterBand & { text: string; key: string }> = []
  const name = (e: LogRow) => `${DEP_TYPE[e.dependency?.type ?? ''] ?? e.dependency?.type ?? ''} "${e.dependency?.name || e.dependency?.host}"`
  const sorted = events.filter((e) => e.dependency && e.eventCode.startsWith('dependency.')).sort((a, b) => isoMs(a.timestamp) - isoMs(b.timestamp))
  const labels = new Map<string, string>()
  for (const e of sorted) {
    const d = e.dependency!
    const key = `${d.type}|${d.name}|${d.host}:${d.port}`
    labels.set(key, name(e))
    const t = isoMs(e.timestamp)
    if (e.eventCode === 'dependency.down' || e.eventCode === 'dependency.still_down') {
      if (!open.has(key)) open.set(key, t)
    } else if (e.eventCode === 'dependency.up' && open.has(key)) {
      out.push({ key, fromMs: open.get(key)!, toMs: t, label: '', text: '' })
      open.delete(key)
    }
  }
  for (const [key, from] of open) out.push({ key, fromMs: from, toMs: toMs, label: '', text: '' })
  return out
    .filter((b) => b.toMs >= fromMs && b.fromMs <= toMs)
    .map((b) => ({
      ...b,
      label: `${labels.get(b.key)} down ${fmtDuration(b.toMs - b.fromMs)}`,
      text: `${labels.get(b.key)} down ${fmtTimeSec(b.fromMs)}–${fmtTimeSec(b.toMs)}`,
    }))
}

/** Route select: HTTP routes per service, then jobs (overview routes + job stats). */
function routeGroups(routes: Array<{ service: string; kind: string; route: string; method: string }>, jobs: JobStat[], current?: string): RouteGroup[] {
  const http = new Map<string, Array<{ value: string; label: string }>>()
  const job = new Map<string, string>()
  for (const r of routes) {
    if (r.method) {
      const list = http.get(r.service) ?? []
      if (!list.some((o) => o.value === r.route)) list.push({ value: r.route, label: r.route })
      http.set(r.service, list)
    } else job.set(r.route, r.route.slice(r.route.indexOf(' ') + 1))
  }
  for (const j of jobs) if (!job.has(`${j.queue} ${j.type}`)) job.set(`${j.queue} ${j.type}`, j.type)
  const groups: RouteGroup[] = Array.from(http.entries()).map(([svc, options]) => ({ label: `HTTP · ${svc}`, options }))
  if (job.size) groups.push({ label: 'Job · message · cron', options: Array.from(job.entries()).map(([value, label]) => ({ value, label })) })
  if (current && !groups.some((g) => g.options.some((o) => o.value === current))) groups.push({ label: 'ตัวกรองปัจจุบัน', options: [{ value: current, label: current }] })
  return groups
}

interface RowView {
  key: string
  row: TraceListRow
  tone: Tone
  http: boolean
  module: string
  what: string
  status: string
  mark?: string
}

function viewOf(row: TraceListRow, jobs: JobStat[]): RowView {
  const http = isHttpRow(row)
  const tone = rowTone(row)
  const module = http ? '' : jobModule(row, jobs)
  const what = http ? row.route : jobName(row)
  let status: string
  if (http) status = `${row.status || '–'}${tone === 'bad' ? ' · error' : tone === 'slow' ? ' · ช้า' : row.errorCount ? ' · span error' : ''}`
  else {
    const js = jobStatus(row)
    status = js.failed ? `ล้มเหลว${js.attempt ? ` · ครั้งที่ ${js.attempt}` : ''}` : 'สำเร็จ'
  }
  return { key: rowKey(row), row, tone, http, module, what, status }
}

/** Marked traces: A = newest failed request, B = slowest ok request, C = newest failed job. */
function pickMarks(views: RowView[]): Map<string, string> {
  const marks = new Map<string, string>()
  const newest = (list: RowView[]) => list.reduce<RowView | null>((a, b) => (!a || isoMs(b.row.timestamp) > isoMs(a.row.timestamp) ? b : a), null)
  // a downstream hop (a service called by another one) is a step of someone else's trace: never an A / B mark
  const a = newest(views.filter((v) => v.tone === 'bad' && v.http && !v.row.downstream))
  const b = views.filter((v) => v.tone !== 'bad' && v.http && !v.row.downstream).reduce<RowView | null>((x, y) => (!x || y.row.durationMs > x.row.durationMs ? y : x), null)
  const c = newest(views.filter((v) => v.tone === 'bad' && !v.http))
  if (a) marks.set(a.key, 'A')
  if (b) marks.set(b.key, 'B')
  if (c) marks.set(c.key, 'C')
  return marks
}

/** What the marks list says about a marked trace (from its detail; the error line of this entry / attempt). */
function markNote(v: RowView, d: TraceDetail | null): { note: string; err?: [string, string]; job?: string } {
  if (!d) return { note: '' }
  const wf = buildWaterfall(d)
  const log = pickEntryErrorLog(wf, d.logs, v.row.spanId)
  if (v.tone === 'bad') {
    const failed = failedSpan(wf, log)
    const err: [string, string] | undefined = log?.error ? [log.error.code || log.error.type, log.error.hint || log.message] : undefined
    if (!v.http) {
      // a job: which attempt failed and what came after
      const j = log?.job
      const next = log ? jobFollowUp(log, d.logs) : null
      const job = j?.attempt
        ? `ล้มเหลว ครั้งที่ ${j.attempt}/${j.maxAttempts || '?'}${next?.endedAt ? ` · ครั้งที่ ${next.attempt} ${next.ok ? 'สำเร็จ' : 'ล้มเหลว'} ${fmtTimeSec(next.endedAt)}` : ''}`
        : 'ล้มเหลว'
      return { note: log?.error?.hint || log?.message || failed?.span.name || '', err, job }
    }
    // a step inside the request, else the function that threw (never "พังที่ <the route itself>")
    const step = namedStep(failed, log)
    return { note: step ? `พังที่ ${spanLabel(step)}` : log?.error?.originFunction ? `พังที่ ${log.error.originFunction}` : log?.error?.hint || '', err }
  }
  const leaves = wf.spans.filter((w) => w.n > 1 && w.childCount === 0)
  const slowest = (leaves.length ? leaves : wf.spans.slice(1)).reduce<(typeof wf.spans)[number] | null>((a, b) => (!a || b.span.durationMs > a.span.durationMs ? b : a), null)
  return { note: slowest ? `span ช้าสุด ${slowest.span.name} ${fmtMs(slowest.span.durationMs)}` : '' }
}

export default async function TracesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const envs = meta.ok ? meta.data.envs : undefined
  const scope = parseScope(sp, 'traces', { envs, limited: meta.ok && meta.data.envsLimited })
  const p = new Params(sp)
  const route = p.str('route', 200)
  const status = p.oneOf('status', ['error', 'ok'] as const)
  const minMs = p.int('minMs', 0, 86_400_000)
  const kind = p.name('kind')
  const traceId = p.traceIdPrefix('traceId')
  // Params.oneOf lower-cases the value, which cannot match `durationMs`
  const sort = p.oneOf('sort', ['timestamp', 'durationMs'] as const)
  const show = p.int('show', 1, 500)
  // sample=errors|slow|spread (comma list) as the engine takes it; "เวลาที่ใช้" sort without one = the slowest 100 of the range
  const sampleRaw = p.list('sample')
  const sampleBad = sampleRaw?.filter((s) => !(SAMPLE_PARTS as readonly string[]).includes(s.toLowerCase())) ?? []
  if (sampleBad.length) p.problems.push({ name: 'sample', value: sampleRaw!.join(','), message: `ค่า sample ต้องเป็น ${SAMPLE_PARTS.join(', ')} (คั่นด้วย ,)` })
  const sampleAsked = sampleRaw && !sampleBad.length ? (Array.from(new Set(sampleRaw.map((s) => s.toLowerCase()))) as SamplePart[]) : undefined
  const sample = sampleAsked ? sampleAsked.join(',') : sort === 'durationMs' ? undefined : 'spread'
  const common = scopeQuery(scope)
  const [res, ov, deps, errs] = await Promise.all([
    engine.traces({ ...common, route, status, minMs, kind, traceId, sort, sample, limit: SAMPLE_LIMIT }),
    engine.overview(common),
    engine.dependencies({ env: scope.env, from: scope.from, to: scope.to }),
    engine.errors({ ...common, limit: 500 }),
  ])
  const order = serviceOrder(meta.ok ? meta.data : null)
  const jobs = ov.ok ? ov.data.jobs : []
  const views = res.ok ? res.data.rows.map((r) => viewOf(r, jobs)) : []
  const marks = pickMarks(views)
  for (const v of views) v.mark = marks.get(v.key)
  // details of the marked traces: the marks list notes and the row that starts open (A)
  const markIds = Array.from(new Set(views.filter((v) => v.mark).map((v) => v.row.traceId)))
  const details = new Map<string, TraceDetail>()
  await Promise.all(
    markIds.map(async (id) => {
      const d = await engine.trace(id, { env: scope.env })
      if (d.ok) details.set(id, d.data)
    }),
  )
  const notes = new Map(views.filter((v) => v.mark).map((v) => [v.key, markNote(v, details.get(v.row.traceId) ?? null)]))

  // filters
  const services = (meta.ok ? meta.data.services : []).filter((s) => !scope.env || s.envs.includes(scope.env))
  const roles = Array.from(new Set(services.filter((s) => !scope.service || s.service === scope.service).flatMap((s) => s.roles))).sort()
  const groups = routeGroups(ov.ok ? ov.data.routes : [], jobs, route)
  const hasFilters = !!(scope.service || scope.role || route || status || minMs !== undefined || traceId || kind)
  const clearHref = buildHref('/traces', scope.keep, { sort })
  const newSince: Record<string, string> = {}
  if (errs.ok) for (const g of errs.data.groups) if (g.isNew) newSince[g.fingerprint] = g.firstSeenVersion

  const bands = deps.ok ? outages(deps.data.events, scope.fromMs, scope.toMs) : []
  const words = rangeWords(scope)
  const n = views.length
  const bad = views.filter((v) => v.tone === 'bad')
  const slow = views.filter((v) => v.tone === 'slow')
  // what the engine's totals count: entries (requests + job attempts), distinct traces, failed and slow requests
  const totalsText = res.ok
    ? `${fmtCount(res.data.totalTraces)} trace · error ${fmtCount(res.data.totalErrors)} · request ช้า ${fmtCount(res.data.totalSlow)}`
    : ''
  // a range that crosses midnight (ICT): times carry the date
  const withDate = !sameDay(scope.fromMs, scope.toMs)
  const tsFormat = withDate ? 'date-ms' : 'ms'
  // a job attempt, consumer or downstream request opens the trace with its own entry span selected (?span=)
  const firstOfTrace = new Map<string, number>()
  for (const v of views) firstOfTrace.set(v.row.traceId, Math.min(firstOfTrace.get(v.row.traceId) ?? Infinity, isoMs(v.row.timestamp)))
  const entryHref = (v: RowView) =>
    buildHref(`/traces/${v.row.traceId}`, scope.keep, v.row.spanId && (!v.http || isoMs(v.row.timestamp) > (firstOfTrace.get(v.row.traceId) ?? 0)) ? { span: v.row.spanId } : undefined)
  const points: ScatterPoint[] = views.map((v) => ({
    key: v.key,
    href: entryHref(v),
    t: isoMs(v.row.timestamp),
    ms: v.row.durationMs,
    tone: v.tone,
    http: v.http,
    when: fmtDateTimeMs(v.row.timestamp),
    what: v.what,
    status: v.status,
    svc: `${v.row.service}/${v.row.role}`,
    mark: v.mark,
    err: notes.get(v.key)?.err,
    clock: fmtTimeSec(v.row.timestamp),
    msText: fmtMs(v.row.durationMs),
  }))
  const maxMs = Math.max(0, ...views.map((v) => v.row.durationMs))
  const shown = Math.min(n, show ?? FIRST_ROWS)
  const bySlowest = sort === 'durationMs'
  const listServices = order.filter((s) => views.some((v) => v.row.services.includes(s) || v.row.service === s))
  const marked = ['A', 'B', 'C'].map((m) => views.find((v) => v.mark === m)).filter((v): v is RowView => !!v)
  const sortHref = (s: string | null) => withParams('/traces', sp, { sort: s, show: null })
  const firstOpen = views.slice(0, shown).find((v) => v.tone === 'bad' && v.mark === 'A' && details.has(v.row.traceId))

  return (
    <>
      <PageHead
        scope={scope}
        title="Trace"
        question="Request หรือ job ไหนช้า หรือ error ในช่วงเวลานี้"
        actions={
          <Link className="btn" href={buildHref('/logs', scope.keep, { service: scope.service, role: scope.role })}>
            เปิด Log ช่วงเดียวกัน
          </Link>
        }
      />
      <ParamProblems problems={[...scope.problems, ...p.problems]} />
      <RowNav />
      <TraceFilters services={services.map((s) => s.service)} roles={roles} routeGroups={groups} keep={scope.keep} clearHref={clearHref} hasFilters={hasFilters} />

      {!res.ok ? (
        <EngineErrorState error={res.error} />
      ) : n === 0 ? (
        <div className="panel">
          <EmptyState
            icon="search-none"
            title="ไม่พบ trace ที่ตรงกับตัวกรอง"
            text={`ไม่มี request หรือ job ${hasFilters ? 'ที่ตรงกับตัวกรอง' : ''}ใน ${rangeText(scope)}${scope.env ? ` ของ ${scope.env}` : ''} ลองขยายช่วงเวลาหรือเอาตัวกรองออก`}
            actions={
              <>
                {scope.preset !== 'now-24h' && scope.preset !== 'now-7d' ? (
                  <Link className="btn btn--sm" href={withParams('/traces', sp, { from: 'now-24h', to: null, show: null })}>
                    ขยายเป็น 24 ชั่วโมง
                  </Link>
                ) : null}
                {hasFilters ? (
                  <Link className="btn btn--sm btn--quiet" href={clearHref}>
                    ล้างตัวกรอง
                  </Link>
                ) : null}
              </>
            }
          />
        </div>
      ) : (
        <>
          <figure className="chart" aria-labelledby="sc-title">
            <div className="chart__head">
              <h2 className="chart__title" id="sc-title">
                เวลาที่ใช้ของแต่ละ trace
              </h2>
              <span className="chart__sub">
                {res.data.sample ? (
                  <>
                    {fmtCount(n)} จุดตัวอย่างจาก request และ job ทั้งหมด {fmtCount(res.data.total)} ครั้ง ({totalsText}) ใน {words} (<code>sample={res.data.sample.join(',')}</code>) ·{' '}
                    {res.data.sample.includes('spread') ? 'error และ trace ที่ช้าขึ้นก่อน จึงไม่ใช่สัดส่วนจริง' : `เฉพาะ ${res.data.sample.join(' และ ')}`} · แกนตั้งแบบ log
                  </>
                ) : (
                  <>
                    {fmtCount(n)} จุด{bySlowest ? 'ที่ช้าที่สุด' : 'ล่าสุด'}จาก request และ job ทั้งหมด {fmtCount(res.data.total)} ครั้ง ({totalsText}) ใน {words} · ไม่ได้สุ่มตัวอย่าง · แกนตั้งแบบ log
                  </>
                )}
              </span>
              <ul className="legend">
                <li className="legend__item">
                  <span className="legend__key legend__key--dot" style={{ '--c': 'var(--bar-neutral)' } as CSSProperties} />
                  ok
                </li>
                <li className="legend__item">
                  <span className="legend__key legend__key--dot" style={{ '--c': 'var(--warn-solid)' } as CSSProperties} />
                  ช้า (request ≥ 2 s)
                </li>
                <li className="legend__item">
                  <span className="legend__key legend__key--dot" style={{ '--c': 'var(--danger-solid)' } as CSSProperties} />
                  error
                </li>
                <li className="legend__item" aria-hidden="true">
                  <span className="tr-legend-sep" />
                </li>
                <li className="legend__item">
                  <span className="legend__key legend__key--dot" style={{ '--c': 'var(--muted)' } as CSSProperties} />
                  HTTP request
                </li>
                <li className="legend__item">
                  <span className="legend__key" style={{ '--c': 'var(--muted)' } as CSSProperties} />
                  job · message · cron
                </li>
              </ul>
            </div>
            <TimeAxisPlot>
              <TraceScatter points={points} fromMs={scope.fromMs} toMs={scope.toMs} bands={bands} titleId="sc-title" descId="sc-desc" desc={scatterDesc(points, scope.fromMs, scope.toMs)} />
            </TimeAxisPlot>
            {marked.length ? (
              <ul className="tr-marks" aria-label="Trace ที่ทำเครื่องหมายบนกราฟ">
                {marked.map((v) => {
                  const note = notes.get(v.key)
                  return (
                    <li key={v.mark}>
                      <span className="tr-mark" aria-hidden="true">
                        {v.mark}
                      </span>
                      <Ts value={v.row.timestamp} format={tsFormat} />
                      {v.http ? (
                        <>
                          <span className="tr-marks__what">
                            <Method method={v.row.method} /> {v.row.httpRoute || v.row.route.replace(/^\S+ /, '')}
                          </span>
                          <HttpStatus status={v.row.status} />
                          <b className={v.tone === 'slow' ? 'num t-warn' : 'num'}>
                            {fmtMs(v.row.durationMs)}
                            {v.tone === 'slow' ? ' · ช้า' : ''}
                          </b>
                        </>
                      ) : (
                        <>
                          <span className="tr-marks__what">
                            {v.module ? <Tag>{v.module}</Tag> : null} {v.what}
                            {v.row.job?.id ? ` #${v.row.job.id}` : ''}
                          </span>
                          <span className="t-danger small">{note?.job ?? 'ล้มเหลว'}</span>
                          <b className="num">{fmtMs(v.row.durationMs)}</b>
                        </>
                      )}
                      {note?.note ? <span className="tr-marks__note">{note.note}</span> : null}
                      <Link className="mono small" href={entryHref(v)}>
                        {v.row.traceId}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            <div className="chart__foot">
              <span>
                error {bad.length} · ช้า {slow.length} จาก {fmtCount(n)} จุดในกราฟ · ทั้งช่วงมี request ช้า (≥ {fmtMs(res.data.slowMs)}) {fmtCount(res.data.totalSlow)} ครั้ง
                {bands.length ? ` · แถบแดงจาง = ${bands.map((b) => b.text).join(', ')}` : ''} · แกนตั้งแบบ log: ทุก 2 เส้นเท่ากับ 10 เท่า
              </span>
              {bad.length || slow.length ? (
                <details className="chart__table">
                  <summary className="summary-line">ดูจุดที่ error และช้าเป็นตาราง</summary>
                  <div className="table-wrap">
                    <table className="table table--dense">
                      <thead>
                        <tr>
                          <th scope="col">เวลา</th>
                          <th scope="col">Route หรือ job</th>
                          <th scope="col">Service</th>
                          <th scope="col">สถานะ</th>
                          <th scope="col">เด่นเพราะ</th>
                          <th scope="col" className="num">
                            เวลาที่ใช้
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {views
                          .filter((v) => v.tone !== 'ok')
                          .sort((a, b) => isoMs(b.row.timestamp) - isoMs(a.row.timestamp))
                          .map((v) => (
                            <tr key={v.key}>
                              <td>
                                <Ts value={v.row.timestamp} format={tsFormat} />
                              </td>
                              <td className="mono nowrap">
                                {v.what} {v.mark ? <span className="tr-mark">{v.mark}</span> : null}
                              </td>
                              <td className="nowrap">
                                <ServiceChip service={v.row.service} role={v.row.role} order={order} />
                              </td>
                              <td>{v.http ? <HttpStatus status={v.row.status} /> : <span className="t-danger">ล้มเหลว</span>}</td>
                              <td>{v.tone === 'bad' ? <span className="t-danger">error</span> : <span className="t-warn">ช้า</span>}</td>
                              <td className="num">{fmtMs(v.row.durationMs)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </div>
          </figure>

          <section className="section" aria-labelledby="h-list">
            <div className="section__head">
              <h2 className="section__title" id="h-list">
                รายการ trace
              </h2>
              <span className="section__meta">
                {res.data.sample ? `${fmtCount(n)} แถวชุดเดียวกับกราฟ` : bySlowest ? `${fmtCount(n)} ที่ช้าที่สุดในช่วงนี้ (ชุดเดียวกับกราฟ)` : `${fmtCount(n)} แถวล่าสุด (ชุดเดียวกับกราฟ)`} · {bySlowest ? 'ช้าสุดก่อน' : 'ใหม่สุดก่อน'} · แสดง {shown} แถวแรก
              </span>
              <div className="section__actions">
                <ul className="legend" aria-label="สี service">
                  {listServices.map((s) => (
                    <li className="legend__item" key={s}>
                      <span className="legend__key" style={{ '--c': svcColor(s, order) } as CSSProperties} />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="lead tr-lead">
              1 แถว = 1 entry span คือจุดที่งานเริ่มในระบบ: HTTP request จากผู้ใช้, BullMQ job, Kafka message หรือ cron · job ที่ retry มี 1 แถวต่อ attempt จึงอาจมีหลายแถวใน trace เดียว · เวลาที่ใช้ = เวลาของ entry span นั้น · request ที่ service อื่นเรียกต่อ (เช่น POST /etl/parse-excel) ไม่มีแถวของตัวเอง ดูได้ใน waterfall · คลิกแถวเพื่อเปิด waterfall
            </p>
            <div className="table-wrap">
              <table className="table table--dense table--reflow tr-table">
                <caption className="sr-only">
                  Entry span {shown} แถว{bySlowest ? 'ที่ช้าที่สุด' : 'ล่าสุด'}จาก {fmtCount(n)} trace ตัวอย่าง {scope.env ?? 'ทุก env'} {fmtRange(scope.fromMs, scope.toMs)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="col-tight">
                      <span className="sr-only">ขยาย</span>
                    </th>
                    <SortTh label="เวลา" href={sortHref(null)} dir={bySlowest ? undefined : 'descending'} />
                    <th scope="col">Service / role</th>
                    <th scope="col">Route หรือ job</th>
                    <th scope="col">สถานะ</th>
                    <SortTh label="เวลาที่ใช้" href={sortHref('durationMs')} dir={bySlowest ? 'descending' : undefined} num />
                    <th scope="col" className="num">
                      Span
                    </th>
                    <th scope="col" className="num">
                      Error
                    </th>
                    <th scope="col" title="ทุก service ที่มี span ใน trace นี้">
                      ผ่าน service
                    </th>
                    <th scope="col">Trace id</th>
                  </tr>
                </thead>
                <tbody>
                  {views.slice(0, shown).map((v) => {
                    const href = entryHref(v)
                    const cells = <Cells v={v} href={href} maxMs={maxMs} order={order} tsFormat={tsFormat} />
                    const cls = ['is-clickable', v.tone === 'bad' ? 'is-bad' : v.tone === 'slow' ? 'is-slow' : ''].filter(Boolean).join(' ')
                    if (v.tone !== 'bad')
                      return (
                        <tr key={v.key} className={cls} data-key={v.key}>
                          <td className="col-tight tr-c-tog" />
                          {cells}
                        </tr>
                      )
                    const ctx: ErrorBlockContext = {
                      keep: scope.keep,
                      newSince,
                      moduleLabel: v.module,
                      label: v.mark ? `error ของ trace ${v.mark}` : `error ของ trace ${v.what} ${fmtTimeSec(v.row.timestamp)}`,
                      aiId: `ai-trace-${v.key.replace(/[^\w-]+/g, '-')}`,
                      entrySpanId: v.row.spanId || undefined,
                    }
                    const open = firstOpen === v
                    const openDetail = open ? (details.get(v.row.traceId) ?? null) : null
                    return (
                      <TraceErrorRow
                        key={v.key}
                        rowKey={v.key}
                        traceId={v.row.traceId}
                        cells={cells}
                        className={cls}
                        label={`ขยาย error ของ ${v.what} ${fmtTimeSec(v.row.timestamp)}`}
                        colSpan={COLS}
                        defaultOpen={open}
                        initial={openDetail ? slimDetail(openDetail, pickEntryErrorLog(buildWaterfall(openDetail), openDetail.logs, v.row.spanId)) : null}
                        ctx={ctx}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="list-foot tr-foot">
              <span className="hint">
                แสดง {shown} จาก {fmtCount(n)} trace · แถบเวลาที่ใช้เทียบกับแถวที่นานที่สุด ({fmtMs(maxMs)}) แบบเส้นตรง
              </span>
              {shown < n ? (
                <Link className="btn btn--sm" href={withParams('/traces', sp, { show: String(Math.min(n, shown + MORE_ROWS)) })} scroll={false}>
                  แสดงอีก {Math.min(MORE_ROWS, n - shown)} แถว
                </Link>
              ) : null}
            </div>
          </section>
        </>
      )}
    </>
  )
}

/** The cells of one trace row after the toggle cell. */
function Cells({ v, href, maxMs, order, tsFormat }: { v: RowView; href: string; maxMs: number; order: string[]; tsFormat: 'ms' | 'date-ms' }): ReactNode {
  const r = v.row
  const js = jobStatus(r)
  const durText = fmtMs(r.durationMs)
  return (
    <>
      <td className="tr-c-time">
        <Ts value={r.timestamp} format={tsFormat} />
      </td>
      <td className="nowrap tr-c-svc">
        <ServiceChip service={r.service} role={r.role} order={order} />
      </td>
      <td className="nowrap tr-c-what">
        {v.http ? (
          <Link className="tr-name" href={href}>
            <span className="method">{r.method}</span> <span>{r.httpRoute || r.route.replace(/^\S+ /, '')}</span>
          </Link>
        ) : (
          <>
            {v.module ? <Tag>{v.module}</Tag> : null}{' '}
            <Link className="tr-name" href={href} title={r.route}>
              {v.what}
            </Link>
            {r.job?.id ? (
              <>
                {' '}
                <span className="t-muted mono small" title="job.id จาก attribute ของ entry span">
                  #{r.job.id}
                </span>
              </>
            ) : null}
          </>
        )}
        {v.mark ? (
          <>
            {' '}
            <span className="tr-mark" title={`Trace ${v.mark} ในกราฟ`}>
              {v.mark}
            </span>
          </>
        ) : null}
      </td>
      <td className="nowrap tr-c-st">
        {v.http ? (
          r.status ? <HttpStatus status={r.status} /> : <span className="t-muted">–</span>
        ) : js.failed ? (
          <>
            <span className="t-danger">ล้มเหลว</span>
            {js.attempt ? (
              <>
                {' '}
                <span className="t-muted small" title={`attempt ครั้งที่ ${r.job?.attempt} จาก ${r.job?.maxAttempts || '?'}`}>
                  {js.attempt}
                </span>
              </>
            ) : null}
          </>
        ) : (
          <span className="t-muted">สำเร็จ</span>
        )}
      </td>
      <td className="num tr-c-dur">
        <span className="dur-cell">
          {v.tone === 'bad' ? <span className="t-danger">{durText}</span> : v.tone === 'slow' ? <span className="t-warn">{durText} · ช้า</span> : durText}
          <DurBar width={maxMs > 0 ? (r.durationMs / maxMs) * 100 : 0} tone={v.tone === 'bad' ? 'bad' : v.tone === 'slow' ? 'warn' : undefined} />
        </span>
      </td>
      <td className="num tr-c-spans" data-label="span">
        {fmtCount(r.spanCount)}
      </td>
      <td className={r.errorCount ? 'num t-danger tr-c-err' : 'num t-muted tr-c-err'} data-label="error">
        {fmtCount(r.errorCount)}
      </td>
      <td className="rf-hide">
        <ServiceDots services={r.services.length ? r.services : [r.service]} order={order} />
      </td>
      <td className="nowrap tr-c-id">
        <span className="idchip">
          <Link href={href} title={r.traceId}>
            {shortId(r.traceId)}
          </Link>
          <CopyButton text={r.traceId} variant="icon" ariaLabel={`คัดลอก trace id ${r.traceId.slice(0, 8)}`} />
        </span>
      </td>
    </>
  )
}

