import type { Metadata } from 'next'
import Link from 'next/link'
import { cache, type ReactNode } from 'react'
import { CategoryChip, HttpStatus, LevelBadge, Method, NewBadge, ServiceChip, Tag, Ts } from '@/components/badges'
import { ChartFrame } from '@/components/charts/ChartFrame'
import { CopyButton } from '@/components/CopyButton'
import { Icon } from '@/components/icons'
import { Kpi, Kpis } from '@/components/Kpi'
import { PageHead } from '@/components/PageHead'
import { Panel } from '@/components/Panel'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { DurBar } from '@/components/table'
import { KvList } from '@/components/ErrorParts'
import { engine, getMeta } from '@/lib/engine'
import { fmtAiTime, fmtCount, fmtDate, fmtDateTime, fmtDuration, fmtMs, fmtNumber, fmtPercent, fmtRange, fmtRelative, fmtTime, sameDay, shortId, toMs } from '@/lib/format'
import { buildHref, isFingerprint, isPastWindow, parseScope, withParams, type RawSearchParams, type Scope } from '@/lib/params'
import { actualError, aiErrorMarkdown, CATEGORY_LABEL, groupTitle, logKvs, type Kv } from '@/lib/readable'
import { aiStack, firstAppLine, frameText, type ParsedStack, parseStack } from '@/lib/stack'
import { serviceOrder } from '@/lib/services'
import type { Deploy, ErrorDetail, ErrorGroup, LogRow, OverviewRoute } from '@/lib/types'
import {
  bucketEnd,
  bucketLabel,
  bucketStarts,
  bucketTimes,
  CATEGORY_WHY,
  deploysOf,
  depText,
  groupWhere,
  inRangeWords,
  levelCounts,
  markdownLines,
  rangeLabelText,
  releaseOf,
  rolesText,
  showNew,
  splitOf,
  stepText,
  timeOrDate,
  versionAt,
  whereShort,
} from '../_lib/errors'
import { type HourBucket, HourChart, MinuteChart } from './_components/EdCharts'
import './screen.css'

type Props = { params: Promise<{ fingerprint: string }>; searchParams: Promise<RawSearchParams> }

/** One engine call per request, shared by generateMetadata and the page (React cache). */
const loadError = cache((fp: string, env: string | undefined, from: string, to: string | undefined, step: string) => engine.error(fp, { env, from, to, step }))

async function scopeOf(sp: RawSearchParams): Promise<Scope> {
  const meta = await getMeta()
  return parseScope(sp, 'error', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
}

/** `Value too long for column · Error` (the layout adds the product name). */
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ fingerprint }, sp] = await Promise.all([params, searchParams])
  const fp = decodeURIComponent(fingerprint).trim()
  if (!isFingerprint(fp)) return { title: 'Error' }
  const scope = await scopeOf(sp)
  const res = await loadError(fp, scope.env, scope.from, scope.to, fineStep(scope))
  if (!res.ok) return { title: 'Error' }
  // the where tells two groups with one title apart in the tab list (Query cancelled · GET /classes/:id/students)
  const where = whereShort(res.data.group)
  return { title: `${groupTitle(res.data.group)}${where ? ` · ${where}` : ''} · Error` }
}

const QUESTION = 'error group เดียว: เกิดอะไร กรณีนี้ต้องแก้อะไร แก้ที่ไหน ใครโดน'
const QUESTION_NEW = 'error group ใหม่หลัง deploy: เกิดอะไร ต้องแก้อะไร แก้ที่ไหน ใครโดน'

/** Smallest whole-minute step that keeps the range ≤ 2000 buckets (minute counts for the deploy split). */
function fineStep(scope: Scope): string {
  return `${Math.max(1, Math.ceil((scope.toMs - scope.fromMs) / 60_000 / 2000))}m`
}

/** `3 นาที` / `2.5 ชั่วโมง` between two times. */
function gap(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} นาที`
  const h = Math.round((m / 60) * 10) / 10
  return h < 48 ? `${fmtNumber(h, h % 1 ? 1 : 0)} ชั่วโมง` : `${Math.round(h / 24)} วัน`
}

/** `66.8 %`, `100 %`. */
function share(part: number, total: number): string {
  if (!total) return '0 %'
  const v = (part / total) * 100
  return `${fmtNumber(v, Number.isInteger(Math.round(v * 10) / 10) ? 0 : 1)} %`
}

function ShareCell({ part, total, bad }: { part: number; total: number; bad?: boolean }) {
  if (!part) return <td className="num t-muted">0 %</td>
  return (
    <td className="num">
      <span className="dur-cell">
        {share(part, total)}
        <DurBar width={total ? (part / total) * 100 : 0} tone={bad ? 'bad' : undefined} />
      </span>
    </td>
  )
}

export default async function ErrorDetailPage({ params, searchParams }: Props) {
  const [{ fingerprint }, sp] = await Promise.all([params, searchParams])
  const meta = await getMeta()
  const md = meta.ok ? meta.data : null
  const scope = await scopeOf(sp)
  const fp = decodeURIComponent(fingerprint).trim()
  const errorsCrumb = { label: 'Error', href: buildHref('/errors', scope.keep) }

  if (!isFingerprint(fp)) {
    return (
      <>
        <PageHead scope={scope} title="Error group" question={QUESTION} crumbs={[errorsCrumb, { label: fp, mono: true }]} />
        <ParamProblems problems={scope.problems} />
        <div className="panel">
          <EmptyState icon="search-none" title="fingerprint ไม่ถูกต้อง" text="fingerprint เป็นตัวเลข (UInt64) จากหน้า Error หรือจาก log บรรทัดที่เป็น error" />
        </div>
      </>
    )
  }

  const res = await loadError(fp, scope.env, scope.from, scope.to, fineStep(scope))
  if (!res.ok) {
    // not found in this env / range: a Thai empty state with a way on (the group may live in another env)
    if (res.error.status === 404) {
      const other = scope.env ? await engine.error(fp, { from: scope.from, to: scope.to, step: fineStep(scope) }) : null
      const otherEnv = other?.ok ? other.data.group.env : ''
      const where = `${scope.env ? `ใน ${scope.env}` : 'ในทุก env'} ${scope.to ? `ช่วง ${fmtRange(scope.fromMs, scope.toMs)}` : `ตั้งแต่ ${fmtDateTime(scope.fromMs)}`}`
      return (
        <>
          <PageHead scope={scope} title="Error group" question={QUESTION} crumbs={[errorsCrumb, { label: fp, mono: true }]} />
          <ParamProblems problems={scope.problems} />
          <div className="panel">
            <EmptyState
              icon="search-none"
              title={otherEnv ? `error group นี้ไม่ได้อยู่ใน ${scope.env}` : 'ไม่พบ error group นี้'}
              text={
                otherEnv
                  ? `fingerprint ${fp} เป็น error group ของ ${otherEnv} ไม่ใช่ ${scope.env} เปิดใน ${otherEnv} เพื่อดูรายละเอียด`
                  : `ไม่มีบรรทัด log ของ fingerprint ${fp} ${where} ลิงก์อาจเก่ากว่าข้อมูลที่เก็บไว้ หรือ fingerprint ไม่ถูกต้อง`
              }
              actions={
                <>
                  {otherEnv ? (
                    <Link className="btn btn--sm" href={withParams(`/errors/${fp}`, sp, { env: otherEnv })}>
                      เปิดใน {otherEnv}
                    </Link>
                  ) : scope.env ? (
                    <Link className="btn btn--sm" href={withParams(`/errors/${fp}`, sp, { env: 'all' })}>
                      ดูทุก env
                    </Link>
                  ) : null}
                  {!otherEnv && scope.preset !== 'now-7d' ? (
                    <Link className="btn btn--sm btn--quiet" href={withParams(`/errors/${fp}`, sp, { from: 'now-7d', to: null })}>
                      ขยายเป็น 7 วัน
                    </Link>
                  ) : null}
                  <Link className="btn btn--sm btn--quiet" href={errorsCrumb.href}>
                    กลับไปหน้า Error
                  </Link>
                </>
              }
            />
          </div>
        </>
      )
    }
    return (
      <>
        <PageHead scope={scope} title="Error group" question={QUESTION} crumbs={[errorsCrumb, { label: fp, mono: true }]} />
        <ParamProblems problems={scope.problems} />
        <EngineErrorState error={res.error} />
      </>
    )
  }

  const d = res.data
  const g = d.group
  const env = g.env || scope.env
  const order = serviceOrder(md)
  const release = releaseOf(md, env, g.service)
  const deploys = deploysOf(md, env, g.service)
  const isNew = showNew(g)
  const newDeploy = g.isNew ? (deploys.filter((x) => x.version === g.firstSeenVersion).pop() ?? deploys.filter((x) => toMs(x.at) <= toMs(g.firstSeen)).pop()) : undefined
  const lastDeploy = deploys[deploys.length - 1]
  const route = g.routes[0] ?? ''
  const isJob = !!(g.jobType || g.jobQueue)
  // job.retry WRN vs job.failed ERR (DESIGN.md §6: "38 retry · 3 ล้มเหลวจริง" on every screen)
  const lv = levelCounts(g, splitOf(g))
  const splitText = lv.mixed ? (isJob ? `${fmtCount(lv.warn)} retry · ${fmtCount(lv.err)} ล้มเหลวจริง` : `${fmtCount(lv.warn)} WRN · ${fmtCount(lv.err)} ERR`) : ''
  const levelAi = lv.mixed ? `${g.level} (${fmtCount(lv.warn)}${isJob ? ' job.retry' : ''} warn + ${fmtCount(lv.err)}${isJob ? ' job.failed' : ''} error)` : g.level
  const latest: LogRow | null = d.recent[0] ?? null
  const stackRow = d.recent.find((r) => r.error?.stack) ?? null
  const stack = stackRow?.error?.stack ? parseStack(stackRow.error.stack) : null
  const lastHourFrom = scope.to ? new Date(scope.toMs - 3600_000).toISOString() : 'now-1h'
  const iso = (ms: number) => new Date(ms).toISOString()

  const [minute, routeNow, routeBefore, trace, depRes] = await Promise.all([
    isNew ? engine.error(fp, { env, from: lastHourFrom, to: scope.to, step: '1m' }) : null,
    route ? engine.overview({ env, service: g.service, role: g.role || undefined, from: lastHourFrom, to: scope.to }) : null,
    route && isNew && newDeploy ? engine.overview({ env, service: g.service, role: g.role || undefined, from: iso(toMs(newDeploy.at) - 3600_000), to: newDeploy.at }) : null,
    g.failedStep && g.sampleTraceId ? engine.trace(g.sampleTraceId, { env }) : null,
    // a dependency group: is that dependency back up? (the "ล่าสุด" KPI says so instead of "ยังเกิดอยู่")
    g.dependencyName ? engine.dependencies({ env, service: g.service }) : null,
  ])
  const depList = depRes?.ok ? depRes.data.dependencies : []
  // the same dependency: name + service, the role and host of the latest line first (one name can point at two hosts)
  const depHost = latest?.dependency?.host
  const dep = g.dependencyName
    ? (depList.find((x) => x.name === g.dependencyName && x.service === g.service && x.role === g.role && (!depHost || x.host === depHost)) ??
      depList.find((x) => x.name === g.dependencyName && x.service === g.service && (!depHost || x.host === depHost)) ??
      depList.find((x) => x.name === g.dependencyName && x.service === g.service && x.role === g.role))
    : undefined
  const findRoute = (r: typeof routeNow): OverviewRoute | undefined => (r?.ok ? r.data.routes.find((x) => x.route === route && x.service === g.service) : undefined)
  const now = findRoute(routeNow)
  const before = routeBefore?.ok ? (findRoute(routeBefore) ?? null) : undefined
  const minuteSeries = minute?.ok ? minute.data.series.map((s) => ({ t: toMs(s.t), count: s.count })) : null
  // The per-minute chart only when the last hour of the range has occurrences.
  const minutes = minuteSeries?.some((m) => m.count > 0) ? minuteSeries : null
  const lastHourCount = minuteSeries ? minuteSeries.reduce((a, m) => a + m.count, 0) : d.spark.stepSeconds === 3600 ? (g.spark[g.spark.length - 1] ?? 0) : null
  const spans = trace?.ok ? [...trace.data.spans].sort((a, b) => a.startTime.localeCompare(b.startTime)) : []
  const stepSpanIdx = spans.findIndex((s) => s.name === g.failedStep || (s.statusCode === 'ERROR' && g.failedStep.endsWith(s.name)))
  const stepSpan = stepSpanIdx >= 0 ? spans[stepSpanIdx] : undefined

  // Buckets of the main chart = the spark of the Error list (same counts per bar).
  const starts = bucketStarts(d.spark)
  const fine = d.series.map((s) => ({ t: toMs(s.t), count: s.count }))
  const deploysIn = deploys.filter((x) => toMs(x.at) >= (starts[0] ?? scope.fromMs) && toMs(x.at) <= scope.toMs)
  const buckets: HourBucket[] = starts.map((s, i) => {
    const end = bucketEnd(starts, i, d.spark.stepSeconds, scope.toMs)
    const dep = deploysIn.find((x) => toMs(x.at) > s && toMs(x.at) < end)
    let version = versionAt(s, deploys, release)
    if (dep) {
      const pre = fine.filter((f) => f.t >= s && f.t < toMs(dep.at)).reduce((a, f) => a + f.count, 0)
      const post = fine.filter((f) => f.t >= toMs(dep.at) && f.t < end).reduce((a, f) => a + f.count, 0)
      version = `${dep.previousVersion} ${fmtCount(pre)} · ${dep.version} ${fmtCount(post)}`
    }
    return { start: s, end, count: g.spark[i] ?? 0, version, label: bucketLabel(s, end) }
  })
  const max = Math.max(0, ...g.spark)
  const maxIdx = g.spark.indexOf(max)
  const maxTimes = maxIdx >= 0 ? bucketTimes(buckets[maxIdx].start, buckets[maxIdx].end, scope.nowMs) : ''
  const stepWords = stepText(d.spark.stepSeconds)
  /** After ต่อ / ทุก: `ชั่วโมง`, ` 3 นาที`. */
  const per = /^\d/.test(stepWords) ? ` ${stepWords}` : stepWords

  // Occurrences per version inside the range, from the minute series (the version running at each minute).
  const rangeByVersion = new Map<string, number>()
  for (const f of fine) if (f.count) rangeByVersion.set(versionAt(f.t, deploys, release), (rangeByVersion.get(versionAt(f.t, deploys, release)) ?? 0) + f.count)
  const mainDeploy = deploysIn[deploysIn.length - 1]
  const preCount = mainDeploy ? fine.filter((f) => f.t < toMs(mainDeploy.at)).reduce((a, f) => a + f.count, 0) : 0
  const postCount = mainDeploy ? fine.filter((f) => f.t >= toMs(mainDeploy.at)).reduce((a, f) => a + f.count, 0) : 0

  const versionsSorted = [...d.versions].sort((a, b) => toMs(b.lastSeen) - toMs(a.lastSeen))
  const lastVersion = versionsSorted[0]?.version || latest?.version || ''
  const firstVersion = g.firstSeenVersion || [...d.versions].sort((a, b) => toMs(a.firstSeen) - toMs(b.firstSeen))[0]?.version || ''
  const code = g.errorCode || g.errorType
  const title = groupTitle(g)
  // เกิดอะไรขึ้น / ต้องแก้อะไร = error_detail / error_how_to_fix of the latest occurrence (DESIGN.md §6).
  const what = g.detail || latest?.error?.detail || ''
  const fix = g.howToFix || latest?.error?.howToFix || ''
  const actual = actualError(latest?.error) || actualError({ type: g.errorType, code: g.errorCode, message: g.sampleMessage })
  const sampleTrace = g.sampleTraceId || latest?.traceId || ''
  const traceHref = (id: string, span?: string) => buildHref(`/traces/${id}`, scope.keep, span ? { span } : undefined)
  const logsHref = buildHref('/logs', scope.keep, { fingerprint: fp, from: scope.from, to: scope.to })
  const rangeTxt = rangeLabelText(scope)

  const head = (
    <PageHead
      scope={scope}
      title={title}
      question={isNew ? QUESTION_NEW : QUESTION}
      crumbs={[errorsCrumb, { label: code || shortId(fp), mono: !!code }]}
      metaFirst
      meta={
        <>
          <LevelBadge level={g.level} />
          {g.errorCode ? <Tag title="error_code">{g.errorCode}</Tag> : null}
          <CategoryChip category={g.category} />
          {isNew ? <NewBadge since={g.firstSeenVersion} /> : null}
          <ServiceChip service={g.service} role={rolesText(g)} order={order} />
          {/* where: two groups with one title (Query cancelled in a route and in a job) differ here */}
          {whereShort(g) ? (
            <span className="idchip" title={g.routes[0] ? 'http_method · http_route' : isJob ? 'job_type' : 'origin_function'}>
              <span className="idchip__k">{g.routes[0] ? 'route' : isJob ? 'job' : 'ที่'}</span>
              <span className="idchip__v">{g.routes[0] || (isJob ? g.jobType || g.jobQueue : whereShort(g))}</span>
            </span>
          ) : null}
          {g.errorType ? (
            <span className="idchip" title="error_type">
              <span className="idchip__k">type</span>
              <span className="idchip__v">{g.errorType}</span>
            </span>
          ) : null}
          <span className="idchip">
            <span className="idchip__k">fingerprint</span>
            <span className="idchip__v">{fp}</span>
            <CopyButton text={fp} variant="icon" ariaLabel="คัดลอก fingerprint" />
          </span>
        </>
      }
      actions={
        <>
          {sampleTrace ? (
            <Link className="btn" href={traceHref(sampleTrace)}>
              <Icon name="traces" />
              เปิด trace ตัวอย่าง
            </Link>
          ) : null}
          <Link className="btn" href={logsHref}>
            <Icon name="logs" />
            ดู log ทั้งหมดของ error นี้
          </Link>
          <CopyButton targetId="ed-ai-md" label="คัดลอกให้ AI" variant="cta" />
        </>
      }
    />
  )

  // ---- KPIs ----
  // First seen at / after the current deploy of a service that ran an earlier version: NEW unless its category never is.
  const afterDeploy = !!lastDeploy?.previousVersion && toMs(g.firstSeen) >= toMs(lastDeploy.at)
  const catLabel = CATEGORY_LABEL[g.category] ?? g.category
  const neverNew = g.category === 'dependency' || g.category === 'input'
  const firstReason = (() => {
    const v = firstVersion ? `บน ${firstVersion}` : 'version ไม่ทราบ'
    if (isNew) return `${v} · ${newDeploy ? `${gap(toMs(g.firstSeen) - toMs(newDeploy.at))}หลัง deploy ` : ''}จึงเป็น NEW`
    if ((g.isNew || afterDeploy) && neverNew) return `${v} · หลัง deploy แต่หมวด${catLabel}ไม่นับเป็น NEW`
    if (toMs(g.firstSeen) < scope.fromMs) return `${v} · ก่อนช่วงที่เลือก จึงไม่ใช่ NEW`
    if (lastDeploy && toMs(g.firstSeen) < toMs(lastDeploy.at)) return `${v} · ก่อน deploy ${lastDeploy.version} จึงไม่ใช่ NEW`
    if (afterDeploy) return `${v} · หลัง deploy แต่ engine ไม่นับเป็น NEW`
    return `${v} · ไม่มี version ก่อนหน้าให้เทียบ จึงไม่ใช่ NEW`
  })()
  // "ยังเกิดอยู่" = it happened recently for this group's own pace (3 × its median gap, 5–60 min), and its
  // dependency (if any) is not back up since; a 45 s outage that recovered reads as stopped.
  const occ = fine.filter((f) => f.count > 0).map((f) => f.t)
  const gaps = occ.slice(1).map((t, i) => t - occ[i]).sort((a, b) => a - b)
  // a burst (fewer than 3 active minutes, e.g. a 45 s outage) is over after 15 minutes of quiet
  const recentWindow = gaps.length >= 2 ? Math.min(3600_000, Math.max(5 * 60_000, 3 * gaps[Math.floor(gaps.length / 2)])) : 15 * 60_000
  const depBack = !!dep && dep.state === 'up' && !!dep.since && toMs(dep.since) > toMs(g.lastSeen)
  const stillGoing = !depBack && scope.nowMs - toMs(g.lastSeen) < recentWindow
  const goingText = depBack
    ? `หยุดแล้ว · ${dep!.name} กลับมา ${timeOrDate(dep!.since!, scope.nowMs)}`
    : dep?.state === 'down'
      ? `ยังเกิดอยู่ · ${dep.name} ยัง down`
      : stillGoing
        ? 'ยังเกิดอยู่'
        : 'ไม่เกิดอีกหลังจากนั้น'
  // a past window (incident review) speaks about itself: its last occurrence (recent[] lies inside the window), how
  // long before the window end, and whether it happened again after it; never "ยังเกิดอยู่"
  const past = isPastWindow(scope)
  const lastInMs = latest ? toMs(latest.timestamp) : null
  const afterWindow = toMs(g.lastSeen) > scope.toMs
  const lastKpi = past
    ? {
        label: 'ล่าสุดในช่วงนี้',
        value: lastInMs !== null ? fmtDateTime(lastInMs) : '–',
        foot: [
          lastInMs === null ? 'ไม่เกิดในช่วงนี้' : scope.toMs - lastInMs < 60_000 ? 'ไม่ถึง 1 นาทีก่อนสิ้นสุดช่วง' : `${gap(scope.toMs - lastInMs)}ก่อนสิ้นสุดช่วง`,
          latest?.version ? `บน ${latest.version}` : '',
          afterWindow ? `หลังช่วงนี้ยังเกิดอีก ล่าสุด ${timeOrDate(g.lastSeen, scope.nowMs)}` : 'ไม่เกิดอีกหลังช่วงนี้',
        ]
          .filter(Boolean)
          .join(' · '),
      }
    : { label: 'ล่าสุด', value: fmtDateTime(g.lastSeen), foot: `${fmtRelative(g.lastSeen, scope.nowMs)}${lastVersion ? ` · บน ${lastVersion}` : ''} · ${goingText}` }
  const schools = new Set(d.recent.map((r) => r.organizationId).filter(Boolean)).size
  // inside a request although the line has no http_route (ThaID called during a request): users / request status say so
  const inRequest = g.users > 0 || d.recent.some((r) => (r.httpStatus ?? 0) > 0)
  const reach = g.routes.length === 1 ? 'route เดียว' : g.routes.length ? `${g.routes.length} route` : isJob ? 'job เดียว' : inRequest ? 'ใน request (log ไม่มี http_route)' : 'นอก request'
  const hit = g.spark.filter((v) => v > 0).length
  const countFoot =
    g.count === 0
      ? `ไม่เกิดใน${rangeTxt} · ครั้งล่าสุด ${fmtDateTime(g.lastSeen)}`
      : `${splitText ? `${splitText} · ` : ''}${
          isNew && lastHourCount !== null
            ? `${fmtCount(lastHourCount)} ใน 1 ชั่วโมงล่าสุด · สูงสุด ${fmtCount(max)} ช่วง ${maxTimes}`
            : g.count < starts.length
              ? // rare: an average below one per bucket reads as "0.0"; say in how many buckets it happened
                `เกิดใน ${fmtCount(hit)} จาก ${fmtCount(starts.length)} ${per === 'ชั่วโมง' ? 'ชั่วโมง' : `ช่อง (ช่องละ ${stepWords})`} · สูงสุด ${fmtCount(max)} ช่วง ${maxTimes}`
              : `เฉลี่ย ${fmtNumber(g.count / Math.max(1, starts.length), 1)} ต่อ${per} · สูงสุด ${fmtCount(max)} ช่วง ${maxTimes}`
        }`

  // ---- where ----
  const kvs: Kv[] = latest
    ? logKvs(latest).filter((kv) => kv.k !== 'file' && kv.k !== 'duration')
    : [
        ...(route ? [{ k: 'method', v: route.split(' ')[0] }, { k: 'route', v: route.split(' ').slice(1).join(' ') }] : []),
        ...(g.originFunction ? [{ k: 'source', v: g.originFunction }] : []),
        ...(g.target ? [{ k: 'target', v: g.target }] : []),
      ]
  if (latest && !kvs.some((kv) => kv.k === 'source' || kv.k === 'job') && g.originFunction) {
    const ti = kvs.findIndex((kv) => kv.k === 'target')
    kvs.splice(ti < 0 ? kvs.length : ti, 0, { k: 'source', v: g.originFunction })
  }
  // "บรรทัด N" only for the file shown next to it: the stack has the built .js (dist/…), origin_file the .ts source
  const appFrame = stack?.frames.find((f) => f.app)
  const framePath = appFrame ? appFrame.loc.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '') : ''
  const lineNo = stack ? firstAppLine(stack) : null
  const stem = (p: string) => p.replace(/\.[cm]?[jt]sx?$/, '').split('/').slice(-2).join('/')
  const lineNote = (() => {
    if (lineNo === null || !framePath) return undefined
    if (g.originFile && framePath.endsWith(g.originFile)) return `บรรทัด ${lineNo} ตาม frame แรกของแอปใน stack`
    if (g.originFile && stem(framePath) !== stem(g.originFile)) return undefined
    const built = framePath.includes('dist/') ? framePath.slice(framePath.indexOf('dist/')) : framePath
    return `stack ชี้บรรทัด ${lineNo} ของ ${built} (ไฟล์ที่ build แล้ว ไม่ใช่บรรทัดใน ${g.originFile ? g.originFile.split('/').pop() : 'source'})`
  })()

  // empty failed_step: what that means for this group (it must agree with the category and the dependency shown)
  const depName = g.dependencyName ? depText(latest?.dependency?.type || g.dependencyType || '', g.dependencyName) : ''
  const emptyStepNote = depName
    ? `ไม่มี span ที่พัง: error เกิดตอน${(latest?.dependency?.type || g.dependencyType) === 'http' ? 'เรียก' : 'เชื่อมต่อ'} ${depName}`
    : g.category === 'bug'
      ? 'ว่าง: error เกิดในโค้ดของแอปเอง ไม่ใช่ระหว่างเรียก DB หรือระบบอื่น'
      : g.category === 'dependency' || g.category === 'config'
        ? `ว่าง: log ไม่ได้บอกขั้นที่พัง${g.target ? ` · ระบบที่เกี่ยวข้อง ${g.target}` : ''}`
        : 'ว่าง: log ของ group นี้ไม่ได้บอกขั้นที่พัง'

  // ---- Copy for AI ----
  const versionCounts = d.versions.map((v) => `${v.version} = ${fmtCount(v.count)}`)
  if (isNew && newDeploy?.previousVersion && !d.versions.some((v) => v.version === newDeploy.previousVersion)) versionCounts.unshift(`${newDeploy.previousVersion} = 0`)
  const firstNote = `${firstVersion}${isNew && newDeploy ? `, deploy ${fmtTime(newDeploy.at)}` : ''}`
  const ai = aiErrorMarkdown({
    hint: title,
    code,
    category: g.category,
    newSince: isNew ? g.firstSeenVersion : undefined,
    level: levelAi,
    service: g.service,
    role: rolesText(g),
    env,
    what: what || undefined,
    howToFix: fix || undefined,
    where: groupWhere(g, latest?.eventModule, latest?.dependency?.type),
    usecase: g.usecases[0],
    origin: g.originFunction,
    originFile: g.originFile,
    target: g.target,
    failedStep: g.failedStep,
    error: actual,
    stack: stack ? aiStack(stack) : undefined,
    traceId: latest?.traceId ? `${latest.traceId} (latest occurrence)` : sampleTrace || undefined,
    fingerprint: fp,
    counts: [
      `${fmtCount(g.count)} times`,
      g.users ? `${fmtCount(g.users)} users` : '',
      `${fmtAiTime(scope.fromMs, { ms: false })} to ${fmtAiTime(scope.toMs, { ms: false })} ICT`,
      `first ${fmtAiTime(g.firstSeen, { ms: false })}${firstNote ? ` (${firstNote})` : ''}`,
      past
        ? `last in window ${lastInMs !== null ? fmtAiTime(lastInMs, { ms: false }) : '–'}${latest?.version ? ` (${latest.version})` : ''}${afterWindow ? ` · last overall ${fmtAiTime(g.lastSeen, { ms: false })}` : ''}`
        : `last ${fmtAiTime(g.lastSeen, { ms: false })}${lastVersion ? ` (${lastVersion})` : ''}`,
      versionCounts.join(', '),
    ]
      .filter(Boolean)
      .join(' · '),
  })

  // ---- chart texts ----
  const zeroRun = (() => {
    let best = { len: 0, i: 0 }
    let cur = 0
    g.spark.forEach((v, i) => {
      cur = v === 0 ? cur + 1 : 0
      if (cur > best.len) best = { len: cur, i: i - cur + 1 }
    })
    if (best.len < 3 || best.len === g.spark.length) return ''
    if (isNew && mainDeploy && buckets[best.i + best.len - 1].end <= toMs(mainDeploy.at)) return ''
    return `${bucketTimes(buckets[best.i].start, buckets[best.i + best.len - 1].end, scope.nowMs)} ไม่เกิดเลย`
  })()
  const deployBucket = mainDeploy ? buckets.find((b) => toMs(mainDeploy.at) > b.start && toMs(mainDeploy.at) < b.end) : undefined
  const deployMix = (() => {
    if (!deployBucket || !mainDeploy) return ''
    const pre = fine.filter((f) => f.t >= deployBucket.start && f.t < toMs(mainDeploy.at)).reduce((a, f) => a + f.count, 0)
    const post = deployBucket.count - pre
    return pre > 0 && post > 0 ? `ช่อง ${bucketTimes(deployBucket.start, deployBucket.end, scope.nowMs)} มีทั้งสอง version (${fmtCount(pre)} + ${fmtCount(post)})` : ''
  })()
  // one share on the page: the route's own 5xx rate (route_stats), the same number as the route panel
  const lastShare =
    now && d.spark.stepSeconds === 3600 && now.requests
      ? `ชั่วโมงล่าสุด ${fmtCount(g.spark[g.spark.length - 1] ?? 0)} ครั้ง · route นี้มี 5xx ${fmtCount(now.errors)} จาก ${fmtCount(now.requests)} request (${fmtPercent(now.errorRate)})`
      : ''
  const chartFoot = [
    mainDeploy ? `ก่อน deploy (${mainDeploy.previousVersion}) ${fmtCount(preCount)} ครั้ง · หลัง deploy (${mainDeploy.version}) ${fmtCount(postCount)} ครั้ง` : '',
    deployMix,
    zeroRun,
    lastShare,
  ]
    .filter(Boolean)
    .join(' · ')
  const startMinute = fmtTime(starts[0] ?? scope.fromMs).slice(3)
  const chartSub = `${env ?? 'ทุก env'} · ${fmtRange(starts[0] ?? scope.fromMs, scope.toMs)} · รวม ${fmtCount(g.count)} ครั้ง · ช่องละ ${/^\d/.test(stepWords) ? stepWords : `1 ${stepWords}`}${d.spark.stepSeconds >= 3600 ? `เริ่มที่ :${startMinute}` : ''} (ช่องเดียวกับแท่งในหน้า Error)`
  const chartDesc = `จำนวนครั้งต่อ${per} ${fmtRange(starts[0] ?? scope.fromMs, scope.toMs)} รวม ${fmtCount(g.count)} ครั้ง${max ? ` สูงสุด ${fmtCount(max)} ครั้งช่วง ${maxTimes}` : ''}${mainDeploy ? ` มี deploy ${mainDeploy.version} เวลา ${fmtTime(mainDeploy.at)} ก่อน deploy ${fmtCount(preCount)} ครั้ง หลัง deploy ${fmtCount(postCount)} ครั้ง` : ''}`
  const minuteSum = minutes ? minutes.reduce((a, m) => a + m.count, 0) : 0
  const minuteTimes = minutes?.length ? bucketTimes(minutes[0].t, Math.min(minutes[minutes.length - 1].t + 60_000, scope.toMs), scope.nowMs) : ''
  const minuteRoute = now
    ? ` ${now.errors === minuteSum ? '=' : 'จาก'} 5xx ทั้งหมด${now.errors === minuteSum ? '' : ` ${fmtCount(now.errors)} ครั้ง`}ของ ${route} (${fmtPercent(now.errorRate)} ของ ${fmtCount(now.requests)})`
    : ''
  const lastMinute = minutes ? [...minutes].reverse().find((m) => m.count > 0) : undefined

  // ---- versions panel ----
  const vNames = new Set(d.versions.filter((v) => v.count > 0).map((v) => v.version))
  if (release?.currentVersion) vNames.add(release.currentVersion)
  const prevOf = (newDeploy ?? lastDeploy)?.previousVersion
  if (prevOf) vNames.add(prevOf)
  const vOrder = (v: string) => toMs(release?.versions.find((x) => x.version === v)?.firstSeen ?? d.versions.find((x) => x.version === v)?.firstSeen ?? 0)
  const vRows = [...vNames].sort((a, b) => vOrder(b) - vOrder(a))
  const vTotal = d.versions.reduce((a, v) => a + v.count, 0)
  const versionFoot = (() => {
    if (isNew) return `ไม่เคยเกิดบน ${newDeploy?.previousVersion || 'version ก่อนหน้า'} ในข้อมูลที่เก็บไว้ จึงเป็น error ใหม่ของ ${g.firstSeenVersion} (ป้าย NEW) · แก้แล้วดูว่า version ถัดไปเป็น 0`
    if ((g.isNew || afterDeploy) && neverNew)
      return `เพิ่งเกิดหลัง deploy ${lastDeploy?.version ?? g.firstSeenVersion} แต่หมวด${catLabel}ไม่นับเป็น NEW (ระบบที่เรียกใช้มีปัญหาหรือ request ผิดไม่ใช่ bug ใหม่ของ version นี้)`
    if (release?.currentVersion && firstVersion && firstVersion !== release.currentVersion) return `เจอตั้งแต่ ${firstVersion} ก่อน deploy จึงไม่ใช่ error ใหม่ของ ${release.currentVersion} (ไม่มีป้าย NEW)`
    return `เจอตั้งแต่ ${firstVersion || 'version แรกในข้อมูล'} · ไม่มี version ก่อนหน้าให้เทียบ จึงไม่มีป้าย NEW`
  })()

  // ---- recent ----
  const recent = d.recent.slice(0, 8)
  // the request's status; a job or outbound line's http.status is the other system's answer, said separately
  const reqStatus = (r: LogRow) => r.httpStatus ?? (r.job || r.http?.domain ? 0 : r.http?.status || 0)
  const statuses = [...new Set(d.recent.map(reqStatus).filter(Boolean))]
  const outbound = [...new Set(d.recent.filter((r) => r.http?.domain && r.http.status).map((r) => `${r.http!.domain} ${r.http!.status}`))]
  const allSameDay = recent.length > 0 && recent.every((r) => sameDay(r.timestamp, recent[0].timestamp))
  const recentMeta = [
    `${recent.length} จาก ${d.recent.length} ครั้งล่าสุด`,
    statuses.length === 1 && d.recent.every((r) => reqStatus(r) === statuses[0]) ? `ทุกครั้ง request ตอบ ${statuses[0]}` : '',
    outbound.length === 1 && d.recent.every((r) => r.http?.domain) ? `${outbound[0].replace(' ', ' ตอบ ')} ทุกครั้ง` : '',
    isJob && lv.mixed ? splitText : '',
    allSameDay ? `เวลา ${fmtDate(recent[0].timestamp)} ICT` : 'เวลา ICT',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      {head}
      <ParamProblems problems={scope.problems} />

      {isNew ? (
        <div className="callouts">
          <div className="callout callout--error" role="status">
            <Icon name="alert-octagon" className="callout__icon" />
            <p className="callout__title">
              ใหม่ใน {g.firstSeenVersion}
              {newDeploy?.previousVersion ? `: ไม่เคยเกิดบน ${newDeploy.previousVersion} ในข้อมูลที่เก็บไว้` : ''}
            </p>
            <p className="callout__text">
              {newDeploy ? (
                <>
                  deploy <Tag>{newDeploy.version}</Tag> <span className="ts">{timeOrDate(newDeploy.at, scope.nowMs)}</span> ·{' '}
                </>
              ) : null}
              ครั้งแรก <span className="ts">{timeOrDate(g.firstSeen, scope.nowMs)}</span>
              {lastHourCount !== null ? ` · ${fmtCount(lastHourCount)} จาก ${fmtCount(g.count)} ครั้งอยู่ใน 1 ชั่วโมงล่าสุด` : ''}
              {before !== undefined && now
                ? before
                  ? ` · ก่อน deploy route นี้${before.errors ? `มี 5xx ${fmtPercent(before.errorRate)}` : 'ไม่มี 5xx'} และ p95 ${fmtDuration(before.p95Ms)} (ตอนนี้ ${fmtPercent(now.errorRate)} · ${fmtDuration(now.p95Ms)})`
                  : ' · ก่อน deploy route นี้ไม่มี request ให้เทียบ'
                : ''}
            </p>
            <div className="callout__actions">
              <Link className="btn btn--sm" href={`${buildHref('/overview', scope.keep)}#ov-routes-t`}>
                เทียบ route ก่อน deploy
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <Kpis cols={4} label="สรุป error group" className={isNew ? 'mt-4' : undefined}>
        <Kpi label={`ครั้ง${inRangeWords(scope)}`} value={g.count} unit="ครั้ง" foot={countFoot} />
        <Kpi
          label="User ที่โดน"
          value={g.users}
          unit="คน"
          foot={
            g.users
              ? `นับ user_id ไม่ซ้ำ · ${reach}${isNew && schools ? ` · ${schools} โรงเรียนในตัวอย่าง` : ''}`
              : inRequest
                ? 'log ของ group นี้ไม่มี user_id (เกิดใน request ที่ไม่มี user)'
                : 'log ของ group นี้ไม่มี user_id (เกิดนอก request)'
          }
        />
        <Kpi label="ครั้งแรก" value={fmtDateTime(g.firstSeen)} tone={isNew ? 'alert' : undefined} delta={{ text: firstReason, tone: isNew ? 'bad' : undefined }} />
        <Kpi label={lastKpi.label} value={lastKpi.value} foot={lastKpi.foot} />
      </Kpis>

      <div className="ed-explain">
        <section className="section" aria-labelledby="h-what">
          <div className="section__head">
            <h2 className="section__title" id="h-what">
              เกิดอะไรขึ้น
            </h2>
            <span className="section__meta">
              <span className="mono">error_detail</span>
            </span>
          </div>
          <p className={what ? 'ed-what' : 'ed-what t-muted'}>{what || 'error ชนิดนี้ไม่มี error_detail'}</p>
          <p className="ed-what-cat">
            <CategoryChip category={g.category} />
            <span>{CATEGORY_WHY[g.category] ?? ''}</span>
          </p>
        </section>
        <section className="section" aria-labelledby="h-case">
          <div className="section__head">
            <h2 className="section__title" id="h-case">
              กรณีนี้
            </h2>
            <span className="section__meta">
              {latest ? (
                <>
                  จากครั้งล่าสุด <Ts value={latest.timestamp} format={sameDay(latest.timestamp, scope.nowMs) ? 'ms' : 'date-ms'} /> ·{' '}
                </>
              ) : null}
              <span className="mono">error_how_to_fix</span>
            </span>
          </div>
          <div className="ed-fix">
            <span className="err-row__detail-label">ต้องแก้อะไร</span>
            <p className="ed-fix__text">{fix || '–'}</p>
            <KvList items={kvs} className="ed-fix__foot" />
          </div>
        </section>
      </div>

      <section className="section" aria-labelledby="h-where">
        <div className="section__head">
          <h2 className="section__title" id="h-where">
            แก้ที่ไหน
          </h2>
          <span className="section__meta">จาก error group และ log ครั้งล่าสุด · ชื่อเล็กใต้หัวข้อคือชื่อ column ใน ClickHouse</span>
        </div>
        <dl className="ed-where">
          <WhereFirst g={g} latest={latest} />
          <WhereCell dt="Usecase" fname="usecase" value={g.usecases[0]} more={g.usecases.length > 1 ? `อีก ${g.usecases.length - 1} usecase ในตารางด้านล่าง` : undefined} />
          <WhereCell dt="Function ต้นทาง" fname="origin_function" value={g.originFunction} copy="คัดลอกชื่อ function" />
          <WhereCell dt="ไฟล์" fname="origin_file" value={g.originFile} copy="คัดลอก path ของไฟล์" more={lineNote} />
          <WhereCell dt="ค่าที่ผิด (target)" fname="error_target" value={g.target} target />
          <div className="ed-where__cell">
            <dt>
              ขั้นที่พัง<span className="fname">failed_step</span>
            </dt>
            <dd>
              {g.failedStep ? (
                <>
                  <span className="ed-where__v">
                    <LevelBadge level="error" />
                    <span>{g.failedStep}</span>
                  </span>
                  {sampleTrace ? (
                    <span className="ed-where__more">
                      <Link href={traceHref(sampleTrace, stepSpan?.spanId)}>ดู span นี้ใน trace ตัวอย่าง</Link>
                      {stepSpan ? ` (${fmtMs(stepSpan.durationMs)}, span ที่ ${stepSpanIdx + 1} จาก ${spans.length})` : ''}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="ed-where__v t-muted">–</span>
                  <span className="ed-where__more">{emptyStepNote}</span>
                </>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="section" aria-labelledby="h-actual">
        <div className="section__head">
          <h2 className="section__title" id="h-actual">
            Error จริง
          </h2>
          {latest ? (
            <span className="section__meta">
              ครั้งล่าสุด <Ts value={latest.timestamp} format="date-ms" />
              {latest.traceId ? (
                <>
                  {' '}
                  · trace{' '}
                  <Link className="mono" href={traceHref(latest.traceId)} title={latest.traceId}>
                    {shortId(latest.traceId)}
                  </Link>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="stack">
          <div className="code-block">
            <div className="code-block__head">
              <span className="code-block__title">
                error จริง · <span className="mono">error_type [error_code] error_message</span>
              </span>
              <CopyButton targetId="ed-actual" label="คัดลอก" variant="quiet" size="sm" />
            </div>
            <pre className="code code--wrap" id="ed-actual">
              <span className="c-err">{actual || '–'}</span>
            </pre>
          </div>
          {stack ? <StackBlocks s={stack} /> : <p className="hint">log ของ group นี้ไม่มี error_stack</p>}
        </div>
      </section>

      <section className="section" aria-labelledby="h-when">
        <div className="section__head">
          <h2 className="section__title" id="h-when">
            เกิดเมื่อไหร่
          </h2>
          <span className="section__meta">
            ทุก{per}ใน{scope.preset === 'custom' ? '' : ' '}
            {rangeTxt}
            {minutes ? ' และทุกนาทีในชั่วโมงล่าสุด' : ''}
            {deploysIn.length ? ` · เส้นตั้ง = deploy ${g.service}` : ''}
          </span>
        </div>
        {g.count > 0 ? (
          <ChartFrame
            className="ed-chart"
            titleId="ed-chart-title"
            title={`จำนวนครั้งต่อ${per}`}
            sub={chartSub}
            foot={chartFoot || undefined}
            table={{
              caption: `จำนวนครั้งต่อ${per} พร้อม version ที่ทำงานในช่วงนั้น`,
              columns: ['ช่วงเวลา (ICT)', 'ครั้ง', 'Version'],
              textColumns: [2],
              rows: [
                ...[...buckets].reverse().map((b) => [
                  bucketLabel(b.start, b.end),
                  b.count ? fmtCount(b.count) : <span className="t-muted">0</span>,
                  <span className="nowrap" key="v">
                    {b.version ? <Tag>{b.version}</Tag> : '–'}
                    {deploysIn.some((x) => toMs(x.at) > b.start && toMs(x.at) < b.end) ? (
                      <span className="t-muted small"> deploy {deploysIn.find((x) => toMs(x.at) > b.start && toMs(x.at) < b.end)?.version} เวลา {fmtTime(deploysIn.find((x) => toMs(x.at) > b.start && toMs(x.at) < b.end)?.at)}</span>
                    ) : null}
                  </span>,
                ]),
                [
                  <b key="t">รวม</b>,
                  <b key="n">{fmtCount(g.count)}</b>,
                  <span className="t-muted small" key="v">
                    {[...rangeByVersion.entries()].map(([v, n]) => `${v} = ${fmtCount(n)}`).join(' · ')}
                  </span>,
                ],
              ],
            }}
          >
            <HourChart buckets={buckets} deploys={deploysIn} titleId="ed-chart-title" descId="ed-chart-desc" desc={chartDesc} />
          </ChartFrame>
        ) : (
          <div className="panel">
            <EmptyState
              icon="check-circle"
              title={`ไม่เกิดใน${scope.preset === 'custom' ? '' : ' '}${rangeTxt}`}
              text={`ครั้งล่าสุด ${fmtDateTime(g.lastSeen)} ICT${lastVersion ? ` บน ${lastVersion}` : ''} · ขยายช่วงเวลาเพื่อดูว่าเกิดเมื่อไหร่`}
              actions={
                scope.preset !== 'now-7d' ? (
                  <Link className="btn btn--sm" href={withParams(`/errors/${fp}`, sp, { from: 'now-7d', to: null })}>
                    ขยายเป็น 7 วัน
                  </Link>
                ) : null
              }
            />
          </div>
        )}
        {minutes && minutes.length ? (
          <ChartFrame
            bare
            className="mt-4"
            titleId="ed-min-title"
            title="ชั่วโมงล่าสุด ต่อนาที"
            sub={`${minuteTimes} · ${fmtCount(minuteSum)} ครั้ง${minuteRoute} · ตารางต่อนาทีเดียวกับหน้าภาพรวม`}
            table={{
              caption: 'จำนวนครั้งต่อนาทีในชั่วโมงล่าสุด',
              columns: ['นาที (ICT)', 'ครั้ง'],
              rows: [...minutes].reverse().map((m) => [fmtDateTime(m.t), m.count ? fmtCount(m.count) : <span className="t-muted">0</span>]),
            }}
          >
            <MinuteChart
              minutes={minutes}
              titleId="ed-min-title"
              descId="ed-min-desc"
              desc={`จำนวนครั้งต่อนาที ${minuteTimes} รวม ${fmtCount(minuteSum)} ครั้ง${lastMinute ? ` ครั้งล่าสุด ${fmtTime(lastMinute.t)}` : ''}`}
            />
          </ChartFrame>
        ) : null}
      </section>

      <section className="section" aria-labelledby="h-scope">
        <div className="section__head">
          <h2 className="section__title" id="h-scope">
            Route และ version ที่โดน
          </h2>
          <span className="section__meta">
            {rangeTxt} · สัดส่วนจาก {fmtCount(g.count)} ครั้ง
          </span>
        </div>
        <div className="grid grid--2">
          <RoutePanel
            g={g}
            d={d}
            now={now}
            before={before}
            newDeploy={isNew ? newDeploy : undefined}
            order={order}
            scope={scope}
            inRequest={inRequest}
            sampleHref={sampleTrace ? traceHref(sampleTrace) : undefined}
          />
          <Panel
            title={`Version ของ ${g.service}`}
            meta={lastDeploy ? `deploy ${lastDeploy.version} เวลา ${timeOrDate(lastDeploy.at, scope.nowMs)}${lastDeploy.previousVersion ? ` (เดิม ${lastDeploy.previousVersion})` : ''}` : 'version เดียวในข้อมูลที่เก็บไว้'}
            flush
            foot={versionFoot}
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col" className="num" title="ทั้งข้อมูลที่เก็บไว้">
                      ครั้ง
                    </th>
                    <th scope="col" className="num">
                      สัดส่วน
                    </th>
                    <th scope="col">ครั้งแรก</th>
                    <th scope="col">ล่าสุด</th>
                  </tr>
                </thead>
                <tbody>
                  {vRows.map((v) => {
                    const row = d.versions.find((x) => x.version === v)
                    return (
                      <tr key={v}>
                        <td className="nowrap">
                          <Tag>{v}</Tag>
                          {v === release?.currentVersion ? <span className="t-muted small"> ปัจจุบัน</span> : null}
                        </td>
                        <td className={row?.count ? 'num' : 'num t-muted'}>{fmtCount(row?.count ?? 0)}</td>
                        <ShareCell part={row?.count ?? 0} total={vTotal} bad={isNew && v === g.firstSeenVersion} />
                        {row?.count ? (
                          <>
                            <td>
                              <Ts value={row.firstSeen} format="date" />
                            </td>
                            <td>
                              <Ts value={row.lastSeen} format="date" />
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="t-muted">–</td>
                            <td className="t-muted">–</td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </section>

      <section className="section" aria-labelledby="h-recent">
        <div className="section__head">
          <h2 className="section__title" id="h-recent">
            ครั้งล่าสุด
          </h2>
          <span className="section__meta">{recentMeta}</span>
          <div className="section__actions">
            <Link className="btn btn--sm" href={logsHref}>
              ดู log ทั้งหมด {fmtCount(g.count)} ครั้ง
            </Link>
          </div>
        </div>
        {recent.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">เวลา</th>
                  <th scope="col">User</th>
                  <th scope="col">โรงเรียน</th>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    เวลาที่ใช้
                  </th>
                  <th scope="col">Trace</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <RecentRow key={`${r.timestamp}-${r.traceId}-${i}`} r={r} sample={r.traceId === sampleTrace} allSameDay={allSameDay} scope={scope} traceHref={traceHref} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="panel">
            <EmptyState icon="search-none" title="ยังไม่มีครั้งล่าสุดให้แสดง" text="engine ไม่ส่ง log ของ group นี้มา ลองขยายช่วงเวลา" />
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="h-ai">
        <div className="section__head">
          <h2 className="section__title" id="h-ai">
            คัดลอกให้ AI
          </h2>
          <span className="section__meta">ข้อความในกล่องนี้คือสิ่งที่ถูกคัดลอกทุกตัวอักษร ไม่มีข้อมูลส่วนบุคคล</span>
        </div>
        <div className="ai-box">
          <div className="code-block">
            <div className="code-block__head">
              <span className="code-block__title">
                Markdown · <span className="mono">error-group.md</span>
              </span>
              <CopyButton targetId="ed-ai-md" label="คัดลอกให้ AI" variant="primary" size="sm" />
            </div>
            <pre className="code code--wrap" id="ed-ai-md">
              {markdownLines(ai).map((l, i, all) => (
                <span key={i}>
                  {l.key ? <span className="c-key">{l.key}</span> : null}
                  {l.rest}
                  {i < all.length - 1 ? '\n' : ''}
                </span>
              ))}
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
                  <li>หัวข้อ, code, category, {isNew ? 'NEW, ' : ''}เกิดอะไรขึ้น, กรณีนี้</li>
                  <li>แก้ที่ไหน: route, usecase, function, ไฟล์, target{g.failedStep ? ', ขั้นที่พัง' : ''}</li>
                  <li>error จริง และ stack 3 frame แรก (โค้ดแอปก่อน)</li>
                  <li>จำนวนครั้ง, จำนวน user, ช่วงเวลา, version</li>
                  <li>trace id ตัวอย่างหนึ่งตัว ให้ AI อ้างอิงกลับได้</li>
                </ul>
              </div>
              <div>
                <h3>ไม่ใส่</h3>
                <ul>
                  <li>
                    <span className="mono">user_id</span>, <span className="mono">organization_id</span> และ role ของ user
                  </li>
                  <li>id ใน path, query string, request body และค่าที่ผู้ใช้กรอก</li>
                  <li>IP, user agent, header</li>
                </ul>
              </div>
              <p className="hint">
                ชื่อ key ชุดเดียวกับทุกหน้า (<span className="mono">what</span>, <span className="mono">how_to_fix</span>, <span className="mono">origin</span>
                {g.failedStep ? (
                  <>
                    , <span className="mono">failed_step</span>
                  </>
                ) : null}
                , <span className="mono">trace_id</span>; DESIGN.md §6b) และอธิบายไว้ในพจนานุกรมข้อมูล
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

/** First cell of "แก้ที่ไหน": the route, else the job, else the dependency. */
function WhereFirst({ g, latest }: { g: ErrorGroup; latest: LogRow | null }) {
  const route = g.routes[0]
  if (route) {
    const [method, ...path] = route.split(' ')
    return (
      <div className="ed-where__cell">
        <dt>
          Route<span className="fname">http_method · http_route</span>
        </dt>
        <dd>
          <span className="ed-where__v">
            <span>
              {path.length ? <Method method={method} /> : null} {path.length ? path.join(' ') : route}
            </span>
          </span>
          <span className="ed-where__more">{g.routes.length === 1 ? 'ทุกครั้งมาจาก route นี้' : `route ที่โดนมากสุด · อีก ${g.routes.length - 1} route ในตารางด้านล่าง`}</span>
        </dd>
      </div>
    )
  }
  if (g.jobType || g.jobQueue) {
    return (
      <div className="ed-where__cell">
        <dt>
          Job<span className="fname">job_queue · job_type</span>
        </dt>
        <dd>
          <span className="ed-where__v">{[g.jobQueue, g.jobType].filter(Boolean).join(' · ')}</span>
          <span className="ed-where__more">ทุกครั้งมาจาก job นี้ (ไม่ได้อยู่ใน HTTP request)</span>
        </dd>
      </div>
    )
  }
  const dep = latest?.dependency
  return (
    <div className="ed-where__cell">
      <dt>
        {g.dependencyName ? 'Dependency' : 'Route'}
        <span className="fname">{g.dependencyName ? 'dependency_name' : 'http_method · http_route'}</span>
      </dt>
      <dd>
        <span className={g.dependencyName ? 'ed-where__v' : 'ed-where__v t-muted'}>{g.dependencyName ? `${dep?.type ? `${dep.type} ` : ''}${g.dependencyName}` : '–'}</span>
        <span className="ed-where__more">{g.dependencyName ? (dep?.host ? `${dep.host}${dep.port ? `:${dep.port}` : ''}` : 'ระบบที่เรียกใช้') : 'ไม่ได้เกิดใน request หรือ job'}</span>
      </dd>
    </div>
  )
}

function WhereCell({ dt, fname, value, copy, more, target }: { dt: string; fname: string; value: string | undefined; copy?: string; more?: ReactNode; target?: boolean }) {
  return (
    <div className={target ? 'ed-where__cell ed-where__cell--target' : 'ed-where__cell'}>
      <dt>
        {dt}
        <span className="fname">{fname}</span>
      </dt>
      <dd>
        {value ? (
          <span className="ed-where__v">
            <span>{value}</span>
            {copy ? <CopyButton text={value} variant="icon" ariaLabel={copy} /> : null}
          </span>
        ) : (
          <span className="ed-where__v t-muted">–</span>
        )}
        {more ? <span className="ed-where__more">{more}</span> : null}
      </dd>
    </div>
  )
}

/** App frames first (`.fr--app`), the full stack in order in a closed details; copy keeps line breaks. */
function StackBlocks({ s }: { s: ParsedStack }) {
  const app = s.frames.filter((f) => f.app)
  const libCount = s.frames.length - app.length
  const from = [s.libs.length ? `node_modules (${s.libs.join(', ')})` : '', s.nodeInternal ? 'node:internal' : ''].filter(Boolean).join(' และ ')
  const shown = app.length ? app : s.frames.slice(0, 3)
  const rest = s.frames.length - shown.length
  const frame = (f: (typeof s.frames)[number], i: number, last: boolean) => (
    <span key={i} className={f.app ? 'fr fr--app' : 'fr'}>
      {f.app ? (
        <>
          {`    at ${f.async ? 'async ' : ''}`}
          {f.fn ? (
            <>
              {f.fn} (<span className="fr__loc">{f.loc}</span>)
            </>
          ) : (
            <span className="fr__loc">{f.loc}</span>
          )}
        </>
      ) : (
        frameText(f)
      )}
      {last ? '' : '\n'}
    </span>
  )
  return (
    <>
      <div className="code-block">
        <div className="code-block__head">
          <span className="code-block__title">
            Stack · frame ในโค้ดของแอปก่อน ({app.length} จาก {s.frames.length} frame) · <span className="mono">error_stack</span>
          </span>
          <CopyButton targetId="ed-stack-full" label="คัดลอก stack เต็ม" variant="quiet" size="sm" />
        </div>
        <pre className="code stacktrace" id="ed-stack-app">
          <span className="fr fr--head">{s.head}</span>
          {'\n'}
          {shown.map((f, i) => frame(f, i, i === shown.length - 1 && rest <= 0))}
          {rest > 0 ? <span className="stacktrace__gap">{`    … อีก ${rest} frame${from ? ` จาก ${from}` : ''} อยู่ใน stack เต็มด้านล่าง`}</span> : null}
        </pre>
      </div>
      <details className="disclosure">
        <summary>
          Stack เต็มตามลำดับจริง
          <span className="disclosure__meta">
            {s.frames.length} frame · {app.length} ในโค้ดแอป · {libCount} จาก library
          </span>
        </summary>
        <div className="disclosure__body">
          <pre className="code stacktrace" id="ed-stack-full">
            <span className="fr fr--head">{s.head}</span>
            {s.frames.length ? '\n' : ''}
            {s.frames.map((f, i) => frame(f, i, i === s.frames.length - 1))}
          </pre>
        </div>
      </details>
    </>
  )
}

function RoutePanel({
  g,
  d,
  now,
  before,
  newDeploy,
  order,
  scope,
  inRequest,
  sampleHref,
}: {
  g: ErrorGroup
  d: ErrorDetail
  now?: OverviewRoute
  before?: OverviewRoute | null
  newDeploy?: Deploy
  order: string[]
  scope: Scope
  /** The lines have no http_route but come from requests (users, request status). */
  inRequest: boolean
  sampleHref?: string
}) {
  const rows: Array<{ kind: string; name: ReactNode; key: string; count: number }> = [
    ...d.routes.map((r) => {
      const [m, ...p] = r.route.split(' ')
      return { kind: 'route', key: `r-${r.route}`, count: r.count, name: p.length ? <><Method method={m} /> {p.join(' ')}</> : r.route }
    }),
    ...d.usecases.map((u) => ({ kind: 'usecase', key: `u-${u.usecase}`, count: u.count, name: u.usecase })),
  ]
  if (!d.routes.length && (g.jobType || g.jobQueue)) rows.unshift({ kind: 'job', key: 'job', count: g.count, name: [g.jobQueue, g.jobType].filter(Boolean).join(' ') })
  const route = g.routes[0]
  const foot = route ? (
    <>
      {now ? (
        <>
          route นี้ใน 1 ชั่วโมงล่าสุด: {fmtCount(now.requests)} request · error rate <span className={now.errors ? 't-danger' : undefined}>{fmtPercent(now.errorRate)}</span> · p95 {fmtDuration(now.p95Ms)}
          {newDeploy && before ? ` (${fmtTime(toMs(newDeploy.at) - 3600_000)}–${fmtTime(newDeploy.at)} บน ${newDeploy.previousVersion}: ${fmtPercent(before.errorRate)} · ${fmtDuration(before.p95Ms)})` : ''} ·{' '}
        </>
      ) : (
        <>route นี้ไม่มี request ใน 1 ชั่วโมงล่าสุด · </>
      )}
      <Link href={buildHref('/traces', scope.keep, { route, status: 'error' })}>ดู trace ที่ error</Link>
    </>
  ) : g.jobType || g.jobQueue ? (
    <Link href={buildHref('/jobs', scope.keep)}>ดูสถิติของ job นี้ในหน้างานเบื้องหลัง</Link>
  ) : undefined
  return (
    <Panel title="Route และ usecase" meta={<ServiceChip service={g.service} role={rolesText(g)} order={order} />} flush foot={foot}>
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">ชนิด</th>
                <th scope="col">ชื่อ</th>
                <th scope="col" className="num">
                  ครั้ง
                </th>
                <th scope="col" className="num">
                  สัดส่วน
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="t-ink2">{r.kind}</td>
                  <td className="mono nowrap">{r.name}</td>
                  <td className="num">{fmtCount(r.count)}</td>
                  <ShareCell part={r.count} total={g.count} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        inRequest ? (
          <EmptyState
            icon="search-none"
            title="log ของ group นี้ไม่มี route หรือ usecase"
            text="แต่เกิดระหว่าง request (มี user และ status ของ request) เช่น ตอนเรียกระบบภายนอก ดู trace ตัวอย่างว่าเป็น request ไหน"
            actions={
              sampleHref ? (
                <Link className="btn btn--sm" href={sampleHref}>
                  เปิด trace ตัวอย่าง
                </Link>
              ) : undefined
            }
          />
        ) : (
          <EmptyState icon="search-none" title="group นี้ไม่มี route หรือ usecase" text="error เกิดนอก HTTP request และนอก usecase เช่น ตอนเชื่อมต่อระบบที่เรียกใช้" />
        )
      )}
    </Panel>
  )
}

function RecentRow({ r, sample, allSameDay, scope, traceHref }: { r: LogRow; sample: boolean; allSameDay: boolean; scope: Scope; traceHref: (id: string) => string }) {
  // a job line: retry n/m or the real failure first (its http.status is the outbound call's, e.g. Google's 429)
  const outboundStatus = r.http?.domain ? r.http.status || 0 : 0
  const status = r.httpStatus ?? (r.job || r.http?.domain ? 0 : r.http?.status || 0)
  const dur = r.requestDurationMs ?? r.durationMs
  return (
    <tr>
      <td>
        <Ts value={r.timestamp} format={allSameDay ? 'ms' : 'date-ms'} />
      </td>
      <td className="nowrap">
        {r.userId ? (
          <>
            <Link className="mono" href={buildHref('/logs', scope.keep, { userId: r.userId, from: scope.from, to: scope.to })}>
              {r.userId}
            </Link>{' '}
            {r.userRoles.length ? <span className="t-muted small">{r.userRoles.join(', ')}</span> : null}
          </>
        ) : (
          <span className="t-muted">–</span>
        )}
      </td>
      <td className="mono">{r.organizationId || <span className="t-muted">–</span>}</td>
      <td>{r.version ? <Tag>{r.version}</Tag> : <span className="t-muted">–</span>}</td>
      <td className="nowrap">
        {r.job ? (
          <span className="small">
            {r.job.final || r.eventCode === 'job.failed' ? <span className="t-danger">ล้มเหลว</span> : 'retry'}
            {r.job.attempt ? ` ${r.job.attempt}/${r.job.maxAttempts || '?'}` : ''}
            {outboundStatus ? <span className="t-muted"> · {outboundStatus}</span> : null}
          </span>
        ) : status ? (
          <>
            <HttpStatus status={status} />
            {outboundStatus && outboundStatus !== status ? <span className="t-muted small"> · {r.dependency?.name || r.http?.domain} ตอบ {outboundStatus}</span> : null}
          </>
        ) : outboundStatus ? (
          <HttpStatus status={outboundStatus} />
        ) : (
          <span className="t-muted">–</span>
        )}
      </td>
      <td className="num">{dur !== null && dur !== undefined ? fmtMs(dur) : <span className="t-muted">–</span>}</td>
      <td className="nowrap">
        {r.traceId ? (
          <>
            <span className="idchip">
              <Link href={traceHref(r.traceId)} title={r.traceId}>
                {r.traceId}
              </Link>
              {sample ? <CopyButton text={r.traceId} variant="icon" ariaLabel="คัดลอก trace id" /> : null}
            </span>
            {sample ? <> <Tag>ตัวอย่าง</Tag></> : null}
          </>
        ) : (
          <span className="t-muted">–</span>
        )}
      </td>
    </tr>
  )
}
