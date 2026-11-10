/** /traces noise groups (engine query/noise.ts TRACE_NOISE_GROUPS) in the `noise` param (lib/noise). */
export const TRACE_NOISE_GROUPS = ['probe', 'preflight', 'cron', 'outside'] as const
export type TraceNoiseGroup = (typeof TRACE_NOISE_GROUPS)[number]

export const TRACE_NOISE_LABEL: Record<TraceNoiseGroup, { label: string; hint: string }> = {
  probe: { label: 'Health check / probe ที่ตอบสำเร็จ', hint: '/health, /ready, /metrics, /ping … ตอบต่ำกว่า 400 · GET / ของ uptime checker (python-requests) ที่ได้ 2xx' },
  preflight: { label: 'CORS preflight', hint: 'OPTIONS ที่ตอบต่ำกว่า 400' },
  cron: { label: 'Cron ที่รันถี่และทำงานปกติ', hint: 'cron ที่รันทุก 15 นาทีหรือถี่กว่า · cron รายวันและรอบที่ล้มยังแสดง' },
  outside: { label: 'งานนอก request', hint: 'DB หรือ HTTP ที่เรียกนอก request และ job เช่นตอน start แอป หรือ connection pool' },
}
