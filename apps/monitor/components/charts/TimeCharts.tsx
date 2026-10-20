/**
 * Time-axis SVG charts (DESIGN.md §7), drawn at the 1440 px render width (viewBox 740 wide)
 * with `--chart-min` ≈ 90 % so ticks never render under 10 px; put them in a <ChartFrame timeAxis>.
 * One y axis; solid hairline grid; round ticks (0 · 500 · 1K); x ticks every 10 min for 1 h,
 * every 4 h for 24 h; a hover column per bucket (`.c-hit[data-tip]`, tooltip by TooltipHost).
 *
 *   <TimeBars labelledBy="ov-c-err-t" stepSeconds={60} buckets={series.map(s => ({ t: s.t, values: [s.errors] }))}
 *     series={[{ key: 'errors', label: '5xx', color: 'var(--danger-solid)', tipKey: 'danger-solid' }]} />
 *   Stacked (bottom-up): series = DBG, INF, WRN, ERR, FTL with className 'c-lvl-dbg' … and values per bucket.
 *   <TimeLine labelledBy="…" stepSeconds={60} buckets={series.map(s => s.t)}
 *     series={[{ key: 'req', label: 'request', className: 'svc-1', values: series.map(s => s.requests), area: true }]} />
 * Events (deploy, outage) = 1 px line + label; bands = a tinted time window.
 * `bucketTips` replaces the tooltip of each hover column (several measures of one bucket in one tooltip);
 * `bucketHrefs` puts a link on each column (`data-href`): wrap the charts in <BucketLinks> to follow it on click.
 * Motion (DESIGN.md §7b) is in the markup (`svg[data-mo-ready]`): each bar carries its baseline as
 * transform-origin and --mo-x (0–1 across the plot), lines pathLength=1 + .mo-draw, the end dot .mo-now with
 * a .mo-ring under it. Inside a ChartFrame (`figure.chart`, a reveal target) they play when it scrolls into view.
 */
import type { CSSProperties } from 'react'
import {
  DEFAULT_FRAME,
  type Frame,
  areaPath,
  barPath,
  baseline,
  linePath,
  niceScale,
  plotWidth,
  r1,
  rectPath,
  slots,
  tickInterval,
  tickLabel,
  timeTicks,
  timeTickText,
  tipAttrs,
} from '@/lib/chart'
import { fmtCount, fmtDate, fmtDateTime, toMs } from '@/lib/format'

export interface ChartSeries {
  key: string
  /** Tooltip / legend name. */
  label: string
  /** A class that sets --c (`svc-1`, `c-lvl-err`). */
  className?: string
  /** Or a CSS colour for --c. */
  color?: string
  /** Token name for the tooltip key (`svc-1`, `danger-solid`); default from className. */
  tipKey?: string
}

export interface TimeEvent {
  at: string | number
  label?: string
}

interface Common {
  stepSeconds: number
  /** id of the chart title (aria-labelledby), or `label` as aria-label. */
  labelledBy?: string
  label?: string
  frame?: Partial<Frame>
  /** Tooltip / end-label number format (default thousands separators). */
  formatValue?: (v: number) => string
  /** Tooltip title of a bucket (default `17 ต.ค. 13:20`). */
  formatTime?: (ms: number) => string
  events?: TimeEvent[]
  bands?: Array<{ from: string | number; to: string | number }>
  /** About how many y steps (default 3). */
  yTicks?: number
  className?: string
  /** Tooltip of each bucket instead of the chart's own values (same length as the buckets). */
  bucketTips?: BucketTip[]
  /** Link of each bucket (`data-href` on its hover column; followed by <BucketLinks>). */
  bucketHrefs?: Array<string | undefined>
}

export interface BucketTip {
  title: string
  lines: Array<{ value: string; name?: string; key?: string }>
}

const LEVEL_TOKEN: Record<string, string> = { dbg: 'debug-solid', inf: 'info-solid', wrn: 'warn-solid', err: 'danger-solid', ftl: 'ink' }

/** Token for the tooltip line key: explicit tipKey, svc-N, or the level's solid colour. */
function tipKeyOf(s: ChartSeries): string | undefined {
  if (s.tipKey) return s.tipKey
  const cls = s.className ?? ''
  if (/^svc-\d$/.test(cls)) return cls
  if (cls.startsWith('c-lvl-')) return LEVEL_TOKEN[cls.slice(6)]
  return undefined
}

const seriesStyle = (s: ChartSeries): CSSProperties | undefined => (s.color ? ({ '--c': s.color } as CSSProperties) : undefined)

function Axes({ f, max, ticks, t0, stepMs, n }: { f: Frame; max: number; ticks: number[]; t0: number; stepMs: number; n: number }) {
  const base = baseline(f)
  const h = base - f.top
  const right = f.width - f.right
  const end = t0 + stepMs * n
  // n buckets span (n - 1) steps of start times: 61 one-minute buckets are a 1 h chart (10 min ticks)
  const interval = tickInterval(Math.max(stepMs, stepMs * (n - 1)))
  const pw = plotWidth(f)
  return (
    <>
      {ticks.map((v, i) => {
        const y = r1(base - (v / max) * h)
        return (
          <g key={v}>
            <line className={i === 0 ? 'c-axis' : 'c-grid'} x1={f.left} x2={right} y1={y} y2={y} />
            <text className="c-tick c-tick--end" x={f.left - 8} y={y + 4}>
              {tickLabel(v)}
            </text>
          </g>
        )
      })}
      {timeTicks(t0, end - stepMs, interval).map((t) => (
        <text key={t} className="c-tick c-tick--mid" x={r1(f.left + ((t - t0 + stepMs / 2) / (stepMs * n)) * pw)} y={f.height - 8}>
          {timeTickText(t, interval)}
        </text>
      ))}
    </>
  )
}

function Marks({ f, t0, stepMs, n, events, bands }: { f: Frame; t0: number; stepMs: number; n: number; events?: TimeEvent[]; bands?: Common['bands'] }) {
  const base = baseline(f)
  const pw = plotWidth(f)
  const x = (ms: number) => f.left + Math.max(0, Math.min(1, (ms - t0) / (stepMs * n))) * pw
  return (
    <>
      {bands?.map((b, i) => {
        const x1 = x(toMs(b.from))
        const x2 = Math.max(x1 + 2, x(toMs(b.to)))
        return <rect key={`b${i}`} className="c-band" x={r1(x1)} y={f.top} width={r1(x2 - x1)} height={base - f.top} />
      })}
      {events?.map((e, i) => {
        const ex = r1(x(toMs(e.at)))
        return (
          <g key={`e${i}`}>
            <line className="c-event" x1={ex} x2={ex} y1={f.top} y2={base} />
            {e.label ? (
              <text className="c-event-label c-halo" x={ex + 7} y={f.top + 10}>
                {e.label}
              </text>
            ) : null}
          </g>
        )
      })}
    </>
  )
}

function Hits({
  f,
  times,
  stepMs,
  lines,
  formatTime,
  tips,
  hrefs,
}: {
  f: Frame
  times: number[]
  stepMs: number
  lines: (i: number) => Array<{ value: string; name?: string; key?: string }>
  formatTime?: (ms: number) => string
  tips?: BucketTip[]
  hrefs?: Array<string | undefined>
}) {
  const base = baseline(f)
  const s = slots(f, times.length)
  const fmt = formatTime ?? (stepMs >= 86_400_000 ? fmtDate : fmtDateTime)
  return (
    <g>
      {times.map((t, i) => {
        const tip = tips?.[i]
        return (
          <rect
            key={t}
            className="c-hit"
            x={r1(s.x(i))}
            y={f.top}
            width={r1(s.width)}
            height={base - f.top}
            data-href={hrefs?.[i]}
            {...(tip ? tipAttrs(tip.title, tip.lines) : tipAttrs(fmt(t), lines(i)))}
          />
        )
      })}
    </g>
  )
}

/** Bar entrance: grows from its baseline (transform-origin in viewBox units), staggered left to right. */
function barMotion(f: Frame, x: number, base: number): CSSProperties {
  return { transformOrigin: `0 ${r1(base)}px`, '--mo-x': Math.max(0, Math.min(1, x / f.width)).toFixed(3) } as CSSProperties
}

function svgProps(f: Frame, labelledBy?: string, label?: string, className?: string) {
  return {
    'data-mo-ready': '',
    viewBox: `0 0 ${f.width} ${f.height}`,
    role: 'img' as const,
    'aria-labelledby': labelledBy,
    'aria-label': labelledBy ? undefined : label,
    className,
    style: { '--chart-min': `${Math.round(f.width * 0.9)}px` } as CSSProperties,
  }
}

/** Bars per time bucket; several series stack bottom-up with a 2 px surface gap; top corners rounded. */
export function TimeBars({
  buckets,
  series,
  stepSeconds,
  labelledBy,
  label,
  frame,
  formatValue = fmtCount,
  formatTime,
  events,
  bands,
  yTicks = 3,
  className,
  bucketTips,
  bucketHrefs,
}: Common & { buckets: Array<{ t: string | number; values: number[] }>; series: ChartSeries[] }) {
  const f: Frame = { ...DEFAULT_FRAME, height: 110, ...frame }
  const n = buckets.length
  const times = buckets.map((b) => toMs(b.t))
  const stepMs = stepSeconds * 1000
  const t0 = times[0] ?? Date.now()
  const totals = buckets.map((b) => b.values.reduce((a, v) => a + (v || 0), 0))
  // counts (every value whole) get whole ticks: 0 · 1 · 2, never 0 · 0.5 · 1
  const scale = niceScale(Math.max(0, ...totals), yTicks, { integer: totals.every(Number.isInteger) })
  const base = baseline(f)
  const h = base - f.top
  const s = slots(f, n)
  return (
    <svg {...svgProps(f, labelledBy, label, className)}>
      <Axes f={f} max={scale.max} ticks={scale.ticks} t0={t0} stepMs={stepMs} n={n} />
      <Marks f={f} t0={t0} stepMs={stepMs} n={n} events={events} bands={bands} />
      {buckets.map((b, i) => {
        let top = base
        const parts = b.values.map((v, k) => ({ v: v || 0, k })).filter((p) => p.v > 0)
        return parts.map((p, j) => {
          const full = (p.v / scale.max) * h
          const gap = j > 0 ? 2 : 0
          const hh = Math.max(1, full - gap)
          const y = top - gap - hh
          top = y
          const sr = series[p.k]
          const d = j === parts.length - 1 ? barPath(s.barX(i), y, s.bar, hh) : rectPath(s.barX(i), y, s.bar, hh)
          return <path key={`${i}-${p.k}`} className={sr?.className ? `c-bar ${sr.className}` : 'c-bar'} style={{ ...(sr ? seriesStyle(sr) : null), ...barMotion(f, s.barX(i), base) }} d={d} />
        })
      })}
      <Hits
        f={f}
        times={times}
        stepMs={stepMs}
        lines={(i) =>
          series
            .map((sr, k) => ({ value: formatValue(buckets[i].values[k] || 0), name: sr.label, key: tipKeyOf(sr) }))
            .reverse()
        }
        formatTime={formatTime}
        tips={bucketTips}
        hrefs={bucketHrefs}
      />
    </svg>
  )
}

/** Lines over time (first series with a 10 % area when `area`), end dot + direct label of the newest value. */
export function TimeLine({
  buckets,
  series,
  stepSeconds,
  labelledBy,
  label,
  frame,
  formatValue = fmtCount,
  events,
  bands,
  yTicks = 3,
  endLabel = true,
  formatTime,
  className,
  bucketTips,
  bucketHrefs,
}: Common & {
  /** Bucket starts, oldest first. */
  buckets: Array<string | number>
  series: Array<ChartSeries & { values: number[]; area?: boolean }>
  /** Label the newest value of the first series (default true). */
  endLabel?: boolean
}) {
  const f: Frame = { ...DEFAULT_FRAME, ...frame }
  const n = buckets.length
  const times = buckets.map(toMs)
  const stepMs = stepSeconds * 1000
  const t0 = times[0] ?? Date.now()
  const all = series.flatMap((sr) => sr.values)
  const scale = niceScale(Math.max(0, ...all), yTicks, { integer: all.every((v) => Number.isInteger(v || 0)) })
  const base = baseline(f)
  const h = base - f.top
  const s = slots(f, n)
  const pts = (values: number[]) => values.map((v, i) => [s.center(i), base - ((v || 0) / scale.max) * h] as [number, number])
  return (
    <svg {...svgProps(f, labelledBy, label, className)}>
      <Axes f={f} max={scale.max} ticks={scale.ticks} t0={t0} stepMs={stepMs} n={n} />
      <Marks f={f} t0={t0} stepMs={stepMs} n={n} events={events} bands={bands} />
      {series.map((sr) => {
        const p = pts(sr.values)
        const cls = sr.className ? ` ${sr.className}` : ''
        return (
          <g key={sr.key}>
            {sr.area ? <path className={`c-area${cls}`} style={seriesStyle(sr)} d={areaPath(p, base)} /> : null}
            <path className={`c-line mo-draw${cls}`} style={seriesStyle(sr)} d={linePath(p)} pathLength={1} />
          </g>
        )
      })}
      {series[0] && n ? (
        <>
          {/* the newest value: the ring breathes three times after the line has drawn, then rests */}
          <circle className={`mo-ring${series[0].className ? ` ${series[0].className}` : ''}`} style={seriesStyle(series[0])} cx={r1(s.center(n - 1))} cy={r1(pts(series[0].values)[n - 1][1])} r="4" aria-hidden="true" />
          <circle className={`c-dot mo-now${series[0].className ? ` ${series[0].className}` : ''}`} style={seriesStyle(series[0])} cx={r1(s.center(n - 1))} cy={r1(pts(series[0].values)[n - 1][1])} r="4" />
          {endLabel ? (
            <text className="c-label c-halo" x={r1(s.center(n - 1) + 9)} y={r1(pts(series[0].values)[n - 1][1] + 4)}>
              {formatValue(series[0].values[n - 1] || 0)}
            </text>
          ) : null}
        </>
      ) : null}
      <Hits
        f={f}
        times={times}
        stepMs={stepMs}
        lines={(i) => series.map((sr) => ({ value: formatValue(sr.values[i] || 0), name: sr.label, key: tipKeyOf(sr) }))}
        formatTime={formatTime}
        tips={bucketTips}
        hrefs={bucketHrefs}
      />
    </svg>
  )
}
