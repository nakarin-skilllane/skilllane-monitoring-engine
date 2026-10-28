/** Escaping and Thai formatting for the report's HTML (render/*). */
import { STATUS_TEXT } from '../rules'
import type { AiStatus, Compare, ReportStatus } from '../types'

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Every value from the payload goes through this: it is data, never markup. */
export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c])

const BKK = 'Asia/Bangkok'
const longDate = new Intl.DateTimeFormat('th-TH', { timeZone: BKK, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const shortDate = new Intl.DateTimeFormat('th-TH', { timeZone: BKK, day: 'numeric', month: 'short' })
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: BKK, hour: '2-digit', minute: '2-digit', hour12: false })

/** `2026-10-21` → `พ. 21 ต.ค. 2569`. */
export const thaiDate = (reportDate: string): string => longDate.format(new Date(`${reportDate}T12:00:00+07:00`))
export const clock = (ms: number): string => hm.format(ms)
/** `20 ต.ค. 09:01 ถึง 21 ต.ค. 09:00`. */
export const windowText = (startMs: number, endMs: number): string =>
  `${shortDate.format(startMs + 60_000)} ${hm.format(startMs + 60_000)} ถึง ${shortDate.format(endMs)} ${hm.format(endMs)}`
export const dateTime = (iso: string): string => `${shortDate.format(Date.parse(iso))} ${hm.format(Date.parse(iso))}`

export const count = (n: number): string => n.toLocaleString('en-US')
export const pct = (ratio: number, digits = 2): string => `${(ratio * 100).toFixed(digits)}%`
export const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`)

export { STATUS_TEXT }
export const STATUS_TONE: Record<ReportStatus, 'ok' | 'warn' | 'bad'> = { ok: 'ok', partial: 'warn', bad: 'bad' }

/** `+25%`, `ใหม่`, `ยังไม่มีค่าปกติ`. */
export function changeText(c: Compare): string {
  if (c.baseline === null) return 'ยังไม่มีค่าปกติ'
  if (c.changePct === null) return 'ใหม่'
  const p = Math.round(c.changePct * 100)
  return `${p > 0 ? '+' : ''}${p}%`
}

/** Lower is better for every figure but requests (neutral). */
export function changeTone(c: Compare, neutral = false): 'bad' | 'ok' | '' {
  if (neutral || c.baseline === null) return ''
  if (c.changePct === null) return c.value > 0 ? 'bad' : ''
  if (c.changePct > 0.05) return 'bad'
  if (c.changePct < -0.05) return 'ok'
  return ''
}

const AI_TEXT: Record<AiStatus, string> = { ok: 'AI พร้อม', unavailable: 'AI ต่อไม่ได้', quota: 'AI โควตาหมด', error: 'AI ผิดพลาด', disabled: 'AI ปิดอยู่' }

/** The grey bar shown instead of the AI box. */
export function aiMissingText(status: AiStatus, message: string): string {
  const why = status === 'disabled' ? 'ยังไม่ได้เปิดใช้ AI' : `${AI_TEXT[status]}${message ? ` (${message})` : ''}`
  return `${why} · รายงานวันนี้มีเฉพาะส่วนที่คำนวณจากกฎ`
}

export const EMPTY = 'ไม่มีรายการในช่วงนี้'

/** `13 (1.0%)` of a total; no % without a total (capped at 100 %: affected users can come from lines other than requests). */
export const share = (part: number, total: number): string =>
  total > 0 ? `${count(part)} (${pct(Math.min(1, part / total), 1)})` : count(part)
