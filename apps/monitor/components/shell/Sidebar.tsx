/**
 * Sidebar (server): brand "skilllane monitor" (→ /about), nav, foot with the ClickHouse state
 * (/api/health) and "ข้อมูลล่าสุด HH:mm:ss ICT" = the newest line of the selected env (SidebarFresh,
 * from /api/meta releases), with "สด" only while data arrives and the range ends now. Markup of _shell.html.
 */
import Link from 'next/link'
import { Suspense } from 'react'
import type { EngineResult } from '@/lib/engine'
import { latestByEnv } from '@/lib/freshness'
import type { Health, Me, Meta } from '@/lib/types'
import { StateChip } from '../badges'
import { BrandMark, Icon } from '../icons'
import { NavToggle } from './AppFrame'
import { PRODUCT_NAME } from './names'
import { BrandLink } from './BrandLink'
import { NavLinks, NavLinksFallback } from './NavLinks'
import { SidebarFresh, SidebarFreshFallback } from './SidebarFresh'

function HealthState({ health }: { health: EngineResult<Health> }) {
  if (!health.ok) {
    return (
      <StateChip state="down" title={`${health.error.engineUrl}: ${health.error.message}`}>
        ติดต่อ engine ไม่ได้
      </StateChip>
    )
  }
  const h = health.data
  const title = `engine ${h.role} · ${h.transport}${h.pending !== null ? ` · ค้างในคิว ${h.pending}` : ''}`
  if (!h.clickhouse) {
    return (
      <StateChip state="down" title={title}>
        ClickHouse ติดต่อไม่ได้
      </StateChip>
    )
  }
  if (!h.ok) {
    return (
      <StateChip state="warn" title={title}>
        ClickHouse schema มีปัญหา
      </StateChip>
    )
  }
  return (
    <StateChip state="ok" title={title}>
      ClickHouse ปกติ
    </StateChip>
  )
}

const BRAND_TITLE = 'skilllane monitor คืออะไร'

export function Sidebar({ health, meta, me }: { health: EngineResult<Health>; meta: EngineResult<Meta>; me?: Me }) {
  const fresh = {
    latest: meta.ok ? latestByEnv(meta.data) : {},
    now: meta.ok ? meta.data.now : null,
    envs: meta.ok ? meta.data.envs : [],
    limited: meta.ok && !!meta.data.envsLimited,
  }
  return (
    <aside className="sidebar" id="sidebar" aria-label="เมนูหลัก">
      <div className="sidebar__top">
        <Suspense
          fallback={
            <Link className="brand" href="/about" title={BRAND_TITLE} prefetch={false}>
              <BrandMark />
              <span className="brand__name">
                {PRODUCT_NAME}
                <span className="brand__sub">log · trace · error</span>
              </span>
            </Link>
          }
        >
          <BrandLink className="brand" title={BRAND_TITLE}>
            <BrandMark />
            <span className="brand__name">
              {PRODUCT_NAME}
              <span className="brand__sub">log · trace · error</span>
            </span>
          </BrandLink>
        </Suspense>
        <NavToggle className="btn-icon sidebar__close" label="ปิดเมนู">
          <Icon name="close" />
        </NavToggle>
      </div>
      <Suspense fallback={<NavLinksFallback permissions={me?.permissions} />}>
        <NavLinks permissions={me?.permissions} />
      </Suspense>
      <div className="sidebar__foot">
        <HealthState health={health} />
        <Suspense fallback={<SidebarFreshFallback {...fresh} />}>
          <SidebarFresh {...fresh} />
        </Suspense>
      </div>
    </aside>
  )
}
