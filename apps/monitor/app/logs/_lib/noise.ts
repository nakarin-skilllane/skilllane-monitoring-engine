/**
 * /logs noise groups and repeats in the URL (pure).
 *
 *   show=all | none | probe,cache   noise groups shown; absent = none, or all while the page is narrowed to one thing
 *   repeats=collapse | all          repeats kept to their latest line or not; absent = collapse, or all while narrowed
 *
 * Narrowed = a trace, a job, an error group, a route or one repeat pattern: every line of it is wanted.
 */
import { shownGroups } from '@/lib/noise'

export const NOISE_GROUPS = ['probe', 'preflight', 'middleware', 'cache', 'cron', 'startup'] as const
export type NoiseGroup = (typeof NOISE_GROUPS)[number]

export const NOISE_LABEL: Record<NoiseGroup, { label: string; hint: string }> = {
  probe: { label: 'Health check / probe ที่ตอบสำเร็จ', hint: '/health, /ready, /metrics, /ping … ตอบต่ำกว่า 400' },
  preflight: { label: 'CORS preflight', hint: 'OPTIONS ที่ตอบต่ำกว่า 400' },
  middleware: { label: 'Middleware', hint: 'log ทั่วไปที่ข้อความมีคำว่า middleware' },
  cache: { label: 'Cache hit / set', hint: 'logger ที่ชื่อมี cache หรือข้อความ Cache hit / miss / set …' },
  cron: { label: 'Cron ที่รันถี่และทำงานปกติ', hint: 'cron ที่รันทุก 15 นาทีหรือถี่กว่า · cron รายวันและรอบที่ล้มยังแสดง' },
  startup: { label: 'Log ตอน start แอป', hint: 'INF ระหว่าง start จนถึง app.started เช่น Mapped route · app.started และ WRN / ERR ยังแสดง' },
}

export const shownNoise = (show: string | undefined, narrowed: boolean): NoiseGroup[] => shownGroups(NOISE_GROUPS, show, narrowed)

export function collapsesRepeats(repeats: string | undefined, narrowed: boolean): boolean {
  return repeats === undefined ? !narrowed : repeats === 'collapse'
}

/** `repeats` for this choice; null = the page's default. */
export function repeatsParam(collapse: boolean, narrowed: boolean): string | null {
  return collapse === !narrowed ? null : collapse ? 'collapse' : 'all'
}
