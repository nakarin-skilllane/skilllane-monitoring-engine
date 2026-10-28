/** Pure wording for /reports/daily. */
import type { ReportAiStatus, ReportCompare, ReportDateItem, ReportStatus } from '@/lib/types'

export const STATUS_TEXT: Record<ReportStatus, string> = { ok: 'ปกติ', partial: 'มีปัญหาบางช่วง', bad: 'มีปัญหา' }
export const STATUS_STATE: Record<ReportStatus, 'ok' | 'warn' | 'down'> = { ok: 'ok', partial: 'warn', bad: 'down' }
export const EMPTY = 'ไม่มีรายการในช่วงนี้'

export const AI_STATUS_TEXT: Record<ReportAiStatus, string> = {
  pending: 'AI กำลังวิเคราะห์…',
  ok: 'AI พร้อม',
  unavailable: 'AI ต่อไม่ได้',
  quota: 'AI โควตาหมด',
  error: 'AI ผิดพลาด',
  disabled: 'AI ปิดอยู่',
}

/** The grey bar shown instead of the AI box. */
export function aiMissingText(status: ReportAiStatus, message: string): string {
  if (status === 'pending') return 'AI กำลังวิเคราะห์ · ตัวเลขทั้งหมดพร้อมแล้ว หน้านี้จะอัปเดตเองเมื่อเสร็จ'
  if (status === 'ok') return 'AI ไม่มีข้อความสำหรับส่วนนี้ · ส่วนนี้มีเฉพาะที่คำนวณจากกฎ'
  const why = status === 'disabled' ? message || 'ยังไม่ได้เปิดใช้ AI' : `${AI_STATUS_TEXT[status]}${message ? ` (${message})` : ''}`
  return `${why} · รายงานวันนี้มีเฉพาะส่วนที่คำนวณจากกฎ`
}

/** The env to show: the one asked for if allowed, else prod, else the first allowed. */
export function pickEnv(wanted: string | undefined, envs: string[], scope: 'all' | string[] | undefined): string | undefined {
  const allowed = !scope || scope === 'all' ? envs : envs.filter((e) => scope.includes(e))
  if (wanted && allowed.includes(wanted)) return wanted
  return allowed.includes('prod') ? 'prod' : allowed[0]
}

const BKK = 'Asia/Bangkok'
const longDate = new Intl.DateTimeFormat('th-TH', { timeZone: BKK, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat('th-TH', { timeZone: BKK, day: 'numeric', month: 'short' })
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: BKK, hour: '2-digit', minute: '2-digit', hour12: false })

/** `2026-10-21` → `พ. 21 ต.ค. 2569`. */
export const thaiDate = (reportDate: string): string => longDate.format(new Date(`${reportDate}T12:00:00+07:00`))

/** `20 ต.ค. 09:01 ถึง 21 ต.ค. 09:00` (the first minute shown is the one after the start). */
export function windowText(startMs: number, endMs: number): string {
  const s = startMs + 60_000
  return `${shortDate.format(s)} ${hm.format(s)} ถึง ${shortDate.format(endMs)} ${hm.format(endMs)}`
}

export const clock = (ms: number): string => hm.format(ms)

/** `+25%`, `ใหม่`, `ยังไม่มีค่าปกติ`. */
export function changeText(c: ReportCompare): string {
  if (c.baseline === null) return 'ยังไม่มีค่าปกติ'
  if (c.changePct === null) return 'ใหม่'
  const p = Math.round(c.changePct * 100)
  return `${p > 0 ? '+' : ''}${p}%`
}

/** Lower is better for every figure but requests (neutral). */
export function changeTone(c: ReportCompare, neutral = false): 'bad' | 'good' | undefined {
  if (neutral || c.baseline === null) return undefined
  if (c.changePct === null) return c.value > 0 ? 'bad' : undefined
  if (c.changePct > 0.05) return 'bad'
  if (c.changePct < -0.05) return 'good'
  return undefined
}

/** Previous (older) and next (newer) dates around `current`; `dates` newest first. */
export function neighbours(dates: ReportDateItem[], current: string): { prev?: string; next?: string } {
  const list = dates.map((d) => d.reportDate)
  const i = list.indexOf(current)
  if (i < 0) return { prev: list.find((d) => d < current), next: [...list].reverse().find((d) => d > current) }
  return { prev: list[i + 1], next: i > 0 ? list[i - 1] : undefined }
}

/** `13 (1.0%)` of a total; no % without one (capped at 100 %). */
export const share = (part: number, total: number): string =>
  total > 0 ? `${part.toLocaleString('en-US')} (${(Math.min(1, part / total) * 100).toFixed(1)}%)` : part.toLocaleString('en-US')

/** The AI's note for a target (summaryOverview, summaryDetail, an error fingerprint, an incident id), when it ran. */
export const aiNote = (r: { aiStatus: ReportAiStatus; payload: { aiNotes: Array<{ target: string; text: string }> } }, target: string): string | undefined =>
  r.aiStatus === 'ok' ? r.payload.aiNotes.find((n) => n.target === target)?.text : undefined

export const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)

export type ReportView = 'data' | 'infographic'

export const reportHref = (q: { env: string; date?: string; tab?: string; view?: string }): string =>
  `/reports/daily?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`
