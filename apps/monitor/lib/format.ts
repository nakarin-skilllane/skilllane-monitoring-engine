/**
 * Display formats (DESIGN.md §3 Type). Pure functions, same output on server and client.
 * Times are ICT (Asia/Bangkok, UTC+7, no DST): `14:18:07.412` in lists, `17 ต.ค. 14:18` for dates.
 * Numbers use thousands separators; durations `84 ms`, `1.8 s`; percentages `0.16 %`.
 */

export const TZ = 'Asia/Bangkok'
const ICT_OFFSET_MS = 7 * 3600_000
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

export type TimeInput = string | number | Date | null | undefined

/** Milliseconds since the epoch, or NaN for empty / unparsable input. */
export function toMs(value: TimeInput): number {
  if (value === null || value === undefined || value === '') return Number.NaN
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}

interface Parts {
  day: number
  month: number
  year: number
  hh: string
  mm: string
  ss: string
  ms: string
}

function ict(value: TimeInput): Parts | null {
  const t = toMs(value)
  if (!Number.isFinite(t)) return null
  const d = new Date(t + ICT_OFFSET_MS)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return {
    day: d.getUTCDate(),
    month: d.getUTCMonth(),
    year: d.getUTCFullYear(),
    hh: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    ms: pad(d.getUTCMilliseconds(), 3),
  }
}

const DASH = '–'

/** `14:18:07.412` (HH:mm:ss.SSS, ICT). */
export function fmtTimeMs(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.hh}:${p.mm}:${p.ss}.${p.ms}` : DASH
}

/** `14:20:00` (HH:mm:ss, ICT). */
export function fmtTimeSec(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.hh}:${p.mm}:${p.ss}` : DASH
}

/** `14:18` (HH:mm, ICT). */
export function fmtTime(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.hh}:${p.mm}` : DASH
}

/** `17 ต.ค.` */
export function fmtDate(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.day} ${TH_MONTHS[p.month]}` : DASH
}

/** `17 ต.ค. 14:18` */
export function fmtDateTime(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.day} ${TH_MONTHS[p.month]} ${p.hh}:${p.mm}` : DASH
}

/** `17 ต.ค. 14:18:07.412` */
export function fmtDateTimeMs(value: TimeInput): string {
  const p = ict(value)
  return p ? `${p.day} ${TH_MONTHS[p.month]} ${p.hh}:${p.mm}:${p.ss}.${p.ms}` : DASH
}

/** Same calendar day in ICT. */
export function sameDay(a: TimeInput, b: TimeInput): boolean {
  const x = ict(a)
  const y = ict(b)
  return !!x && !!y && x.day === y.day && x.month === y.month && x.year === y.year
}

/**
 * Absolute range with zone, as the top bar shows it:
 * `17 ต.ค. 13:20–14:20 ICT` (same day) or `16 ต.ค. 14:20 – 17 ต.ค. 14:20 ICT`.
 */
export function fmtRange(from: TimeInput, to: TimeInput): string {
  if (!Number.isFinite(toMs(from)) || !Number.isFinite(toMs(to))) return DASH
  if (sameDay(from, to)) return `${fmtDate(from)} ${fmtTime(from)}${DASH}${fmtTime(to)} ICT`
  return `${fmtDateTime(from)} ${DASH} ${fmtDateTime(to)} ICT`
}

/** Range for a subline: `13:20–14:20 ICT` when it is today (ICT), else as fmtRange. */
export function fmtRangeShort(from: TimeInput, to: TimeInput, now: TimeInput = Date.now()): string {
  if (sameDay(from, to) && sameDay(to, now)) return `${fmtTime(from)}${DASH}${fmtTime(to)} ICT`
  return fmtRange(from, to)
}

/**
 * The date format of the Copy-for-AI Markdown (DESIGN.md §6b), ICT with the year:
 * `2026-10-17 14:18:09.226 ICT` (one occurrence, `when`) or `2026-10-17 14:18` (counts, ranges: `ms: false`, no zone).
 */
export function fmtAiTime(value: TimeInput, { ms = true }: { ms?: boolean } = {}): string {
  const p = ict(value)
  if (!p) return ''
  const day = `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  return ms ? `${day} ${p.hh}:${p.mm}:${p.ss}.${p.ms} ICT` : `${day} ${p.hh}:${p.mm}`
}

/** `datetime-local` input value (ICT wall clock) ↔ ISO UTC. */
export function toIctInput(value: TimeInput): string {
  const p = ict(value)
  if (!p) return ''
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${p.hh}:${p.mm}`
}
export function fromIctInput(value: string): string | null {
  const ms = Date.parse(`${value.length === 16 ? `${value}:00` : value}+07:00`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** `14,210` */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return intFmt.format(n)
}

/** Fixed decimals with separators: fmtNumber(1180.456, 1) → `1,180.5`. */
export function fmtNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
}

/** Compact for axis ticks: 0 · 500 · 1K · 1.5K · 2M. */
export function fmtCompact(n: number): string {
  const a = Math.abs(n)
  const trim = (x: number) => String(Math.round(x * 10) / 10)
  if (a >= 1e9) return `${trim(n / 1e9)}B`
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e3) return `${trim(n / 1e3)}K`
  return trim(n)
}

/**
 * Duration: `0.4 ms`, `84 ms`, `1.8 s`, `45.2 s`, `2.5 นาที`, `1.2 ชม.`.
 * ≥ 1,000 ms switches to seconds with one decimal (DESIGN.md §7).
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH
  const a = Math.abs(ms)
  if (a < 10) return `${Math.round(ms * 10) / 10} ms`
  if (a < 1000) return `${Math.round(ms)} ms`
  if (a < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (a < 3600_000) return `${(ms / 60_000).toFixed(1)} นาที`
  return `${(ms / 3600_000).toFixed(1)} ชม.`
}

/** Exact ms for waterfall, trace lists and key=value chips: `1,842 ms`. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH
  return Math.abs(ms) < 10 ? `${Math.round(ms * 10) / 10} ms` : `${intFmt.format(Math.round(ms))} ms`
}

/**
 * Percent of a ratio (engine errorRate is a ratio): 0.0016 → `0.16 %`, 0.114 → `11.4 %`, 0 → `0 %`.
 * Below 1 % two decimals, else one; `digits` forces a count.
 */
export function fmtPercent(ratio: number | null | undefined, digits?: number): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH
  const v = ratio * 100
  if (v === 0) return '0 %'
  const d = digits ?? (Math.abs(v) < 1 ? 2 : 1)
  return `${fmtNumber(v, d)} %`
}

/** Calls per minute as the 3D map labels print them (lib/3d/system-map.js): `93`, `6.2`, `< 0.1`, `0`. */
export function fmtRate(v: number | null | undefined): string {
  if (!(v && v > 0)) return '0'
  if (v >= 10) return intFmt.format(Math.round(v))
  if (v < 0.1) return '< 0.1'
  return String(Math.round(v * 10) / 10)
}

/** Error ratio as the 3D map labels print it (no trailing zeros): `0.16 %`, `6.3 %`, `< 0.01 %`, `100 %`. */
export function fmtPct(ratio: number | null | undefined): string {
  const p = (ratio || 0) * 100
  if (p <= 0) return '0 %'
  if (p < 0.01) return '< 0.01 %'
  if (p < 1) return `${parseFloat(p.toFixed(2))} %`
  if (p >= 100) return '100 %'
  return `${parseFloat(p.toFixed(1))} %`
}

/** Thai relative time: `เมื่อสักครู่`, `5 นาทีที่แล้ว`, `3 ชั่วโมงที่แล้ว`, `2 วันที่แล้ว`, `อีก 5 นาที`. */
export function fmtRelative(value: TimeInput, now: TimeInput = Date.now()): string {
  const t = toMs(value)
  const n = toMs(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) return DASH
  const diff = n - t
  const ahead = diff < 0
  const s = Math.abs(diff) / 1000
  let text: string
  if (s < 45) return ahead ? 'อีกสักครู่' : 'เมื่อสักครู่'
  if (s < 3600) text = `${Math.max(1, Math.round(s / 60))} นาที`
  else if (s < 86_400) text = `${Math.round(s / 3600)} ชั่วโมง`
  else if (s < 30 * 86_400) text = `${Math.round(s / 86_400)} วัน`
  else return fmtDateTime(t)
  return ahead ? `อีก ${text}` : `${text}ที่แล้ว`
}

/** Short id for crumbs and narrow cells: `4bf92f35…`. */
export function shortId(id: string, keep = 8): string {
  return id.length > keep ? `${id.slice(0, keep)}…` : id
}
