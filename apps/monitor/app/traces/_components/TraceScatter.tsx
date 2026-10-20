/**
 * Duration over time, one point per sampled trace (traces.html, DESIGN.md §7): x = time of the entry
 * span, y = duration on a log axis, colour = ok / ช้า / error, shape = request (circle) or job (square).
 * Marked traces get a ring + letter. Every point has a ≥ 24 px hit target with a tooltip and links to
 * its trace; error and slow points are reachable with Tab. Drawn at the 1440 px width (viewBox 1140).
 */
import type { CSSProperties } from 'react'
import { r1, timeTicks, timeTickText, tickInterval, tipAttrs } from '@/lib/chart'
import { fmtCount, fmtTime } from '@/lib/format'
import { SLOW_MS, type Tone } from '../_lib/model'

export interface ScatterPoint {
  /** Unique per entry span (rowKey). */
  key: string
  href: string
  t: number
  ms: number
  tone: Tone
  http: boolean
  /** Tooltip title: `17 ต.ค. 13:57:34.685`. */
  when: string
  /** `GET /me`, `report:generate`. */
  what: string
  /** `200`, `500 · error`, `ล้มเหลว · ครั้งที่ 1/3`. */
  status: string
  svc: string
  mark?: string
  /** [code, hint] of the trace's error when known. */
  err?: [string, string]
  /** Short time for the aria-label: `13:27:41`. */
  clock: string
  /** Value label: `1,842 ms`. */
  msText: string
}

export interface ScatterBand {
  fromMs: number
  toMs: number
  label: string
}

const W = 1140
const H = 300
const L = 60
const R = 1124
const TOP = 20
const BASE = 268
const STEPS = [1, 2, 5]

/** 1-2-5 value at or below / above `v`. */
function niceLog(v: number, up: boolean): number {
  const e = Math.floor(Math.log10(v))
  const cands = [-1, 0, 1].flatMap((k) => STEPS.map((s) => s * 10 ** (e + k)))
  return up ? Math.min(...cands.filter((c) => c >= v * 0.999)) : Math.max(...cands.filter((c) => c <= v * 1.001))
}

export function scatterDomain(values: number[]): { lo: number; hi: number } {
  const pos = values.filter((v) => v > 0)
  if (!pos.length) return { lo: 5, hi: 20_000 }
  let lo = niceLog(Math.max(0.1, Math.min(...pos)), false)
  const hi = niceLog(Math.max(...pos, lo * 10), true)
  // at least two decades, so a 10 ms request and a 1 s one never look alike
  if (hi / lo < 100) lo = niceLog(hi / 100, false)
  return { lo, hi }
}

const tickText = (v: number) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`)

interface Box {
  x1: number
  x2: number
  y1: number
  y2: number
}
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2
/** Rough text box at the chart's 12 px label size (Latin / digits ≈ 7 px, Thai a little narrower). */
const textBox = (x: number, y: number, text: string, anchor: 'start' | 'end'): Box => {
  const w = text.length * 7 + 4
  return anchor === 'start' ? { x1: x - 2, x2: x + w, y1: y - 12, y2: y + 3 } : { x1: x - w, x2: x + 2, y1: y - 12, y2: y + 3 }
}
const THRESH_TEXT = '2 s · เกณฑ์ช้า (request)'

export function TraceScatter({
  points,
  fromMs,
  toMs,
  bands,
  titleId,
  descId,
  desc,
}: {
  points: ScatterPoint[]
  fromMs: number
  toMs: number
  bands: ScatterBand[]
  titleId: string
  descId: string
  desc: string
}) {
  const { lo, hi } = scatterDomain(points.map((p) => p.ms))
  const llo = Math.log10(lo)
  const lhi = Math.log10(hi)
  const y = (ms: number) => r1(BASE - ((Math.log10(Math.min(hi, Math.max(lo, ms))) - llo) / (lhi - llo)) * (BASE - TOP))
  const span = Math.max(1, toMs - fromMs)
  const x = (t: number) => r1(L + (Math.min(toMs, Math.max(fromMs, t)) - fromMs) / span * (R - L))
  // 1-3-10 grid inside the domain
  const yTicks: number[] = []
  for (let e = Math.floor(llo) - 1; e <= Math.ceil(lhi); e++) for (const m of [1, 3]) {
    const v = m * 10 ** e
    if (v > lo * 1.05 && v < hi * 0.95) yTicks.push(Number(v.toPrecision(3)))
  }
  const interval = tickInterval(span)
  const xTicks = timeTicks(fromMs, toMs, interval)
  const order: Tone[] = ['ok', 'slow', 'bad']
  const drawn = order.flatMap((tone) => points.filter((p) => p.tone === tone))
  const marked = points.filter((p) => p.mark)
  const showThresh = SLOW_MS > lo && SLOW_MS < hi

  // Labels never overprint: the threshold label moves away from the mark rings (left → right end, above → below),
  // then each mark label takes the first free spot (beside the ring above it, other side, below).
  const rings: Box[] = marked.map((p) => ({ x1: x(p.t) - 11, x2: x(p.t) + 11, y1: y(p.ms) - 11, y2: y(p.ms) + 11 }))
  const ty = showThresh ? y(SLOW_MS) : 0
  const threshSpots = [
    { x: L + 6, y: ty - 5, anchor: 'start' as const },
    { x: R - 6, y: ty - 5, anchor: 'end' as const },
    { x: L + 6, y: ty + 14, anchor: 'start' as const },
    { x: R - 6, y: ty + 14, anchor: 'end' as const },
  ]
  const thresh = showThresh ? (threshSpots.find((s) => !rings.some((r) => overlaps(r, textBox(s.x, s.y, THRESH_TEXT, s.anchor)))) ?? null) : null
  const taken: Box[] = [...rings, ...(thresh ? [textBox(thresh.x, thresh.y, THRESH_TEXT, thresh.anchor)] : [])]
  const labels = new Map<string, { x: number; y: number; anchor: 'start' | 'end' }>()
  for (const p of [...marked].sort((a, b) => a.t - b.t)) {
    const cx = x(p.t)
    const cy = y(p.ms)
    const text = `${p.mark} ${p.msText}`
    const left = cx > (L + R) / 2
    const up = cy - TOP < 24 ? cy + 4 : cy - 12
    const down = Math.min(BASE - 4, cy + 22)
    const spots = [
      { x: left ? cx - 14 : cx + 14, y: up, anchor: left ? ('end' as const) : ('start' as const) },
      { x: left ? cx + 14 : cx - 14, y: up, anchor: left ? ('start' as const) : ('end' as const) },
      { x: left ? cx - 14 : cx + 14, y: down, anchor: left ? ('end' as const) : ('start' as const) },
      { x: left ? cx + 14 : cx - 14, y: down, anchor: left ? ('start' as const) : ('end' as const) },
      { x: left ? cx - 14 : cx + 14, y: up - 16, anchor: left ? ('end' as const) : ('start' as const) },
    ]
    const own = rings[marked.indexOf(p)]
    // inside the plot (a label past the right edge is clipped), and clear of every ring and placed label
    const inside = (b: Box) => b.x1 >= L - 4 && b.x2 <= W - 2 && b.y1 >= 0 && b.y2 <= BASE
    const spot =
      spots.find((s) => inside(textBox(s.x, s.y, text, s.anchor)) && !taken.some((b) => b !== own && overlaps(b, textBox(s.x, s.y, text, s.anchor)))) ??
      spots.find((s) => inside(textBox(s.x, s.y, text, s.anchor))) ??
      spots[0]
    taken.push(textBox(spot.x, spot.y, text, spot.anchor))
    labels.set(p.key, spot)
  }

  const dot = (p: ScatterPoint, i: number) => {
    const r = p.tone === 'bad' ? 5 : p.tone === 'slow' ? 4.5 : 4
    const cls = `c-dot tr-${p.tone}`
    const cx = x(p.t)
    const cy = y(p.ms)
    return p.http ? <circle key={i} className={cls} cx={cx} cy={cy} r={r} /> : <rect key={i} className={cls} x={r1(cx - r)} y={r1(cy - r)} width={r * 2} height={r * 2} rx={1} />
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${titleId} ${descId}`} style={{ '--chart-min': '1026px' } as CSSProperties}>
      <desc id={descId}>{desc}</desc>
      <text className="c-axis-title" x="0" y="11">
        เวลาที่ใช้ (log)
      </text>
      {yTicks.map((v) => (
        <g key={v}>
          <line className="c-grid" x1={L} x2={R} y1={y(v)} y2={y(v)} />
          <text className="c-tick c-tick--end" x={L - 8} y={y(v) + 4}>
            {tickText(v)}
          </text>
        </g>
      ))}
      <line className="c-axis" x1={L} x2={R} y1={BASE} y2={BASE} />
      {xTicks.map((t) => {
        const tx = x(t)
        const cls = tx - L < 24 ? 'c-tick' : R - tx < 24 ? 'c-tick c-tick--end' : 'c-tick c-tick--mid'
        return (
          <g key={t}>
            <line className="c-axis" x1={tx} x2={tx} y1={BASE} y2={BASE + 4} />
            <text className={cls} x={tx} y={BASE + 18}>
              {timeTickText(t, interval)}
            </text>
          </g>
        )
      })}
      {bands.map((b, i) => {
        const x1 = x(b.fromMs)
        const x2 = Math.max(x1 + 2, x(b.toMs))
        const right = x1 > R - 220
        return (
          <g key={`b${i}`}>
            <rect className="c-band" x={x1} y={TOP} width={r1(x2 - x1)} height={BASE - TOP} />
            <line className="c-event" x1={x1} x2={x1} y1={TOP} y2={BASE} />
            <text className="c-event-label c-halo" x={right ? x1 - 6 : r1(x2 + 6)} y={TOP + 14} textAnchor={right ? 'end' : undefined}>
              {b.label}
            </text>
          </g>
        )
      })}
      {showThresh ? <line className="tr-thresh" x1={L} x2={R} y1={y(SLOW_MS)} y2={y(SLOW_MS)} /> : null}
      <g aria-hidden="true">
        {drawn.map(dot)}
        {/* the threshold label after the dots: its halo keeps it readable when a point lands on it */}
        {showThresh && thresh ? (
          <text className="c-tick c-halo" x={thresh.x} y={thresh.y} textAnchor={thresh.anchor === 'end' ? 'end' : undefined}>
            {THRESH_TEXT}
          </text>
        ) : null}
        {marked.map((p) => {
          const cx = x(p.t)
          const cy = y(p.ms)
          const at = labels.get(p.key)!
          return (
            <g key={`m${p.key}`}>
              <circle className="tr-ring" cx={cx} cy={cy} r={9} />
              <text className="c-label c-halo" textAnchor={at.anchor} x={r1(at.x)} y={r1(at.y)}>
                {p.mark} <tspan className="tr-label-v">{p.msText}</tspan>
              </text>
            </g>
          )
        })}
      </g>
      <g className="tr-hits">
        {drawn.map((p) => {
          const key = p.tone === 'bad' ? 'danger-solid' : p.tone === 'slow' ? 'warn-solid' : 'bar-neutral'
          const lines = [
            { value: p.msText, name: p.what, key },
            { value: p.status, name: p.svc },
            ...(p.err ? [{ value: p.err[0], name: p.err[1] }] : []),
          ]
          const tip = tipAttrs(`${p.mark ? `Trace ${p.mark} · ` : ''}${p.when}`, lines)
          const focusable = p.tone !== 'ok' || !!p.mark
          return (
            // the tooltip sits on the link, so keyboard focus shows it too (TooltipHost reads the focused [data-tip])
            <a
              key={p.key}
              href={p.href}
              tabIndex={focusable ? undefined : -1}
              aria-label={focusable ? `${p.mark ? `Trace ${p.mark}, ` : ''}${p.clock}, ${p.what}, ${p.status}, ${p.msText}` : undefined}
              {...tip}
            >
              <circle className="c-hit" cx={x(p.t)} cy={y(p.ms)} r={12} />
            </a>
          )
        })}
      </g>
    </svg>
  )
}

/** `100 trace ตัวอย่างระหว่าง 13:20 ถึง 14:20 …` for the chart's <desc>. */
export function scatterDesc(points: ScatterPoint[], fromMs: number, toMs: number): string {
  const { lo, hi } = scatterDomain(points.map((p) => p.ms))
  const bad = points.filter((p) => p.tone === 'bad').length
  const slow = points.filter((p) => p.tone === 'slow').length
  const marks = points.filter((p) => p.mark).map((p) => p.mark)
  return `${fmtCount(points.length)} trace ตัวอย่างระหว่าง ${fmtTime(fromMs)} ถึง ${fmtTime(toMs)} แกนนอนคือเวลา แกนตั้งคือเวลาที่ใช้แบบ log จาก ${tickText(lo)} ถึง ${tickText(hi)} มี error ${bad} จุด request ที่ช้ากว่า 2 วินาที ${slow} จุด${marks.length ? ` ทำเครื่องหมาย ${marks.join(', ')}` : ''}`
}
