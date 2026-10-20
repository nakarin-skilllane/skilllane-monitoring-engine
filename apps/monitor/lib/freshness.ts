/**
 * How fresh the data of an env is: the newest log line per env (from /api/meta releases[].versions[].lastSeen,
 * which the engine reads over all retained data and caches for 10 s). The sidebar's "ข้อมูลล่าสุด" and the top
 * bar's env list (envs with data in the last hour first) use it, so a stopped pipeline (queue down, engine
 * ingest broken) or a leftover test env shows as such instead of as live. Pure: server and client.
 */
import { fmtDateTime, fmtTimeSec, sameDay, toMs } from './format'
import type { Meta } from './types'

/** Newest line older than this = no data arriving (the demo writes every second; real apps log at least per minute). */
export const STALE_MS = 2 * 60_000

/** env → ISO time of its newest line (every service and version). */
export function latestByEnv(meta: Pick<Meta, 'releases'> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of meta?.releases ?? []) {
    for (const v of r.versions) {
      if (v.lastSeen && (!out[r.env] || toMs(v.lastSeen) > toMs(out[r.env]))) out[r.env] = v.lastSeen
    }
  }
  return out
}

/** Newest line of `env` (undefined env = every env); null when the env has none. */
export function newestOf(latest: Record<string, string>, env: string | undefined): string | null {
  if (env !== undefined) return latest[env] ?? null
  let best: string | null = null
  for (const t of Object.values(latest)) if (!best || toMs(t) > toMs(best)) best = t
  return best
}

/** `45 วินาที` · `12 นาที` · `11 ชั่วโมง` · `3 วัน` (how long no data arrived). */
export function fmtAge(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${Math.round(s)} วินาที`
  if (s < 3600) return `${Math.floor(s / 60)} นาที`
  if (s < 86_400) return `${Math.floor(s / 3600)} ชั่วโมง`
  return `${Math.floor(s / 86_400)} วัน`
}

/** `13:00:14` on the same day as `now`, else `17 ต.ค. 00:31`. */
export function fmtNewest(newest: string, now: number): string {
  return sameDay(newest, now) ? fmtTimeSec(newest) : fmtDateTime(newest)
}

export interface Freshness {
  /** ISO time of the newest line; null = the env has no data. */
  newest: string | null
  /** now − newest (ms); null without data. */
  ageMs: number | null
  /** Data arrived within STALE_MS. */
  fresh: boolean
}

export function freshness(latest: Record<string, string>, env: string | undefined, nowMs: number): Freshness {
  const newest = newestOf(latest, env)
  const ageMs = newest ? Math.max(0, nowMs - toMs(newest)) : null
  return { newest, ageMs, fresh: ageMs !== null && ageMs < STALE_MS }
}

/**
 * The env has data since `fromMs`: its newest line is at or after it. The top bar passes now − 1 hour on every
 * screen and lists the others apart ("env ที่ไม่มีข้อมูลใน 1 ชม."): leftover test runs stay out of the way.
 */
export function isActiveEnv(latest: Record<string, string>, env: string, fromMs: number): boolean {
  const t = latest[env]
  return !!t && toMs(t) >= fromMs
}
