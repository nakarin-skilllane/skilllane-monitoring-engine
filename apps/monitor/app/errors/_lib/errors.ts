/**
 * Helpers shared by /errors and /errors/[fingerprint] (both live in this route folder): the NEW rule,
 * the level split of a group (job.retry WRN vs job.failed ERR, from ErrorGroup errorCount / sparkError; stack parsing
 * is lib/stack.ts), spark bucket labels, deploy / release lookup and the AI where-line.
 */
import { fmtAiTime, fmtDateTime, fmtTime, fmtTimeSec, sameDay, toMs } from '@/lib/format'
import { moduleName } from '@/lib/readable'
import { RANGE_PRESETS, type Scope } from '@/lib/params'
import type { Deploy, ErrorGroup, ErrorSpark, Meta, ServiceRelease } from '@/lib/types'

// ---------- NEW + level ----------

/** Decided rule: NEW = isNew, never for category dependency or input (outages and bad requests are not new bugs). */
export function showNew(g: Pick<ErrorGroup, 'isNew' | 'category'>): boolean {
  return g.isNew && g.category !== 'dependency' && g.category !== 'input'
}

/** ERR band = error + fatal; everything else is the WRN band. */
export const isErrLevel = (level: string) => level === 'error' || level === 'fatal'

/** Lines of one group by level, per spark bucket, and what its latest occurrence says (ErrorGroup fields). */
export interface GroupSplit {
  warn: number[]
  error: number[]
  warnTotal: number
  errorTotal: number
  /** HTTP status the latest occurrence's request answered (0 = none). */
  status: number
  /** Queue system of the latest occurrence (bullmq …), '' when none. */
  eventModule: string
  /** dependency.type of the latest occurrence, '' when none. */
  dependencyType: string
}

/** The level split of a group from the engine's errorCount / warnCount / sparkError (job.retry WRN vs job.failed ERR). */
export function splitOf(g: ErrorGroup): GroupSplit {
  const error = g.spark.map((v, i) => Math.min(v, g.sparkError?.[i] ?? (isErrLevel(g.level) ? v : 0)))
  const warn = g.spark.map((v, i) => v - error[i])
  return {
    warn,
    error,
    warnTotal: g.warnCount ?? warn.reduce((a, v) => a + v, 0),
    errorTotal: g.errorCount ?? error.reduce((a, v) => a + v, 0),
    status: g.httpStatus ?? 0,
    eventModule: g.eventModule ?? '',
    dependencyType: g.dependencyType ?? '',
  }
}

/** ERR / WRN occurrences of a group: from its split when it has both, else all at the group's level. Sums to count. */
export function levelCounts(g: ErrorGroup, split?: GroupSplit): { err: number; warn: number; mixed: boolean } {
  if (split && split.warnTotal > 0 && split.errorTotal > 0) {
    const err = Math.min(g.count, split.errorTotal)
    return { err, warn: g.count - err, mixed: true }
  }
  return isErrLevel(g.level) ? { err: g.count, warn: 0, mixed: false } : { err: 0, warn: g.count, mixed: false }
}

/** ERR occurrences per spark bucket (a mixed group counts its ERR lines only). */
export function errSpark(g: ErrorGroup, split?: GroupSplit): number[] {
  if (split && split.warnTotal > 0 && split.errorTotal > 0) return g.spark.map((v, i) => Math.min(v, split.error[i] ?? 0))
  return isErrLevel(g.level) ? g.spark : g.spark.map(() => 0)
}

/** HTTP status of a group: the latest line's request, else HTTP_404-style codes. */
export function groupStatus(g: ErrorGroup, split?: GroupSplit): number {
  const s = split?.status ?? 0
  if (s) return s
  const m = /^HTTP_(\d{3})$/.exec(g.errorCode)
  return m ? Number(m[1]) : 0
}

// ---------- ranges and buckets ----------

/** `24 ชั่วโมง` for a preset range, else `ช่วงที่เลือก`. */
export function rangeWords(scope: Pick<Scope, 'preset'>): string {
  const p = RANGE_PRESETS.find((r) => r.value === scope.preset)
  return p ? p.label.replace(/ล่าสุด$/, '') : 'ช่วงที่เลือก'
}

/** `ใน 24 ชั่วโมง` for a preset range, else `ในช่วงที่เลือก` (no space inside the Thai phrase). */
export function inRangeWords(scope: Pick<Scope, 'preset'>): string {
  const w = rangeWords(scope)
  return w === 'ช่วงที่เลือก' ? `ใน${w}` : `ใน ${w}`
}

/** Short where of a group for telling two groups with the same title apart: route, job, else the function. */
export function whereShort(g: Pick<ErrorGroup, 'routes' | 'jobType' | 'jobQueue' | 'originFunction' | 'dependencyName'>): string {
  if (g.routes[0]) return g.routes[0]
  if (g.jobType || g.jobQueue) return `job ${g.jobType || g.jobQueue}`
  return g.originFunction || (g.dependencyName ? `dependency ${g.dependencyName}` : '')
}

/** Every role the group was seen on in the range (`api, persister`), else its latest role (ErrorGroup.roles). */
export function rolesText(g: Pick<ErrorGroup, 'role' | 'roles'>): string {
  return g.roles && g.roles.length > 1 ? g.roles.join(', ') : g.role
}

/** `24 ชั่วโมงล่าสุด` for a preset range, else `ช่วงที่เลือก`. */
export function rangeLabelText(scope: Pick<Scope, 'preset'>): string {
  return RANGE_PRESETS.find((r) => r.value === scope.preset)?.label ?? 'ช่วงที่เลือก'
}

/** Axis start label: `−24 ชม.`, `−1 ชม.`, `−7 วัน`, `−15 นาที`; a custom range shows its start. */
export function rangeStartTick(scope: Pick<Scope, 'preset' | 'fromMs'>): string {
  switch (scope.preset) {
    case 'now-15m':
      return '−15 นาที'
    case 'now-1h':
      return '−1 ชม.'
    case 'now-6h':
      return '−6 ชม.'
    case 'now-24h':
      return '−24 ชม.'
    case 'now-7d':
      return '−7 วัน'
    default:
      return fmtDateTime(scope.fromMs)
  }
}

/** Bucket length in words: `ชั่วโมง`, `นาที`, `3 นาที`, `7 ชั่วโมง`, `วัน`. */
export function stepText(stepSeconds: number): string {
  if (stepSeconds % 86_400 === 0) return stepSeconds === 86_400 ? 'วัน' : `${stepSeconds / 86_400} วัน`
  if (stepSeconds % 3600 === 0) return stepSeconds === 3600 ? 'ชั่วโมง' : `${stepSeconds / 3600} ชั่วโมง`
  const m = Math.round(stepSeconds / 60)
  return m === 1 ? 'นาที' : `${m} นาที`
}

/** Short unit after a per-bucket max: `ชม.`, `นาที`, `3 นาที`, `7 ชม.`. */
export function stepShort(stepSeconds: number): string {
  if (stepSeconds % 3600 === 0) return stepSeconds === 3600 ? 'ชม.' : `${stepSeconds / 3600} ชม.`
  return stepText(stepSeconds)
}

/** Start of every spark bucket (ms). */
export function bucketStarts(spark: ErrorSpark): number[] {
  const from = toMs(spark.from)
  return Array.from({ length: spark.buckets }, (_, i) => from + i * spark.stepSeconds * 1000)
}

/** End of bucket i: the next start, the last one runs to `to`. */
export function bucketEnd(starts: number[], i: number, stepSeconds: number, toMsValue: number): number {
  return i === starts.length - 1 ? Math.max(starts[i] + 60_000, toMsValue) : starts[i] + stepSeconds * 1000
}

/**
 * Short buckets (under an hour) laid back from a `to` that is not on a whole minute carry seconds
 * (`12:19:50–12:20:50`): ErrorSpark buckets end exactly at `to`, so a minute label would be up to 59 s off.
 */
function withSec(start: number, end: number): boolean {
  return end - start < 3_600_000 && (start % 60_000 !== 0 || end % 60_000 !== 0)
}

/** `16 ต.ค. 14:20–15:20` (`–17 ต.ค. 00:20` when the bucket ends on another day; seconds, see withSec). */
export function bucketLabel(start: number, end: number): string {
  const sec = withSec(start, end)
  const head = sec ? `${fmtDateTime(start)}:${fmtTimeSec(start).slice(-2)}` : fmtDateTime(start)
  return `${head}–${sameDay(start, end) ? (sec ? fmtTimeSec(end) : fmtTime(end)) : fmtDateTime(end)}`
}

/** `13:20–14:20` (dates when it spans days; seconds, see withSec). */
export function bucketTimes(start: number, end: number, nowMs: number): string {
  if (sameDay(start, end) && sameDay(end, nowMs)) return withSec(start, end) ? `${fmtTimeSec(start)}–${fmtTimeSec(end)}` : `${fmtTime(start)}–${fmtTime(end)}`
  return bucketLabel(start, end)
}

/** HH:mm today, else `17 ต.ค. 14:18`. */
export function timeOrDate(value: string | number, nowMs: number): string {
  return sameDay(value, nowMs) ? fmtTime(value) : fmtDateTime(value)
}

/** The last occurrence inside the window: exact (`at`), or the bucket it is in (`from`–`to`, ms). */
export type LastInWindow = { at: number } | { from: number; to: number }

/**
 * The last occurrence of a group inside the selected window. ErrorGroup.lastSeen covers all retained data (SPEC §12),
 * so in a past window (isPastWindow) it can lie after `to`; then the last spark bucket with occurrences stands in.
 * null when the window has none.
 */
export function lastInWindow(g: Pick<ErrorGroup, 'lastSeen' | 'spark'>, spark: ErrorSpark, endMs: number): LastInWindow | null {
  const last = toMs(g.lastSeen)
  if (last <= endMs) return { at: last }
  const i = g.spark.findLastIndex((n) => n > 0)
  if (i < 0) return null
  const starts = bucketStarts(spark)
  return { from: starts[i], to: bucketEnd(starts, i, spark.stepSeconds, endMs) }
}

/** Sort key of a LastInWindow (its time, a bucket's end); 0 for none. */
export const lastInWindowMs = (l: LastInWindow | null): number => (!l ? 0 : 'at' in l ? l.at : l.to)

/** The AI text's `last …`: `2026-10-18 12:19`, a bucket `2026-10-18 12:00–12:15`. */
export function lastInWindowAi(l: LastInWindow): string {
  return 'at' in l ? fmtAiTime(l.at, { ms: false }) : `${fmtAiTime(l.from, { ms: false })}–${fmtAiTime(l.to, { ms: false }).slice(11)}`
}

/** `redis cache`, `http ThaID`; just `redis` when the dependency is named after its type (no `redis redis`). */
export function depText(type: string, name: string): string {
  return !type || type.toLowerCase() === name.toLowerCase() ? name : `${type} ${name}`
}

// ---------- deploys ----------

export function releaseOf(meta: Meta | null, env: string | undefined, service: string): ServiceRelease | undefined {
  return meta?.releases.find((r) => r.service === service && (!env || r.env === env))
}

/** Deploys of a service in an env, oldest first. */
export function deploysOf(meta: Meta | null, env: string | undefined, service: string): Deploy[] {
  return (meta?.deploys ?? []).filter((d) => d.service === service && (!env || d.env === env)).sort((a, b) => toMs(a.at) - toMs(b.at))
}

/** Version running at `t` from the deploys (oldest first) and the release. */
export function versionAt(t: number, deploys: Deploy[], release?: ServiceRelease): string {
  let v = deploys[0]?.previousVersion || release?.versions[0]?.version || release?.currentVersion || ''
  for (const d of deploys) if (toMs(d.at) <= t) v = d.version
  return v
}

// ---------- Copy for AI ----------

/** Markdown lines with the `###` / `##` heading text in `.c-key` (the copied text is unchanged). */
export function markdownLines(md: string): Array<{ key?: string; rest: string }> {
  return md.split('\n').map((line) => {
    if (!line.startsWith('#')) return { rest: line }
    const i = line.indexOf(' (')
    return i > 0 ? { key: line.slice(0, i), rest: line.slice(i) } : { key: line, rest: '' }
  })
}

/**
 * Where of a group for the AI text: route, else `job <type> (BullMQ queue <q>)`, else `dependency <type> <name>`.
 * `module` / `depType` come from its latest line (ErrorGroup has neither).
 */
export function groupWhere(g: ErrorGroup, module = '', depType = ''): string {
  if (g.routes[0]) return g.routes[0]
  if (g.jobType || g.jobQueue) {
    const sys = moduleName(module)
    return `job ${g.jobType || g.jobQueue}${g.jobQueue && g.jobType ? ` (${sys ? `${sys} ` : ''}queue ${g.jobQueue})` : ''}`
  }
  if (g.dependencyName) return `dependency ${depText(depType, g.dependencyName)}`
  return ''
}

/** Thai explanation of a category (error-detail "เกิดอะไรขึ้น"). */
export const CATEGORY_WHY: Record<string, string> = {
  bug: 'error เกิดในโค้ดของแอปเอง ต้องแก้โค้ดแล้ว deploy ใหม่ ไม่ใช่ข้อมูลที่ผู้ใช้ส่งมาผิดและไม่ใช่ระบบภายนอกล่ม',
  input: 'client ส่งข้อมูลมาผิด (4xx) ระบบตอบถูกแล้ว ดูเมื่อจำนวนผิดปกติ ไม่ใช่ bug ในโค้ดและไม่ใช่ระบบภายนอกล่ม',
  data: 'ค่าที่จะบันทึกขัดกับข้อกำหนดของฐานข้อมูล (เช่น ความยาว column หรือ lock ของแถว) ไม่ใช่ระบบภายนอกล่ม',
  dependency: 'ระบบที่เรียกใช้ (DB, cache, queue หรือ API ภายนอก) ล่ม ช้า หรือปฏิเสธ request ไม่ใช่ bug ในโค้ดโดยตรง',
  config: 'env หรือ config ผิด เช่น ตัวแปร env หาย หรือ URL / credential ของระบบที่เรียกใช้ผิด',
}

/** What a category holds (errors empty state): `หมวดนี้คือ …`. */
export const CATEGORY_ABOUT: Record<string, string> = {
  bug: 'หมวดนี้คือ error ที่ต้องแก้โค้ดแล้ว deploy ใหม่ เช่น อ่านค่าจาก object ที่ไม่มีอยู่จริง',
  input: 'หมวดนี้คือ request ที่ client ส่งข้อมูลมาผิด (4xx) เช่น id ที่ไม่มีอยู่ หรือ field ที่ไม่ผ่าน validation',
  data: 'หมวดนี้คือค่าที่จะบันทึกขัดกับข้อกำหนดของฐานข้อมูล เช่น ข้อความยาวเกิน column หรือ deadlock',
  dependency: 'หมวดนี้คือระบบที่เรียกใช้ล่มหรือตอบช้า เช่น DB, Redis หรือ API ภายนอก',
  config: 'หมวดนี้คือ error ที่เกิดจาก env หรือ config ผิด เช่น ตัวแปร env หาย หรือ URL ของระบบที่เรียกใช้ผิด',
}
