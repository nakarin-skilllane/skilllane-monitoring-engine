/**
 * "Log ต่อนาทีตาม level": two stacked small multiples that share the time axis (DESIGN.md §7: one y axis per
 * chart; INF outnumbers ERR ~450×, so WRN · ERR · FTL get their own plot above DBG · INF). Drawn at the
 * 1440 px width (viewBox 1140), bars carry their baseline + --mo-x for the entrance (svg[data-mo-ready]).
 * Outages from dependency.* lines are a tinted band + event line. Click / drag: HistBrush.
 * A bucket not fully inside [from, to] (the first starts at `from` rounded down to the minute, the last of a live range
 * is the minute still filling) counts fewer lines by construction: drawn lighter, with "ช่วงไม่เต็ม" in its tooltip and
 * table row, so it never reads as a drop in traffic.
 */
import { type CSSProperties, Fragment, type ReactNode } from 'react'
import { ChartTable, Legend } from '@/components/charts/ChartFrame'
import { barPath, niceScale, r1, rectPath, tickInterval, tickLabel, timeTicks, timeTickText, tipAttrs } from '@/lib/chart'
import { fmtCount, fmtDate, fmtDateTime, fmtTime, fmtTimeSec, sameDay } from '@/lib/format'
import type { LogsHistogramBucket } from '@/lib/types'
import type { Outage } from '../_lib/lines'
import { HistBrush } from './HistBrush'

const W = 1140
const LEFT = 44
const RIGHT = 16
const H = 268
/** Upper plot (WRN · ERR · FTL) and lower plot (DBG · INF): top and baseline in viewBox units. */
const UP = { top: 28, base: 140 }
const LOW = { top: 178, base: 242 }
const PW = W - LEFT - RIGHT

type Key = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
const UPPER: Array<{ key: Key; cls: string }> = [
  { key: 'warn', cls: 'c-lvl-wrn' },
  { key: 'error', cls: 'c-lvl-err' },
  { key: 'fatal', cls: 'c-lvl-ftl' },
]
const LOWER: Array<{ key: Key; cls: string }> = [
  { key: 'debug', cls: 'c-lvl-dbg' },
  { key: 'info', cls: 'c-lvl-inf' },
]

/** `36 วินาที`, `4 นาที 10 วินาที`, `2 ชั่วโมง`: the counted part of a partial bucket. */
function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} วินาที`
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} นาที ${s % 60} วินาที` : `${s / 60} นาที`
  const m = Math.round(s / 60)
  return m % 60 ? `${Math.floor(m / 60)} ชั่วโมง ${m % 60} นาที` : `${m / 60} ชั่วโมง`
}

/** `1 นาที`, `5 นาที`, `1 ชั่วโมง`, `6 ชั่วโมง`, `1 วัน`. */
export function stepLabel(stepSeconds: number): string {
  if (stepSeconds % 86_400 === 0) return `${stepSeconds / 86_400} วัน`
  if (stepSeconds % 3600 === 0) return `${stepSeconds / 3600} ชั่วโมง`
  return `${Math.round(stepSeconds / 60)} นาที`
}

/** `ต่อนาที`, `ต่อ 5 นาที`, `ต่อชั่วโมง`, `ต่อวัน`. */
export function perStep(stepSeconds: number): string {
  const label = stepLabel(stepSeconds)
  return label.startsWith('1 ') ? `ต่อ${label.slice(2)}` : `ต่อ ${label}`
}

/** The part of bucket [start, start + step) inside [fromMs, toMs], when it is not all of it (1 s slack); else null. */
function partOf(start: number, stepMs: number, fromMs: number, toMs: number): { from: number; to: number } | null {
  const from = Math.max(start, fromMs)
  const to = Math.min(start + stepMs, toMs)
  return from > start + 1000 || to < start + stepMs - 1000 ? { from, to } : null
}

function Panel({
  buckets,
  partial,
  levels,
  frame,
  ticks,
  slot,
  bar,
}: {
  buckets: LogsHistogramBucket[]
  /** Per bucket: not fully inside the range (drawn lighter). */
  partial: boolean[]
  levels: typeof UPPER
  frame: typeof UP
  ticks: { max: number; ticks: number[] }
  slot: number
  bar: number
}) {
  const h = frame.base - frame.top
  return (
    <>
      {ticks.ticks.map((v, i) => {
        const y = r1(frame.base - (v / ticks.max) * h)
        return (
          <g key={v}>
            <line className={i === 0 ? 'c-axis' : 'c-grid'} x1={LEFT} x2={W - RIGHT} y1={y} y2={y} />
            <text className="c-tick c-tick--end" x={LEFT - 8} y={y + 4}>
              {tickLabel(v)}
            </text>
          </g>
        )
      })}
      {buckets.map((b, i) => {
        const x = LEFT + i * slot + (slot - bar) / 2
        const parts = levels.map((l) => ({ v: b[l.key] || 0, cls: l.cls })).filter((p) => p.v > 0)
        let top = frame.base
        const style = { transformOrigin: `0 ${frame.base}px`, '--mo-x': Math.max(0, Math.min(1, x / W)).toFixed(3) } as CSSProperties
        return parts.map((p, j) => {
          const gap = j > 0 ? 2 : 0
          const hh = Math.max(1, (p.v / ticks.max) * h - gap)
          const y = top - gap - hh
          top = y
          const d = j === parts.length - 1 ? barPath(x, y, bar, hh) : rectPath(x, y, bar, hh)
          return <path key={`${i}-${p.cls}`} className={`c-bar ${p.cls}${partial[i] ? ' lg-bar--partial' : ''}`} style={style} d={d} />
        })
      })}
    </>
  )
}

export function LogHistogram({
  buckets,
  stepSeconds,
  fromMs,
  toMs,
  outages,
  sub,
  notes,
  subject,
}: {
  buckets: LogsHistogramBucket[]
  stepSeconds: number
  /** Start of the range (the first bucket starts at it rounded down to the minute). */
  fromMs: number
  /** End of the range (the last bucket ends there). */
  toMs: number
  outages: Outage[]
  sub: ReactNode
  /** Foot parts after the scale note (ERR breakdown, band legend, how to zoom). */
  notes: ReactNode[]
  /** `ของ school-core-api ใน prod 13:20–14:20 ICT` for the svg <desc>. */
  subject: string
}) {
  const n = Math.max(1, buckets.length)
  const stepMs = stepSeconds * 1000
  const t0 = buckets.length ? Date.parse(buckets[0].t) : toMs - stepMs
  const span = n * stepMs
  const slot = PW / n
  const bar = slot >= 12 ? Math.min(24, slot - 4) : Math.max(1, slot - 2)
  const x = (ms: number) => LEFT + Math.max(0, Math.min(1, (ms - t0) / span)) * PW
  const up = niceScale(Math.max(0, ...buckets.map((b) => b.warn + b.error + b.fatal)), 3)
  const low = niceScale(Math.max(0, ...buckets.map((b) => b.debug + b.info)), 2)
  const interval = tickInterval(Math.max(stepMs, span - stepMs))
  const per = perStep(stepSeconds)
  const sum = (k: Key) => buckets.reduce((a, b) => a + (b[k] || 0), 0)
  const parts = buckets.map((b) => partOf(Date.parse(b.t), stepMs, fromMs, toMs))
  const partial = parts.map((p) => p !== null)
  /** `นับ 12:34:24–12:35:00 (36 วินาที จาก 1 นาที)` */
  const partText = (p: { from: number; to: number }) => `นับ ${fmtTimeSec(p.from)}–${fmtTimeSec(p.to)} (${fmtSpan(p.to - p.from)} จาก ${stepLabel(stepSeconds)})`
  const desc =
    `จำนวนบรรทัด log ${per}${subject} แยกตาม level. กราฟบน WRN ERR FTL สเกล 0 ถึง ${fmtCount(up.max)}, กราฟล่าง DBG INF สเกล 0 ถึง ${fmtCount(low.max)}. ` +
    `FTL ${fmtCount(sum('fatal'))} ERR ${fmtCount(sum('error'))} WRN ${fmtCount(sum('warn'))} INF ${fmtCount(sum('info'))} DBG ${fmtCount(sum('debug'))} บรรทัด.` +
    outages.map((o) => ` ${o.label} ${fmtTimeSec(o.from)} ถึง ${o.to === null ? 'ตอนนี้' : fmtTimeSec(o.to)}.`).join('')
  const foot = [
    `สองกราฟแกนแยกกัน: บน WRN ขึ้นไป (0–${tickLabel(up.max)}), ล่าง DBG และ INF (0–${tickLabel(low.max)})`,
    ...(partial.some(Boolean) ? ['แท่งจาง = ช่วงไม่เต็ม (ต้นหรือท้ายช่วงที่เลือก นับไม่ครบ step) ไม่ใช่ log ลดลง'] : []),
    ...notes,
  ]
  const fmtBucket = stepMs >= 86_400_000 ? fmtDate : fmtDateTime
  // the date on every row once the range crosses midnight (ICT), so 18:59 of two days never look alike
  const rowTime = stepMs >= 86_400_000 ? fmtDate : stepMs >= 3600_000 || !sameDay(t0, toMs) ? fmtDateTime : fmtTime
  const tipKeys = [
    { key: 'fatal' as const, name: 'FTL', tok: 'ink' },
    { key: 'error' as const, name: 'ERR', tok: 'danger-solid' },
    { key: 'warn' as const, name: 'WRN', tok: 'warn-solid' },
    { key: 'info' as const, name: 'INF', tok: 'info-solid' },
    { key: 'debug' as const, name: 'DBG', tok: 'debug-solid' },
  ]
  return (
    <figure className="chart lg-hist" aria-labelledby="lg-hist-title">
      <div className="chart__head">
        <h2 className="chart__title" id="lg-hist-title">
          Log {per}ตาม level
        </h2>
        <span className="chart__sub">{sub}</span>
        <Legend
          items={[
            { label: 'DBG', color: 'var(--debug-solid)' },
            { label: 'INF', color: 'var(--info-solid)' },
            { label: 'WRN', color: 'var(--warn-solid)' },
            { label: 'ERR', color: 'var(--danger-solid)' },
            { label: 'FTL', color: 'var(--ink)' },
          ]}
        />
      </div>
      <HistBrush>
        <svg data-mo-ready="" viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="lg-hist-title lg-hist-desc" style={{ '--chart-min': '1030px' } as CSSProperties}>
          <desc id="lg-hist-desc">{desc}</desc>
          <text className="c-axis-title" x="0" y="12">
            WRN · ERR · FTL {per}
          </text>
          <text className="c-axis-title" x="0" y="168">
            DBG · INF {per}
          </text>
          <Panel buckets={buckets} partial={partial} levels={UPPER} frame={UP} ticks={up} slot={slot} bar={bar} />
          <Panel buckets={buckets} partial={partial} levels={LOWER} frame={LOW} ticks={low} slot={slot} bar={bar} />
          {timeTicks(t0, t0 + span, interval).map((t) => (
            <text key={t} className="c-tick c-tick--mid" x={r1(x(t))} y={H - 6}>
              {timeTickText(t, interval)}
            </text>
          ))}
          {outages.map((o, i) => {
            const x1 = x(o.from)
            const x2 = Math.max(x1 + 2, x(o.to ?? toMs))
            const right = x1 > W - 220
            return (
              <g key={`o${i}`}>
                <rect className="c-band" x={r1(x1)} y={UP.top} width={r1(x2 - x1)} height={UP.base - UP.top} />
                <rect className="c-band" x={r1(x1)} y={LOW.top} width={r1(x2 - x1)} height={LOW.base - LOW.top} />
                <line className="c-event" x1={r1(x1)} x2={r1(x1)} y1={18} y2={LOW.base} />
                <text className="c-event-label c-halo" x={r1(right ? x1 - 6 : x1 + 6)} y={26} style={right ? { textAnchor: 'end' } : undefined}>
                  {o.label}
                </text>
              </g>
            )
          })}
          <g>
            {buckets.map((b, i) => {
              const start = Date.parse(b.t)
              const end = i === buckets.length - 1 ? Math.max(toMs, start + 1000) : start + stepMs
              return (
                <rect
                  key={b.t}
                  className="c-hit"
                  x={r1(LEFT + i * slot)}
                  y={UP.top}
                  width={r1(slot)}
                  height={LOW.base - UP.top}
                  data-t0={new Date(start).toISOString()}
                  data-t1={new Date(Math.min(end, start + stepMs)).toISOString()}
                  {...tipAttrs(fmtBucket(start), [
                    ...tipKeys.map((k) => ({ value: fmtCount(b[k.key]), name: k.name, key: k.tok })),
                    ...(parts[i] ? [{ value: 'ช่วงไม่เต็ม', name: partText(parts[i]) }] : []),
                  ])}
                />
              )
            })}
          </g>
        </svg>
      </HistBrush>
      <div className="chart__foot">
        <span>
          {foot.map((part, i) => (
            <Fragment key={i}>
              {i ? ' · ' : null}
              {part}
            </Fragment>
          ))}
        </span>
        <ChartTable
          data={{
            caption: `จำนวนบรรทัด log ${per} แยกตาม level ใหม่สุดก่อน`,
            columns: [stepSeconds === 60 ? 'นาที' : 'เวลา', 'FTL', 'ERR', 'WRN', 'INF', 'DBG', 'รวม'],
            rows: [...buckets].map((b, i) => [
              parts[i] ? `${rowTime(b.t)} (ช่วงไม่เต็ม: ${partText(parts[i])})` : rowTime(b.t),
              fmtCount(b.fatal),
              fmtCount(b.error),
              fmtCount(b.warn),
              fmtCount(b.info),
              fmtCount(b.debug),
              fmtCount(b.debug + b.info + b.warn + b.error + b.fatal),
            ]).reverse(),
          }}
        />
      </div>
    </figure>
  )
}
