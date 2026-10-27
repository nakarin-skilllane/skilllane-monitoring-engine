/**
 * Pure rules of the daily report: no ClickHouse, no config. Every threshold comes in as
 * ReportRules so tests can pin them. A report date D covers [D-1 09:00, D 09:00) Bangkok.
 */
import type { Compare, ErrorTrend, ReportRules, ReportStatus } from './types'

export const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const BANGKOK_OFFSET_MS = 7 * HOUR_MS
/** 09:00 Asia/Bangkok = 02:00 UTC of the report date. */
const WINDOW_END_UTC_MS = 2 * HOUR_MS
/** logs keep 90 days in prod. */
const MAX_AGE_DAYS = 89
/** Windows a baseline averages, and how many of them need data. */
export const BASELINE_WINDOWS = 6
export const MIN_BASELINE = 3

export const STATUS_TEXT: Record<ReportStatus, string> = { ok: 'ปกติ', partial: 'มีปัญหาบางช่วง', bad: 'มีปัญหา' }

export const round = (n: number, digits: number): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
export const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

/** 0.021 → `2.10%`. */
export const pct = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`

/** [D-1 09:00, D 09:00) Asia/Bangkok of report date `date` (YYYY-MM-DD), in UTC milliseconds. */
export function reportWindow(date: string): { fromMs: number; toMs: number } {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnightUtc) || new Date(midnightUtc).toISOString().slice(0, 10) !== date) {
    throw new Error(`date must be YYYY-MM-DD: ${date}`)
  }
  const toMs = midnightUtc + WINDOW_END_UTC_MS
  return { fromMs: toMs - DAY_MS, toMs }
}

/** The Asia/Bangkok date of an instant. */
export const bangkokDate = (ms: number): string => new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, 10)

export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** The newest report date whose window has ended: today from 09:00 Bangkok, else yesterday. */
export function latestReportDate(nowMs: number): string {
  const today = bangkokDate(nowMs)
  return nowMs >= reportWindow(today).toMs ? today : addDays(today, -1)
}

/** Why a report of `date` cannot be built (Thai, for a 400), or undefined. */
export function reportDateProblem(date: string, nowMs: number): string | undefined {
  try {
    reportWindow(date)
  } catch {
    return 'date ต้องเป็น YYYY-MM-DD'
  }
  const latest = latestReportDate(nowMs)
  if (date > latest) return `รายงาน ${date} ยังไม่ครบช่วง (ครบเวลา 09:00) สร้างได้ถึง ${latest}`
  if (date < addDays(latest, -MAX_AGE_DAYS)) return 'สร้างรายงานย้อนหลังได้ไม่เกิน 90 วัน'
  return undefined
}

/** The report dates among the last `days` (latest included) not in `existing`, oldest first. */
export function dueDates(nowMs: number, existing: Set<string>, days: number): string[] {
  const latest = latestReportDate(nowMs)
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(latest, -i)
    if (!existing.has(date)) out.push(date)
  }
  return out
}

export function changePct(value: number, baseline: number | null): number | null {
  if (baseline === null) return null
  if (baseline === 0) return value === 0 ? 0 : null
  return round((value - baseline) / baseline, 4)
}

/** `history` = the 6 windows before, oldest first; null = a window without data (not counted). */
export function compare(value: number, history: Array<number | null>): Compare {
  const withData = history.filter((v): v is number => v !== null)
  const baseline = withData.length >= MIN_BASELINE ? round(mean(withData), 5) : null
  return { value, baseline, changePct: changePct(value, baseline) }
}

/** `history` = counts of the windows before with data; `seenBefore` = a line in the newLookbackDays before the window. */
export function classifyError(count: number, history: number[], seenBefore: boolean, r: ReportRules): ErrorTrend {
  if (!seenBefore) return 'new'
  const avg = mean(history)
  if (count > avg * r.increaseX && count > r.increaseMin) return 'up'
  if (count < avg * 0.5) return 'down'
  return 'same'
}

export interface StatusInput {
  errorRate: number
  errorRateBaseline: number | null
  /** Sum of the dependency outage minutes of the window. */
  outageMinutes: number
  features: Array<{ name: string; successRate: number }>
  incidents: number
}

/** The first tier that matches; every matching reason is kept, bad ones first. */
export function decideStatus(s: StatusInput, r: ReportRules): { status: ReportStatus; reasons: string[] } {
  const bad: string[] = []
  const warn: string[] = []
  const base = s.errorRateBaseline
  const rateText = (x: number) => `error rate ${pct(s.errorRate)} สูงกว่าค่าปกติ (${pct(base ?? 0)}) เกิน ${x} เท่า`
  // no baseline, or no errors at all before: there is nothing to be "x times" of
  if (base) {
    if (s.errorRate > base * r.badErrorRateX) bad.push(rateText(r.badErrorRateX))
    else if (s.errorRate > base * r.warnErrorRateX) warn.push(rateText(r.warnErrorRateX))
  }
  if (s.outageMinutes > r.badOutageMin) bad.push(`ระบบที่พึ่งพาล่มรวม ${round(s.outageMinutes, 1)} นาที`)
  for (const f of s.features) {
    if (f.successRate < r.badFeatureSuccess) bad.push(`ฟีเจอร์ ${f.name} ใช้งานสำเร็จ ${(f.successRate * 100).toFixed(1)}%`)
  }
  if (s.incidents >= 1) warn.push(`มีเหตุการณ์สำคัญ ${s.incidents} ครั้ง`)
  const status: ReportStatus = bad.length ? 'bad' : warn.length ? 'partial' : 'ok'
  return { status, reasons: [...bad, ...warn] }
}
