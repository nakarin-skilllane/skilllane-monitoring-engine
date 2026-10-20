'use client'

/**
 * Modal side drawer (port of app.js §3), open state in the URL: the drawer whose
 * `param=value` is in the search params is open, so a drawer link can be shared and
 * Back closes it. While open: aria-modal, the rest of `.app` is inert, Tab stays
 * inside, Esc / scrim / × close it, and focus returns to the element that opened it.
 * Opened by a click it slides in and moves focus to the title ([data-drawer-focus] wins);
 * a page loaded with the param shows it open without moving focus (like ?drawer=).
 *
 * The page renders the content server-side for the selected item:
 *   const id = p.str('log')
 *   <DrawerLink param="log" value={row.id} className="lg-title">{title}</DrawerLink>
 *   {selected && <Drawer id="lg-drawer" param="log" value={id} title={…} sub={…} foot={…}>…</Drawer>}
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { withParams } from '@/lib/params'
import { useShell } from './shell/AppFrame'
import { Icon } from './icons'
import { motionAllowed } from './useInView'

/** The opener of the drawer being opened (focus returns to it), and whether opening pushed a history entry. */
let lastOpener: HTMLElement | null = null
let pushedByLink = false

const SLIDE_MS = 200

export interface DrawerProps {
  /** Element id (aria ids derive from it). */
  id: string
  /** Search param holding the open drawer (default `drawer`). */
  param?: string
  /** Value of `param` that opens this drawer. */
  value: string
  title: ReactNode
  /** `.drawer__sub` line above the title (level, time, service, env …). */
  sub?: ReactNode
  /** `.drawer__foot` actions. */
  foot?: ReactNode
  /** 760 px instead of 560 px. */
  wide?: boolean
  className?: string
  /** Label of the close button. */
  closeLabel?: string
  children: ReactNode
}

export function Drawer({ id, param = 'drawer', value, title, sub, foot, wide, className, closeLabel = 'ปิด', children }: DrawerProps) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const { setModal } = useShell()
  const urlOpen = sp.get(param) === value
  const [mounted, setMounted] = useState(false)
  // A page loaded with the param starts open (no slide-in, focus stays); a click slides it in.
  const [shown, setShown] = useState(() => urlOpen && !lastOpener)
  const ref = useRef<HTMLElement | null>(null)
  const closing = useRef(false)

  useEffect(() => setMounted(true), [])

  // URL → visible state. Two frames so the closed position is styled before the transition.
  useEffect(() => {
    if (!mounted) return
    if (!urlOpen) {
      setShown(false)
      return
    }
    closing.current = false
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setShown(true))
    })
    return () => cancelAnimationFrame(raf)
  }, [urlOpen, mounted])

  // modal while shown; focus in on open, back to the opener on close
  useEffect(() => {
    if (!shown) return
    setModal(true)
    const el = ref.current
    if (el && lastOpener) {
      const f = el.querySelector<HTMLElement>('[data-drawer-focus]') ?? el.querySelector<HTMLElement>('.drawer__title')
      if (f) {
        if (!f.hasAttribute('tabindex')) f.setAttribute('tabindex', '-1')
        f.focus()
      }
    }
    return () => {
      setModal(false)
      const back = lastOpener
      lastOpener = null
      if (back?.isConnected) window.setTimeout(() => back.focus(), 0)
    }
  }, [shown, setModal])

  const close = useCallback(() => {
    if (closing.current) return
    closing.current = true
    setShown(false)
    const go = () => {
      if (pushedByLink) {
        pushedByLink = false
        router.back()
      } else {
        router.replace(withParams(pathname, sp, { [param]: null }), { scroll: false })
      }
    }
    if (!motionAllowed()) go()
    else window.setTimeout(go, SLIDE_MS)
  }, [router, pathname, sp, param])

  // Esc closes; Tab stays inside
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'Tab') return
      const f = Array.from(
        el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'),
      ).filter((x) => x.offsetWidth || x.offsetHeight || x.getClientRects().length)
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (!el.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shown, close])

  if (!mounted || (!urlOpen && !shown)) return null
  const titleId = `${id}-title`
  return createPortal(
    <>
      <div className={shown ? 'scrim is-on' : 'scrim'} aria-hidden="true" onClick={close} />
      <aside
        ref={ref}
        id={id}
        className={['drawer', wide ? 'drawer--wide' : '', shown ? 'is-open' : '', className ?? ''].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-hidden={!shown}
        aria-labelledby={titleId}
      >
        <div className="drawer__head">
          <div className="drawer__heading">
            {sub ? <div className="drawer__sub">{sub}</div> : null}
            <h2 className="drawer__title" id={titleId}>
              {title}
            </h2>
          </div>
          <button className="btn-icon" type="button" aria-label={closeLabel} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {foot ? <div className="drawer__foot">{foot}</div> : null}
      </aside>
    </>,
    document.body,
  )
}

/**
 * For openers that are not a DrawerLink (a clickable row that calls router.push itself):
 * call before navigating so focus moves into the drawer and returns to `el` on close.
 */
export function rememberDrawerOpener(el: HTMLElement, pushed = true): void {
  lastOpener = el
  pushedByLink = pushed
}

/**
 * A link that opens a drawer: sets `param=value` on the current URL (history push, no
 * scroll) and remembers itself for focus return. Renders <a>; style it with className.
 */
export function DrawerLink({
  param = 'drawer',
  value,
  className,
  children,
  ariaLabel,
  title,
}: {
  param?: string
  value: string
  className?: string
  children: ReactNode
  ariaLabel?: string
  title?: string
}) {
  const pathname = usePathname()
  const sp = useSearchParams()
  const open = sp.get(param) === value
  return (
    <Link
      href={withParams(pathname, sp, { [param]: value })}
      scroll={false}
      // one per row: no prefetch (it would re-render the page per row on every 30 s refresh)
      prefetch={false}
      className={className}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      title={title}
      onClick={(e) => {
        lastOpener = e.currentTarget
        pushedByLink = true
      }}
    >
      {children}
    </Link>
  )
}
