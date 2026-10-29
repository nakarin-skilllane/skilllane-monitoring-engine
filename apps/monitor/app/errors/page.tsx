import type { Metadata } from 'next'
import Link from 'next/link'
import { AutoRefresh } from '@/components/AutoRefresh'
import { CategoryChip, EnvTag, HttpStatus, LevelBadge, Method, NewBadge, ServiceChip, Tag, Ts } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { Icon, type IconName } from '@/components/icons'
import { Kpi, Kpis } from '@/components/Kpi'
import { ChangedValue } from '@/components/Motion'
import { PageHead } from '@/components/PageHead'
import { AppliedChip } from '@/components/ParamControls'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { Tabs } from '@/components/Tabs'
import { engine, getMeta } from '@/lib/engine'
import { fmtAiTime, fmtCount, fmtDate, fmtDateTime, fmtDuration, fmtRange, fmtTime, sameDay, toMs } from '@/lib/format'
import { buildHref, isPastWindow, Params, parseScope, scopeQuery, withParams, type ParamProblem, type RawSearchParams, type Scope } from '@/lib/params'
import { mergeDependencies } from '@/app/overview/_lib/model'
import { aiErrorMarkdown, CATEGORY_LABEL, groupDetail, groupTitle, MODULE_LABEL } from '@/lib/readable'
import { serviceOrder } from '@/lib/services'
import type { Deploy, ErrorGroup, ErrorSpark, Meta } from '@/lib/types'
import { EgAxis, EgSpark, SLOT, type SparkBucket } from './_components/EgSpark'
import { LevelChips, type LevelKey, ServiceSelect, SortSeg } from './_components/EgControls'
import { EgTarget } from './_components/EgTarget'
import {
  bucketEnd,
  bucketLabel,
  bucketStarts,
  bucketTimes,
  CATEGORY_ABOUT,
  deploysOf,
  depText,
  errSpark,
  splitOf,
  type GroupSplit,
  groupStatus,
  groupWhere,
  inRangeWords,
  isErrLevel,
  lastInWindow,
  lastInWindowAi,
  lastInWindowMs,
  type LastInWindow,
  levelCounts,
  markdownLines,
  rangeLabelText,
  rangeStartTick,
  rangeWords,
  rolesText,
  showNew,
  stepShort,
  stepText,
  whereShort,
} from './_lib/errors'
import './screen.css'

export const metadata: Metadata = { title: 'Error group' }

const SORTS = ['count', 'lastSeen', 'firstSeen'] as const
const CATEGORIES = ['bug', 'input', 'data', 'dependency', 'config'] as const
const CATEGORY_ICON: Record<string, IconName> = { bug: 'cat-bug', input: 'cat-input', data: 'cat-data', dependency: 'cat-dependency', config: 'cat-config' }
const QUESTION = 'error อะไรเกิดบ่อย ใครโดน ต้องแก้ที่ไหน และอันไหนเพิ่งเกิดหลัง deploy'
/** The engine's maximum `limit` for /api/errors: the KPIs count every group the list got. */
const GROUP_LIMIT = 500
const LOG_LINES_TIP = 'หน้า Log นับบรรทัด: ทุก request ที่ตอบ 5xx มีบรรทัด http.request อีก 1 บรรทัด ซึ่งไม่นับเป็น error group'

/** One group with what the list needs beside ErrorGroup. */
interface Row {
  g: ErrorGroup
  split?: GroupSplit
  err: number
  warn: number
  mixed: boolean
  band: LevelKey
  isNew: boolean
  status: number
  /** Length of the dependency outage a dependency.* group is about (the union every screen shows); null when none. */
  outageMs: number | null
  /** Last occurrence inside a past window (isPastWindow); else lastSeen. null when the window has none. */
  last: LastInWindow | null
  /** redis, http … from /api/dependencies (or the latest line). */
  depType: string
  /** Row title: the hint, plus the where (route / job / function) when another listed group of the env has the same title. */
  title: string
}

/** `level` param: absent = both, `none` = neither, else a comma list of error / warn. */
function parseLevels(raw: string | undefined, problems: ParamProblem[]): LevelKey[] {
  if (!raw) return ['error', 'warn']
  if (raw === 'none') return []
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const out = (['error', 'warn'] as const).filter((k) => list.includes(k) || (k === 'error' && list.includes('fatal')))
  if (!out.length) {
    problems.push({ name: 'level', value: raw, message: 'ค่า level ต้องเป็น error, warn หรือ error,warn' })
    return ['error', 'warn']
  }
  return out
}

/** The deploy that made a NEW group new: its service's deploy of firstSeenVersion, else the last one before it. */
function deployOfNew(g: ErrorGroup, meta: Meta | null, env?: string): Deploy | undefined {
  const deps = deploysOf(meta, g.env || env, g.service)
  return deps.filter((d) => d.version === g.firstSeenVersion).pop() ?? deps.filter((d) => toMs(d.at) <= toMs(g.firstSeen)).pop()
}

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const md = meta.ok ? meta.data : null
  const scope = parseScope(sp, 'errors', { envs: md?.envs, limited: md?.envsLimited })
  const p = new Params(sp)
  const problems: ParamProblem[] = []
  const sortRaw = p.str('sort', 20)
  const sort = SORTS.find((s) => s.toLowerCase() === sortRaw?.toLowerCase())
  if (sortRaw && !sort) problems.push({ name: 'sort', value: sortRaw, message: 'ค่า sort ต้องเป็น count, lastSeen หรือ firstSeen' })
  const levels = parseLevels(p.str('level', 40), problems)
  // `category` selects the tab on the client (components/Tabs); read here only to report an invalid value.
  p.oneOf('category', CATEGORIES)
  const order = serviceOrder(md)
  const services = (md?.services ?? []).filter((s) => !scope.env || s.envs.includes(scope.env)).map((s) => s.service)
  const logsHref = buildHref('/logs', scope.keep, { level: 'warn,error', from: scope.from, to: scope.to, service: scope.service, role: scope.role })

  const res = await engine.errors({ ...scopeQuery(scope), sort: sort ?? 'count', limit: GROUP_LIMIT })
  const head = (
    <PageHead
      scope={scope}
      title="Error group"
      question={QUESTION}
      actions={
        <>
          {/* a fixed past window does not change: no auto refresh */}
          {isPastWindow(scope) ? null : <AutoRefresh />}
          <Link className="btn" href={logsHref}>
            เปิดใน Log
          </Link>
          {res.ok ? <CopyButton targetId="eg-ai-md" label="คัดลอกให้ AI" variant="cta" /> : null}
        </>
      }
    />
  )
  const filterbar = (counts: Record<LevelKey, number>) => (
    <div className="filterbar" role="group" aria-label="ตัวกรอง">
      <ServiceSelect services={services} value={scope.service} />
      {scope.role ? <AppliedChip param="role" label="role" value={scope.role} /> : null}
      <LevelChips selected={levels} counts={counts} />
      <span className="hint filterbar__end">ตัวเลขในตัวกรองและ tab คือจำนวน group</span>
    </div>
  )
  const allProblems = [...scope.problems, ...p.problems, ...problems]
  if (!res.ok) {
    return (
      <>
        {head}
        <ParamProblems problems={allProblems} />
        {filterbar({ error: 0, warn: 0 })}
        <EngineErrorState error={res.error} />
      </>
    )
  }

  const { spark } = res.data
  // a past window speaks about itself: "ล่าสุดในช่วงนี้" (lastSeen covers all retained data), and sort=lastSeen by it
  const past = isPastWindow(scope)
  const lastOf = new Map(res.data.groups.map((g) => [g.fingerprint, past ? lastInWindow(g, spark, scope.toMs) : { at: toMs(g.lastSeen) }]))
  const byLast = (list: ErrorGroup[]) =>
    past && sort === 'lastSeen' ? [...list].sort((a, b) => lastInWindowMs(lastOf.get(b.fingerprint) ?? null) - lastInWindowMs(lastOf.get(a.fingerprint) ?? null)) : list
  // every env: prod first (a prod incident is not buried among test envs), engine order inside each
  const groups = scope.env ? byLast(res.data.groups) : [...byLast(res.data.groups.filter((g) => g.env === 'prod')), ...byLast(res.data.groups.filter((g) => g.env !== 'prod'))]
  const capped = res.data.groups.length >= GROUP_LIMIT
  // two groups of one env with the same title (Query cancelled in a route and in a job) say where they differ
  const titleCount = new Map<string, number>()
  for (const g of groups) titleCount.set(`${g.env}|${groupTitle(g)}`, (titleCount.get(`${g.env}|${groupTitle(g)}`) ?? 0) + 1)
  const rowTitle = (g: ErrorGroup) => {
    const t = groupTitle(g)
    const w = (titleCount.get(`${g.env}|${t}`) ?? 0) > 1 ? whereShort(g) : ''
    return w ? `${t} · ${w}` : t
  }
  const starts = bucketStarts(spark)
  const lastStart = starts[starts.length - 1] ?? scope.fromMs
  const splits = new Map(groups.map((g) => [g.fingerprint, splitOf(g)]))
  const [logsErr, deps] = await Promise.all([
    engine.logs({ ...scopeQuery(scope), from: new Date(lastStart).toISOString(), level: 'error,fatal', limit: 1 }),
    groups.some((g) => g.dependencyName) ? engine.dependencies(scopeQuery(scope)) : Promise.resolve(null),
  ])
  const depList = deps?.ok ? deps.data.dependencies : []
  // outages per host:port as the overview and the about page show them (one length: the union over the processes)
  const depRows = deps?.ok ? mergeDependencies(deps.data, scope.fromMs) : []

  const rows: Row[] = groups.map((g) => {
    const split = splits.get(g.fingerprint)
    const lv = levelCounts(g, split)
    const dep = g.dependencyName ? (depList.find((d) => d.service === g.service && d.name === g.dependencyName && d.role === g.role) ?? depList.find((d) => d.service === g.service && d.name === g.dependencyName)) : undefined
    return {
      g,
      split,
      ...lv,
      band: isErrLevel(g.level) ? 'error' : 'warn',
      isNew: showNew(g),
      status: groupStatus(g, split),
      outageMs: g.eventCode.startsWith('dependency.')
        ? (depRows.find((d) => d.name === g.dependencyName && d.issue === 'recovered' && d.users.some((u) => u.service === g.service && (g.roles?.length ? g.roles : [g.role]).includes(u.role)))
            ?.lastOutageMs ?? null)
        : null,
      last: lastOf.get(g.fingerprint) ?? null,
      depType: dep?.type || split?.dependencyType || '',
      title: rowTitle(g),
    }
  })

  // KPI numbers cover every group of the env / range / service (not the tab or level filter).
  const errTotal = rows.reduce((a, r) => a + r.err, 0)
  const warnTotal = rows.reduce((a, r) => a + r.warn, 0)
  const errPerBucket = starts.map((_, i) => rows.reduce((a, r) => a + (errSpark(r.g, r.split)[i] ?? 0), 0))
  const lastErr = errPerBucket[errPerBucket.length - 1] ?? 0
  const logErrLines = logsErr.ok ? logsErr.data.histogram.reduce((a, b) => a + b.error + b.fatal, 0) : null
  const nErr = rows.filter((r) => r.band === 'error').length
  const nWarn = rows.length - nErr
  const totalCount = rows.reduce((a, r) => a + r.g.count, 0)

  // NEW since deploy: the deploy of the first NEW group, else the latest deploy in range of a listed service.
  const newRows = rows.filter((r) => r.isNew)
  const firstNew = [...newRows].sort((a, b) => toMs(a.g.firstSeen) - toMs(b.g.firstSeen))[0]
  const listedServices = new Set(rows.map((r) => r.g.service))
  const envDeploys = (md?.deploys ?? []).filter((d) => (!scope.env || d.env === scope.env) && (!scope.service || d.service === scope.service))
  const inRange = (d: Deploy) => toMs(d.at) >= scope.fromMs && toMs(d.at) <= scope.toMs
  const primary =
    (firstNew ? deployOfNew(firstNew.g, md, scope.env) : undefined) ??
    envDeploys.filter((d) => inRange(d) && listedServices.has(d.service)).pop() ??
    envDeploys.filter(inRange).pop() ??
    envDeploys[envDeploys.length - 1]
  const primaryIn = primary && inRange(primary) ? primary : undefined

  const levelSel = new Set(levels)
  const shown = rows.filter((r) => levelSel.has(r.band))
  // The hours table and the AI summary cover every shown group (the category tabs switch on the client).
  const activeRows = shown
  const counts = { error: nErr, warn: nWarn }

  const ctx: ListCtx = { scope, spark, starts, md, order, primaryIn, sp, allEnvs: !scope.env, past }
  const rangeTxt = rangeLabelText(scope)
  const envName = scope.env ?? 'ทุก env'
  const svcName = scope.service ? `${scope.service}${scope.role ? `/${scope.role}` : ''}` : ''
  // `ใน prod · school-etl-api ช่วง 18 ต.ค. 11:00–12:00 ICT` (an absolute window has an end), else `… ตั้งแต่ 17 ต.ค. 12:20`
  const whereWhen = `ใน ${envName}${svcName ? ` · ${svcName}` : ''} ${scope.to ? `ช่วง ${fmtRange(scope.fromMs, scope.toMs)}` : `ตั้งแต่ ${fmtDateTime(scope.fromMs)}`}`
  const emptyActions = (
    <>
      {scope.preset !== 'now-7d' ? (
        <Link className="btn btn--sm" href={withParams('/errors', sp, { from: 'now-7d', to: null })} scroll={false}>
          ขยายเป็น 7 วัน
        </Link>
      ) : null}
      {scope.service ? (
        <Link className="btn btn--sm btn--quiet" href={withParams('/errors', sp, { service: null, role: null })} scroll={false}>
          ดูทุก service
        </Link>
      ) : null}
      {scope.env ? (
        <Link className="btn btn--sm btn--quiet" href={withParams('/errors', sp, { env: 'all' })} scroll={false}>
          ดูทุก env
        </Link>
      ) : null}
    </>
  )
  const panel = (key: string, list: Row[]) => {
    if (!levels.length) return <EmptyState icon="filter" title="ไม่ได้เลือกระดับ error หรือ warn" text="เปิดตัวกรองระดับอย่างน้อยหนึ่งตัวเพื่อดู group" />
    if (!list.length) {
      const label = key === 'all' ? '' : `หมวด${CATEGORY_LABEL[key]}`
      const text = key === 'all' ? `${whereWhen} ยังไม่พบบรรทัด error หรือ warn ที่จัดกลุ่มได้` : `${CATEGORY_ABOUT[key]} ${whereWhen} ยังไม่พบเลย`
      return (
        <div className="panel">
          <EmptyState
            icon={key === 'all' ? 'check-circle' : CATEGORY_ICON[key]}
            title={`ไม่มี error ${label}ใน${scope.preset === 'custom' ? '' : ' '}${rangeTxt}`}
            text={text}
            actions={emptyActions}
          />
        </div>
      )
    }
    return <GroupList rows={list} panelKey={key} ctx={ctx} />
  }
  const tabItems = [
    { key: 'all', label: 'ทั้งหมด', count: shown.length, title: tabTitle(shown), panel: panel('all', shown) },
    ...CATEGORIES.map((c) => {
      const list = shown.filter((r) => r.g.category === c)
      return {
        key: c,
        label: (
          <>
            <Icon name={CATEGORY_ICON[c]} size="sm" className="eg-tab__icon" />
            {CATEGORY_LABEL[c]}
          </>
        ),
        count: list.length,
        title: tabTitle(list),
        panel: panel(c, list),
      }
    }),
  ]

  const ai = listMarkdown(activeRows, ctx, { errTotal, warnTotal, nErr, nWarn, newCount: newRows.length, primary })
  const stepWords = spark.stepSeconds === 3600 ? 'รายชั่วโมง' : `ทุก ${stepText(spark.stepSeconds)}`
  const lastLabel = spark.stepSeconds === 3600 ? 'ชั่วโมงล่าสุด' : `${stepText(spark.stepSeconds)}ล่าสุด`
  const newKpiFoot = firstNew
    ? `${groupTitle(firstNew.g)}${newRows.length > 1 ? ` และอีก ${newRows.length - 1} group` : ''} · ครั้งแรก ${timeShort(firstNew.g.firstSeen, scope.nowMs)}${primary ? `, deploy ${timeShort(primary.at, scope.nowMs)}` : ''}`
    : primary
      ? `ไม่มี group ใหม่หลัง deploy ${fmtDateTime(primary.at)}`
      : scope.service
        ? `${scope.service} ยังไม่มี deploy ใน ${envName} ในข้อมูลที่เก็บไว้`
        : `ยังไม่มี deploy ใน ${scope.env ? 'env นี้' : 'env ใด'}ในข้อมูลที่เก็บไว้`
  const cappedNote = capped ? `แสดง ${fmtCount(rows.length)} group แรก (engine ส่งได้สูงสุด ${GROUP_LIMIT}) ตัวเลขจึงอาจต่ำกว่าจริง` : ''

  return (
    <>
      {head}
      <ParamProblems problems={allProblems} />
      {filterbar(counts)}
      <EgTarget />

      <Kpis cols={3} label={`สรุป ${rangeWords(scope)}`} className="eg-kpis">
        <Kpi
          label={`ครั้งที่เกิด error (ERR) ${inRangeWords(scope)}`}
          value={errTotal}
          unit="ครั้ง"
          foot={
            <span title={LOG_LINES_TIP}>
              {lastLabel} {fmtCount(lastErr)} ครั้ง{logErrLines !== null ? ` (ใน Log = ${fmtCount(logErrLines)} บรรทัด ERR)` : ''} · WRN อีก {fmtCount(warnTotal)}
            </span>
          }
          spark={errPerBucket}
          sparkBad
        />
        <Kpi label="Error group" value={rows.length} foot={`ERR ${nErr} · WRN ${nWarn} · รวม ${fmtCount(totalCount)} ครั้ง${cappedNote ? ` · ${cappedNote}` : ''}`} />
        <Kpi
          label={primary ? `Group ใหม่ตั้งแต่ deploy ${primary.version}` : 'Group ใหม่หลัง deploy'}
          icon={newRows.length ? <Icon name="alert-octagon" size="sm" /> : undefined}
          value={newRows.length}
          tone={newRows.length ? 'alert' : undefined}
          delta={{ text: newKpiFoot, tone: newRows.length ? 'bad' : undefined }}
          // back to the "ทั้งหมด" tab (the row lives in its panel); EgTarget highlights + focuses the row
          href={firstNew ? `${withParams('/errors', sp, { category: null })}#g-${firstNew.g.fingerprint}` : undefined}
          linkLabel={firstNew ? `ไปที่ group ใหม่ ${groupTitle(firstNew.g)}` : undefined}
        />
      </Kpis>

      <section className="section eg-section" aria-labelledby="h-groups">
        <div className="section__head">
          <h2 className="section__title" id="h-groups">
            Error group
          </h2>
          <span className="section__meta">
            {shown.length} group · {fmtCount(shown.reduce((a, r) => a + r.g.count, 0))} ครั้ง · ERR ขึ้นก่อน WRN
            {scope.env ? '' : ' · prod ขึ้นก่อน env อื่น'}
            {capped ? ` · ${cappedNote}` : ''}
            {primaryIn ? ` · เส้นตั้งในแท่ง = deploy ${primaryIn.version} (${fmtTime(primaryIn.at)})` : ''}
          </span>
          <div className="section__actions">
            <SortSeg value={sort ?? 'count'} />
          </div>
        </div>
        <Tabs className="eg-tabs" label="หมวดของ error" param="category" defaultKey="all" items={tabItems} />
        <div className="stack mt-3">
          {activeRows.length ? (
            <details className="chart__table">
              <summary className="summary-line">ดูจำนวน{stepWords}เป็นตาราง (ข้อมูลเดียวกับกราฟแท่ง)</summary>
              <HoursTable rows={activeRows} ctx={ctx} />
            </details>
          ) : null}
          <details className="disclosure">
            <summary>
              สรุปสำหรับ AI<span className="disclosure__meta">Markdown ที่ปุ่ม &quot;คัดลอกให้ AI&quot; คัดลอก</span>
            </summary>
            <div className="disclosure__body">
              <div className="code-block">
                <div className="code-block__head">
                  <span className="code-block__title">Markdown · {activeRows.length} group · ชื่อ field ตรงกับพจนานุกรมข้อมูล</span>
                  <CopyButton targetId="eg-ai-md" label="คัดลอก" variant="quiet" size="sm" />
                </div>
                <pre className="code code--wrap code--tall" id="eg-ai-md">
                  {markdownLines(ai).map((l, i, all) => (
                    <span key={i}>
                      {l.key ? <span className="c-key">{l.key}</span> : null}
                      {l.rest}
                      {i < all.length - 1 ? '\n' : ''}
                    </span>
                  ))}
                </pre>
              </div>
            </div>
          </details>
        </div>
      </section>
    </>
  )
}

interface ListCtx {
  scope: Scope
  spark: ErrorSpark
  starts: number[]
  md: Meta | null
  order: string[]
  primaryIn?: Deploy
  sp: RawSearchParams
  /** env=all: each row says its env. */
  allEnvs: boolean
  /** A fixed past window (isPastWindow): "ล่าสุดในช่วงนี้". */
  past: boolean
}

/**
 * The note of a level band. ERR: real failures. WRN: the 4xx sentence only when every row is a client mistake
 * (input); a WRN band with a config or dependency row (expired ThaID secret, Redis down) says to read each row.
 */
function bandNote(key: LevelKey, rows: Row[]): string {
  if (key === 'error') return 'ดูก่อน: request หรือ job ล้มเหลวจริง'
  if (rows.every((r) => r.g.category === 'input')) return '4xx: client ส่งข้อมูลมาผิด ระบบตอบถูกแล้ว ดูเมื่อจำนวนผิดปกติ'
  const serious = rows.filter((r) => r.g.category === 'config' || r.g.category === 'dependency').length
  return `request ยังตอบได้ (retry, fallback หรือ 4xx) ดูหมวดของแต่ละแถว${serious ? ` · ${serious} group เป็น config หรือระบบที่เรียกใช้ ไม่ใช่ client ส่งผิด` : ''}`
}

/**
 * Column-head axis labels: `−24 ชม.` … `ตอนนี้` for a preset range; a custom range shows its times, and when it
 * crosses midnight (ICT) the dates on a second line (`12:20` / `17 ต.ค.` … `12:20` / `18 ต.ค.`).
 */
function axisLabels(scope: Scope): { start: string; end: string; startSub?: string; endSub?: string } {
  if (!scope.to && scope.preset !== 'custom') return { start: rangeStartTick(scope), end: 'ตอนนี้' }
  if (sameDay(scope.fromMs, scope.toMs)) return { start: rangeStartTick(scope), end: scope.to ? fmtTime(scope.toMs) : 'ตอนนี้' }
  return { start: fmtTime(scope.fromMs), startSub: fmtDate(scope.fromMs), end: scope.to ? fmtTime(scope.toMs) : 'ตอนนี้', endSub: fmtDate(scope.toMs) }
}

/** Tab tooltip: `2 group · 3,426 ครั้ง`. */
function tabTitle(rows: Row[]): string {
  return `${rows.length} group · ${fmtCount(rows.reduce((a, r) => a + r.g.count, 0))} ครั้ง`
}

function timeShort(value: string, nowMs: number): string {
  return sameDay(value, nowMs) ? fmtTime(value) : fmtDateTime(value)
}

/** x of a time in a row sparkline (buckets × 6 px). */
function sparkX(ctx: ListCtx, at: string): number | null {
  const from = toMs(ctx.spark.from)
  const span = ctx.spark.buckets * ctx.spark.stepSeconds * 1000
  const t = toMs(at)
  if (t < from || t > Math.max(from + span, ctx.scope.toMs)) return null
  return Math.round(Math.min(1, (t - from) / span) * ctx.spark.buckets * SLOT)
}

function GroupList({ rows, panelKey, ctx }: { rows: Row[]; panelKey: string; ctx: ListCtx }) {
  const width = ctx.spark.buckets * SLOT
  const deployX = ctx.primaryIn ? sparkX(ctx, ctx.primaryIn.at) : null
  const bands: Array<{ key: LevelKey; rows: Row[] }> = [
    { key: 'error', rows: rows.filter((r) => r.band === 'error') },
    { key: 'warn', rows: rows.filter((r) => r.band === 'warn') },
  ]
  return (
    <div className="err-list eg-list">
      <div className="eg-cols" aria-hidden="true">
        <span className="eg-cols__main">Error group · ต้องแก้อะไร · ที่ไหน</span>
        <span className="eg-cols__trend">
          {ctx.spark.stepSeconds === 3600 ? 'ครั้งต่อชั่วโมง' : `ครั้งต่อ ${stepText(ctx.spark.stepSeconds)}`}
          <EgAxis
            width={width}
            {...axisLabels(ctx.scope)}
            deploy={deployX !== null && ctx.primaryIn ? { x: deployX, at: ctx.primaryIn.at } : undefined}
          />
        </span>
        <span className="eg-cols__num eg-cols__count">ครั้ง</span>
        <span className="eg-cols__num eg-cols__users">users</span>
        <span className="eg-cols__seen">Service · ครั้งแรก · {ctx.past ? 'ล่าสุดในช่วงนี้' : 'ล่าสุด'}</span>
      </div>
      {bands
        .filter((b) => b.rows.length)
        .map((b) => (
          <div className="eg-group" data-level={b.key === 'error' ? 'err' : 'wrn'} key={b.key}>
            <p className="eg-band">
              <LevelBadge level={b.key} />
              <span className="eg-band__n">{b.rows.length} group</span>
              <span className="eg-band__note">{bandNote(b.key, b.rows)}</span>
            </p>
            <div className="eg-rows">
              {b.rows.map((r) => (
                <GroupRow key={r.g.fingerprint} r={r} panelKey={panelKey} ctx={ctx} />
              ))}
            </div>
          </div>
        ))}
    </div>
  )
}

function GroupRow({ r, panelKey, ctx }: { r: Row; panelKey: string; ctx: ListCtx }) {
  const { g, split } = r
  const { scope, spark, starts } = ctx
  const id = panelKey === 'all' ? `g-${g.fingerprint}` : `g-${g.fingerprint}-${panelKey}`
  const title = r.title
  const fix = groupDetail(g)
  const code = g.errorCode || g.errorType
  const isJob = !!(g.jobType || g.jobQueue)
  const [method, ...pathParts] = (g.routes[0] ?? '').split(' ')
  const path = pathParts.join(' ')
  const jobModule = split?.eventModule ?? ''
  const depType = r.depType
  const errs = errSpark(g, split)
  const buckets: SparkBucket[] = starts.map((s, i) => ({
    label: bucketLabel(s, bucketEnd(starts, i, spark.stepSeconds, scope.toMs)),
    total: g.spark[i] ?? 0,
    lines: r.mixed
      ? isJob
        ? [
            { value: errs[i] ?? 0, name: 'ล้มเหลวจริง (ERR)' },
            { value: (g.spark[i] ?? 0) - (errs[i] ?? 0), name: 'retry (WRN)' },
          ]
        : [
            { value: errs[i] ?? 0, name: 'ERR' },
            { value: (g.spark[i] ?? 0) - (errs[i] ?? 0), name: 'WRN' },
          ]
      : undefined,
  }))
  const max = Math.max(0, ...g.spark)
  const maxIdx = g.spark.indexOf(max)
  const deployXs = deploysOf(ctx.md, g.env || scope.env, g.service)
    .map((d) => sparkX(ctx, d.at))
    .filter((x): x is number => x !== null)
  // muted only for client mistakes (input); a WRN config or dependency failure (expired secret, Redis down) keeps full weight
  const cls = ['err-row', 'eg-row', r.isNew ? 'eg-row--new' : '', r.band === 'warn' && g.category === 'input' ? 'eg-row--quiet' : ''].filter(Boolean).join(' ')
  return (
    <article className={cls} id={id} aria-labelledby={`${id}-t`}>
      <div className="eg-main">
        <div className="err-row__head">
          <LevelBadge level={g.level} />
          <h3 className="err-row__title" id={`${id}-t`}>
            <Link href={buildHref(`/errors/${g.fingerprint}`, scope.keep)}>{title}</Link>
          </h3>
          {ctx.allEnvs ? <EnvTag env={g.env} /> : null}
          {code ? <Tag>{code}</Tag> : null}
          <CategoryChip category={g.category} />
          {r.isNew ? <NewBadge since={g.firstSeenVersion} /> : null}
        </div>
        {fix ? (
          <p className="eg-fix" title={fix}>
            <span className="eg-fix__k">ต้องแก้อะไร</span>
            {fix}
          </p>
        ) : null}
        <p className="eg-where">
          {g.originFunction ? (
            <span className="eg-where__item">
              <span className="eg-k">source</span> <code>{g.originFunction}</code>
            </span>
          ) : null}
          {g.originFile ? (
            <span className="eg-where__item">
              <span className="eg-k">file</span> <code>{g.originFile}</code>
            </span>
          ) : null}
          {g.routes[0] ? (
            <span className="eg-where__item">
              {path ? <Method method={method} /> : null} <code>{path || g.routes[0]}</code> <HttpStatus status={r.status} />
            </span>
          ) : isJob ? (
            <span className="eg-where__item">
              <span className="eg-k">job</span> <code>{g.jobType || g.jobQueue}</code> {MODULE_LABEL[jobModule] ? <Tag>{MODULE_LABEL[jobModule]}</Tag> : null}
            </span>
          ) : g.dependencyName ? (
            <span className="eg-where__item">
              <span className="eg-k">dependency</span> <code>{depText(depType, g.dependencyName)}</code>
            </span>
          ) : g.usecases[0] ? (
            <span className="eg-where__item">
              <span className="eg-k">usecase</span> <code>{g.usecases[0]}</code>
            </span>
          ) : null}
          {g.target ? (
            <span className="eg-where__item">
              <span className="eg-k">target</span> <code>{g.target}</code>
            </span>
          ) : null}
        </p>
      </div>
      <EgSpark
        buckets={buckets}
        deployXs={deployXs}
        label={`${fmtCount(g.count)} ครั้ง${inRangeWords(scope)} สูงสุด ${fmtCount(max)} ครั้งต่อ${/^\d/.test(stepText(spark.stepSeconds)) ? ' ' : ''}${stepText(spark.stepSeconds)}${maxIdx >= 0 && max > 0 ? ` ช่วง ${buckets[maxIdx].label}` : ''}`}
        maxLabel={`สูงสุด ${fmtCount(max)}/${stepShort(spark.stepSeconds)}`}
      />
      <p className="eg-count">
        <ChangedValue value={g.count} className="eg-n">
          {fmtCount(g.count)}
        </ChangedValue>
        <span className="unit">ครั้ง</span>
        {r.mixed ? (
          <span className="eg-sub">
            <span>{isJob ? `${fmtCount(r.warn)} retry` : `${fmtCount(r.warn)} WRN`}</span>
            <span>{isJob ? `${fmtCount(r.err)} ล้มเหลวจริง` : `${fmtCount(r.err)} ERR`}</span>
          </span>
        ) : r.outageMs ? (
          <span className="eg-sub">down {fmtDuration(r.outageMs)}</span>
        ) : null}
      </p>
      <p className="eg-users">
        {g.users > 0 ? (
          <>
            <ChangedValue value={g.users} className="eg-n">
              {fmtCount(g.users)}
            </ChangedValue>
            <span className="unit">users</span>
          </>
        ) : (
          <>
            <span className="eg-n eg-n--none" title="log ของ group นี้ไม่มี user_id (เกิดนอก request)" aria-hidden="true">
              –
            </span>
            <span className="unit" aria-hidden="true">
              users
            </span>
            <span className="sr-only">ไม่มีข้อมูล users</span>
          </>
        )}
      </p>
      <p className="eg-seen">
        <ServiceChip service={g.service} role={rolesText(g)} order={ctx.order} />
        <span>
          <span className="eg-seen__k">ครั้งแรก</span> <Ts value={g.firstSeen} format="date" />
        </span>
        <span>
          <span className="eg-seen__k">{ctx.past ? 'ล่าสุดในช่วงนี้' : 'ล่าสุด'}</span> <LastCell last={r.last} nowMs={scope.nowMs} />
        </span>
      </p>
    </article>
  )
}

/** The time of a LastInWindow: an exact one as Ts, a bucket as its span (`12:00–12:15`). */
function LastCell({ last, nowMs }: { last: LastInWindow | null; nowMs: number }) {
  if (!last) return <span className="t-muted">–</span>
  if ('at' in last) return <Ts value={last.at} format={sameDay(last.at, nowMs) ? 'min' : 'date'} />
  return (
    <span className="ts" title="ช่องสุดท้ายที่มี error นี้ (เวลาแน่นอนอยู่หลังสิ้นสุดช่วง)">
      {bucketTimes(last.from, last.to, nowMs)}
    </span>
  )
}

/** "ดูจำนวนรายชั่วโมงเป็นตาราง": the bars of every shown group, plus the ERR total per bucket. */
function HoursTable({ rows, ctx }: { rows: Row[]; ctx: ListCtx }) {
  const { starts, spark, scope, primaryIn } = ctx
  const ordered = [...rows.filter((r) => r.band === 'error'), ...rows.filter((r) => r.band === 'warn')]
  const errSums = starts.map((_, i) => ordered.reduce((a, r) => a + (errSpark(r.g, r.split)[i] ?? 0), 0))
  const st = stepText(spark.stepSeconds)
  const stepN = /^\d/.test(st) ? st : `1 ${st}`
  const dayTicks = spark.stepSeconds >= 6 * 3600
  let deployBucket = -1
  if (primaryIn) starts.forEach((s, i) => s <= toMs(primaryIn.at) && (deployBucket = i))
  const cell = (v: number, k: number) => (
    <td key={k} className={v ? 'num' : 'num t-muted'}>
      {fmtCount(v)}
    </td>
  )
  return (
    <div className="table-wrap">
      <table className="table table--dense eg-hours">
        <caption>
          ช่วงละ {stepN} เริ่ม {fmtDateTime(toMs(spark.from))} ถึง {fmtDateTime(scope.toMs)} ICT · หัวคอลัมน์ = เวลาเริ่มของช่วง
          {primaryIn && deployBucket >= 0 ? ` · deploy ${primaryIn.version} อยู่ในช่วง ${fmtTime(starts[deployBucket])}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Error group</th>
            {starts.map((s, i) => (
              <th key={s} scope="col" className="num" title={bucketLabel(s, bucketEnd(starts, i, spark.stepSeconds, scope.toMs))}>
                {dayTicks ? fmtDateTime(s) : fmtTime(s)}
              </th>
            ))}
            <th scope="col" className="num">
              รวม
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.g.fingerprint}>
              <th scope="row" className="nowrap">
                <LevelBadge level={r.g.level} /> {r.title}
                {ctx.allEnvs ? (
                  <>
                    {' '}
                    <EnvTag env={r.g.env} />
                  </>
                ) : null}
              </th>
              {starts.map((_, i) => cell(r.g.spark[i] ?? 0, i))}
              <td className="num">
                <b>{fmtCount(r.g.count)}</b>
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="nowrap">
              ครั้งที่เกิด error (ERR) รวม
            </th>
            {errSums.map((v, i) => (
              <td key={i} className="num">
                {fmtCount(v)}
              </td>
            ))}
            <td className="num">
              <b>{fmtCount(errSums.reduce((a, v) => a + v, 0))}</b>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** Copy-for-AI Markdown of the shown groups (DESIGN.md §6b, one block per group, fields line once). */
function listMarkdown(
  rows: Row[],
  ctx: ListCtx,
  s: { errTotal: number; warnTotal: number; nErr: number; nWarn: number; newCount: number; primary?: Deploy },
): string {
  const { scope } = ctx
  const env = scope.env ?? 'all'
  const head = `## Error groups · env ${env} · ${fmtAiTime(scope.fromMs, { ms: false })} – ${fmtAiTime(scope.toMs, { ms: false })} ICT`
  const newPart = s.primary
    ? ` · new since ${s.primary.service} ${s.primary.version} (deploy ${fmtAiTime(s.primary.at, { ms: false })}${s.primary.previousVersion ? `, previous ${s.primary.previousVersion}` : ''}): ${s.newCount}`
    : ` · new since deploy: ${s.newCount}`
  const counts = `- counts: ${fmtCount(s.errTotal)} error occurrences (+${fmtCount(s.warnTotal)} warn) · ${s.nErr + s.nWarn} groups (error ${s.nErr}, warn ${s.nWarn})${newPart}`
  const ordered = [...rows.filter((r) => r.band === 'error'), ...rows.filter((r) => r.band === 'warn')]
  const blocks = ordered.map((r) => {
    const g = r.g
    const isJob = !!(g.jobType || g.jobQueue)
    const level = r.mixed ? `${g.level} (${fmtCount(r.warn)}${isJob ? ' job.retry' : ''} warn + ${fmtCount(r.err)}${isJob ? ' job.failed' : ''} error)` : g.level
    const outage = r.outageMs ? ` · down ${fmtDuration(r.outageMs)}` : ''
    const md = aiErrorMarkdown({
      hint: groupTitle(g),
      code: g.errorCode || g.errorType,
      category: g.category,
      newSince: r.isNew ? g.firstSeenVersion : undefined,
      level,
      service: g.service,
      role: rolesText(g),
      env: g.env || scope.env,
      what: g.detail || undefined,
      howToFix: g.howToFix || undefined,
      where: groupWhere(g, r.split?.eventModule, r.depType),
      usecase: g.usecases[0],
      origin: g.originFunction,
      originFile: g.originFile,
      target: g.target,
      failedStep: g.failedStep,
      // a past window: the last time inside it, and the overall last when that is later
      counts: `${fmtCount(g.count)} times${g.users ? ` · ${fmtCount(g.users)} users` : ''} · first ${fmtAiTime(g.firstSeen, { ms: false })} · ${
        ctx.past
          ? `last in window ${r.last ? lastInWindowAi(r.last) : '–'}${toMs(g.lastSeen) > scope.toMs ? ` (last overall ${fmtAiTime(g.lastSeen, { ms: false })})` : ''}`
          : `last ${fmtAiTime(g.lastSeen, { ms: false })}`
      }${outage}`,
    })
    return md.replace(/\n- fields: see docs\/DATA-DICTIONARY\.md$/, '')
  })
  return [head, counts, '', ...blocks.flatMap((b) => [b, '']), '- fields: see docs/DATA-DICTIONARY.md'].join('\n')
}
