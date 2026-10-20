'use client'

/**
 * Tooltips (port of app.js §6). Any element with
 *   data-tip="title|value::name|value::name"  (+ data-tip-keys="svc-1,danger-solid")
 * shows a floating `.tip` on hover and on keyboard focus; the keys colour each line's
 * key with var(--<key>). Build the attributes with tipAttrs() from lib/chart.ts.
 * A tooltip shown for keyboard focus follows its element when the page scrolls (Tab to a
 * mark below the fold scrolls it into view right after focusin); a pointer tooltip hides.
 * <TooltipHost /> is mounted once by AppFrame; <Tip> is a convenience wrapper.
 * A tooltip never holds the only copy of a value (DESIGN.md §7).
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { tipAttrs } from '@/lib/chart'

export function TooltipHost() {
  const tipRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const tip = document.createElement('div')
    tip.className = 'tip tip--float'
    tip.setAttribute('role', 'tooltip')
    tip.hidden = true
    document.body.appendChild(tip)
    tipRef.current = tip

    function show(el: Element, x: number, y: number) {
      tip.textContent = ''
      const keys = (el.getAttribute('data-tip-keys') || '').split(',')
      ;(el.getAttribute('data-tip') || '').split('|').forEach((part, i) => {
        const line = document.createElement('div')
        if (i === 0) {
          line.className = 'tip__title'
          line.textContent = part
          tip.appendChild(line)
          return
        }
        line.className = 'tip__line'
        const k = keys[i - 1]?.trim()
        if (k) {
          const key = document.createElement('span')
          key.className = 'tip__key'
          key.style.setProperty('--c', `var(--${k})`)
          line.appendChild(key)
        }
        const [value, name] = part.split('::')
        const v = document.createElement('span')
        v.className = 'tip__val'
        v.textContent = value
        line.appendChild(v)
        if (name) {
          const n = document.createElement('span')
          n.className = 'tip__name'
          n.textContent = name
          line.appendChild(n)
        }
        tip.appendChild(line)
      })
      tip.hidden = false
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      let left = x + 14
      let top = y + 14
      if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 14)
      if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 14)
      tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`
    }
    // the element whose tooltip is shown for keyboard focus (null: none, or a pointer tooltip)
    let focused: Element | null = null
    let frame = 0
    const hide = () => {
      tip.hidden = true
      focused = null
    }
    const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null)
    const showAt = (el: Element) => {
      const r = el.getBoundingClientRect()
      show(el, r.left + r.width / 2, r.top + r.height / 2)
    }
    const onMove = (e: PointerEvent) => {
      // the browser's own hover update after a scroll (no movement) keeps a keyboard tooltip
      if (focused && !e.movementX && !e.movementY) return
      const el = target(e)
      focused = null
      if (el) show(el, e.clientX, e.clientY)
      else hide()
    }
    const onFocus = (e: FocusEvent) => {
      const el = target(e)
      if (!el) return hide()
      focused = el
      showAt(el)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => {
      if (!focused || tip.hidden) return hide()
      // keyboard focus: the browser scrolls the focused mark into view after focusin; follow it
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (focused && focused.isConnected && document.activeElement?.closest('[data-tip]') === focused) showAt(focused)
        else hide()
      })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', onKey)
    // capture: inner scrollers (a chart plot, a table) move the mark too
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, { capture: true })
      tip.remove()
    }
  }, [])

  return null
}

/**
 * Wraps content in a focusable span with a tooltip (for text, not chart marks):
 * <Tip title="17 ต.ค. 13:20" lines={[{ value: '1,152', name: 'request', key: 'svc-1' }]}>…</Tip>
 */
export function Tip({
  title,
  lines = [],
  children,
  className,
}: {
  title: string
  lines?: Array<{ value: string; name?: string; key?: string }>
  children: ReactNode
  className?: string
}) {
  return (
    <span className={className} tabIndex={0} {...tipAttrs(title, lines)}>
      {children}
    </span>
  )
}
