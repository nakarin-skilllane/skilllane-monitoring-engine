/**
 * /logs: the log console (design/monitoring-ui/logs-console.html). Reads the URL (_lib/query.ts), asks the engine for
 * the newest page of lines, the pods, the error groups of the range, the dependency outages and, for the Timeline
 * view, every line of the requests on the page (/api/logs/traces); the console (client) draws them and keeps every
 * filter in the URL. No service in the URL: the remembered one (lib/prefs.ts), every service when a link narrows the
 * page (a trace, user, error group …), else the service picker.
 */
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHead } from '@/components/PageHead'
import { EngineErrorState, ParamProblems } from '@/components/states'
import { engine, getMeta } from '@/lib/engine'
import { sameDay } from '@/lib/format'
import { buildHref, isPastWindow, Params, parseScope, type RawSearchParams, toRecord, withParams } from '@/lib/params'
import { PREF, readPref } from '@/lib/prefs'
import { groupTitle } from '@/lib/readable'
import { serviceOrder } from '@/lib/services'
import type { ErrorGroup, LogPod, LogRow, LogsQuery } from '@/lib/types'
import type { ErrorInfo } from './_components/ConsoleLines'
import type { SourceCounts } from './_components/ConsoleControls'
import { LogConsole, type LogConsoleProps } from './_components/LogConsole'
import { type PickerCard, ServicePicker } from './_components/ServicePicker'
import { outagesSeenBy, separatorsOf } from './_lib/console'
import { outagesOf } from './_lib/lines'
import { collapsesRepeats, NOISE_GROUPS, shownNoise } from './_lib/noise'
import {
  CONSOLE_VIEWS,
  engineQuery,
  GREP_PARAMS,
  type GrepFilters,
  grepText,
  isNarrowed,
  parsePods,
  parseSelection,
  serviceParam,
  sourcesOf,
} from './_lib/query'
import './screen.css'

export const metadata: Metadata = { title: 'Log' }

/** Lines per page (the first one and each "โหลดเก่ากว่า"). */
const PAGE = 300

/** Engine series step when the histogram has a single bucket (the engine's stepFor). */
function stepFor(rangeMs: number): number {
  if (rangeMs <= 3600_000) return 60
  if (rangeMs <= 6 * 3600_000) return 300
  if (rangeMs <= 24 * 3600_000) return 900
  if (rangeMs <= 30 * 86_400_000) return 3600
  return 21600
}

/** Error groups by fingerprint: NEW badges and counts in a line's detail. */
function errorInfo(groups: readonly ErrorGroup[]): Record<string, ErrorInfo> {
  return Object.fromEntries(
    groups.map((g) => [g.fingerprint, { count: g.count, users: g.users, isNew: g.isNew, since: g.firstSeenVersion, title: groupTitle(g) }]),
  )
}

/** ERR / WRN / lines per source, summed from its pods. */
function countsOf(pods: readonly LogPod[]): Record<string, SourceCounts> {
  const out: Record<string, SourceCounts> = {}
  for (const p of pods) {
    const c = (out[`${p.service}/${p.role}`] ??= { errors: 0, warns: 0, lines: 0 })
    c.errors += p.errors
    c.warns += p.warns
    c.lines += p.lines
  }
  return out
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const [meta, jar] = await Promise.all([getMeta(), cookies()])
  // the console reads service (+ role) itself: a list of service/role
  const scopeSp = toRecord(sp)
  delete scopeSp.service
  delete scopeSp.role
  const scope = parseScope(scopeSp, 'logs', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
  const p = new Params(sp)
  const order = serviceOrder(meta.ok ? meta.data : null)
  const known = sourcesOf(meta.ok ? meta.data : null, scope.env, order)
  const sel = parseSelection(p.str('service', 2600), p.name('role'), known)
  const podSel = parsePods(p.str('pod', 4000))
  const id = (name: string) => {
    const v = p.str(name, 24)
    return v && /^\d{1,20}$/.test(v) ? v : undefined
  }
  const grep: GrepFilters = {
    q: p.str('q'),
    exclude: p.str('exclude'),
    traceId: p.traceId(),
    userId: p.str('userId', 128),
    route: p.str('route'),
    job: p.str('job'),
    jobId: p.str('jobId', 128),
    event: p.event(),
    fingerprint: p.fingerprint(),
    category: p.name('category'),
    pattern: id('pattern'),
    check: id('check'),
  }
  const levels = p.levels()
  const hasGrep = GREP_PARAMS.some((k) => !!grep[k])
  const narrowed = isNarrowed(grep)
  const pick = p.flag('pick') === true
  const prefView = readPref(jar, PREF.logView)
  const view = p.oneOf('view', CONSOLE_VIEWS) ?? (CONSOLE_VIEWS.find((v) => v === prefView) || 'timeline')
  const problems = [...scope.problems, ...p.problems, ...sel.problems, ...podSel.problems]

  // no service in the URL: the remembered one; a link that narrows the page shows every service; else the picker
  if (!sel.given && !hasGrep && !pick) {
    const remembered = readPref(jar, PREF.logSources)
    if (remembered) redirect(withParams('/logs', sp, { service: remembered, role: null }))
  }
  const picker = pick || (!sel.given && !hasGrep)
  const all = sel.all || !sel.given
  const base = { env: scope.env, from: scope.from, to: scope.to }
  const errorsHref = buildHref('/errors', scope.keep, sel.ids.length === 1 ? { service: sel.ids[0].split('/')[0], role: sel.ids[0].split('/')[1] } : undefined)
  const head = (question: React.ReactNode) => (
    <PageHead
      scope={scope}
      title="Log"
      question={question}
      actions={
        <Link className="btn" href={errorsHref}>
          ดู error group
        </Link>
      }
    />
  )

  if (picker) {
    const hide = NOISE_GROUPS.join(',')
    const [podsRes, errs, ...per] = await Promise.all([
      engine.logPods(base),
      engine.errors({ ...base, limit: 500, sparkBuckets: 1 }),
      ...known.map((s) => engine.logs({ ...base, sources: s.id, hide, limit: 1 })),
    ])
    const pods = podsRes.ok ? podsRes.data.pods : []
    const groups = errs.ok ? errs.data.groups : []
    const cards: PickerCard[] = known.map((s, i) => {
      const r = per[i]
      const lc = r.ok ? r.data.levelCounts : null
      const mine = groups.filter((g) => g.service === s.service && (g.roles?.length ? g.roles.includes(s.role) : g.role === s.role))
      const lastErr = mine.reduce<ErrorGroup | null>((a, g) => (!a || g.lastSeen > a.lastSeen ? g : a), null)
      const lastRow: LogRow | undefined = r.ok ? r.data.rows[0] : undefined
      return {
        id: s.id,
        service: s.service,
        role: s.role,
        errors: lc ? lc.error + lc.fatal : 0,
        warns: lc?.warn ?? 0,
        lines: lc ? lc.debug + lc.info + lc.warn + lc.error + lc.fatal : 0,
        pods: pods.filter((x) => x.service === s.service && x.role === s.role && !x.gone).length,
        spark: r.ok ? r.data.histogram.map((b) => b.debug + b.info + b.warn + b.error + b.fatal) : [],
        sparkErr: r.ok ? r.data.histogram.map((b) => b.error + b.fatal) : [],
        last: lastErr ? { at: lastErr.lastSeen, text: groupTitle(lastErr), error: true } : lastRow ? { at: lastRow.timestamp, text: lastRow.message, error: false } : null,
      }
    })
    return (
      <>
        {head('อ่าน log ทีละ service แบบ terminal ตอน dev')}
        <ParamProblems problems={problems} />
        {!meta.ok ? <EngineErrorState error={meta.error} /> : <ServicePicker cards={cards} order={order} />}
      </>
    )
  }

  const shown = shownNoise(p.str('show', 64), narrowed)
  const hide = NOISE_GROUPS.filter((g) => !shown.includes(g))
  const collapse = collapsesRepeats(p.str('repeats', 16), narrowed)
  const query: LogsQuery = engineQuery(base, { ids: sel.ids, all }, podSel.pods, {
    ...grep,
    levels,
    hide: hide.length ? hide.join(',') : undefined,
    collapse: collapse ? '1' : undefined,
  })
  const [res, podsRes, errs, deps] = await Promise.all([
    engine.logs({ ...query, limit: PAGE }),
    engine.logPods(base),
    engine.errors({ ...base, limit: 500, sparkBuckets: 1 }),
    engine.dependencies(base),
  ])
  const rows = res.ok ? res.data.rows : []
  // Timeline: every line of the requests on the page, in every service and pod
  const tracesQuery = { ...base, hide: hide.length ? hide.join(',') : undefined }
  const traceIds = view === 'timeline' ? [...new Set(rows.filter((r) => r.traceId && !r.repeat).map((r) => r.traceId))] : []
  const traceParts = await Promise.all(
    Array.from({ length: Math.ceil(traceIds.length / 100) }, (_, i) => engine.logTraces({ ...tracesQuery, traceIds: traceIds.slice(i * 100, i * 100 + 100).join(',') })),
  )

  const pods = podsRes.ok ? podsRes.data.pods : []
  const histogram = res.ok ? res.data.histogram : []
  const stepMs = (histogram.length > 1 ? Math.round((Date.parse(histogram[1].t) - Date.parse(histogram[0].t)) / 1000) : stepFor(scope.toMs - scope.fromMs)) * 1000
  // the outages one of the shown services reported (all of them on "ทุก service")
  const outages = outagesSeenBy(deps.ok ? outagesOf(deps.data.events, scope.fromMs) : [], all ? [] : sel.ids)
  const selServices = all ? [] : [...new Set(sel.ids.map((s) => s.split('/')[0]))]
  const seps = separatorsOf({
    deploys: meta.ok ? meta.data.deploys : [],
    releases: meta.ok ? meta.data.releases : [],
    outages,
    env: scope.env,
    fromMs: scope.fromMs,
    toMs: scope.toMs,
    services: selServices,
  })
  const hiddenN = res.ok ? res.data.hidden.total + (res.data.collapse?.lines ?? 0) : 0
  const sources = [...known, ...sel.ids.filter((s) => !known.some((k) => k.id === s)).map((s) => ({ id: s, service: s.split('/')[0], role: s.split('/')[1] ?? '' }))]
  const filterKey = JSON.stringify([scope.env, scope.from, scope.to, all ? 'all' : sel.ids, podSel.pods, view, levels, grep, hide, collapse])
  const what = grep.traceId ? `trace ${grep.traceId.slice(0, 8)}…` : all ? 'ทุก service' : sel.ids.length === 1 ? sel.ids[0] : `${sel.ids.length} service`

  const props: LogConsoleProps = {
    filterKey,
    view,
    data: {
      rows,
      nextBefore: res.ok ? res.data.nextBefore : null,
      histogram,
      levelCounts: res.ok ? res.data.levelCounts : { debug: 0, info: 0, warn: 0, error: 0, fatal: 0, requestError: 0 },
      hidden: hiddenN,
      traceRows: traceParts.flatMap((t) => (t.ok ? t.data.rows : [])),
      truncated: traceParts.flatMap((t) => (t.ok ? t.data.truncated : [])),
    },
    query,
    tracesQuery,
    pageSize: PAGE,
    sources,
    selected: all ? [] : sel.ids,
    all,
    counts: countsOf(pods),
    pods,
    podSel: podSel.pods,
    byTrace: !!grep.traceId,
    levels: levels ?? null,
    grep: grepText(grep),
    terms: (grep.q ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1),
    noise: shown.length === NOISE_GROUPS.length && !collapse,
    narrowed,
    fromMs: scope.fromMs,
    toMs: scope.toMs,
    stepMs,
    live: !isPastWindow(scope) && !scope.to,
    outages,
    seps,
    errors: errs.ok ? errorInfo(errs.data.groups) : {},
    order,
    keep: scope.keep,
    withDate: !sameDay(scope.fromMs, scope.toMs),
    remember: sel.given ? (sel.all ? 'all' : serviceParam(sel.ids, known)) : null,
    failed: res.ok ? null : <EngineErrorState error={res.error} />,
  }

  return (
    <>
      {head(
        <>
          {all || sel.ids.length > 1 ? what : <span className="mono">{what}</span>} · {view === 'timeline' ? 'ทีละ request (timeline)' : 'ทุกบรรทัดแบบ terminal'} · เก่าอยู่บน ใหม่อยู่ล่าง
        </>,
      )}
      <ParamProblems problems={problems} />
      <LogConsole {...props} />
    </>
  )
}
