'use client'

/**
 * Sidebar foot: how fresh the data of the selected env is (lib/freshness.ts), not the engine clock.
 * - range ending now (no `to`, or to=now) and a line within 2 min: pulsing "สด" + "ข้อมูลล่าสุด 13:00:14 ICT";
 * - a fixed past range: the same time, without "สด" (DESIGN.md §5: live only while the range is relative);
 * - no line for 2 min or more: a warn chip "ไม่มีข้อมูลใหม่ 11 ชั่วโมง" above it, whatever the range, so a stopped
 *   pipeline (queue down, engine ingest broken) or a leftover test env never looks live.
 * The env comes from the URL (layouts get no searchParams), like the top bar.
 */
import { usePathname, useSearchParams } from 'next/navigation'
import { fmtDateTime } from '@/lib/format'
import { fmtAge, fmtNewest, freshness } from '@/lib/freshness'
import { get, parseScope, screenFromPath } from '@/lib/params'
import { Live, StateChip } from '../badges'
import { ChangedValue } from '../Motion'

export interface SidebarFreshProps {
  /** env → newest line (latestByEnv(meta)); {} when /api/meta failed. */
  latest: Record<string, string>
  /** Engine clock of that meta answer (ISO); null when /api/meta failed. */
  now: string | null
  envs: string[]
  /** The user reads only `envs`, one at a time. */
  limited?: boolean
}

export function SidebarFresh({ latest, now, envs, limited }: SidebarFreshProps) {
  const sp = useSearchParams()
  const pathname = usePathname()
  return <FreshLines latest={latest} now={now} envs={envs} env={parseScope(sp, screenFromPath(pathname) ?? 'overview', { envs, limited }).env} toParam={get(sp, 'to')} />
}

/** Server fallback (no search params yet): the default env and a range that ends now. */
export function SidebarFreshFallback({ latest, now, envs, limited }: SidebarFreshProps) {
  return <FreshLines latest={latest} now={now} envs={envs} env={parseScope(undefined, 'overview', { envs, limited }).env} />
}

function FreshLines({ latest, now, env, toParam }: SidebarFreshProps & { env: string | undefined; toParam?: string }) {
  if (!now) {
    return <span className="sidebar__fresh">ข้อมูลล่าสุด –</span>
  }
  const nowMs = Date.parse(now)
  const f = freshness(latest, env, nowMs)
  const endsNow = !toParam || toParam === 'now'
  const where = env ? `env ${env}` : 'ทุก env'
  return (
    <>
      {f.fresh ? null : (
        <StateChip
          state="warn"
          title={
            f.newest
              ? `${where}: บรรทัดล่าสุดเมื่อ ${fmtDateTime(f.newest)} ICT · ถ้าแอปยังทำงานอยู่ ให้ดู queue และ engine (scripts/live.sh status)`
              : `${where} ยังไม่มี log ในข้อมูลที่เก็บไว้`
          }
        >
          {f.newest && f.ageMs !== null ? `ไม่มีข้อมูลใหม่ ${fmtAge(f.ageMs)}` : 'ยังไม่มีข้อมูลของ env นี้'}
        </StateChip>
      )}
      <span className="sidebar__fresh">
        {f.fresh && endsNow ? <Live /> : null}
        ข้อมูลล่าสุด{' '}
        <ChangedValue value={f.newest} className="ts">
          {f.newest ? fmtNewest(f.newest, nowMs) : '–'}
        </ChangedValue>{' '}
        {f.newest ? 'ICT' : null}
      </span>
    </>
  )
}
