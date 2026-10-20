/**
 * Row sparkline of the error list (errors.html `.eg-trend`): one 4 px bar per spark bucket (6 px slot), deploy
 * lines of the row's service, a hover column per bucket (`.c-hit[data-tip]`), and the column-head axis.
 * Bars carry the motion markup (`data-mo-ready`, baseline transform-origin, --mo-x) like components/charts.
 */
import type { CSSProperties } from 'react'
import { tipAttrs } from '@/lib/chart'
import { fmtCount, fmtTime } from '@/lib/format'

export const SLOT = 6
const H = 28
const BASE = 27

export interface SparkBucket {
  label: string
  total: number
  /** Extra tooltip lines (ERR / WRN split). */
  lines?: Array<{ value: number; name: string }>
}

export function EgSpark({ buckets, deployXs, label, maxLabel }: { buckets: SparkBucket[]; deployXs: number[]; label: string; maxLabel: string }) {
  const width = Math.max(SLOT, buckets.length * SLOT)
  const max = Math.max(1, ...buckets.map((b) => b.total))
  return (
    <div className="eg-trend spark-inline">
      <svg className="eg-spark" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={label} data-mo-ready="">
        <line className="c-axis" x1="0" x2={width} y1={BASE + 0.5} y2={BASE + 0.5} />
        {buckets.map((b, i) => {
          if (b.total <= 0) return null
          const h = Math.max(1.5, (b.total / max) * (BASE - 2))
          const style = { transformOrigin: `0 ${BASE}px`, '--mo-x': ((i * SLOT + 1) / width).toFixed(3) } as CSSProperties
          return <rect key={i} className="c-bar" x={i * SLOT + 1} y={Math.round((BASE - h) * 10) / 10} width="4" height={Math.round(h * 10) / 10} style={style} />
        })}
        {deployXs.map((x) => (
          <line key={x} className="c-event" x1={x} x2={x} y1="0" y2={H} />
        ))}
        {buckets.map((b, i) => (
          <rect
            key={`h${i}`}
            className="c-hit"
            x={i * SLOT}
            y="0"
            width={SLOT}
            height={H}
            {...tipAttrs(b.label, [{ value: fmtCount(b.total), name: 'ครั้ง' }, ...(b.lines ?? []).map((l) => ({ value: fmtCount(l.value), name: l.name }))])}
          />
        ))}
      </svg>
      <span className="spark-inline__max">{maxLabel}</span>
    </div>
  )
}

/** Rough width of an 11 px axis label: digits / Latin ≈ 6.6 px, Thai ≈ 6 px, Thai vowel and tone marks 0. */
function textW(s: string): number {
  let w = 0
  for (const c of s) w += /[ัิ-ฺ็-๎]/.test(c) ? 0 : /[฀-๿]/.test(c) ? 6 : 6.6
  return w
}

/**
 * Column-head axis: range start, the deploy line + time, `ตอนนี้` / the range end. A custom range across
 * midnight passes `startSub` / `endSub` (the dates, second line). The deploy line is drawn whenever it is in
 * range; its time goes left of the line, else right of it; when the line runs under the end label, that label
 * gets a halo so both stay readable.
 */
export function EgAxis({
  width,
  start,
  end,
  startSub,
  endSub,
  deploy,
}: {
  width: number
  start: string
  end: string
  startSub?: string
  endSub?: string
  deploy?: { x: number; at: string }
}) {
  const two = !!(startSub || endSub)
  const h = two ? 26 : 14
  const sw = Math.max(textW(start), startSub ? textW(startSub) : 0)
  const ew = Math.max(textW(end), endSub ? textW(endSub) : 0)
  const label = deploy ? fmtTime(deploy.at) : ''
  const dw = textW(label)
  const x = deploy?.x ?? -1
  const showLine = !!deploy && x >= 1 && x <= width - 1
  const underEnd = showLine && x >= width - ew - 3
  // the deploy time sits left of its line, else right of it; it never touches the start or end label. A line under the
  // end label keeps its time just left of that label (the end label and its date get a halo over the line).
  const leftEdge = Math.min(x - 3, width - ew - 6)
  const labelAt = !showLine ? null : leftEdge - dw >= sw + 4 ? { x: leftEdge, end: true } : x + 3 + dw <= width - ew - 6 ? { x: x + 3, end: false } : null
  return (
    <svg className={two ? 'eg-axis eg-axis--2' : 'eg-axis'} viewBox={`0 0 ${width} ${h}`} style={{ width }} aria-hidden="true">
      <text className="c-tick" x="0" y="11">
        {start}
      </text>
      {startSub ? (
        <text className="c-tick" x="0" y="24">
          {startSub}
        </text>
      ) : null}
      {showLine ? <line className="c-event" x1={x} x2={x} y1="2" y2={h} /> : null}
      {labelAt ? (
        <text className={labelAt.end ? 'c-tick c-tick--end' : 'c-tick'} x={labelAt.x} y="11">
          {label}
        </text>
      ) : null}
      <text className={underEnd ? 'c-tick c-tick--end c-halo' : 'c-tick c-tick--end'} x={width} y="11">
        {end}
      </text>
      {endSub ? (
        <text className={underEnd ? 'c-tick c-tick--end c-halo' : 'c-tick c-tick--end'} x={width} y="24">
          {endSub}
        </text>
      ) : null}
    </svg>
  )
}
