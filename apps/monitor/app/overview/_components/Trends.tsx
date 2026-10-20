/**
 * "Traffic, error และ latency" of the selected service/role (/api/overview with service + role): request line,
 * 5xx bars and p95 line per bucket, one y axis each, with deploys and dependency outages as event lines / bands.
 * One tooltip per bucket carries all three values; a click opens Log of that bucket; "ดูเป็นตาราง" has every value.
 */
import { ServiceChip } from '@/components/badges'
import { ChartFrame, ChartTable } from '@/components/charts/ChartFrame'
import { BucketLinks } from '@/components/charts/BucketLinks'
import { type BucketTip, TimeBars, TimeLine, type TimeEvent } from '@/components/charts/TimeCharts'
import { EmptyState } from '@/components/states'
import { fmtCount, fmtDateTime, fmtDuration, fmtPct, fmtRangeShort, fmtRate, fmtTime } from '@/lib/format'
import { buildHref, type Scope } from '@/lib/params'
import { svcClass } from '@/lib/services'
import type { OverviewRoute, OverviewSeriesPoint, OverviewService } from '@/lib/types'
import { type Volume, perStep, stepWord } from '../_lib/model'
import { wholeRange } from '../_lib/text'
import { ServiceSelect } from './ServiceSelect'

export interface TrendsProps {
  scope: Scope
  order: string[]
  selected: OverviewService
  vol: Volume
  /** Complete buckets of the selected service (see completeCount). */
  points: OverviewSeriesPoint[]
  stepSeconds: number
  routes: OverviewRoute[]
  options: Array<{ value: string; label: string; href: string }>
  events: TimeEvent[]
  bands: Array<{ from: number; to: number }>
  /** What the event lines / bands are (panel foot). */
  marks: string[]
  /** Worker / consumer: the range's job.retry (+ redeliver) and real failures of this service/role (/api/overview jobs). */
  jobSplit: { retried: number; failed: number } | null
}

const NOUN: Record<string, string> = { req: 'Request', job: 'Job', msg: 'Message' }

export function Trends({ scope, order, selected, vol, points, stepSeconds, routes, options, events, bands, marks, jobSplit }: TrendsProps) {
  const http = selected.kind === 'SERVER'
  const word = stepWord(stepSeconds)
  const per = perStep(stepSeconds)
  /** `นาทีนั้น`, `ช่วง 15 นาทีนั้น` */
  const that = /^\d/.test(word) ? `ช่วง ${word}นั้น` : `${word}นั้น`
  const noun = NOUN[vol.short] ?? 'Request'
  // a worker's errors are every attempt that did not finish: retries and real failures (as /jobs splits them)
  const errName = http ? '5xx' : 'ไม่สำเร็จ'
  const split =
    !http && jobSplit && jobSplit.retried + jobSplit.failed > 0
      ? jobSplit.retried + jobSplit.failed === selected.errors
        ? ` = retry ${fmtCount(jobSplit.retried)} + ล้มเหลวจริง ${fmtCount(jobSplit.failed)}`
        : ` · retry ${fmtCount(jobSplit.retried)} · ล้มเหลวจริง ${fmtCount(jobSplit.failed)}`
      : ''
  const cls = svcClass(selected.service, order)
  const svcKey = cls || 'muted'
  const times = points.map((p) => Date.parse(p.t))
  const multiDay = scope.toMs - scope.fromMs > 86_400_000
  const timeText = (t: number) => (multiDay || stepSeconds >= 3600 ? fmtDateTime(t) : fmtTime(t))
  const totalErrors = selected.errors
  const errRoutes = routes.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 2)
  // a spike = one bucket at three times the average and at least 5
  const errs = points.map((p) => p.errors)
  const mean = errs.length ? errs.reduce((a, v) => a + v, 0) / errs.length : 0
  const peak = errs.length ? Math.max(...errs) : 0
  const peakAt = errs.indexOf(peak)
  const spike = peak >= 5 && peak >= mean * 3 ? `พุ่งสุด ${fmtCount(peak)} ครั้งตอน ${timeText(times[peakAt])}` : 'ไม่มีช่วงที่พุ่ง'
  const stepMs = stepSeconds * 1000
  // one tooltip per bucket with all three values, and a link to Log of that bucket (on every chart)
  const tips: BucketTip[] = points.map((p, i) => ({
    title: fmtDateTime(times[i]),
    lines: [
      { value: fmtCount(p.requests), name: vol.word, key: svcKey },
      { value: fmtCount(p.errors), name: errName, key: 'bar-neutral' },
      { value: fmtDuration(p.p95Ms), name: 'p95', key: svcKey },
    ],
  }))
  const hrefs = points.map((_, i) =>
    buildHref('/logs', { env: scope.keep.env }, {
      service: selected.service,
      role: selected.role,
      from: new Date(times[i]).toISOString(),
      to: new Date(Math.min(times[i] + stepMs, scope.toMs)).toISOString(),
    }),
  )
  const range = fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs)
  const current = `${selected.service}/${selected.role}`
  // p95 in one unit (DESIGN.md §3): seconds once a bucket reaches 1 s, so the ticks read 0 · 1 · 2 next to "2.1 s"
  const p95InSec = points.some((p) => p.p95Ms >= 1000)
  const p95Values = points.map((p) => (p95InSec ? Math.round(p.p95Ms / 100) / 10 : Math.round(p.p95Ms)))
  const p95Unit = p95InSec ? 's' : 'ms'

  return (
    <section className="section" aria-labelledby="ov-trend-t">
      <div className="section__head">
        <h2 className="section__title" id="ov-trend-t">
          Traffic, error และ latency
        </h2>
        <span className="section__meta">
          <ServiceChip service={selected.service} role={selected.role} order={order} /> · step {stepSeconds === 60 ? '1 นาที' : word}
        </span>
        <div className="section__actions">
          <ServiceSelect options={options} value={current} />
        </div>
      </div>
      {points.length ? (
        <BucketLinks className="panel ov-charts">
          <div className="panel__body">
            <ChartFrame title={`${noun} ${per}`} titleId="ov-c-req-t" sub={`รวม ${fmtCount(selected.requests)} · เฉลี่ย ${fmtRate(selected.rpm)} ต่อนาที`} bare>
              <TimeLine
                labelledBy="ov-c-req-t"
                stepSeconds={stepSeconds}
                buckets={times}
                series={[{ key: 'req', label: vol.word, className: cls || undefined, color: cls ? undefined : 'var(--muted)', values: points.map((p) => p.requests), area: true }]}
                events={events}
                bands={bands}
                bucketTips={tips}
                bucketHrefs={hrefs}
              />
            </ChartFrame>
            <ChartFrame
              title={http ? `5xx error ${per}` : `attempt ที่ไม่สำเร็จ ${per}`}
              titleId="ov-c-err-t"
              sub={
                totalErrors
                  ? [`รวม ${fmtCount(totalErrors)} ครั้ง (${fmtPct(selected.errorRate)})${split}`, ...errRoutes.map((r) => `${r.route} ${fmtCount(r.errors)}`), spike].join(' · ')
                  : `ไม่มี${http ? ' 5xx' : ' attempt ที่ไม่สำเร็จ'}ในช่วงนี้`
              }
              bare
            >
              <TimeBars
                labelledBy="ov-c-err-t"
                stepSeconds={stepSeconds}
                buckets={points.map((p) => ({ t: p.t, values: [p.errors] }))}
                series={[{ key: 'err', label: errName, color: 'var(--bar-neutral)', tipKey: 'bar-neutral' }]}
                events={events.map((e) => ({ at: e.at }))}
                bands={bands}
                bucketTips={tips}
                bucketHrefs={hrefs}
              />
            </ChartFrame>
            <ChartFrame title={`p95 ${per} (${p95Unit})`} titleId="ov-c-p95-t" sub={`${wholeRange(scope)} ${fmtDuration(selected.p95Ms)}`} bare>
              <TimeLine
                labelledBy="ov-c-p95-t"
                stepSeconds={stepSeconds}
                buckets={times}
                frame={{ height: 118 }}
                formatValue={(v) => (p95InSec ? `${v.toFixed(1)} s` : fmtDuration(v))}
                series={[{ key: 'p95', label: `p95 (${p95Unit})`, className: cls || undefined, color: cls ? undefined : 'var(--muted)', values: p95Values }]}
                events={events.map((e) => ({ at: e.at }))}
                bands={bands}
                bucketTips={tips}
                bucketHrefs={hrefs}
              />
            </ChartFrame>
          </div>
          <div className="panel__foot chart__foot">
            <span>{[...marks, `ชี้หรือแตะกราฟเพื่อดูค่าทั้งสามของ${that} · กดเพื่อเปิด Log ช่วงนั้น`].join(' · ')}</span>
            <ChartTable
              data={{
                caption: `ค่า${per}ของ ${current}, ${range}`,
                columns: [word === 'นาที' ? 'นาที' : 'เวลา', noun, errName, 'p95'],
                rows: [...points]
                  .map((p, i) => [timeText(times[i]), fmtCount(p.requests), fmtCount(p.errors), fmtDuration(p.p95Ms)])
                  .reverse(),
                // keyboard path to Log of a bucket (the chart's bucket links are mouse / touch only); rows are reversed
                rowHrefs: [...hrefs].reverse(),
                rowLinkLabel: (i) => `เปิด Log ${timeText(times[times.length - 1 - i])}`,
              }}
            />
          </div>
        </BucketLinks>
      ) : (
        <div className="panel">
          <EmptyState title={`ยังไม่มีข้อมูลของ ${current} ในช่วงนี้`} text="ลองขยายช่วงเวลา หรือเลือก service อื่นจากตารางสุขภาพ service" />
        </div>
      )}
    </section>
  )
}
