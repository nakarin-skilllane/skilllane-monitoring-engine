'use client'

/**
 * The `.app` grid plus everything app.js added to <body>: the scrim, the polite live region
 * (#sr-live, see lib/announce.ts) and the tooltip host. Holds the mobile nav state and makes
 * `.app` inert while a modal drawer is open (useShell().setModal). While the off-canvas nav is
 * open (< 900 px) the rest of the app (`.main`: top bar + content) is inert, so Tab stays in the
 * menu. MotionRoot runs the design's reveal layer (components/Motion.tsx) for every screen.
 */
import { usePathname } from 'next/navigation'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { LIVE_REGION_ID } from '@/lib/announce'
import { MotionRoot } from '../Motion'
import { TooltipHost } from '../Tooltip'

interface ShellState {
  navOpen: boolean
  /** Open/close the off-canvas sidebar (< 900 px); `from` gets focus back on close. */
  setNav: (open: boolean, from?: HTMLElement | null) => void
  /** A modal (drawer) is open: `.app` becomes inert. Counted, so nested calls are safe. */
  setModal: (open: boolean) => void
}

const ShellContext = createContext<ShellState | null>(null)

/** Width below which the sidebar is off-canvas (design-system.css `@media (max-width: 899px)`). */
const OFF_CANVAS = '(max-width: 899px)'
const mainEl = () => document.querySelector<HTMLElement>('.app > .main')

export function useShell(): ShellState {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error('useShell() must be used inside <AppFrame>')
  return ctx
}

export function AppFrame({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false)
  const [modals, setModals] = useState(0)
  const opener = useRef<HTMLElement | null>(null)
  const pathname = usePathname()

  const setNav = useCallback((open: boolean, from?: HTMLElement | null) => {
    setNavOpen(open)
    if (open) {
      opener.current = from ?? null
      // focus the current screen in the menu once the panel is visible
      window.setTimeout(() => {
        const cur =
          document.querySelector<HTMLElement>('.sidebar .nav-item[aria-current="page"]') ??
          document.querySelector<HTMLElement>('.sidebar .nav-item')
        cur?.focus()
      }, 0)
    } else if (opener.current) {
      // the opener (menu button) is in .main: not inert any more before it takes focus back
      const main = mainEl()
      if (main) main.inert = false
      opener.current.focus()
      opener.current = null
    }
  }, [])

  // Off-canvas nav open: the page behind the scrim is inert (Tab walks the menu only), like a drawer.
  useEffect(() => {
    const main = mainEl()
    if (!main || !navOpen) return
    const mq = window.matchMedia(OFF_CANVAS)
    const apply = () => {
      main.inert = mq.matches
    }
    apply()
    mq.addEventListener('change', apply)
    return () => {
      mq.removeEventListener('change', apply)
      main.inert = false
    }
  }, [navOpen])

  const setModal = useCallback((open: boolean) => setModals((n) => Math.max(0, n + (open ? 1 : -1))), [])

  // A nav link was followed: close the menu without moving focus back to the menu button.
  useEffect(() => {
    opener.current = null
    setNavOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modals) setNav(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen, modals, setNav])

  const value = useMemo(() => ({ navOpen, setNav, setModal }), [navOpen, setNav, setModal])

  return (
    <ShellContext.Provider value={value}>
      <div className={navOpen ? 'app nav-open' : 'app'} inert={modals > 0 || undefined}>
        {children}
      </div>
      <div className={navOpen ? 'scrim is-on' : 'scrim'} aria-hidden="true" onClick={() => setNav(false)} />
      <div id={LIVE_REGION_ID} className="sr-only" aria-live="polite" />
      <TooltipHost />
      <MotionRoot />
    </ShellContext.Provider>
  )
}

/**
 * The menu button (top bar, < 900 px) and the × in the sidebar. `controls` = the top-bar
 * button (aria-controls + aria-expanded); the sidebar close button has neither.
 */
export function NavToggle({ controls, label, className, children }: { controls?: boolean; label: string; className: string; children: ReactNode }) {
  const { navOpen, setNav } = useShell()
  return (
    <button
      className={className}
      type="button"
      data-nav-toggle=""
      aria-controls={controls ? 'sidebar' : undefined}
      aria-expanded={controls ? navOpen : undefined}
      aria-label={label}
      onClick={(e) => setNav(!navOpen, navOpen ? null : e.currentTarget)}
    >
      {children}
    </button>
  )
}
