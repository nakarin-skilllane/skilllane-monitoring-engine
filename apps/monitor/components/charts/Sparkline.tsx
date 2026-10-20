/**
 * Small charts without axes (DESIGN.md §5 KPI tile, §5b inline sparkline):
 *   <KpiSpark values={…} bad />                 96×28 line + 10 % area + end dot (`svg.kpi__spark`)
 *   <SparkBars values={hourly} label="24 ชั่วโมง" maxLabel="สูงสุด 47/ชม." />   `.spark-inline` bars
 *   <SparkLine values={…} label="request ต่อนาที" />                             `.spark-inline` line (min..max)
 * Drawn to scale of the series' own max; colour --spark unless `color` is given.
 * Motion markup is built in (`svg[data-mo-ready]`, see TimeCharts): `.kpi` and `.spark-inline` are reveal
 * targets, so the line draws / the bars grow when the tile first scrolls into view.
 */
import type { CSSProperties } from 'react'
import { areaPath, barPath, linePath, r1 } from '@/lib/chart'

/** End of a line: the "now" ring (breathes three times) under the dot. */
function NowDot({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <>
      <circle className="mo-ring mo-ring--spark" cx={r1(x)} cy={r1(y)} r={r} aria-hidden="true" />
      <circle className="spark__dot mo-now" cx={r1(x)} cy={r1(y)} r={r} />
    </>
  )
}

/** Points scaled to min..max inside [top, bottom] (a flat series sits in the middle). */
function scaled(values: number[], width: number, top: number, bottom: number): Array<[number, number]> {
  const n = values.length
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min
  return values.map((v, i) => [n > 1 ? (i / (n - 1)) * width : width / 2, span > 0 ? bottom - ((v - min) / span) * (bottom - top) : (top + bottom) / 2])
}

/** The KPI tile sparkline: `viewBox 0 0 96 28`, line + area + dot (r 3) at the newest value. */
export function KpiSpark({ values, bad }: { values: number[]; bad?: boolean }) {
  if (values.length < 2) return null
  const pts = scaled(values, 96, 4, 24)
  const last = pts[pts.length - 1]
  return (
    <svg className={bad ? 'kpi__spark spark--bad' : 'kpi__spark'} viewBox="0 0 96 28" aria-hidden="true" data-mo-ready="">
      <path className="spark__area" d={areaPath(pts, 28)} />
      <path className="spark__line mo-draw" d={linePath(pts)} pathLength={1} />
      <NowDot x={last[0]} y={last[1]} r={3} />
    </svg>
  )
}

/**
 * Inline bars (one per bucket, 4 px + 2 px gap) on a baseline, from zero.
 * `highlight` = index drawn in `highlightColor` (e.g. the last hour in --danger-solid).
 */
export function SparkBars({
  values,
  label,
  maxLabel,
  color = 'var(--spark)',
  highlight,
  highlightColor = 'var(--danger-solid)',
  height = 28,
  barWidth = 4,
  tip,
}: {
  values: number[]
  /** aria-label of the svg (role img). */
  label: string
  /** `.spark-inline__max` under the bars. */
  maxLabel?: string
  color?: string
  highlight?: number
  highlightColor?: string
  height?: number
  barWidth?: number
  /** data-tip of the whole sparkline (see tipAttrs); makes it focusable. */
  tip?: string
}) {
  const step = barWidth + 2
  const width = Math.max(step, values.length * step)
  const max = Math.max(1, ...values)
  const base = height - 1
  return (
    <span className="spark-inline" tabIndex={tip ? 0 : undefined} data-tip={tip}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-mo-ready="">
        <line className="c-axis" x1="0" x2={width} y1={base + 0.5} y2={base + 0.5} />
        {values.map((v, i) => {
          if (v <= 0) return null
          const h = Math.max(1, (v / max) * (base - 2))
          const style = { '--c': i === highlight ? highlightColor : color, transformOrigin: `0 ${base + 0.5}px`, '--mo-x': ((i * step + 1) / width).toFixed(3) } as CSSProperties
          return <path key={i} className="c-bar" d={barPath(i * step + 1, base - h, barWidth, h, 1)} style={style} />
        })}
      </svg>
      {maxLabel ? <span className="spark-inline__max">{maxLabel}</span> : null}
    </span>
  )
}

/** Inline line sparkline (scaled min..max like the KPI spark), with the newest value as a dot. */
export function SparkLine({
  values,
  label,
  width = 96,
  height = 24,
  color,
  tip,
}: {
  values: number[]
  label: string
  width?: number
  height?: number
  color?: string
  /** data-tip of the whole sparkline (see tipAttrs); makes it focusable. */
  tip?: string
}) {
  if (values.length < 2) return null
  const pts = scaled(values, width, 3, height - 3)
  const last = pts[pts.length - 1]
  return (
    <span className="spark-inline" tabIndex={tip ? 0 : undefined} data-tip={tip}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} style={color ? { ['--spark' as string]: color } : undefined} data-mo-ready="">
        <path className="spark__area" d={areaPath(pts, height)} />
        <path className="spark__line mo-draw" d={linePath(pts)} pathLength={1} />
        <NowDot x={last[0]} y={last[1]} r={2.5} />
      </svg>
    </span>
  )
}
