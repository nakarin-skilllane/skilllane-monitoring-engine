'use client'

/**
 * Tabs (port of app.js §5): `.tabs[role=tablist]` > `button.tab[role=tab]` + `.tab-panel`,
 * roving tabindex, ← → Home End. With `param` the selected tab is kept in the URL so a link can open a
 * tab: the switch is instant (every panel is already rendered) and the URL is updated with
 * history.replaceState, which Next keeps in sync with useSearchParams without a server round trip;
 * back / forward or a link to another tab is followed. Without `param` the choice is local.
 * Panels are rendered by the server and passed in; hidden panels stay in the DOM.
 *
 *   <Tabs label="รายละเอียด span" param="tab" items={[
 *     { key: 'attrs', label: 'Attribute', count: 12, panel: <AttrTable … /> },
 *     { key: 'logs', label: 'Log', count: 4, title: '4 บรรทัด', panel: <LogList … /> },
 *   ]} />
 *
 * Link tabs that change the page (a.tab[aria-current=page]) are plain <Link className="tab"> in a
 * `<div className="tabs">`; put a <TabInk /> last inside it for the sliding ink bar.
 */
import { useSearchParams } from 'next/navigation'
import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'

export interface TabItem {
  key: string
  label: ReactNode
  /** `.tab__count` pill. */
  count?: number | string
  /** title (tooltip) of the tab: `1 group · 66 ครั้ง`. */
  title?: string
  panel: ReactNode
}

export function Tabs({ items, label, param, defaultKey, className }: { items: TabItem[]; label: string; param?: string; defaultKey?: string; className?: string }) {
  const sp = useSearchParams()
  const base = useId()
  const fallback = defaultKey ?? items[0]?.key
  const fromUrl = param ? sp.get(param) : null
  const valid = (k: string | null | undefined) => (k && items.some((t) => t.key === k) ? k : fallback)
  const [selected, setSelected] = useState(valid(fromUrl))
  const [seenUrl, setSeenUrl] = useState(fromUrl)
  // Back / forward or a link to another tab: follow the URL when it changes (render-time sync, no effect).
  if (param && seenUrl !== fromUrl) {
    setSeenUrl(fromUrl)
    setSelected(valid(fromUrl))
  }
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  function select(key: string, focus: boolean) {
    setSelected(key)
    if (param) {
      const url = new URL(window.location.href)
      if (key === fallback) url.searchParams.delete(param)
      else url.searchParams.set(param, key)
      // null state: Next's patched replaceState then syncs useSearchParams (it skips its own __NA states).
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    if (focus) refs.current[items.findIndex((t) => t.key === key)]?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = items.findIndex((t) => t.key === selected)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    select(items[(next + items.length) % items.length].key, true)
  }

  return (
    <div className={className}>
      <div className="tabs has-ink" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el
            }}
            className="tab"
            type="button"
            role="tab"
            id={`${base}-tab-${t.key}`}
            aria-selected={t.key === selected}
            aria-controls={`${base}-panel-${t.key}`}
            tabIndex={t.key === selected ? 0 : -1}
            title={t.title}
            onClick={() => select(t.key, false)}
          >
            {t.label}
            {t.count !== undefined ? <span className="tab__count">{t.count}</span> : null}
          </button>
        ))}
        <TabInk />
      </div>
      {items.map((t) => (
        <div
          key={t.key}
          className="tab-panel"
          role="tabpanel"
          id={`${base}-panel-${t.key}`}
          aria-labelledby={`${base}-tab-${t.key}`}
          tabIndex={0}
          hidden={t.key !== selected}
        >
          {t.panel}
        </div>
      ))}
    </div>
  )
}

/**
 * The sliding ink bar of a `.tabs` list (port of app.js §5 inkFor): place it last inside the list.
 * It follows `[role=tab][aria-selected=true]` or `.tab[aria-current=page]`, re-measures on resize and
 * after the fonts load, and only animates once placed (`.is-ready`), so the first paint never slides.
 */
export function TabInk() {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const ink = ref.current
    const list = ink?.parentElement
    if (!ink || !list) return
    list.classList.add('has-ink')
    const place = () => {
      const cur = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], .tab[aria-current="page"]')
      if (!cur || !cur.offsetWidth) {
        ink.style.width = '0'
        return
      }
      ink.style.width = `${Math.max(0, cur.offsetWidth - 16)}px`
      ink.style.translate = `${cur.offsetLeft + 8}px 0`
    }
    place()
    const raf = requestAnimationFrame(() => list.classList.add('is-ready'))
    const ro = new ResizeObserver(place)
    ro.observe(list)
    const mo = new MutationObserver(place)
    mo.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current'] })
    let live = true
    document.fonts?.ready.then(() => live && place())
    return () => {
      live = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])
  return <span ref={ref} className="tabs__ink" aria-hidden="true" />
}
