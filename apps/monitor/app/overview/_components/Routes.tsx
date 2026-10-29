/**
 * "Route" of the selected service/role: the 8 routes with the most requests (/api/overview routes[] with service +
 * role), with Δ 5xx and Δ p95 against the hour before its current deploy (a second /api/overview call over
 * [deploy − 1 h, deploy]). Slow (p95 ≥ 1 s) and failing (5xx ≥ 1 %) rows expand: the slowest trace and the span
 * the time went to, or the route's main error group (readable error rule: title, category, chips, fix).
 */
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { CategoryChip, LevelBadge, NewBadge, ServiceChip, Ts } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { ErrorWhatFix, KvList } from '@/components/ErrorParts'
import { ExpandRow } from '@/components/ExpandRow'
import { EmptyState } from '@/components/states'
import { fmtCount, fmtDuration, fmtMs, fmtPct, fmtRangeShort, fmtTime, shortId } from '@/lib/format'
import { buildHref, type Scope } from '@/lib/params'
import { groupKvs, groupTitle, groupWhatFix } from '@/lib/readable'
import type { ErrorGroup, OverviewRoute, OverviewService } from '@/lib/types'
import { type DeployInfo, ERROR_RATE_BAD, P95_WORSE, SLOW_MS, isHttp } from '../_lib/model'
import { fmtDeltaMs, fmtPt, inRange } from '../_lib/text'
import type { SlowTrace } from './Attention'

export interface RoutesProps {
  scope: Scope
  order: string[]
  selected: OverviewService
  routes: OverviewRoute[]
  /** Routes of the hour before deploy, by route; null = nothing to compare with. */
  base: Map<string, OverviewRoute> | null
  deploy: DeployInfo | null
  /** Slowest trace per slow route (route key). */
  slowTraces: Map<string, SlowTrace | null>
  /** Error groups of the range and of 24 h. */
  groups: ErrorGroup[]
  groups24: ErrorGroup[] | null
}

const Muted = ({ children = '–' }: { children?: ReactNode }) => <span className="t-muted">{children}</span>

export function Routes({ scope, order, selected, routes, base, deploy, slowTraces, groups, groups24 }: RoutesProps) {
  const keep = scope.keep
  const current = `${selected.service}/${selected.role}`
  // a worker's error rate counts every attempt that did not finish (retry + real failure), not 5xx
  const http = selected.kind === 'SERVER'
  const failWord = http ? '5xx' : 'ไม่สำเร็จ'
  const baseText = deploy ? `${fmtTime(deploy.atMs - 3600_000)}–${fmtTime(deploy.atMs)} (${deploy.previousVersion})` : ''
  const ofRoute = (list: ErrorGroup[] | null, route: string) =>
    (list ?? []).filter((g) => g.service === selected.service && g.role === selected.role && (g.routes.includes(route) || (!!g.jobType && route.endsWith(` ${g.jobType}`)))).sort((a, b) => b.count - a.count)

  return (
    <section className="section" aria-labelledby="ov-routes-t">
      <div className="section__head">
        <h2 className="section__title" id="ov-routes-t">
          Route
        </h2>
        <span className="section__meta">
          <ServiceChip service={selected.service} role={selected.role} order={order} /> · {routes.length} route ที่มี request มากสุด · เรียงตาม request ·{' '}
          {deploy ? `Δ เทียบ ${baseText}` : 'ไม่มี deploy ก่อนหน้าให้เทียบ Δ'}
        </span>
        <div className="section__actions">
          <Link className="btn btn--sm btn--quiet" href={buildHref('/traces', keep, { service: selected.service, role: selected.role })}>
            ดู trace ทั้งหมด
          </Link>
        </div>
      </div>
      {routes.length ? (
        <>
          <div className="table-wrap">
            <table className="table table--reflow ov-routes">
              <caption className="sr-only">
                Route ของ {current} ช่วง {fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)}
                {deploy ? ` เทียบกับ ${baseText} ก่อน deploy ${deploy.version}` : ''}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="col-tight">
                    <span className="sr-only">ขยาย</span>
                  </th>
                  <th scope="col">Route</th>
                  <th scope="col" className="num" aria-sort="descending">
                    Request
                  </th>
                  <th scope="col" className="num">
                    Error rate
                  </th>
                  <th scope="col" className="num" title={deploy ? `เทียบ ${baseText}` : undefined}>
                    Δ {failWord}
                  </th>
                  <th scope="col" className="num">
                    4xx
                  </th>
                  <th scope="col" className="num">
                    p50
                  </th>
                  <th scope="col" className="num">
                    p95
                  </th>
                  <th scope="col" className="num" title={deploy ? `เทียบ ${baseText}` : undefined}>
                    Δ p95
                  </th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => {
                  const b = base?.get(r.route)
                  const bad = r.errorRate >= ERROR_RATE_BAD
                  const slow = r.p95Ms >= SLOW_MS && isHttp(r)
                  // Δ 5xx: "ใหม่" when the route had no 5xx before the deploy
                  let d5: ReactNode = <Muted />
                  let d5Cls = 't-muted'
                  if (base) {
                    if (b) {
                      const diff = r.errorRate - b.errorRate
                      if (b.errorRate === 0 && r.errorRate > 0) {
                        d5 = <span className="t-warn">{fmtPt(diff)} · ใหม่</span>
                        d5Cls = ''
                      } else if (Math.abs(diff) >= 0.0005) d5 = fmtPt(diff)
                    } else if (r.errorRate > 0) {
                      d5 = <span className="t-warn">{fmtPt(r.errorRate)} · ใหม่</span>
                      d5Cls = ''
                    }
                  }
                  let d95: ReactNode = <Muted />
                  let d95Cls = 't-muted'
                  if (b && b.p95Ms > 0) {
                    const diff = r.p95Ms - b.p95Ms
                    const worse = diff / b.p95Ms >= P95_WORSE
                    const text = fmtDeltaMs(diff, r.p95Ms >= 1000)
                    if (worse) {
                      d95 = (
                        <span className="t-warn">
                          {text} · +{Math.round((diff / b.p95Ms) * 100)} %
                        </span>
                      )
                      d95Cls = ''
                    } else d95 = text
                  }
                  const cells = (
                    <>
                      <td className="mono nowrap ov-r-route">
                        <Link className="link-quiet" href={buildHref('/traces', keep, { route: r.route })}>
                          {r.method ? (
                            <>
                              <span className="method">{r.method}</span> {r.path}
                            </>
                          ) : (
                            r.route
                          )}
                        </Link>
                      </td>
                      <td className="num ov-r-req" data-label="request">
                        {fmtCount(r.requests)}
                      </td>
                      <td className={`num ov-r-err ${bad ? 't-danger' : r.errorRate === 0 ? 't-muted' : ''}`.trim()} data-label="error">
                        {fmtPct(r.errorRate)}
                      </td>
                      <td className={`num ov-r-d5 ${d5Cls}`.trim()} data-label={`Δ ${failWord}`}>
                        {d5}
                      </td>
                      <td className={`num rf-hide ${r.clientErrorRate ? '' : 't-muted'}`.trim()}>{r.clientErrorRate ? fmtPct(r.clientErrorRate) : '–'}</td>
                      <td className="num t-ink2 rf-hide">{fmtDuration(r.p50Ms)}</td>
                      <td className="num ov-r-p95" data-label="p95">
                        {slow ? <span className="t-warn">{fmtDuration(r.p95Ms)} · ช้า</span> : fmtDuration(r.p95Ms)}
                      </td>
                      <td className={`num ov-r-d95 ${d95Cls}`.trim()} data-label="Δ p95">
                        {d95}
                      </td>
                    </>
                  )
                  if (bad) {
                    const g = ofRoute(groups, r.route)[0]
                    const g24 = g ? groups24?.find((x) => x.fingerprint === g.fingerprint) : undefined
                    const detail = g ? (
                      <div className="row-detail__body">
                        <div className="row ov-rd">
                          <LevelBadge level={g.level} />
                          <b>{groupTitle(g)}</b>
                          <CategoryChip category={g.category} />
                          {g.isNew ? <NewBadge since={g.firstSeenVersion} /> : null}
                          <span className="hint">
                            error หลักของ route นี้ · {fmtCount(g.count)} ครั้ง{inRange(scope)}
                            {g24 ? ` · ${fmtCount(g24.count)} ครั้งใน 24 ชั่วโมง` : ''} · {fmtCount(g.users)} users ·{' '}
                            {g.isNew
                              ? b && b.errorRate === 0
                                ? http
                                  ? 'ก่อน deploy route นี้ไม่มี 5xx'
                                  : 'ก่อน deploy job นี้ไม่มี attempt ที่ไม่สำเร็จ'
                                : `เกิดครั้งแรกหลัง deploy ${g.firstSeenVersion}`
                              : `เกิดตั้งแต่ ${g.firstSeenVersion}${b ? ` (${baseText.split(' ')[0]} = ${fmtPct(b.errorRate)})` : ''}`}
                          </span>
                          <Link className="btn btn--sm" href={buildHref(`/errors/${g.fingerprint}`, keep)}>
                            เปิด error
                          </Link>
                          {g.sampleTraceId ? (
                            <Link className="btn btn--sm" href={buildHref(`/traces/${g.sampleTraceId}`, keep)}>
                              ตัวอย่าง trace {shortId(g.sampleTraceId)}
                            </Link>
                          ) : null}
                        </div>
                        <KvList items={groupKvs(g)} />
                        <ErrorWhatFix {...groupWhatFix(g)} />
                      </div>
                    ) : (
                      <div className="row-detail__body">
                        <div className="row ov-rd">
                          <span className="hint">
                            ไม่พบ error group ของ route นี้{inRange(scope)} ({http ? '5xx' : 'attempt ที่ไม่สำเร็จ'}ที่ไม่มีบรรทัด error)
                          </span>
                          <Link className="btn btn--sm" href={buildHref('/traces', keep, { route: r.route, status: 'error' })}>
                            ดู trace ที่ error
                          </Link>
                        </div>
                      </div>
                    )
                    return <ExpandRow key={r.route} className="is-bad" toggleCellClassName="ov-r-tog" colSpan={8} label={`ขยาย ${r.route}`} cells={cells} detail={detail} />
                  }
                  if (slow) {
                    const t = slowTraces.get(r.route) ?? null
                    const g24 = ofRoute(groups24, r.route)[0]
                    const gNow = g24 ? groups.find((x) => x.fingerprint === g24.fingerprint) : undefined
                    const detail = (
                      <div className="row-detail__body">
                        <div className="row ov-rd">
                          <span className="t-warn">ช้า</span>
                          {t ? (
                            <>
                              <span>trace ช้าสุด</span>
                              <span className="idchip">
                                <Link href={buildHref(`/traces/${t.row.traceId}`, keep)} title={t.row.traceId}>
                                  {shortId(t.row.traceId, 16)}
                                </Link>
                                <CopyButton text={t.row.traceId} variant="icon" ariaLabel="คัดลอก trace id" />
                              </span>
                              <Ts value={t.row.timestamp} />
                              <span>
                                {fmtMs(t.row.durationMs)}
                                {t.span ? (
                                  <>
                                    {' '}
                                    · span ที่ช้า <span className="mono">{t.span.name}</span> {fmtMs(t.span.durationMs)}
                                  </>
                                ) : null}
                              </span>
                            </>
                          ) : (
                            <span>p95 {fmtDuration(r.p95Ms)} · p99 {fmtDuration(r.p99Ms)}</span>
                          )}
                          {g24 ? (
                            <span className="hint">
                              error group ของ route นี้: <Link href={buildHref(`/errors/${g24.fingerprint}`, keep)}>{groupTitle(g24)}</Link> {fmtCount(g24.count)} ครั้งใน 24 ชั่วโมง,{' '}
                              {gNow ? `${fmtCount(gNow.count)} ครั้ง${inRange(scope)}` : `ไม่มี${inRange(scope)}`}
                            </span>
                          ) : null}
                          <Link className="btn btn--sm" href={buildHref('/traces', keep, { route: r.route, minMs: 1000 })}>
                            ดู trace ที่ช้า
                          </Link>
                        </div>
                      </div>
                    )
                    return <ExpandRow key={r.route} className="is-slow" toggleCellClassName="ov-r-tog" colSpan={8} label={`ขยาย ${r.route}`} cells={cells} detail={detail} />
                  }
                  return (
                    <tr key={r.route}>
                      <td className="ov-r-tog" />
                      {cells}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint mt-2">
            <span className="legend__key--bar" style={{ '--c': 'var(--danger-solid)' } as CSSProperties} aria-hidden="true" />
            {http ? 'error rate (5xx) ≥ 1 %' : 'error rate (attempt ที่ไม่สำเร็จ: retry + ล้มเหลวจริง) ≥ 1 %'} ·{' '}
            <span className="legend__key--bar" style={{ '--c': 'var(--warn-solid)' } as CSSProperties} aria-hidden="true" />
            p95 ≥ 1 s (ช้า)
            {deploy
              ? ` · Δ = ค่าตอนนี้ลบค่า ${baseText.split(' ')[0]} (pt = percentage point) · สีเตือน = แย่ลงชัดหลัง deploy (p95 +20 % ขึ้นไป หรือ ${failWord} จาก 0 เป็นมากกว่า 0)`
              : ''}{' '}
            · กดลูกศรเพื่อดู error หลักหรือ trace ที่ช้าของ route
          </p>
        </>
      ) : (
        <div className="panel">
          <EmptyState title={`ยังไม่มี route ของ ${current} ในช่วงนี้`} text="ลองขยายช่วงเวลา หรือเลือก service อื่นจากตารางสุขภาพ service" />
        </div>
      )}
    </section>
  )
}
