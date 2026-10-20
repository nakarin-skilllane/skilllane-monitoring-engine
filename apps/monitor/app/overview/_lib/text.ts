/** Thai phrases of the overview that depend on the selected range (the mockup's copy is written for 1 ชั่วโมงล่าสุด). */
import { fmtCount, fmtDateTime, fmtDateTimeMs, fmtRangeShort, fmtTime, fmtTimeSec, sameDay, type TimeInput } from '@/lib/format'
import { RANGE_PRESETS, rangeLabel, type Scope } from '@/lib/params'

/** `ใน 1 ชั่วโมงล่าสุด`, `ใน 24 ชั่วโมงล่าสุด`, `ในช่วงที่เลือก`. */
export function inRange(scope: Pick<Scope, 'preset'>): string {
  const p = RANGE_PRESETS.find((r) => r.value === scope.preset)
  return p ? `ใน ${p.label}` : 'ในช่วงที่เลือก'
}

/** `1 ชั่วโมงล่าสุด`; a custom range names its window (`11:00–12:00 ICT`, with the date when it is not today). */
export function rangeName(scope: Pick<Scope, 'preset' | 'fromMs' | 'toMs' | 'nowMs'>): string {
  return scope.preset === 'custom' ? fmtRangeShort(scope.fromMs, scope.toMs, scope.nowMs) : rangeLabel(scope)
}

/** Length of the range for a column head: `60 นาที`, `6 ชั่วโมง`, `24 ชั่วโมง`, `7 วัน`; a custom range its own length. */
export function spanLabel(scope: Pick<Scope, 'preset' | 'fromMs' | 'toMs'>): string {
  switch (scope.preset) {
    case 'now-15m':
      return '15 นาที'
    case 'now-1h':
      return '60 นาที'
    case 'now-6h':
      return '6 ชั่วโมง'
    case 'now-24h':
      return '24 ชั่วโมง'
    case 'now-7d':
      return '7 วัน'
    default: {
      const m = Math.max(1, Math.round((scope.toMs - scope.fromMs) / 60_000))
      const one = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
      if (m < 120) return `${m} นาที`
      if (m < 48 * 60) return `${one(Math.round((m / 60) * 10) / 10)} ชั่วโมง`
      return `${one(Math.round((m / 1440) * 10) / 10)} วัน`
    }
  }
}

/** `ทั้งชั่วโมง` for 1 h, else `ทั้งช่วง`. */
export function wholeRange(scope: Pick<Scope, 'preset'>): string {
  return scope.preset === 'now-1h' ? 'ทั้งชั่วโมง' : 'ทั้งช่วง'
}

/** `14:16` today (ICT), else `17 ต.ค. 14:16`. */
export function at(value: TimeInput, nowMs: number): string {
  return sameDay(value, nowMs) ? fmtTime(value) : fmtDateTime(value)
}

/** `14:16:20` today, else `17 ต.ค. 14:16:20.000`. */
export function atSec(value: TimeInput, nowMs: number): string {
  return sameDay(value, nowMs) ? fmtTimeSec(value) : fmtDateTimeMs(value)
}

/** `3 นาที`, `5 ชั่วโมง`, `2 วัน` between two times. */
export function gap(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} นาที`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} ชั่วโมง`
  return `${Math.round(h / 24)} วัน`
}

/** `+1.9 pt`, `−0.3 pt` from a ratio difference. */
export function fmtPt(diffRatio: number): string {
  const v = diffRatio * 100
  const t = Math.abs(v).toFixed(1)
  return `${v < 0 ? '−' : '+'}${t} pt`
}

/** `+120 ms`, `+0.1 s` (seconds once the value itself is ≥ 1 s, like the p95 next to it). */
export function fmtDeltaMs(diff: number, inSeconds: boolean): string {
  const a = Math.abs(diff)
  if (inSeconds ? a < 50 : a < 0.5) return inSeconds ? '±0.0 s' : '±0 ms'
  const sign = diff < 0 ? '−' : '+'
  return inSeconds ? `${sign}${(a / 1000).toFixed(1)} s` : `${sign}${fmtCount(Math.round(a))} ms`
}
