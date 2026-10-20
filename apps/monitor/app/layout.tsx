import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans_Thai } from 'next/font/google'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import type { ReactNode } from 'react'
import './design-system.css'
import '@/lib/3d/system-map.css'
import './app.css'
import { AppFrame } from '@/components/shell/AppFrame'
import { PRODUCT_NAME } from '@/components/shell/names'
import { Sidebar } from '@/components/shell/Sidebar'
import { Topbar } from '@/components/shell/Topbar'
import { getHealth, getMe, getMeta } from '@/lib/engine'
import type { Me, PermissionId } from '@/lib/types'
import { latestByEnv } from '@/lib/freshness'
import { MOTION_BOOT_SCRIPT } from '@/lib/motion'
import { THEME_BOOT_SCRIPT } from '@/lib/theme'

// Fonts (DESIGN.md §3): wired to --font-ui / --font-mono in app.css.
const ui = IBM_Plex_Sans_Thai({ weight: ['400', '500', '600'], subsets: ['thai', 'latin'], variable: '--nf-ui', display: 'swap' })
const mono = IBM_Plex_Mono({ weight: ['400', '500', '600'], subsets: ['latin'], variable: '--nf-mono', display: 'swap' })

export const metadata: Metadata = {
  title: { template: `%s · ${PRODUCT_NAME}`, default: PRODUCT_NAME },
  description: 'log · trace · error ของทุกแอปที่ติดตั้ง skilllane-monitoring',
}

/** Pages without the shell and without a session. */
const AUTH_PAGES = ['/login', '/set-password']

/** The permission each screen reads with; the first allowed is where a user without the asked one lands. */
const SCREEN_PERMISSION: Array<[path: string, permission: PermissionId]> = [
  ['/overview', 'overview'],
  ['/logs', 'logs'],
  ['/traces', 'traces'],
  ['/errors', 'errors'],
  ['/jobs', 'jobs'],
  ['/admin/users', 'users'],
  ['/admin/roles', 'roles'],
]

/** Another screen when the user cannot open this one (or /account when none). */
function landingFor(path: string, me: Me): string | undefined {
  const screen = SCREEN_PERMISSION.find(([p]) => path === p || path.startsWith(`${p}/`))
  if (!screen || me.permissions[screen[1]]) return undefined
  return SCREEN_PERMISSION.find(([, permission]) => me.permissions[permission])?.[0] ?? '/account'
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every screen is live data: render per request (never at build time).
  await connection()
  const path = (await headers()).get('x-skilllane-monitoring-path') ?? '/'
  const authPage = AUTH_PAGES.includes(path)
  const me = await getMe()
  // an expired or revoked session (the cookie is still there): sign in again
  if (!me.ok && me.error.status === 401 && !authPage) redirect(`/login?next=${encodeURIComponent(path)}`)
  const landing = me.ok && !authPage ? landingFor(path, me.data) : undefined
  if (landing) redirect(landing)
  if (authPage) {
    return (
      <html lang="th" className={`${ui.variable} ${mono.variable}`} suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: `${THEME_BOOT_SCRIPT};${MOTION_BOOT_SCRIPT}` }} />
        </head>
        <body>
          <main className="auth-page" id="main">
            {children}
          </main>
        </body>
      </html>
    )
  }
  const [health, meta] = await Promise.all([getHealth(), getMeta()])
  const user = me.ok ? me.data : undefined
  return (
    <html lang="th" className={`${ui.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* before first paint: data-theme (?theme=, then the saved choice; lib/theme.ts) and the
            motion switch data-motion (?motion=, reduced motion, headless; lib/motion.ts) */}
        <script dangerouslySetInnerHTML={{ __html: `${THEME_BOOT_SCRIPT};${MOTION_BOOT_SCRIPT}` }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          ข้ามไปที่เนื้อหา
        </a>
        <AppFrame>
          <Sidebar health={health} meta={meta} me={user} />
          <div className="main">
            {/* no Suspense: the shell is rendered per request (connection()), so the top bar comes in order */}
            {/* latest: envs without data in the last hour are listed apart, on every screen (lib/freshness.ts) */}
            <Topbar
              envs={meta.ok ? meta.data.envs : []}
              latest={meta.ok ? latestByEnv(meta.data) : undefined}
              limited={meta.ok && !!meta.data.envsLimited}
              me={user}
            />
            <main className="content" id="main" tabIndex={-1}>
              {children}
            </main>
          </div>
        </AppFrame>
      </body>
    </html>
  )
}
