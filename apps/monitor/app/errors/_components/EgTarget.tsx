'use client'

/**
 * The row a `#g-<fingerprint>` link points at (the "Group ใหม่" KPI) gets `.is-target`, the look of the mockup's
 * `.eg-row:target`, is scrolled into view and focused. A client-side navigation (next/link) never sets :target,
 * so this runs after every navigation of /errors, on hashchange, and after a click on a `#g-` link. Renders nothing.
 */
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

/** The hash already scrolled to: a later tab switch (it rewrites the URL) does not jump back to the row. */
let done = ''

function apply() {
  if (window.location.hash === done) return
  const id = decodeURIComponent(window.location.hash.slice(1))
  document.querySelectorAll('.eg-row.is-target').forEach((el) => {
    if (el.id !== id) el.classList.remove('is-target')
  })
  if (!id.startsWith('g-')) return
  const el = document.getElementById(id)
  // a row in a hidden tab panel has no box: the tab follows the URL first (Tabs), then this runs again
  if (!el || !el.getClientRects().length) return
  el.classList.add('is-target')
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  const smooth = document.documentElement.dataset.motion === 'on'
  el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  el.focus({ preventScroll: true })
  done = window.location.hash
}

export function EgTarget() {
  const pathname = usePathname()
  const sp = useSearchParams()
  useEffect(() => {
    const raf = requestAnimationFrame(apply)
    let timer = 0
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest('a[href*="#g-"]') : null
      if (!a) return
      done = ''
      window.clearTimeout(timer)
      timer = window.setTimeout(apply, 60)
    }
    const onHash = () => {
      done = ''
      apply()
    }
    window.addEventListener('hashchange', onHash)
    document.addEventListener('click', onClick)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('click', onClick)
    }
  }, [pathname, sp])
  return null
}
