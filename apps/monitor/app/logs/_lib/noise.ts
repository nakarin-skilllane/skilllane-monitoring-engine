/**
 * /logs noise groups and repeats in the URL (pure).
 *
 *   show=all | none | probe,cache   noise groups shown; absent = none, or all while the page is narrowed to one thing
 *   repeats=collapse | all          repeats kept to their latest line or not; absent = collapse, or all while narrowed
 *
 * Narrowed = a trace, a job, an error group, a route or one repeat pattern: every line of it is wanted.
 */
export const NOISE_GROUPS = ['probe', 'preflight', 'middleware', 'cache', 'cron'] as const
export type NoiseGroup = (typeof NOISE_GROUPS)[number]

export const NOISE_LABEL: Record<NoiseGroup, { label: string; hint: string }> = {
  probe: { label: 'Health check / probe ที่ตอบสำเร็จ', hint: '/health, /ready, /metrics, /ping … ตอบต่ำกว่า 400' },
  preflight: { label: 'CORS preflight', hint: 'OPTIONS ที่ตอบต่ำกว่า 400' },
  middleware: { label: 'Middleware', hint: 'log ทั่วไปที่ข้อความมีคำว่า middleware' },
  cache: { label: 'Cache hit / set', hint: 'logger ที่ชื่อมี cache หรือข้อความ Cache hit / miss / set …' },
  cron: { label: 'Cron ที่รันถี่และทำงานปกติ', hint: 'cron ที่รันทุก 15 นาทีหรือถี่กว่า · cron รายวันและรอบที่ล้มยังแสดง' },
}

export function shownNoise(show: string | undefined, narrowed: boolean): NoiseGroup[] {
  if (show === undefined) return narrowed ? [...NOISE_GROUPS] : []
  if (show === 'all') return [...NOISE_GROUPS]
  const list = show.split(',').map((s) => s.trim())
  return NOISE_GROUPS.filter((g) => list.includes(g))
}

/** `show` for these shown groups; null = the page's default. */
export function showParam(groups: readonly NoiseGroup[], narrowed: boolean): string | null {
  const all = groups.length === NOISE_GROUPS.length
  if (narrowed ? all : !groups.length) return null
  return all ? 'all' : groups.length ? NOISE_GROUPS.filter((g) => groups.includes(g)).join(',') : 'none'
}

export function collapsesRepeats(repeats: string | undefined, narrowed: boolean): boolean {
  return repeats === undefined ? !narrowed : repeats === 'collapse'
}

/** `repeats` for this choice; null = the page's default. */
export function repeatsParam(collapse: boolean, narrowed: boolean): string | null {
  return collapse === !narrowed ? null : collapse ? 'collapse' : 'all'
}
