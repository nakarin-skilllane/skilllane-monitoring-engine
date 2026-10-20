/**
 * "สุขภาพ service": one row per service/role of /api/overview services[] (state, error rate, p95, volume per minute,
 * type, a sparkline of the range, what to look at), plus a row per role that went quiet without any entry span in
 * the range (เงียบ, _lib/model.ts). A row click selects the service of the charts and routes below (URL service +
 * role); the service name opens Log of that service/role; hovering a row lights its map node.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ServiceChip, StateChip } from '@/components/badges'
import { SparkLine } from '@/components/charts/Sparkline'
import { EmptyState } from '@/components/states'
import { fmtCount, fmtDuration, fmtPct, fmtRangeShort, fmtRate, fmtTime } from '@/lib/format'
import { buildHref, type Scope } from '@/lib/params'
import { groupTitle } from '@/lib/readable'
import type { ErrorGroup, JobStat, OverviewRoute, OverviewService } from '@/lib/types'
import { serviceNodeId } from '@/lib/topology'
import { tipAttrs } from '@/lib/chart'
import { systemLabel } from '@/lib/readable'
import { type DepRow, ERROR_RATE_BAD, type Silence, type Volume, depTitle, perStep, stepWord } from '../_lib/model'
import { atSec, gap, rangeName, spanLabel } from '../_lib/text'
import { LinkedRow } from './MapLink'

export interface HealthRow {
  s: OverviewService
  vol: Volume
  warn: boolean
  newGroups: ErrorGroup[]
  slow: OverviewRoute[]
  bad: OverviewRoute[]
  /** Top error group of a worker / consumer role. */
  jobGroup: ErrorGroup | null
  /** When that group is a dependency.* line: the group and its row in the Dependency list (null when not found). */
  dep: { group: ErrorGroup; row: DepRow | null } | null
  jobStat: JobStat | null
  /** เงียบ: no entry span since `lastMs` (note `ไม่มี message ตั้งแต่ 12:17`); null when it has traffic. */
  silent: (Silence & { note: string }) | null
  /** Complete buckets of the range (see completeCount) and their start times; [] for a role silent all range. */
  spark: number[]
  sparkTimes: number[]
  /** URL that selects this row for the charts and routes; null for a role without data in the range. */
  selectHref: string | null
  selected: boolean
}

export function Health({ scope, rows, order, stepSeconds }: { scope: Scope; rows: HealthRow[]; order: string[]; stepSeconds: number }) {
  const keep = scope.keep
  const env = scope.env ?? 'ทุก env'
  const span = spanLabel(scope)
  return (
    <section className="section ov-health-sec" aria-labelledby="ov-health-t">
      <div className="section__head">
        <h2 className="section__title" id="ov-health-t">
          สุขภาพ service
        </h2>
        <span className="section__meta">
          {rows.length} service/role ใน {env} · {rangeName(scope)} · กดแถวเพื่อเปลี่ยน service ของกราฟและ route ด้านล่าง
        </span>
      </div>
      {rows.length ? (
        <>
          <div className="table-wrap">
            <table className="table table--reflow ov-health">
              <caption className="sr-only">
                สุขภาพของทุก service และ role ใน {env} ช่วง {fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">สถานะ</th>
                  <th scope="col">Service / role</th>
                  <th scope="col" className="num">
                    Error rate
                  </th>
                  <th scope="col" className="num">
                    p95
                  </th>
                  <th scope="col" className="num">
                    ปริมาณ
                  </th>
                  <th scope="col">ประเภท</th>
                  <th scope="col">{span}</th>
                  <th scope="col">ที่ต้องดู</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const { s, vol } = r
                  // a role silent all range has no numbers of its own: dashes, and a volume of 0
                  const none = !!r.silent && s.requests === 0
                  const errCls = s.errorRate >= ERROR_RATE_BAD ? 't-danger' : s.errorRate === 0 ? 't-muted' : ''
                  const n = r.spark.length
                  const last = n ? r.spark[n - 1] : 0
                  const min = n ? Math.min(...r.spark) : 0
                  const max = n ? Math.max(...r.spark) : 0
                  const word = stepWord(stepSeconds)
                  return (
                    <LinkedRow
                      key={`${s.service}/${s.role}`}
                      node={serviceNodeId(s.service, s.role)}
                      href={r.selectHref ?? undefined}
                      current={r.selected}
                      className={r.selectHref ? 'is-clickable' : undefined}
                    >
                      <td className="col-tight ov-h-state">
                        <StateChip state={r.warn ? 'warn' : 'ok'}>{r.silent ? 'เงียบ' : r.warn ? 'ต้องดู' : 'ปกติ'}</StateChip>
                      </td>
                      <td className="nowrap ov-h-svc">
                        <Link className="link-quiet" href={buildHref('/logs', keep, { service: s.service, role: s.role })} title={`เปิด Log ของ ${s.service}/${s.role}`}>
                          <ServiceChip service={s.service} role={s.role} order={order} />
                        </Link>
                        {r.selected ? <span className="sr-only"> (แสดงในกราฟด้านล่าง)</span> : null}
                      </td>
                      <td className={`num ov-h-err ${none ? 't-muted' : errCls}`.trim()} data-label="error">
                        {none ? '–' : fmtPct(s.errorRate)}
                      </td>
                      <td className="num ov-h-p95" data-label="p95">
                        {none ? <span className="t-muted">–</span> : fmtDuration(s.p95Ms)}
                      </td>
                      {/* silent: the rate now is 0, never the range average (that is in the note) */}
                      <td className="num ov-h-vol" title={r.silent ? `ตอนนี้ไม่มี ${vol.short} · ก่อนเงียบเฉลี่ย ${r.silent.rpmBefore === null ? '–' : fmtRate(r.silent.rpmBefore)} ${vol.unit}` : undefined}>
                        {r.silent ? '0' : fmtRate(s.rpm)}
                        <span className="unit">{vol.unit}</span>
                      </td>
                      <td className="nowrap t-ink2 rf-hide">{vol.type}</td>
                      <td className="col-tight rf-hide">
                        {n >= 2 ? (
                          <SparkLine
                            values={r.spark}
                            width={120}
                            height={24}
                            label={`${vol.word} ${perStep(stepSeconds)} ${span} ต่ำสุด ${fmtCount(min)} สูงสุด ${fmtCount(max)} ล่าสุด ${fmtCount(last)}`}
                            tip={
                              tipAttrs(`${vol.word} · ${fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs).replace(' ICT', '')}`, [
                                { value: `${fmtCount(last)} ${vol.short}`, name: `${word}ล่าสุด (${fmtTime(r.sparkTimes[n - 1])})` },
                                { value: `${fmtCount(min)}–${fmtCount(max)}`, name: 'ต่ำสุด–สูงสุด' },
                              ])['data-tip']
                            }
                          />
                        ) : (
                          <span className="t-muted">–</span>
                        )}
                      </td>
                      <td className="ov-note ov-h-note">
                        <Notes row={r} scope={scope} />
                      </td>
                    </LinkedRow>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="hint mt-2">
            ต้องดู = error rate ≥ 1 %, มี error group ใหม่หลัง deploy หรือมี route ที่ p95 ≥ 1 s · เงียบ = ไม่มี request, job หรือ message 5 นาทีขึ้นไปจนถึงท้ายช่วง
            ทั้งที่ก่อนหน้านั้นมีเฉลี่ยอย่างน้อย 1 ครั้งต่อนาที · ปริมาณของ worker นับเป็น job attempt, ของ consumer นับเป็น message · เส้น {span}วัดปริมาณ สเกลตามช่วงของแต่ละแถว
          </p>
        </>
      ) : (
        <div className="panel">
          <EmptyState
            title={`ยังไม่มี request, job หรือ message ใน ${env} ช่วงนี้`}
            text="ไม่มี entry span ในช่วงเวลาที่เลือก ลองขยายช่วงเวลา หรือเลือก env อื่นที่แถบด้านบน"
            actions={
              scope.preset !== 'now-24h' ? (
                <Link className="btn btn--sm" href={buildHref('/overview', { ...keep, from: 'now-24h', to: undefined })}>
                  ดู 24 ชั่วโมงล่าสุด
                </Link>
              ) : null
            }
          />
        </div>
      )}
    </section>
  )
}

/** "ที่ต้องดู": NEW groups, slow and failing routes (HTTP roles) or the top job error (workers). */
function Notes({ row, scope }: { row: HealthRow; scope: Scope }) {
  const keep = scope.keep
  const parts: ReactNode[] = []
  if (row.silent) {
    // the log of that role around its last entry (what it said before it stopped)
    const last = row.silent.lastMs
    const href = buildHref('/logs', keep, {
      service: row.s.service,
      role: row.s.role,
      from: new Date(last - 10 * 60_000).toISOString(),
      to: new Date(Math.min(scope.nowMs, last + 10 * 60_000)).toISOString(),
    })
    parts.push(
      <Link key="silent" href={href} title="เปิด Log ของ role นี้ 10 นาทีก่อนและหลังครั้งสุดท้าย">
        {row.silent.note} ({gap(scope.toMs - last)})
        {row.silent.rpmBefore !== null ? ` · ก่อนหน้านั้นเฉลี่ย ${fmtRate(row.silent.rpmBefore)} ${row.vol.unit}` : ''}
      </Link>,
    )
  }
  if (row.newGroups.length) {
    const href =
      row.newGroups.length === 1
        ? buildHref(`/errors/${row.newGroups[0].fingerprint}`, keep)
        : buildHref('/errors', keep, { service: row.s.service, role: row.s.role })
    parts.push(
      <Link key="new" href={href}>
        error group ใหม่ {row.newGroups.length}
      </Link>,
    )
  }
  const routesHref = `${row.selectHref ?? buildHref('/overview', keep)}#ov-routes-t`
  if (row.slow.length)
    parts.push(
      <Link key="slow" href={routesHref}>
        route ช้า {row.slow.length}
      </Link>,
    )
  if (row.bad.length)
    parts.push(
      <Link key="bad" href={routesHref}>
        route error สูง {row.bad.length}
      </Link>,
    )
  if (row.dep) {
    // worded like the Dependency list, and opens that dependency on /jobs (not the job failures)
    const { group: g, row: d } = row.dep
    const name = d ? depTitle(d, systemLabel) : groupTitle(g)
    const text = !d
      ? groupTitle(g)
      : d.issue === 'down'
        ? `${name} down อยู่ ตั้งแต่ ${d.since ? atSec(d.since, scope.nowMs) : '–'}`
        : d.issue === 'degraded'
          ? `${name} เรียกไม่สำเร็จ ${fmtCount(d.outboundFailures || d.attempts)} ครั้ง`
          : d.issue === 'recovered'
            ? `${name} down ${fmtDuration(d.lastOutageMs)} · กลับมาแล้ว`
            : `${name} ต่อไม่ได้ ${fmtCount(g.count)} ครั้ง · กลับมาแล้ว`
    parts.push(
      <Link key="dep" href={d ? `${buildHref('/jobs', keep)}#${d.anchor}` : buildHref(`/errors/${g.fingerprint}`, keep)}>
        {text}
      </Link>,
    )
  } else if (row.jobGroup && row.s.kind !== 'SERVER') {
    const g = row.jobGroup
    const what = g.jobType || g.jobQueue
    const verb = row.jobStat && row.jobStat.retried > 0 ? 'retry เพราะ' : 'ล้มเหลวเพราะ'
    parts.push(
      <Link key="job" href={`${buildHref('/jobs', keep)}#failures`}>
        {what ? `${what} ${verb} ` : ''}
        {groupTitle(g)}
      </Link>,
    )
  }
  if (!parts.length) return <span className="t-muted">–</span>
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i ? ' · ' : null}
          {p}
        </span>
      ))}
    </>
  )
}
