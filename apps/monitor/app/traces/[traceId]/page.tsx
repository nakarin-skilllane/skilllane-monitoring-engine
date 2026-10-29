import type { Metadata } from 'next'
import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { ActualError, ErrorWhatFix, KvList } from '@/components/ErrorParts'
import { CategoryChip, HttpStatus, LevelBadge, NewBadge, ServiceChip, Ts } from '@/components/badges'
import { Icon } from '@/components/icons'
import { Kpi, Kpis } from '@/components/Kpi'
import { PageHead } from '@/components/PageHead'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { engine, getMeta } from '@/lib/engine'
import { fmtCount, fmtDuration, fmtMs, fmtNumber, fmtRange, fmtTimeMs, fmtTimeSec, shortId } from '@/lib/format'
import { buildHref, isTraceId, Params, parseScope, type RawSearchParams, type Scope, withParams } from '@/lib/params'
import { actualError, type Kv, logDetail, logKvs, logTitle, logWhatFix } from '@/lib/readable'
import { normalizeSpanDetail } from '@/lib/io'
import { serviceOrder } from '@/lib/services'
import type { LogRow, SpanDetail } from '@/lib/types'
import {
  aiTraceMarkdown,
  buildWaterfall,
  descendants,
  failedSpan,
  fmtOff,
  ioSpanOf,
  isoMs,
  jobFollowUp,
  jobModule,
  namedStep,
  pickErrorLog,
  servicePath,
  spanLabel,
  stepOf,
  type Waterfall,
  type WfSpan,
  withRequest,
} from '../_lib/model'
import { type LogMarker, type SpanErrorRef, TraceView, type WfModel } from './_components/TraceView'
import './screen.css'

type Props = { params: Promise<{ traceId: string }>; searchParams: Promise<RawSearchParams> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { traceId } = await params
  return { title: `Trace ${shortId(traceId)}` }
}

const QUESTION = 'Request เดียวที่ข้ามหลาย service: เวลาหมดไปกับขั้นไหน และพังที่ขั้นไหน'
const LEVEL_SHORT: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' }
const LEVEL_TIP: Record<string, string> = { debug: 'debug-solid', info: 'info-solid', warn: 'warn-solid', error: 'danger-solid', fatal: 'danger-solid' }

/** `1 ชั่วโมง` for a preset range, else the absolute range. */
function rangeWords(scope: Scope): string {
  const words: Record<string, string> = { 'now-15m': '15 นาที', 'now-1h': '1 ชั่วโมง', 'now-6h': '6 ชั่วโมง', 'now-24h': '24 ชั่วโมง', 'now-7d': '7 วัน' }
  return words[scope.preset] ?? fmtRange(scope.fromMs, scope.toMs)
}

/** Axis widths (px) below which a tick label is hidden (td-tick--N, a container query on the axis). */
const TICK_WIDTHS = [320, 480, 640, 800, 960]
/** Width of one character of the 11 px mono axis labels, in px. */
const TICK_CH = 6.7

/**
 * The narrowest axis on which a tick at `t` % keeps clear of the right-aligned end label (centred label: half its
 * width left of `t`); undefined when it always fits. On a 400 px phone `15,000` at 87 % ran into `17,151`.
 */
function tickHideBelow(t: number, label: string, endLabel: string): number | undefined {
  if (t <= 0) return undefined
  const need = (label.length / 2 + endLabel.length) * TICK_CH + 8
  const minWidth = need / ((100 - t) / 100)
  if (minWidth <= 240) return undefined
  return TICK_WIDTHS.find((w) => w >= minWidth) ?? TICK_WIDTHS[TICK_WIDTHS.length - 1]
}

/** Round axis step (1, 2, 2.5, 5 × 10^k) for about four labels. */
function axisStep(total: number): number {
  const raw = total / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
}

/** Log markers on the lane; markers closer than 2 % (about one marker wide) stack vertically. */
function markersOf(logs: LogRow[], wf: Waterfall): LogMarker[] {
  const out: LogMarker[] = logs.map((l, i) => {
    const off = isoMs(l.timestamp) - wf.t0
    const t = Math.max(0, Math.min(100, (off / wf.total) * 100))
    const title = logTitle(l)
    const short = LEVEL_SHORT[l.level] ?? l.level.toUpperCase()
    // an http.request line says which request and how it answered (traces mockup: `http.request POST /question-bank/import 500`)
    const req = l.eventCode === 'http.request' && l.http ? ` ${[l.http.method, l.http.route || l.http.path, l.http.status || ''].filter(Boolean).join(' ')}` : ''
    const text = `${title.prefix && l.eventCode === 'http.request' ? `${title.prefix} ` : ''}${req ? req.trim() : title.title}`
    return {
      id: `log-${i + 1}`,
      t,
      level: l.level,
      tip: `+${fmtMs(off)} · ${fmtTimeMs(l.timestamp)}|${short}::${text}`,
      tipKey: LEVEL_TIP[l.level] ?? 'info-solid',
      label: `log ${short} ${fmtTimeMs(l.timestamp)} ${text}`,
      spanId: l.spanId,
    }
  })
  const sorted = [...out].sort((a, b) => a.t - b.t)
  let cluster: LogMarker[] = []
  const flush = () => {
    if (cluster.length > 1) cluster.forEach((m, i) => (m.y = Math.round(24 + (i * 52) / (cluster.length - 1))))
    cluster = []
  }
  for (const m of sorted) {
    if (cluster.length && m.t - cluster[cluster.length - 1].t > 2) flush()
    cluster.push(m)
  }
  flush()
  return out
}

function Invalid({ scope, traceId, title, text, actions }: { scope: Scope; traceId: string; title: string; text: string; actions?: ReactNode }) {
  return (
    <>
      <PageHead
        scope={scope}
        title="Trace"
        question={QUESTION}
        crumbs={[{ label: 'Trace', href: buildHref('/traces', scope.keep) }, { label: shortId(traceId), mono: true, title: traceId }]}
      />
      <ParamProblems problems={scope.problems} />
      <div className="panel">
        <EmptyState icon="search-none" title={title} text={text} actions={actions} />
      </div>
    </>
  )
}

export default async function TraceDetailPage({ params, searchParams }: Props) {
  const [{ traceId: rawId }, sp] = await Promise.all([params, searchParams])
  const meta = await getMeta()
  const scope = parseScope(sp, 'trace', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
  if (!isTraceId(rawId)) {
    return <Invalid scope={scope} traceId={rawId} title="trace id ไม่ถูกต้อง" text="trace id ต้องเป็นเลขฐานสิบหก 32 ตัว (เช่นจาก header request-id หรือช่อง trace ใน Log)" />
  }
  const traceId = rawId.toLowerCase()
  const p = new Params(sp)
  const spanParam = get16(p.str('span', 64))
  // the open Network panel, in either view (`span` alone only selects)
  const ioParam = get16(p.str('io', 64))
  const view = p.oneOf('view', ['waterfall', 'network'] as const) ?? 'waterfall'
  // a trace id is unique: ask for it in every env, then show its own env (a user limited to some envs: in the selected one)
  const res = await engine.trace(traceId, meta.ok && meta.data.envsLimited ? { env: scope.env } : {})
  if (!res.ok) {
    if (res.error.status === 404)
      return (
        <Invalid
          scope={scope}
          traceId={traceId}
          title="ไม่พบ trace นี้"
          text={`ไม่มี span ของ trace ${traceId} ในข้อมูลที่เก็บไว้ อาจเก่ากว่าระยะที่เก็บ หรือยังส่งมาไม่ถึง ลองค้น log ด้วย trace id เดียวกัน`}
          actions={
            <>
              <Link className="btn btn--sm" href={buildHref('/logs', scope.keep, { traceId })}>
                ค้น log ด้วย trace id นี้
              </Link>
              <Link className="btn btn--sm btn--quiet" href={buildHref('/traces', scope.keep)}>
                กลับไปที่รายการ trace
              </Link>
            </>
          }
        />
      )
    return (
      <>
        <PageHead scope={scope} title="Trace" question={QUESTION} crumbs={[{ label: 'Trace', href: buildHref('/traces', scope.keep) }, { label: shortId(traceId), mono: true, title: traceId }]} />
        <ParamProblems problems={[...scope.problems, ...p.problems]} />
        <EngineErrorState error={res.error} />
      </>
    )
  }

  const d = res.data
  const env = d.env || scope.env
  const tscope: Scope = { ...scope, env }
  const order = serviceOrder(meta.ok ? meta.data : null)
  const wf = buildWaterfall(d)
  const root = wf.root
  const logs = [...d.logs].sort((a, b) => isoMs(a.timestamp) - isoMs(b.timestamp))
  const raw = pickErrorLog(logs)
  const errLog = raw ? withRequest(raw, logs) : null
  const hasError = !!errLog?.error || wf.spans.some((w) => w.isError)
  const failed = hasError ? failedSpan(wf, errLog) : null
  // a step inside the request (or the one the line names); never "span #1 <the route itself>"
  const step = namedStep(failed, errLog)
  const errOff = errLog ? isoMs(errLog.timestamp) - wf.t0 : 0
  const origin = errLog?.error?.originFunction ?? ''
  // a job that failed, retried and then finished OK: the trace recovered (warn, not error)
  const follow = errLog?.job ? jobFollowUp(errLog, logs) : null
  const recovered = !!follow?.ok && !!follow.endedAt
  const retries = recovered && errLog?.job ? logs.filter((l) => l.eventCode === 'job.retry' && l.job?.id === errLog.job!.id && l.job.queue === errLog.job!.queue).length : 0
  const recoveredText = recovered && errLog?.job ? `retry ${retries || 1} ครั้ง แล้วสำเร็จครั้งที่ ${follow!.attempt} เวลา ${fmtTimeSec(follow!.endedAt)}` : ''
  const path = servicePath(wf)
  // ?io=: the panel of that span, or of the nearest span above it with I/O (a log line written in a handler step
  // opens its request), whatever the view; the server fetches its detail so the panel opens filled
  const ioSpan = ioParam ? ioSpanOf(wf, ioParam) : null
  const openSpanId = ioSpan?.span.spanId ?? null

  const [grp, ov, ioRes] = await Promise.all([
    errLog?.fingerprint ? engine.error(errLog.fingerprint, { env, from: 'now-24h' }) : Promise.resolve(null),
    root ? engine.overview({ env, from: scope.from, to: scope.to, service: root.span.service, role: root.span.role }) : Promise.resolve(null),
    openSpanId ? engine.span(traceId, openSpanId, { env: res.data.env || scope.env }) : Promise.resolve(null),
  ])
  const group = grp?.ok ? grp.data.group : null
  const newSince = group?.isNew ? group.firstSeenVersion : undefined
  const jobs = ov?.ok ? ov.data.jobs : []

  // title: the root request (method + route) or job
  const rs = root?.span
  const isHttp = !!rs?.http?.method
  const title = rs ? (isHttp ? `${rs.http!.method} ${rs.http!.route || rs.http!.path || rs.name}` : rs.name) : traceId
  const routeKey = rs ? (isHttp ? `${rs.http!.method} ${rs.http!.route}` : rs.name) : ''
  const p95 = ov?.ok ? ov.data.routes.find((r) => r.route === routeKey && r.service === rs?.service)?.p95Ms : undefined
  const svcCount = new Set(path.map((s) => s.service)).size
  const question = `${isHttp ? 'Request' : 'Job'} เดียว${svcCount > 1 ? `ที่ข้าม ${svcCount} service` : ''}: เวลาหมดไปกับขั้นไหน และพังที่ขั้นไหน`
  const userLog = logs.find((l) => l.userId)
  // a trace older than the selected range: open its logs on a window around it, not on an empty range
  const logsHref = buildHref('/logs', scope.keep, {
    traceId,
    ...(wf.t0 < scope.fromMs || wf.t0 > scope.toMs ? { from: new Date(wf.t0 - 60_000).toISOString(), to: new Date(wf.t0 + wf.total + 60_000).toISOString() } : {}),
  })
  const hrefSelf = (spanId: string) => `${withParams(`/traces/${traceId}`, sp, { span: spanId })}#span-detail-section`
  const moduleLabel = errLog?.job ? jobModule({ route: `${errLog.job.queue} ${errLog.job.type}`, name: '', job: { ...errLog.job, module: errLog.eventModule } }, jobs) : ''

  // the error line of each span (exception panel "ตรงกับ error")
  const spanErrors: Record<string, SpanErrorRef> = {}
  for (const l of logs) {
    if (!l.error || !l.fingerprint) continue
    const ref = { href: buildHref(`/errors/${l.fingerprint}`, scope.keep), title: l.error.hint || l.message, category: l.error.category }
    // failed_step inside the line's own subtree (its attempt), else the failing span below it
    const target = failedSpan(wf, l)
    if (target && !spanErrors[target.span.spanId]) spanErrors[target.span.spanId] = ref
    if (l.spanId && !spanErrors[l.spanId]) spanErrors[l.spanId] = ref
  }

  // axis: round labels, gridlines every half step
  const axis = axisStep(wf.total)
  const ticks: Array<{ t: number; label: string; hideBelow?: number }> = []
  const endLabel = fmtOff(wf.total)
  for (let v = 0; v < wf.total; v += axis) {
    const t = (v / wf.total) * 100
    if (t > 90 && v > 0) break
    const label = v === 0 ? '0 ms' : fmtOff(v)
    ticks.push({ t, label, hideBelow: tickHideBelow(t, label, endLabel) })
  }
  const markers = markersOf(logs, wf)
  const openDetail: SpanDetail | null = ioRes?.ok && ioSpan ? normalizeSpanDetail(ioRes.data, ioSpan.span) : null
  const initial = openSpanId ?? (spanParam && wf.byId.has(spanParam) ? spanParam : null) ?? failed?.span.spanId ?? root?.span.spanId ?? ''
  const model: WfModel = {
    traceId,
    start: new Date(wf.t0).toISOString(),
    t0: wf.t0,
    total: wf.total,
    spans: wf.spans,
    markers,
    ticks,
    gridMs: axis / 2,
    env: env ?? '',
    order,
    initialSpanId: initial,
    failedSpanId: failed?.span.spanId ?? null,
    spanErrors,
    view,
    openSpanId,
    openDetail,
    openMissing: !!ioRes && !ioRes.ok && ioRes.error.status === 404,
  }

  // KPI 4: time in the other service, else the longest step
  const hop = wf.spans.find((w) => w.hop && w.railAt !== null)
  const hopSpans = hop ? wf.spans.filter((w) => w.hop && w.span.service === hop.span.service && w.span.role === hop.span.role) : []
  const hopMs = hopSpans.reduce((a, w) => a + w.span.durationMs, 0)
  const longestLeaf = (list: WfSpan[]) => list.filter((w) => w.childCount === 0).reduce<WfSpan | null>((a, b) => (!a || b.span.durationMs > a.span.durationMs ? b : a), null)
  const hopLeaf = hop ? longestLeaf(hopSpans.flatMap((w) => [w, ...descendants(wf, w)])) : null
  const leaf = longestLeaf(wf.spans.slice(1)) ?? root
  const counts = group ? `group ${fmtCount(group.count)} times${group.users ? ` · ${fmtCount(group.users)} users` : ''} in 24 h` : undefined
  // the request of a trace that also ran queued jobs (CONSUMER spans): its own time is what the route p95 measures
  const withJobs = isHttp && wf.spans.some((w) => w.span.kind === 'CONSUMER')
  const resultDelta: { text: string; tone?: 'bad' | 'good' } = recovered
    ? { text: recoveredText }
    : step
      ? { text: `พังที่ span #${step.n} · +${fmtMs(step.start)}`, tone: 'bad' }
      : errLog && hasError
        ? { text: `error ที่ ${origin || logTitle(errLog).prefix || 'บรรทัด log'} · +${fmtMs(errOff)}`, tone: 'bad' }
        : failed
          ? { text: `พังที่ span #${failed.n} · +${fmtMs(failed.start)}`, tone: 'bad' }
          : { text: 'ไม่มี span ที่ error' }
  const md = hasError ? aiTraceMarkdown({ log: errLog, wf, detail: d, failed, newSince, moduleLabel, counts }) : ''
  const [mdHead, ...mdRest] = md.split('\n')
  const headSplit = /^(### .*?)( \([^()]*\)(?: · NEW since .*)?)?$/.exec(mdHead) ?? [mdHead, mdHead, '']
  const errTitle = errLog ? logTitle(errLog).title : (failed?.span.exception?.message ?? failed?.span.statusMessage ?? '')
  const levelCounts = Object.entries(
    logs.reduce<Record<string, number>>((acc, l) => {
      const k = LEVEL_SHORT[l.level] ?? l.level
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {}),
  )

  return (
    <>
      <PageHead
        scope={tscope}
        title={
          <span className="td-title">
            <span className="td-title__route">{title}</span>
            {isHttp && rs?.http?.status ? <HttpStatus status={rs.http.status} /> : null}
          </span>
        }
        question={question}
        when={
          <>
            <Ts value={d.start} format="date-ms" /> ICT
          </>
        }
        crumbs={[{ label: 'Trace', href: buildHref('/traces', scope.keep) }, { label: shortId(traceId), mono: true, title: traceId }]}
        metaClassName="td-meta"
        meta={
          <>
            <span className="idchip">
              <span className="idchip__k">trace</span>
              <span className="idchip__v">{traceId}</span>
              <CopyButton text={traceId} variant="icon" ariaLabel="คัดลอก trace id" />
            </span>
            <span className="td-meta__group" aria-label="Service ที่ trace นี้ผ่าน">
              {path.map((s, i) => (
                <Fragment key={`${s.service}/${s.role}`}>
                  {i ? <Icon name="arrow" size="sm" className="td-meta__arrow" /> : null}
                  <ServiceChip service={s.service} role={s.role} order={order} />
                  {i === 0 && s.version ? (
                    <span className="tag" title="service.version">
                      {s.version}
                    </span>
                  ) : null}
                </Fragment>
              ))}
            </span>
            {userLog ? (
              <span className="td-meta__group">
                <span className="idchip">
                  <span className="idchip__k">user</span>
                  <Link href={buildHref('/logs', scope.keep, { userId: userLog.userId })}>{userLog.userId}</Link>
                </span>
                {userLog.userRoles.length || userLog.organizationId ? (
                  <span>
                    {userLog.userRoles.join(', ')}
                    {userLog.organizationId ? (
                      <>
                        {userLog.userRoles.length ? ' · ' : ''}โรงเรียน <span className="mono">{userLog.organizationId}</span>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Link className="btn" href={logsHref}>
              <Icon name="logs" />
              ดู log ของ trace นี้
            </Link>
            {hasError ? <CopyButton targetId="ai-md-trace" label="คัดลอกให้ AI" variant="cta" /> : null}
          </>
        }
      />
      <ParamProblems problems={[...scope.problems, ...p.problems]} />

      {hasError ? (
        <div className="callouts">
          <div className={recovered ? 'callout callout--warn' : 'callout callout--error'} role="status">
            <Icon name={recovered ? 'alert-triangle' : 'alert-octagon'} className="callout__icon" />
            <p className="callout__title">
              {recovered ? (
                <>
                  {moduleLabel ? `${moduleLabel} ` : ''}
                  <span className="mono">{errLog?.job?.type || errLog?.job?.queue}</span>
                  {errLog?.job?.id ? ` #${errLog.job.id}` : ''} {recoveredText}
                  {errTitle ? ` (ครั้งแรก: ${errTitle})` : ''}
                </>
              ) : step ? (
                <>
                  พังที่ span #{step.n} <span className="mono">{step.span.name}</span>
                  {errTitle ? `: ${errTitle}` : ''}
                </>
              ) : origin ? (
                <>
                  พังที่ <span className="mono">{origin}</span> (+{fmtMs(errOff)}){errTitle ? `: ${errTitle}` : ''}
                </>
              ) : (
                <>พัง: {errTitle}</>
              )}
            </p>
            <p className="callout__text">
              {(errLog && logDetail(errLog)) || failed?.span.exception?.message || failed?.span.statusMessage || 'trace นี้มี span ที่ error'}
              {recovered && step ? (
                <span className="td-callout-meta">
                  attempt ที่ไม่ผ่านพังที่ span #{step.n} <span className="mono">{spanLabel(step)}</span>
                </span>
              ) : null}
              {(origin && (step || recovered)) || group ? (
                <span className="td-callout-meta">
                  {origin && (step || recovered) ? (
                    <>
                      ที่ <span className="mono">{origin}</span>
                    </>
                  ) : null}
                  {origin && (step || recovered) && group ? ' · ' : null}
                  {group
                    ? group.count > 1
                      ? `ไม่ใช่ครั้งเดียว: error group นี้เกิด ${fmtCount(group.count)} ครั้ง${group.users ? ` · ${fmtCount(group.users)} users` : ''} ใน 24 ชั่วโมง`
                      : 'error group นี้เกิดครั้งเดียวใน 24 ชั่วโมง'
                    : null}
                </span>
              ) : null}
            </p>
            <div className="callout__actions">
              {failed ? (
                <a className="btn btn--sm" href={hrefSelf(failed.span.spanId)} data-pick={failed.span.spanId}>
                  ดู span
                </a>
              ) : null}
              {errLog?.fingerprint ? (
                <Link className="btn btn--sm" href={buildHref(`/errors/${errLog.fingerprint}`, scope.keep)}>
                  เปิด error
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <Kpis cols={4} className={hasError ? 'td-kpis mt-4' : 'td-kpis'}>
        {withJobs ? (
          // the trace total includes the queued job attempts: compare the request's own time with the route p95
          <Kpi
            label="เวลารวม (รวม job)"
            value={Math.round(d.durationMs)}
            unit="ms"
            foot={`request เอง ${fmtMs(rs?.durationMs ?? 0)}${p95 ? ` · p95 ของ route นี้ ${fmtDuration(p95)} (${rangeWords(scope)})` : ''} · ที่เหลือคือ job ใน queue`}
          />
        ) : (
          <Kpi label="เวลารวม" value={Math.round(d.durationMs)} unit="ms" foot={p95 ? `p95 ของ route นี้ ${fmtDuration(p95)} (${rangeWords(scope)})` : undefined} />
        )}
        {isHttp ? (
          <Kpi
            label="ผลลัพธ์"
            value={rs?.http?.status || '–'}
            unit="HTTP"
            tone={recovered ? 'warn' : hasError ? 'alert' : undefined}
            delta={resultDelta}
            animate={false}
          />
        ) : (
          <Kpi
            label="ผลลัพธ์"
            value={recovered ? 'สำเร็จหลัง retry' : hasError ? 'ล้มเหลว' : 'สำเร็จ'}
            tone={recovered ? 'warn' : hasError ? 'alert' : undefined}
            delta={resultDelta}
          />
        )}
        <Kpi label="Span" value={d.spanCount} foot={`error ${fmtCount(d.errorCount)} · ${svcCount} service · log ${fmtCount(logs.length)}`} />
        {hop ? (
          <Kpi
            label={
              <>
                เวลาใน <ServiceChip service={hop.span.service} role={hop.span.service === rs?.service ? hop.span.role : undefined} order={order} />
              </>
            }
            value={Math.round(hopMs)}
            unit="ms"
            foot={`${fmtNumber((hopMs / wf.total) * 100, 0)} % ของ trace${hopLeaf ? ` · ${hopLeaf.span.name} ${fmtMs(hopLeaf.span.durationMs)}` : ''}`}
          />
        ) : leaf ? (
          <Kpi label="ขั้นที่นานที่สุด" value={Math.round(leaf.span.durationMs)} unit="ms" foot={`${fmtNumber((leaf.span.durationMs / wf.total) * 100, 0)} % ของ trace · ${spanLabel(leaf)}`} />
        ) : null}
      </Kpis>

      <TraceView model={model} />

      <section className="section" aria-labelledby="h-logs">
        <div className="section__head">
          <h2 className="section__title" id="h-logs">
            Log ของ trace นี้
          </h2>
          <span className="section__meta">
            {logs.length} บรรทัดตามเวลา
            {levelCounts.map(([k, v]) => ` · ${k} ${v}`).join('')}
            {logs.length ? (
              <>
                {' '}
                · <Ts value={logs[0].timestamp} />–<Ts value={logs[logs.length - 1].timestamp} />
              </>
            ) : null}
          </span>
          <div className="section__actions">
            <Link className="btn btn--sm" href={logsHref}>
              เปิดใน Log
              <Icon name="arrow" size="sm" />
            </Link>
          </div>
        </div>
        {logs.length ? (
          <div className="err-list">
            {logs.map((l, i) => (
              <LogLine key={i} l={l} i={i} logs={logs} wf={wf} keep={scope.keep} order={order} hrefSelf={hrefSelf} newSince={l.fingerprint && l.fingerprint === errLog?.fingerprint ? newSince : undefined} />
            ))}
          </div>
        ) : (
          <div className="panel">
            <EmptyState icon="logs" title="trace นี้ไม่มี log" text="service ใน trace นี้ไม่ได้เขียน log ระหว่าง request (มีแค่ span) ดู span ที่ error ใน waterfall ด้านบนแทน" />
          </div>
        )}
      </section>

      {hasError ? (
        <section className="section" id="ai-summary" aria-labelledby="h-ai">
          <div className="section__head">
            <h2 className="section__title" id="h-ai">
              คัดลอกให้ AI
            </h2>
            <span className="section__meta">ข้อความในกล่องคือสิ่งที่ปุ่ม &quot;คัดลอกให้ AI&quot; คัดลอกทุกตัวอักษร · key ชุดเดียวกับทุกหน้า · ไม่มีข้อมูลส่วนบุคคล</span>
          </div>
          <div className="ai-box">
            <div className="code-block">
              <div className="code-block__head">
                <span className="code-block__title">Markdown · error ของ trace + span + log</span>
                <CopyButton targetId="ai-md-trace" label="คัดลอกให้ AI" variant="primary" size="sm" />
              </div>
              <pre className="code code--wrap code--tall" id="ai-md-trace">
                <span className="c-key">{headSplit[1]}</span>
                {headSplit[2] ?? ''}
                {`\n${mdRest.join('\n')}`}
              </pre>
            </div>
            <div className="panel ai-box__notes">
              <div className="panel__head">
                <h3 className="panel__title">ใส่อะไร ไม่ใส่อะไร</h3>
              </div>
              <div className="panel__body">
                <div>
                  <h3>ใส่</h3>
                  <ul>
                    <li>error ของ trace ตาม template เดียวกับทุกหน้า (DESIGN.md §6b)</li>
                    <li>
                      span ที่พังพร้อม peer และ statement ที่ใส่ค่าเป็น <span className="mono">:1, :2</span>
                    </li>
                    <li>
                      ต้นไม้ span {wf.spans.length} ตัวและ log {logs.length} บรรทัดของ trace
                    </li>
                    <li>trace id ให้ AI อ้างอิงกลับได้</li>
                  </ul>
                </div>
                <div>
                  <h3>ไม่ใส่</h3>
                  <ul>
                    <li>
                      <span className="mono">user_id</span>, <span className="mono">organization_id</span> และ role ของ user
                    </li>
                    <li>ค่าของ parameter ใน SQL, request body, ชื่อไฟล์ที่อัปโหลด</li>
                    <li>IP, user agent, header</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  )
}

/** A 16-hex span id, else undefined. */
function get16(v: string | undefined): string | undefined {
  return v && /^[0-9a-f]{16}$/i.test(v) ? v.toLowerCase() : undefined
}

/** One log line of the trace in the readable error format (DESIGN.md §6). */
function LogLine({
  l,
  i,
  logs,
  wf,
  keep,
  order,
  hrefSelf,
  newSince,
}: {
  l: LogRow
  i: number
  logs: LogRow[]
  wf: Waterfall
  keep: Scope['keep']
  order: string[]
  hrefSelf: (spanId: string) => string
  newSince?: string
}) {
  const row = withRequest(l, logs)
  const t = logTitle(row)
  const off = isoMs(l.timestamp) - wf.t0
  const kvs: Kv[] = [...logKvs(row), ...Object.entries(l.fields ?? {})
    .filter(([k]) => !k.startsWith('dependency.') && !k.startsWith('http.'))
    .slice(0, 3)
    .map(([k, v]) => ({ k, v: String(v) }))]
  const own = l.spanId ? wf.byId.get(l.spanId) : undefined
  // the failed_step span of this line's own attempt (name, or name + peer host)
  const step = stepOf(wf, l) ?? undefined
  const spanRef = step ?? own
  const summary = l.eventCode === 'http.request' && !l.fingerprint && (l.level === 'error' || l.level === 'fatal')
  return (
    <article className="err-row" id={`log-${i + 1}`}>
      <div className="err-row__head">
        <LevelBadge level={l.level} />
        <h3 className="err-row__title">
          {t.prefix ? <span className="err-row__code">{t.prefix}</span> : null}
          {l.fingerprint ? <Link href={buildHref(`/errors/${l.fingerprint}`, keep)}>{t.title}</Link> : t.title}
        </h3>
        {l.error?.category ? <CategoryChip category={l.error.category} /> : null}
        {newSince ? <NewBadge since={newSince} /> : null}
        <span className="err-row__count">
          <Ts value={l.timestamp} />
          <span className="mono t-muted">+{fmtMs(off)}</span>
        </span>
      </div>
      <KvList items={kvs} />
      {l.error ? (
        <>
          <ErrorWhatFix {...logWhatFix(row)} />
          <ActualError text={actualError(row.error)} />
        </>
      ) : null}
      <div className="err-row__meta">
        <ServiceChip service={l.service} role={l.role} order={order} />
        {spanRef ? (
          <span>
            {step ? 'failed step' : 'span'}{' '}
            <a href={hrefSelf(spanRef.span.spanId)} data-pick={spanRef.span.spanId} className="mono">
              #{spanRef.n} {spanLabel(spanRef)}
            </a>
          </span>
        ) : null}
        {l.usecase ? (
          <span>
            usecase <span className="mono">{l.usecase}</span>
          </span>
        ) : null}
        {summary ? <span>บรรทัดสรุปของ request ไม่นับเป็น error group</span> : null}
        {l.userId ? (
          <span className="idchip">
            <span className="idchip__k">user</span>
            <Link href={buildHref('/logs', keep, { userId: l.userId })}>{l.userId}</Link>
          </span>
        ) : null}
        {l.error && (l.userRoles.length || l.organizationId) ? <span>{[l.userRoles.join(', '), l.organizationId].filter(Boolean).join(' · ')}</span> : null}
      </div>
    </article>
  )
}
