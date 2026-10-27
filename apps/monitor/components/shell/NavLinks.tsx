'use client'

/**
 * Sidebar navigation (markup and Thai copy of _shell.html): aria-current on the current
 * screen (detail routes count for their list), links keep env / from / to. Under เอกสาร: /about (the mockups'
 * index.html, also the brand link) and the data dictionary.
 * No prefetch on shell links: a prefetch renders the target's loading state, which preloads that screen's CSS
 * (a "preloaded but not used" console warning on every page) and repeats on every 30 s refresh.
 */
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { buildHref, keepOf, type Screen, screenFromPath } from '@/lib/params'
import type { Effective, PermissionId } from '@/lib/types'
import { Icon, type IconName } from '../icons'

const ITEMS: Array<{ href: string; label: string; icon: IconName; screens: Screen[]; permission: PermissionId }> = [
  { href: '/overview', label: 'ภาพรวม', icon: 'overview', screens: ['overview'], permission: 'overview' },
  { href: '/logs', label: 'Log', icon: 'logs', screens: ['logs'], permission: 'logs' },
  { href: '/traces', label: 'Trace', icon: 'traces', screens: ['traces', 'trace'], permission: 'traces' },
  { href: '/errors', label: 'Error', icon: 'errors', screens: ['errors', 'error'], permission: 'errors' },
  { href: '/jobs', label: 'งานเบื้องหลัง', icon: 'jobs', screens: ['jobs'], permission: 'jobs' },
  { href: '/reports/daily', label: 'รายงาน', icon: 'panel', screens: [], permission: 'reports' },
]

/** Managing the monitor (users / roles permission). */
const ADMIN_ITEMS: Array<{ href: string; label: string; icon: IconName; permission: PermissionId }> = [
  { href: '/admin/users', label: 'ผู้ใช้', icon: 'panel', permission: 'users' },
  { href: '/admin/roles', label: 'Role และสิทธิ์', icon: 'filter', permission: 'roles' },
]

/** Without the user (engine unreachable): every screen, as before sign-in existed. */
const can = (permissions: Effective | undefined, permission: PermissionId) => !permissions || !!permissions[permission]

const ABOUT_LABEL = 'เกี่ยวกับหน้าจอชุดนี้'
const ABOUT_TITLE = 'skilllane monitor คืออะไร · ข้อมูลไหลอย่างไร · สัญลักษณ์และหน้าจอทั้งหมด'

export function NavLinks({ permissions }: { permissions?: Effective }) {
  const pathname = usePathname()
  const keep = keepOf(useSearchParams())
  const screen = screenFromPath(pathname)
  const admin = permissions ? ADMIN_ITEMS.filter((item) => permissions[item.permission]) : []
  return (
    <nav className="nav" aria-label="หน้าจอ">
      {ITEMS.filter((item) => can(permissions, item.permission)).map((item) => (
        <Link
          key={item.href}
          className="nav-item"
          href={buildHref(item.href, keep)}
          prefetch={false}
          aria-current={(screen && item.screens.includes(screen)) || pathname?.startsWith(item.href) ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          {item.label}
        </Link>
      ))}
      {admin.length ? <p className="nav__label">จัดการ</p> : null}
      {admin.map((item) => (
        <Link
          key={item.href}
          className="nav-item"
          href={item.href}
          prefetch={false}
          aria-current={pathname?.startsWith(item.href) ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          {item.label}
        </Link>
      ))}
      <p className="nav__label">เอกสาร</p>
      <Link className="nav-item" href={buildHref('/about', keep)} prefetch={false} aria-current={pathname === '/about' ? 'page' : undefined} title={ABOUT_TITLE}>
        <Icon name="info" />
        {ABOUT_LABEL}
      </Link>
      <a className="nav-item" href="/DATA-DICTIONARY.md" title="ชื่อ field ทุกตัวใน log และ trace สำหรับคนและ AI">
        <Icon name="book" />
        พจนานุกรมข้อมูล
        <Icon name="external" size="sm" className="nav-item__ext" />
      </a>
    </nav>
  )
}

/** Static fallback while search params are not available (prerender): same markup, no kept params. */
export function NavLinksFallback({ permissions }: { permissions?: Effective }) {
  return (
    <nav className="nav" aria-label="หน้าจอ">
      {ITEMS.filter((item) => can(permissions, item.permission)).map((item) => (
        <a key={item.href} className="nav-item" href={item.href}>
          <Icon name={item.icon} />
          {item.label}
        </a>
      ))}
      <p className="nav__label">เอกสาร</p>
      <a className="nav-item" href="/about" title={ABOUT_TITLE}>
        <Icon name="info" />
        {ABOUT_LABEL}
      </a>
      <a className="nav-item" href="/DATA-DICTIONARY.md" title="ชื่อ field ทุกตัวใน log และ trace สำหรับคนและ AI">
        <Icon name="book" />
        พจนานุกรมข้อมูล
        <Icon name="external" size="sm" className="nav-item__ext" />
      </a>
    </nav>
  )
}
