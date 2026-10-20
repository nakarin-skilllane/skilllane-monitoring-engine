'use client'

/**
 * The histogram plot (`.chart__plot[data-time-axis]`, starts scrolled to the newest bucket on phones) with
 * its interactions: click a bar = zoom to that bucket, drag across bars (mouse) = pick that range. Both set
 * from / to in the URL (env and filters stay; paging and the drawer reset). Bars are the `.c-hit` columns
 * with data-t0 / data-t1 (bucket start / end, ISO).
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type ReactNode, useEffect, useRef } from 'react'
import { withParams } from '@/lib/params'

export function HistBrush({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const drag = useRef<{ start: number; end: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])

  const hits = () => Array.from(ref.current?.querySelectorAll<SVGRectElement>('.c-hit') ?? [])
  const indexOf = (el: Element | null) => {
    const hit = el?.closest?.('.c-hit')
    return hit ? hits().indexOf(hit as SVGRectElement) : -1
  }
  const paint = (a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    hits().forEach((h, i) => h.classList.toggle('is-sel', a >= 0 && i >= lo && i <= hi))
  }
  const go = (a: number, b: number) => {
    const list = hits()
    const lo = list[Math.min(a, b)]
    const hi = list[Math.max(a, b)]
    const from = lo?.getAttribute('data-t0')
    const to = hi?.getAttribute('data-t1')
    if (!from || !to) return
    router.push(withParams(pathname, sp, { from, to, before: null, limit: null, drawer: null }), { scroll: false })
  }

  return (
    <div
      ref={ref}
      className="chart__plot"
      data-time-axis=""
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return
        const i = indexOf(e.target as Element)
        if (i < 0) return
        e.preventDefault()
        drag.current = { start: i, end: i, moved: false }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const i = indexOf(document.elementFromPoint(e.clientX, e.clientY))
        if (i < 0 || i === d.end) return
        d.end = i
        d.moved = true
        paint(d.start, d.end)
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (!d?.moved) return
        suppressClick.current = true
        go(d.start, d.end)
      }}
      onPointerLeave={() => {
        if (!drag.current) return
        drag.current = null
        paint(-1, -1)
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        const i = indexOf(e.target as Element)
        if (i < 0) return
        paint(i, i)
        go(i, i)
      }}
    >
      {children}
    </div>
  )
}
