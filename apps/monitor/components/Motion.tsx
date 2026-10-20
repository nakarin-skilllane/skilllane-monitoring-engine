'use client'

/**
 * The design's motion layer (DESIGN.md §7b; port of app.js §1d reveal + §8 window.skMonitor). The switch
 * `<html data-motion>` is set by lib/motion.ts MOTION_BOOT_SCRIPT before first paint.
 *
 *   <MotionRoot />            once, in AppFrame: every REVEAL target (.chart .kpi .spark-inline .wf .dur
 *                             .badge-new [data-mo]) gets `.is-in` when it first scrolls into view, then a
 *                             'mo:in' event; also elements that arrive later (client navigation, refresh).
 *                             Screens get the entrances by using the shared components or those classes.
 *   <ChangedValue value={x}>  flashes (.is-changed) when `value` changes after the first render
 *   <LiveTbody resetKey={…}>  rows (tr[data-key]) that were not there before the last render slide in and
 *                             keep a highlight for 2 s (tr.is-new); resetKey = the filters (new filters ≠ new rows)
 *   useNewKeys(keys)          the same for client-rendered lists: the set of keys that just arrived
 *   reveal(el) · replay(el) · flash(el) · window.skMonitor { motion, reveal, replay, setValue, addRow }
 *   [data-mo-replay="#id"]    a button that plays that element's entrance again
 *   [data-mo-count]           a plain number ("1,180", "0.16") inside a reveal target counts up from 0
 *
 * Charts (components/charts) render their motion markup themselves (svg[data-mo-ready]: bar baselines,
 * --mo-x, pathLength + .mo-draw, the "now" ring); any other svg in a reveal target is prepared on reveal.
 * KPI numbers count up with <AnimatedNumber>. The 3D views start when they come near the viewport.
 */
import { createElement, type ElementType, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motionOn, NEW_ROW_MS, REVEAL_SELECTOR } from '@/lib/motion'

const SVGNS = 'http://www.w3.org/2000/svg'
const COUNT_MS = 600

export interface SkMonitor {
  motion: boolean
  reveal: (el: Element | null) => void
  replay: (el: Element | null) => void
  setValue: (el: Element, text: string) => void
  addRow: (tbody: Element, tr: Element) => void
}

declare global {
  interface Window {
    /** Set by MotionRoot: the boot script's 5 s safety switch-off is not needed. */
    __skMotion?: boolean
    skMonitor?: SkMonitor
  }
}

type Marked = Element & { __mo?: boolean }

// Elements revealed on this page. React rewrites a className when its props change, which drops
// `.is-in`; MotionRoot's class observer puts it back without playing the entrance again.
let revealed = new WeakSet<Element>()

/** Prepare one svg the first time it is seen: bar baselines, left-to-right position, line lengths, "now" rings. */
function prepSvg(svg: SVGSVGElement) {
  const m = svg as unknown as Marked
  if (m.__mo || svg.hasAttribute('data-mo-ready')) return
  m.__mo = true
  const vb = svg.viewBox?.baseVal
  let bb: DOMRect
  try {
    bb = svg.getBBox()
  } catch {
    return
  }
  const hasVb = !!(vb && vb.width)
  const x0 = hasVb ? vb.x : bb.x
  const w = (hasVb ? vb.width : bb.width) || 1
  const y0 = hasVb ? vb.y : 0
  // horizontal axis lines: a bar grows from the nearest one below it (one svg may hold two stacked plots)
  const axes: number[] = []
  svg.querySelectorAll<SVGLineElement>('line.c-axis').forEach((l) => {
    const a = l.y1.baseVal.value
    if (Math.abs(a - l.y2.baseVal.value) < 0.01) axes.push(a)
  })
  const bars = Array.from(svg.querySelectorAll<SVGGraphicsElement>('.c-bar'))
  const boxes = bars.map((b) => {
    try {
      return b.getBBox()
    } catch {
      return null
    }
  })
  let lowest = 0
  for (const b of boxes) if (b) lowest = Math.max(lowest, b.y + b.height)
  bars.forEach((bar, i) => {
    const b = boxes[i]
    if (!b) return
    const bottom = b.y + b.height
    let base: number | null = null
    for (const a of axes) if (a >= bottom - 1 && (base === null || a < base)) base = a
    bar.style.transformOrigin = `0 ${(base ?? lowest) - y0}px`
    bar.style.setProperty('--mo-x', Math.max(0, Math.min(1, (b.x - x0) / w)).toFixed(3))
  })
  svg.querySelectorAll<SVGGraphicsElement>('.c-dot').forEach((d) => {
    try {
      d.style.setProperty('--mo-x', Math.max(0, Math.min(1, (d.getBBox().x - x0) / w)).toFixed(3))
    } catch {
      // not rendered
    }
  })
  svg.querySelectorAll('.c-line, .spark__line').forEach((line) => {
    line.setAttribute('pathLength', '1')
    line.classList.add('mo-draw')
    // the end dot that follows a line is the newest value: it pops in after the line and breathes
    for (let n = line.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.matches('.c-line, .spark__line')) break
      if (n.matches('circle.c-dot, circle.spark__dot')) {
        n.classList.add('mo-now')
        const ring = document.createElementNS(SVGNS, 'circle')
        const cls = n.classList.contains('spark__dot') ? 'mo-ring mo-ring--spark' : `mo-ring ${(n.getAttribute('class') ?? '').replace(/\b(c-dot|mo-now)\b/g, '').trim()}`
        ring.setAttribute('class', cls.trim())
        for (const a of ['cx', 'cy', 'r']) ring.setAttribute(a, n.getAttribute(a) ?? '0')
        ring.setAttribute('aria-hidden', 'true')
        n.parentNode?.insertBefore(ring, n)
        break
      }
    }
  })
}

/**
 * [data-mo-count]: count a plain number ("1,180", "0.16", "345,600") up from 0 in 600 ms, then restore the
 * exact text. Dates, times, ranges and numbers under 10 without decimals stay as they are. Stops when React
 * renders a new value into the text node meanwhile.
 */
function countUp(el: Element) {
  const m0 = el as Marked
  if (m0.__mo) return
  m0.__mo = true
  let node: Text | null = null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && /\d/.test(n.nodeValue ?? '')) {
      node = n as Text
      break
    }
  }
  if (!node) return
  const text = node.nodeValue ?? ''
  const m = /^(\s*)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*)$/.exec(text)
  if (!m) return
  const dec = m[3] ? m[3].length - 1 : 0
  const target = parseFloat((m[2] + (m[3] ?? '')).replace(/,/g, ''))
  if (target < 10 && !dec) return
  const fmt = (v: number) => m[1] + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[4]
  const tn = node
  let last = fmt(0)
  let t0: number | null = null
  el.classList.add('is-counting')
  tn.nodeValue = last
  const step = (ts: number) => {
    if (tn.nodeValue !== last) {
      el.classList.remove('is-counting')
      return
    }
    if (t0 === null) t0 = ts
    const p = Math.min(1, (ts - t0) / COUNT_MS)
    if (p < 1) {
      last = fmt(target * (1 - (1 - p) ** 3))
      tn.nodeValue = last
      requestAnimationFrame(step)
    } else {
      tn.nodeValue = text
      el.classList.remove('is-counting')
    }
  }
  requestAnimationFrame(step)
}

/**
 * Has React hydrated this server-rendered element yet? Page content streams in its own Suspense boundary
 * (app/loading.tsx) and may hydrate after MotionRoot started; changing its classes or text before that
 * is a hydration mismatch. React marks every element it owns with a `__reactFiber$…` key.
 */
function hydrated(el: Element): boolean {
  return Object.keys(el).some((k) => k.startsWith('__reactFiber$'))
}

/** Reveal an element and every reveal target inside it (`.is-in` + 'mo:in'); not-yet-hydrated ones are skipped. */
export function reveal(el: Element | null) {
  if (!el || el.classList.contains('is-in')) return
  const targets = [el, ...Array.from(el.querySelectorAll(REVEAL_SELECTOR))]
  for (const t of targets) {
    if (t.classList.contains('is-in') || !hydrated(t)) continue
    if (t instanceof SVGSVGElement) prepSvg(t)
    else t.querySelectorAll('svg').forEach(prepSvg)
    t.classList.add('is-in')
    revealed.add(t)
    if (t.matches('[data-mo-count]')) countUp(t)
    t.querySelectorAll('[data-mo-count]').forEach(countUp)
    t.dispatchEvent(new CustomEvent('mo:in'))
  }
}

/** Play an element's entrance again (after new data replaced a chart, or a demo button). */
export function replay(el: Element | null) {
  if (!motionOn() || !el) return
  const targets = [el, ...Array.from(el.querySelectorAll(REVEAL_SELECTOR))]
  for (const t of targets) {
    revealed.delete(t)
    t.classList.remove('is-in')
  }
  for (const v of [el, ...Array.from(el.querySelectorAll('[data-mo-count]'))]) (v as Marked).__mo = false
  void (el as HTMLElement).getBoundingClientRect()
  reveal(el)
}

/** Flash the tint of a changed value once (`.is-changed`, fades over --dur-linger). */
export function flash(el: Element) {
  el.classList.remove('is-changed')
  void (el as HTMLElement).getBoundingClientRect()
  el.classList.add('is-changed')
}

/** DOM version of setValue (window.skMonitor): replace the first text (unit spans stay) and flash. */
function setValue(el: Element, text: string) {
  let node: ChildNode | null = null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && /\S/.test(n.nodeValue ?? '')) {
      node = n
      break
    }
  }
  if (node) node.nodeValue = text
  else el.insertBefore(document.createTextNode(text), el.firstChild)
  flash(el)
}

function markNew(tr: Element) {
  tr.classList.add('is-new')
  window.setTimeout(() => tr.classList.remove('is-new'), NEW_ROW_MS)
}

/** DOM version of a new row (window.skMonitor.addRow): insert on top, it slides in and its highlight fades. */
function addRow(tbody: Element, tr: Element) {
  tbody.insertBefore(tr, tbody.firstElementChild)
  markNew(tr)
}

/** Once, in AppFrame. Renders nothing. */
export function MotionRoot() {
  useEffect(() => {
    window.__skMotion = true
    const on = motionOn()
    window.skMonitor = { motion: on, reveal, replay, setValue, addRow }
    if (!on) return
    revealed = new WeakSet()
    // in view but not hydrated yet: retried every 100 ms (revealed anyway after 8 s, e.g. non-React markup)
    const waiting = new Map<Element, number>()
    let timer = 0
    const retry = () => {
      timer = 0
      const now = performance.now()
      for (const [el, since] of waiting) {
        if (!el.isConnected) waiting.delete(el)
        else if (hydrated(el) || now - since > 8000) {
          waiting.delete(el)
          forceReveal(el)
        }
      }
      if (waiting.size) timer = window.setTimeout(retry, 100)
    }
    const forceReveal = (el: Element) => {
      if (hydrated(el)) reveal(el)
      else {
        // markup React does not own: reveal it as app.js would
        el.classList.add('is-in')
        revealed.add(el)
        el.dispatchEvent(new CustomEvent('mo:in'))
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          io.unobserve(en.target)
          if (hydrated(en.target)) reveal(en.target)
          else {
            waiting.set(en.target, performance.now())
            if (!timer) timer = window.setTimeout(retry, 100)
          }
        }
      },
      { rootMargin: '0px 0px -32px 0px' },
    )
    const watch = (root: Element) => {
      if (root.matches(REVEAL_SELECTOR) && !root.classList.contains('is-in')) io.observe(root)
      root.querySelectorAll(REVEAL_SELECTOR).forEach((el) => {
        if (!el.classList.contains('is-in')) io.observe(el)
      })
    }
    watch(document.body)
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach((n) => {
            if (n.nodeType === 1) watch(n as Element)
          })
          continue
        }
        const el = r.target as Element
        if (el.classList.contains('is-in')) continue
        if (revealed.has(el)) el.classList.add('is-in')
        else if (el.matches(REVEAL_SELECTOR)) io.observe(el)
      }
    })
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    const onClick = (e: MouseEvent) => {
      const b = (e.target as Element | null)?.closest?.('[data-mo-replay]')
      const sel = b?.getAttribute('data-mo-replay')
      if (sel) replay(document.querySelector(sel))
    }
    document.addEventListener('click', onClick)
    return () => {
      window.clearTimeout(timer)
      io.disconnect()
      mo.disconnect()
      document.removeEventListener('click', onClick)
    }
  }, [])
  return null
}

/**
 * A value that flashes its tint when it changes after the first render (auto refresh, live data).
 * Renders `children` (or the value as text) in a span (or `as`).
 *
 *   <ChangedValue value={meta.now}><span className="ts">{fmtTimeSec(meta.now)}</span></ChangedValue>
 */
export function ChangedValue({ value, children, as = 'span', className }: { value: unknown; children?: ReactNode; as?: ElementType; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const prev = useRef(value)
  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    if (ref.current && motionOn()) flash(ref.current)
  }, [value])
  return createElement(as, { ref, className }, children ?? String(value))
}

/**
 * `<tbody>` whose rows carry `data-key`: a row that was not there before the last render (auto refresh)
 * slides in and keeps a highlight that fades (tr.is-new, 2 s). The first render marks nothing; a change
 * of `resetKey` (other filters, range, page) starts over instead of marking every row.
 *
 *   <LiveTbody resetKey={`${scope.env}|${level}|${q}`}>{rows.map((r) => <tr key={k} data-key={k}>…</tr>)}</LiveTbody>
 */
export function LiveTbody({ children, resetKey, className, id }: { children: ReactNode; resetKey?: string; className?: string; id?: string }) {
  const ref = useRef<HTMLTableSectionElement>(null)
  const seen = useRef<{ reset?: string; keys: Set<string> } | null>(null)
  useLayoutEffect(() => {
    const tb = ref.current
    if (!tb) return
    const rows = Array.from(tb.querySelectorAll<HTMLTableRowElement>(':scope > tr[data-key]'))
    const prev = seen.current
    seen.current = { reset: resetKey, keys: new Set(rows.map((r) => r.dataset.key ?? '')) }
    if (!prev || prev.reset !== resetKey || !motionOn()) return
    for (const r of rows) if (!prev.keys.has(r.dataset.key ?? '')) markNew(r)
  })
  return (
    <tbody ref={ref} className={className} id={id}>
      {children}
    </tbody>
  )
}

const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * Keys that arrived since the previous render (for client-rendered rows: add `is-new` to their <tr>);
 * cleared after 2 s. The first render, a `resetKey` change and motion off return an empty set.
 */
export function useNewKeys(keys: readonly string[], resetKey?: string): ReadonlySet<string> {
  const seen = useRef<{ reset?: string; keys: Set<string> } | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_KEYS)
  const sig = keys.join('\u0000')
  useEffect(() => {
    const list = sig ? sig.split('\u0000') : []
    const prev = seen.current
    seen.current = { reset: resetKey, keys: new Set(list) }
    const added = prev && prev.reset === resetKey && motionOn() ? list.filter((k) => !prev.keys.has(k)) : []
    if (!added.length) {
      setFresh((f) => (f.size ? NO_KEYS : f))
      return
    }
    setFresh(new Set(added))
    const t = window.setTimeout(() => setFresh(NO_KEYS), NEW_ROW_MS)
    return () => window.clearTimeout(t)
  }, [sig, resetKey])
  return fresh
}
