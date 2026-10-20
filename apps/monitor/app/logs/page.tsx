import type { Metadata } from 'next'
import Form from 'next/form'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AutoRefresh } from '@/components/AutoRefresh'
import { Live, ServiceChip } from '@/components/badges'
import { Icon } from '@/components/icons'
import { ChangedValue } from '@/components/Motion'
import { PageHead } from '@/components/PageHead'
import { AppliedChip } from '@/components/ParamControls'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { engine, type EngineError, getMeta } from '@/lib/engine'
import { fmtCount, fmtDateTimeMs, fmtRange, fmtRangeShort, fmtTimeMs, sameDay, shortId } from '@/lib/format'
import { buildHref, isTraceId, Params, parseScope, rangeLabel, scopeQuery, toRecord, withParams, type RawSearchParams } from '@/lib/params'
import { CATEGORY_LABEL, LEVEL_SHORT } from '@/lib/readable'
import { serviceOrder } from '@/lib/services'
import { type Level, LEVELS, type LogsHistogramBucket, type LogsQuery, type OverviewRoute } from '@/lib/types'
import { EventChips, ExpandAllButton, FilterSelect, LevelChips, UserIdSearch } from './_components/LogFilters'
import { LogDrawer, LogDrawerNotFound, type RequestCause } from './_components/LogDrawer'
import { LogHistogram, stepLabel } from './_components/LogHistogram'
import { LogTable, type Line } from './_components/LogTable'
import { hasErrorDetail, lineId, outagesOf, parseLineId, requestCause, withLineIds } from './_lib/lines'
import './screen.css'

export const metadata: Metadata = { title: 'Log' }

const PAGE = 100
const MAX_LIMIT = 500

/** Engine series step when the histogram has a single bucket (same rule as the engine's stepFor). */
function stepFor(rangeMs: number): number {
  if (rangeMs <= 3600_000) return 60
  if (rangeMs <= 6 * 3600_000) return 300
  if (rangeMs <= 24 * 3600_000) return 900
  if (rangeMs <= 30 * 86_400_000) return 3600
  return 21600
}

const sumLevels = (buckets: LogsHistogramBucket[]) => {
  const out: Record<Level, number> = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }
  for (const b of buckets) for (const l of LEVELS) out[l] += b[l] || 0
  return out
}

/** `level ≥ INF` when the levels are "this one and up", else `level WRN, ERR`. */
function levelChip(levels: Level[]): { label: string; value: string } {
  const sorted = LEVELS.filter((l) => levels.includes(l))
  const from = LEVELS.indexOf(sorted[0])
  const isTail = from > 0 && sorted.length === LEVELS.length - from
  return isTail ? { label: 'level ≥', value: LEVEL_SHORT[sorted[0]] } : { label: 'level', value: sorted.map((l) => LEVEL_SHORT[l]).join(', ') }
}

const CATEGORY_OPTIONS = ['bug', 'input', 'data', 'dependency', 'config'].map((c) => ({ value: c, label: `${CATEGORY_LABEL[c]} (${c})` }))

const USER_ID = /^u_[\w-]{1,120}$/
const ROUTE_TEXT = /^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/\S*)$/i

/**
 * What a search text really asks for: a trace id → `traceId`, `u_…` → `userId`, a route (`/exams/:id/submit`,
 * `GET /me`: a template with `:` or one the overview knows) → `route`. `q` searches only message and error text,
 * so these would otherwise answer "no logs".
 */
function searchTarget(q: string | undefined, routes: OverviewRoute[] | null): Record<string, string> | null {
  const text = q?.trim()
  if (!text) return null
  if (isTraceId(text)) return { traceId: text.toLowerCase() }
  if (USER_ID.test(text)) return { userId: text }
  const m = ROUTE_TEXT.exec(text)
  if (!m || !routes) return null
  const method = m[1]?.toUpperCase()
  const path = m[2]
  const known = routes.some((r) => r.method && r.path === path && (!method || r.method === method))
  return known || path.includes(':') ? { route: method ? `${method} ${path}` : path } : null
}

/** Route select: HTTP routes, then job keys (`report:generate · report`) in their own group. */
function routeOptionsOf(routes: OverviewRoute[]): Array<{ value: string; label: string; group: string }> {
  const seen = new Set<string>()
  const out: Array<{ value: string; label: string; group: string }> = []
  for (const r of routes) {
    if (seen.has(r.route)) continue
    seen.add(r.route)
    const i = r.route.indexOf(' ')
    out.push(
      r.method
        ? { value: r.route, label: r.route, group: 'HTTP route' }
        : { value: r.route, label: i > 0 ? `${r.route.slice(i + 1)} · ${r.route.slice(0, i)}` : r.route, group: 'งาน (type · queue)' },
    )
  }
  return [...out.filter((o) => o.group === 'HTTP route'), ...out.filter((o) => o.group !== 'HTTP route')]
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const scope = parseScope(sp, 'logs', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
  const p = new Params(sp)
  const level = p.levels()
  const q = p.str('q')
  const event = p.event()
  const traceId = p.traceId()
  const userId = p.str('userId', 128)
  const jobId = p.str('jobId', 128)
  const route = p.str('route')
  const category = p.name('category')
  const fingerprint = p.fingerprint()
  const limit = p.int('limit', 1, MAX_LIMIT) ?? PAGE
  const before = p.time('before', scope.nowMs)
  const drawer = p.str('drawer', 64)
  const order = serviceOrder(meta.ok ? meta.data : null)
  const keep = scope.keep

  const filters: LogsQuery = { ...scopeQuery(scope), q, event, traceId, userId, jobId, route, category, fingerprint }
  const levelParam = level?.join(',')
  // ERR = error lines + http.request lines that answered 5xx: the chart foot says how many of each
  const wantsReqSplit = !event && (!level || level.includes('error'))
  const [res, overview, deps, errs] = await Promise.all([
    // levelCounts: chip counts over every level, also while a level filter is on (+ the http.request 5xx lines)
    engine.logs({ ...filters, level: levelParam, limit, before }),
    engine.overview(scopeQuery(scope)),
    engine.dependencies(scopeQuery(scope)),
    engine.errors({ ...scopeQuery(scope), limit: 500, sparkBuckets: 1 }),
  ])

  // a trace id, user id or route typed into the search box: show those lines (the URL says so and the chip reads trace / user / route)
  const target = searchTarget(q, overview.ok ? overview.data.routes : null)
  if (target) redirect(withParams('/logs', sp, { q: null, before: null, limit: null, drawer: null, ...target }))

  const lines: Line[] = res.ok ? withLineIds(res.data.rows) : []
  const newFps = new Set(errs.ok ? errs.data.groups.filter((g) => g.isNew).map((g) => g.fingerprint) : [])

  // drawer: the selected line from this page, else fetched by the time in its id (any env)
  let selected = drawer ? lines.find((l) => l.id === drawer) : undefined
  let drawerError: EngineError | null = res.ok ? null : res.error
  if (drawer && !selected && res.ok) {
    const at = parseLineId(drawer)
    if (at) {
      const one = await engine.logs({ from: new Date(at.ms).toISOString(), to: new Date(at.ms + 1).toISOString(), limit: MAX_LIMIT })
      if (one.ok) selected = withLineIds(one.data.rows).find((l) => l.id === drawer)
      else drawerError = one.error
    }
  }
  const [trace, group] = selected
    ? await Promise.all([
        selected.row.traceId ? engine.trace(selected.row.traceId, { env: selected.row.env }) : null,
        selected.row.fingerprint ? engine.error(selected.row.fingerprint, { env: selected.row.env, from: 'now-24h' }) : null,
      ])
    : [null, null]
  // a failed http.request line has no error of its own: the drawer shows (and copies for AI) the error line of that request
  const causeLine = selected && trace?.ok ? requestCause(selected.row, trace.data.logs) : null
  const causeGroup = causeLine?.fingerprint ? await engine.error(causeLine.fingerprint, { env: causeLine.env, from: 'now-24h' }) : null
  const cause: RequestCause | null = causeLine
    ? { id: lineId(causeLine), line: causeLine, group: causeGroup?.ok ? causeGroup.data : null, isNew: !!causeLine.fingerprint && newFps.has(causeLine.fingerprint) }
    : null

  const histogram = res.ok ? res.data.histogram : []
  const levelCounts = res.ok && res.data.levelCounts ? res.data.levelCounts : sumLevels(histogram)
  const shown = sumLevels(histogram)
  const total = LEVELS.reduce((a, l) => a + shown[l], 0)
  const stepSeconds = histogram.length > 1 ? Math.round((Date.parse(histogram[1].t) - Date.parse(histogram[0].t)) / 1000) : stepFor(scope.toMs - scope.fromMs)
  const outages = deps.ok ? outagesOf(deps.data.events, scope.fromMs) : []
  const http5xx = wantsReqSplit && res.ok && res.data.levelCounts ? res.data.levelCounts.requestError : null
  const live = !scope.to && !before
  const nextBefore = res.ok ? res.data.nextBefore : null
  const routeOptions = overview.ok ? routeOptionsOf(overview.data.routes) : []
  // a range over more than one calendar day (ICT): times carry the date (rows, the ก่อน chip, the cursor)
  const withDate = !sameDay(scope.fromMs, scope.toMs)
  const atText = (t: string) => `${withDate ? fmtDateTimeMs(t) : fmtTimeMs(t)} ICT`
  const svc = scope.service ? `${scope.service}${scope.role ? `/${scope.role}` : ''}` : ''
  const envText = scope.env ?? 'ทุก env'
  const rangeShort = fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)
  const resetKey = JSON.stringify([scope.env, scope.from, scope.to, scope.service, scope.role, levelParam, q, event, traceId, userId, jobId, route, category, fingerprint, limit, before])

  // applied filters (× removes one)
  const applied: Array<{ param: string; label: string; value: string }> = []
  if (scope.service) applied.push({ param: 'service', label: 'service', value: scope.service })
  if (scope.role) applied.push({ param: 'role', label: 'role', value: scope.role })
  if (level) applied.push({ param: 'level', ...levelChip(level) })
  if (q) applied.push({ param: 'q', label: 'คำค้น', value: q })
  if (event) applied.push({ param: 'event', label: 'event', value: event })
  if (userId) applied.push({ param: 'userId', label: 'user', value: userId })
  if (jobId) applied.push({ param: 'jobId', label: 'job', value: `#${jobId}` })
  if (route) applied.push({ param: 'route', label: 'route', value: route })
  if (category) applied.push({ param: 'category', label: 'หมวด', value: category })
  if (traceId) applied.push({ param: 'traceId', label: 'trace', value: traceId })
  if (fingerprint) applied.push({ param: 'fingerprint', label: 'error group', value: fingerprint })
  if (before) applied.push({ param: 'before', label: 'ก่อน', value: atText(before) })
  const clearHref = buildHref('/logs', keep)

  // hidden inputs keep every other param when the query bar submits (q replaces, paging and drawer reset)
  const hidden = Object.entries(toRecord(sp)).filter(([k]) => !['q', 'before', 'limit', 'drawer'].includes(k))

  // "ไม่มี log ระดับ FTL จาก school-etl-api …" for the empty state
  const what = [
    level ? `ระดับ ${level.map((l) => LEVEL_SHORT[l]).join(', ')}` : '',
    svc ? `จาก ${svc}` : '',
    event ? `event ${event}` : '',
    route ? `ของ route ${route}` : '',
    category ? `หมวด ${category}` : '',
    userId ? `ของ ${userId}` : '',
    jobId ? `ของ job #${jobId}` : '',
    traceId ? `ใน trace ${shortId(traceId)}` : '',
    fingerprint ? `ของ error group นี้` : '',
    q ? `ที่มีคำว่า "${q}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const spanMs = scope.toMs - scope.fromMs
  const wider = spanMs < 24 * 3600_000 ? { from: 'now-24h', label: 'ขยายเป็น 24 ชั่วโมง' } : spanMs < 7 * 86_400_000 ? { from: 'now-7d', label: 'ขยายเป็น 7 วัน' } : null

  const notes = [
    http5xx !== null && http5xx > 0 && shown.error > 0 ? `ERR ${fmtCount(shown.error)} = error ${fmtCount(shown.error - http5xx)} ครั้ง + บรรทัด http.request ที่ตอบ 5xx ${fmtCount(http5xx)}` : null,
    outages.length ? `แถบแดงจาง = ${[...new Set(outages.map((o) => o.label.replace(/ down.*$/, '')))].join(', ')} down` : null,
    `คลิกแท่งเพื่อดู${stepSeconds === 60 ? 'นาที' : 'ช่วง'}นั้น ลากเพื่อเลือกช่วง`,
  ].filter((n): n is string => !!n)

  const errorsHref = fingerprint ? buildHref(`/errors/${fingerprint}`, keep) : buildHref('/errors', keep, { service: scope.service, role: scope.role })

  return (
    <>
      <PageHead
        scope={scope}
        title="Log"
        question="ทุกบรรทัด log ตามเวลา: ค้น กรอง แล้วเปิดดูว่าพังที่ไหนและต้องแก้อะไร"
        actions={
          <>
            {/* a fixed past window does not change: no auto refresh */}
            {scope.to ? null : <AutoRefresh />}
            <Link className="btn" href={errorsHref}>
              ดู error group
            </Link>
          </>
        }
      />
      <ParamProblems problems={[...scope.problems, ...p.problems]} />

      {/* Query bar: one row above everything it scopes (histogram + table) */}
      <Form action="/logs" className="lg-query" role="search" aria-label="ค้นหา log">
        {hidden.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <div className="search">
          <Icon name="search" />
          <label className="sr-only" htmlFor="lg-q">
            ค้นใน message และ error หรือวาง trace id, user id, route
          </label>
          <input
            key={q ?? ''}
            className="search__input"
            id="lg-q"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="ค้นใน message และ error… เช่น ORA-12899 หรือ question bank"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd" aria-hidden="true">
            Enter
          </kbd>
        </div>
        <button className="btn btn--primary" type="submit">
          <Icon name="search" />
          ค้นหา
        </button>
        <p className="hint lg-query__hint">
          ค้นคำใน <span className="mono">message</span> และ <span className="mono">error</span> · วาง trace id 32 ตัว, <span className="mono">u_…</span> หรือ route เช่น{' '}
          <span className="mono">GET /me</span> ในช่องนี้ได้เลย จะกรองบรรทัดของ trace, user หรือ route นั้นให้ · เลือก route จากช่อง Route ด้านล่างก็ได้
        </p>
      </Form>

      <div className="lg-filters">
        <div className="filterbar" aria-label="ตัวกรองที่ใช้อยู่">
          <span className="filter-label">ตัวกรองที่ใช้อยู่</span>
          <div className="chips">
            {applied.length ? (
              <>
                {applied.map((a) => (
                  <AppliedChip key={a.param} param={a.param} label={a.label} value={a.value} />
                ))}
                <Link className="btn btn--sm btn--quiet" href={clearHref} scroll={false}>
                  ล้างทั้งหมด
                </Link>
              </>
            ) : (
              <span className="hint">ไม่มี · แสดงทุกบรรทัดของ {envText} ในช่วงเวลานี้</span>
            )}
          </div>
        </div>
        <div className="filterbar" aria-label="ตัวกรองด่วน">
          <div className="filterbar__group" role="group" aria-label="Level">
            <span className="filter-label">Level</span>
            <LevelChips counts={levelCounts} />
          </div>
          <div className="filterbar__group" role="group" aria-label="Event">
            <span className="filter-label">Event</span>
            <EventChips />
          </div>
          <div className="filterbar__group">
            <UserIdSearch />
            <FilterSelect param="route" label="Route" allLabel="ทุก route" options={routeOptions} />
            <FilterSelect param="category" label="หมวด error" allLabel="ทุกหมวด error" options={CATEGORY_OPTIONS} />
          </div>
        </div>
      </div>

      {!res.ok ? (
        <div className="lg-results">
          <EngineErrorState error={res.error} />
        </div>
      ) : total === 0 && !lines.length ? (
        <div className="panel lg-results">
          <EmptyState
            icon="search-none"
            title="ไม่พบ log ที่ตรงกับตัวกรอง"
            text={`ไม่มี log${what ? ` ${what}` : ''} ${scope.env ? `ของ ${scope.env}` : 'ในทุก env'} ${scope.preset === 'custom' ? `ในช่วง ${fmtRange(scope.fromMs, scope.toMs)}` : `ใน ${rangeLabel(scope)}`} ลองขยายช่วงเวลาหรือเอาตัวกรองออก${q ? ' (คำค้นหาเฉพาะใน message และ error ถ้าเป็น route ให้เลือกจากช่อง Route)' : ''}`}
            actions={
              <>
                {wider ? (
                  <Link className="btn btn--sm" href={withParams('/logs', sp, { from: wider.from, to: null, before: null, drawer: null })} scroll={false}>
                    {wider.label}
                  </Link>
                ) : null}
                {applied.length ? (
                  <Link className="btn btn--sm btn--quiet" href={clearHref} scroll={false}>
                    ล้างตัวกรอง
                  </Link>
                ) : null}
              </>
            }
          />
        </div>
      ) : (
        <>
          <LogHistogram
            buckets={histogram}
            stepSeconds={stepSeconds}
            fromMs={scope.fromMs}
            toMs={scope.toMs}
            outages={outages}
            subject={`${svc ? `ของ ${svc} ` : ''}ใน ${envText} ${rangeShort}`}
            notes={notes}
            sub={
              <>
                {scope.service ? (
                  <>
                    <ServiceChip service={scope.service} role={scope.role} order={order} /> ·{' '}
                  </>
                ) : null}
                {envText} · {rangeShort} · step {stepLabel(stepSeconds)} · รวม{' '}
                <ChangedValue value={total} className="num">
                  {fmtCount(total)}
                </ChangedValue>{' '}
                บรรทัด
              </>
            }
          />

          {/* Log table, newest first */}
          <section className="panel lg-results" aria-labelledby="lg-results-title">
            <div className="panel__head">
              <h2 className="panel__title" id="lg-results-title">
                บรรทัด log
              </h2>
              {live ? <Live title="ช่วงเวลาแบบล่าสุด: บรรทัดใหม่เข้ามาด้านบนเอง" /> : null}
              <span className="panel__meta">ใหม่สุดก่อน · เวลา ICT · คลิกแถวเพื่อดูรายละเอียด</span>
              {lines.some((l) => hasErrorDetail(l.row)) ? (
                <div className="panel__actions">
                  <ExpandAllButton />
                </div>
              ) : null}
            </div>
            {lines.length ? (
              <LogTable
                lines={lines}
                order={order}
                keep={keep}
                newFingerprints={newFps}
                selected={selected?.id}
                resetKey={resetKey}
                caption={`บรรทัด log${svc ? ` ของ ${svc}` : ''} ใน ${envText} เรียงจากใหม่ไปเก่า`}
                outages={outages}
                withDate={withDate}
              />
            ) : (
              <EmptyState
                icon="search-none"
                title="ไม่มีบรรทัดที่เก่ากว่านี้ในช่วงเวลานี้"
                text="ตัวกรองนี้ไม่มีบรรทัดก่อนเวลาที่เลือกแล้ว กลับไปดูบรรทัดล่าสุด หรือขยายช่วงเวลา"
                actions={
                  <Link className="btn btn--sm" href={withParams('/logs', sp, { before: null, limit: null, drawer: null })} scroll={false}>
                    กลับไปบรรทัดล่าสุด
                  </Link>
                }
              />
            )}
            <div className="panel__foot list-foot">
              <span className="list-foot__count">
                แสดง <b>{fmtCount(lines.length)}</b> แถว · ในช่วงเวลานี้มี{' '}
                <ChangedValue value={total} as="b">
                  {fmtCount(total)}
                </ChangedValue>{' '}
                แถว
              </span>
              {nextBefore ? (
                <span className="list-foot__cursor">
                  ต่อจาก {atText(nextBefore)} · before={nextBefore}
                </span>
              ) : null}
              {nextBefore ? (
                <Link
                  className="btn btn--sm"
                  href={
                    limit < MAX_LIMIT
                      ? withParams('/logs', sp, { limit: String(Math.min(MAX_LIMIT, limit + PAGE)), drawer: null })
                      : withParams('/logs', sp, { before: nextBefore, limit: null, drawer: null })
                  }
                  scroll={false}
                >
                  <Icon name="chevron" size="sm" />
                  {limit < MAX_LIMIT ? `โหลดเพิ่ม ${PAGE} แถว` : `ดู ${PAGE} แถวที่เก่ากว่า`}
                </Link>
              ) : null}
            </div>
          </section>
        </>
      )}

      {drawer ? (
        selected ? (
          <LogDrawer
            id={drawer}
            row={selected.row}
            keep={keep}
            order={order}
            isNew={!!selected.row.fingerprint && newFps.has(selected.row.fingerprint)}
            trace={trace?.ok ? trace.data : null}
            group={group?.ok ? group.data : null}
            cause={cause}
          />
        ) : (
          <LogDrawerNotFound id={drawer} error={drawerError} />
        )
      ) : null}
    </>
  )
}
