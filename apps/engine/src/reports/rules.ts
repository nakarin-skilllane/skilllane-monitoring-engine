/**
 * Pure rules of the daily report: no ClickHouse, no config. Every threshold comes in as
 * ReportRules so tests can pin them. A report date D covers [D-1 09:00, D 09:00) Bangkok.
 */
import type {
  Compare,
  ErrorTrend,
  OutageWindow,
  ReportDependency,
  ReportError,
  ReportFeature,
  ReportFigures,
  ReportFollowup,
  ReportIncident,
  ReportRules,
  ReportStatus,
} from './types'

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

// ---------- incidents ----------

export interface SpikeBucket {
  /** Bucket start (ms). */
  t: number
  requests: number
  errors: number
}

export interface Spike {
  fromMs: number
  toMs: number
  requests: number
  errors: number
  peakRate: number
}

/** 5-minute windows with error rate > baselineRate × spikeX and requests ≥ spikeMinReq; adjacent ones join. No baseline = none. */
export function spikeIncidents(buckets: SpikeBucket[], baselineRate: number | null, r: ReportRules, stepMs = 5 * 60_000): Spike[] {
  if (baselineRate === null) return []
  const out: Spike[] = []
  for (const b of [...buckets].sort((a, z) => a.t - z.t)) {
    const rate = b.requests ? b.errors / b.requests : 0
    if (b.requests < r.spikeMinReq || rate <= baselineRate * r.spikeX) continue
    const last = out[out.length - 1]
    if (last && last.toMs === b.t) {
      last.toMs = b.t + stepMs
      last.requests += b.requests
      last.errors += b.errors
      last.peakRate = Math.max(last.peakRate, round(rate, 5))
    } else {
      out.push({ fromMs: b.t, toMs: b.t + stepMs, requests: b.requests, errors: b.errors, peakRate: round(rate, 5) })
    }
  }
  return out
}

export interface DependencyEvent {
  /** `service/host`: whose lines these are; each process has its own down / up sequence. */
  process: string
  type: string
  name: string
  host: string
  port: number
  code: 'dependency.down' | 'dependency.still_down' | 'dependency.up'
  atMs: number
  /** dependency.up: the outage length. */
  durationMs: number | null
  reason: string
  message: string
}

export interface OutageTarget {
  key: string
  type: string
  name: string
  host: string
  port: number
  windows: OutageWindow[]
  /** Union of the windows (1 decimal). */
  minutes: number
  downEvents: number
  message: string
}

function mergeWindows(windows: OutageWindow[]): OutageWindow[] {
  const out: OutageWindow[] = []
  for (const w of [...windows].sort((a, b) => a.fromMs - b.fromMs)) {
    const last = out[out.length - 1]
    if (last && w.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, w.toMs)
      last.ongoing = last.ongoing || w.ongoing
    } else out.push({ ...w })
  }
  return out
}

/**
 * Outage windows of each target (type:name@host:port) in [fromMs, toMs), the union over
 * every process that reported it. dependency.up (not reason `connected`) closes a window
 * of its duration; a down that never comes up runs to the end of the window (ongoing); a
 * process whose first line is still_down was down since the start of the window.
 */
export function outageTargets(events: DependencyEvent[], fromMs: number, toMs: number): OutageTarget[] {
  const targets = new Map<string, { e: DependencyEvent; windows: OutageWindow[]; message: string; downEvents: number }>()
  const open = new Map<string, number>()
  const seen = new Set<string>()
  for (const e of [...events].sort((a, b) => a.atMs - b.atMs)) {
    const key = `${e.type}:${e.name}@${e.host}:${e.port}`
    const pk = `${e.process}\u0000${key}`
    let target = targets.get(key)
    if (!target) targets.set(key, (target = { e, windows: [], message: '', downEvents: 0 }))
    const first = !seen.has(pk)
    seen.add(pk)
    if (e.code === 'dependency.up') {
      if (e.reason === 'connected') continue
      const opened = open.get(pk)
      const start = Math.min(e.durationMs ? e.atMs - e.durationMs : (opened ?? e.atMs), opened ?? Number.POSITIVE_INFINITY)
      target.windows.push({ fromMs: Math.max(fromMs, start), toMs: Math.min(toMs, e.atMs), ongoing: false })
      open.delete(pk)
      continue
    }
    if (e.code === 'dependency.down') target.downEvents++
    if (!open.has(pk)) open.set(pk, e.code === 'dependency.still_down' && first ? fromMs : e.atMs)
    if (e.message) target.message = e.message
  }
  for (const [pk, start] of open) {
    targets.get(pk.split('\u0000')[1])!.windows.push({ fromMs: start, toMs, ongoing: true })
  }
  return [...targets.entries()]
    .map(([key, { e, windows, message, downEvents }]) => {
      const merged = mergeWindows(windows)
      const minutes = round(merged.reduce((sum, w) => sum + (w.toMs - w.fromMs), 0) / 60_000, 1)
      return { key, type: e.type, name: e.name, host: e.host, port: e.port, windows: merged, minutes, downEvents, message }
    })
    .filter((d) => d.windows.length)
    .sort((a, b) => b.minutes - a.minutes || a.key.localeCompare(b.key))
}

export interface MissedCron {
  /** Job type (`Class.method`). */
  key: string
  medianGapMin: number
  longestGapMin: number
  missedRuns: number
}

/**
 * Cron jobs (`Class.method`) with at least 3 starts before the window: each gap ending in the
 * window (and the gap from the last start to the end of the window, or now) longer than the
 * median gap before the window × 2 counts round(gap / median) − 1 missed runs. A guess from history.
 */
export function missedCrons(rows: Array<{ type: string; starts: number[] }>, fromMs: number, toMs: number, nowMs: number): MissedCron[] {
  const out: MissedCron[] = []
  for (const row of rows) {
    const starts = [...row.starts].sort((a, b) => a - b).filter((ms) => ms < toMs)
    const before = starts.filter((ms) => ms < fromMs)
    if (before.length < 3) continue
    const gaps = before.slice(1).map((ms, i) => ms - before[i]).sort((a, b) => a - b)
    const median = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2
    if (median <= 0) continue
    const inWindow: number[] = []
    starts.forEach((ms, i) => {
      if (i > 0 && ms >= fromMs) inWindow.push(ms - starts[i - 1])
    })
    inWindow.push(Math.min(toMs, nowMs) - starts[starts.length - 1])
    const long = inWindow.filter((g) => g > median * 2)
    if (!long.length) continue
    out.push({
      key: row.type,
      medianGapMin: round(median / 60_000, 1),
      longestGapMin: round(Math.max(...long) / 60_000, 1),
      missedRuns: long.reduce((sum, g) => sum + Math.round(g / median) - 1, 0),
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** One row per job_type of the window (report-queries `jobs`). */
export interface JobDb {
  job: string
  /** event_module of its lines: cron, bullmq, kafka, rabbitmq, task. */
  kind: string
  service: string
  total: number
  failed: number
  first_failed_ms: number
  last_failed_ms: number
  /** Last job.finished; 0 when none. */
  last_ok_ms: number
}

/** A job.failed incident per failing job: resolved when a run finished after its last failure. */
export function jobIncidents(rows: JobDb[]): ReportIncident[] {
  return rows
    .filter((j) => j.failed > 0)
    .map((j) => {
      const resolved = j.last_ok_ms > j.last_failed_ms
      return {
        id: `job:${j.job}`,
        source: 'job.failed' as const,
        startedAtMs: j.first_failed_ms,
        endedAtMs: resolved ? j.last_failed_ms : null,
        what: `งาน ${j.job} ล้มเหลว ${j.failed} ครั้ง`,
        usersAffected: null,
        state: resolved ? ('resolved' as const) : ('ongoing' as const),
      }
    })
}

// ---------- wording ----------

const fmtInt = (n: number): string => n.toLocaleString('en-US')

/** Summaries without AI. */
export function headlines(p: { status: ReportStatus; reasons: string[]; figures: ReportFigures }): { summaryOverview: string; summaryDetail: string } {
  const label = STATUS_TEXT[p.status]
  const why = p.reasons[0] ? ` · ${p.reasons[0]}` : ''
  const f = p.figures
  return {
    summaryOverview: `${label} · ผู้ใช้ที่เจอปัญหา ${fmtInt(f.usersAffected.value)} คน${why}`,
    summaryDetail: `${label} · error rate ${pct(f.errorRate.value)} · error กลุ่มใหม่ ${f.errorGroups.new} · เพิ่มขึ้น ${f.errorGroups.up}`,
  }
}

/** An error group with its trend before the topErrors cut (any trend). */
export type ClassifiedError = Omit<ReportError, 'trend'> & {
  trend: ErrorTrend
  /** Windows with this error among this one and the 6 before. */
  seenWindows: number
}

/** A figure that went up by more than this against its normal needs a look. */
const FIGURE_WORSE = 0.2
const FIGURE_LABELS: Array<[keyof Pick<ReportFigures, 'usersAffected' | 'orgsAffected' | 'errorRate' | 'p95Ms'>, string]> = [
  ['usersAffected', 'ผู้ใช้ที่เจอปัญหา'],
  ['orgsAffected', 'โรงเรียนที่ได้รับผลกระทบ'],
  ['errorRate', 'อัตราที่ใช้งานไม่สำเร็จ'],
  ['p95Ms', 'ความเร็ว (p95)'],
]

/** "ต้องติดตาม": new errors with users, errors in ≥ 3 of 7 windows, figures > 20 % over normal, dependency problems, features below normal or the bar. */
export function followups(errors: ClassifiedError[], figures: ReportFigures, dependencies: ReportDependency[], features: ReportFeature[] = []): ReportFollowup[] {
  const out: ReportFollowup[] = []
  const what = (e: ClassifiedError) => e.errorHint || e.errorType || 'error'
  const where = (e: ClassifiedError) => e.route || e.service
  for (const e of errors) {
    if (e.trend === 'new' && e.users > 0) out.push({ kind: 'new', key: e.fingerprint, text: `ปัญหาใหม่ ${what(e)} ที่ ${where(e)} กระทบผู้ใช้ ${fmtInt(e.users)} คน` })
  }
  for (const e of errors) {
    if (e.trend !== 'new' && e.seenWindows >= 3) out.push({ kind: 'recurring', key: e.fingerprint, text: `${what(e)} ที่ ${where(e)} เกิดซ้ำ ${e.seenWindows} ใน 7 ช่วงล่าสุด` })
  }
  for (const [key, label] of FIGURE_LABELS) {
    const k: Compare = figures[key]
    if (k.changePct !== null && k.changePct > FIGURE_WORSE) {
      out.push({ kind: 'threshold', key, text: `${label} สูงกว่าค่าปกติ ${Math.round(k.changePct * 100)}%` })
    }
  }
  for (const d of dependencies) {
    if (d.problem) out.push({ kind: 'threshold', key: d.key, text: `${d.name} ล่มรวม ${d.downMinutes} นาที` })
  }
  for (const f of features) {
    if (f.state === 'bad' || f.state === 'below') out.push({ kind: 'threshold', key: f.featureId, text: `ฟีเจอร์ ${f.name} ${f.note}` })
  }
  return out.slice(0, 10)
}
