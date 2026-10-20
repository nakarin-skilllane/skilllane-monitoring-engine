/**
 * Geometry for the hand-drawn SVG charts (DESIGN.md §7): nice y ticks, round time ticks,
 * bar / line / area paths. Used by components/charts/*. Pure.
 */
import { fmtCompact, fmtDate, fmtTime } from './format'

/** Plot frame inside the viewBox (the 1440 px render width of a full-width chart is ~740). */
export interface Frame {
  width: number
  height: number
  left: number
  right: number
  top: number
  /** Space under the x axis for tick labels. */
  bottom: number
}

export const DEFAULT_FRAME: Frame = { width: 740, height: 138, left: 44, right: 50, top: 12, bottom: 26 }

export const plotWidth = (f: Frame) => f.width - f.left - f.right
export const baseline = (f: Frame) => f.height - f.bottom

export const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * Round axis maximum and ticks (0 · 500 · 1K · 1.5K): about `count` steps of 1, 2, 2.5 or 5 × 10^k.
 * `integer` (default: when `max` is a whole number, as counts are) keeps every step whole and at least 1:
 * a count axis reads 0 · 5 · 10 or 0 · 1 · 2, never 0 · 2.5 · 5 · 7.5 or 0 · 0.5 · 1 (DESIGN.md §7).
 * Pass `{ integer: false }` for a measure that happens to peak at a whole number.
 */
export function niceScale(max: number, count = 3, opts: { integer?: boolean } = {}): { max: number; step: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0, 1] }
  const integer = opts.integer ?? Number.isInteger(max)
  const raw = max / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = integer && raw <= 1
    ? 1
    : ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw && (!integer || Number.isInteger(s))) ?? 10 * pow)
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { max: top, step, ticks }
}

export const tickLabel = (v: number) => fmtCompact(v)

/** Time tick interval: 5 min ≤ 15 min, 10 min ≤ 1 h, 1 h ≤ 6 h, 4 h ≤ 24 h, else 1 day. */
export function tickInterval(rangeMs: number): number {
  if (rangeMs <= 15 * 60_000) return 5 * 60_000
  if (rangeMs <= 3600_000) return 10 * 60_000
  if (rangeMs <= 6 * 3600_000) return 3600_000
  if (rangeMs <= 24 * 3600_000) return 4 * 3600_000
  return 86_400_000
}

const ICT_MS = 7 * 3600_000

/** Round ICT times (every `interval`) within [fromMs, toMs]. */
export function timeTicks(fromMs: number, toMs: number, interval = tickInterval(toMs - fromMs)): number[] {
  const start = Math.ceil((fromMs + ICT_MS) / interval) * interval - ICT_MS
  const out: number[] = []
  for (let t = start; t <= toMs; t += interval) out.push(t)
  return out
}

/** `13:20`, or `17 ต.ค.` for day ticks. */
export function timeTickText(ms: number, interval: number): string {
  return interval >= 86_400_000 ? fmtDate(ms) : fmtTime(ms)
}

/** A bar with 2 px rounded top corners and a square base (`h` up from `y + h`). */
export function barPath(x: number, y: number, w: number, h: number, radius = 2): string {
  const r = Math.min(radius, w / 2, h)
  if (h <= 0 || w <= 0) return ''
  const b = r1(y + h)
  return `M${r1(x)} ${b}V${r1(y + r)}Q${r1(x)} ${r1(y)} ${r1(x + r)} ${r1(y)}H${r1(x + w - r)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + r)}V${b}Z`
}

/** A square segment (lower parts of a stacked bar). */
export function rectPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0 || w <= 0) return ''
  return `M${r1(x)} ${r1(y + h)}V${r1(y)}H${r1(x + w)}V${r1(y + h)}Z`
}

export function linePath(points: Array<[number, number]>): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('')
}

export function areaPath(points: Array<[number, number]>, base: number): string {
  if (!points.length) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `${linePath(points)}L${r1(last[0])} ${r1(base)}L${r1(first[0])} ${r1(base)}Z`
}

/** Slot geometry of n equal buckets across the plot: x of slot i, its width, the bar width (2 px gap, ≤ 24 px). */
export function slots(frame: Frame, n: number) {
  const w = plotWidth(frame) / Math.max(1, n)
  const bar = Math.max(1, Math.min(24, w - 2))
  return {
    width: w,
    bar,
    x: (i: number) => frame.left + i * w,
    center: (i: number) => frame.left + i * w + w / 2,
    barX: (i: number) => frame.left + i * w + (w - bar) / 2,
  }
}

/** Build a `data-tip` value: `title|value::name|value::name` (and `data-tip-keys`). */
export function tipAttrs(title: string, lines: Array<{ value: string; name?: string; key?: string }>) {
  const tip = [title, ...lines.map((l) => (l.name ? `${l.value}::${l.name}` : l.value))].join('|')
  const keys = lines.map((l) => l.key ?? '').join(',')
  return keys.replace(/,/g, '') ? { 'data-tip': tip, 'data-tip-keys': keys } : { 'data-tip': tip }
}
