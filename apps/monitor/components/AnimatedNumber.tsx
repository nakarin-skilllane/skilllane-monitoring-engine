'use client'

/**
 * A number that counts up from 0 (600 ms, like app.js) the first time it scrolls into view; a later
 * change (auto refresh) shows the new value at once and flashes its tint (`.is-changed`, DESIGN.md §7b).
 * The server renders the final value (no JS, motion off and prefers-reduced-motion all show it as is).
 * Like the design only numbers ≥ 10 or with decimals count. Format: thousands separators + `decimals`.
 *
 *   <span className="kpi__value"><AnimatedNumber value={1180} /><span className="kpi__unit">req/min</span></span>
 */
import { useEffect, useRef, useState } from 'react'
import { fmtNumber } from '@/lib/format'
import { flash } from './Motion'
import { motionAllowed, useInView } from './useInView'

export function AnimatedNumber({ value, decimals = 0, duration = 600, className }: { value: number; decimals?: number; duration?: number; className?: string }) {
  const [ref, inView] = useInView<HTMLSpanElement>()
  const [shown, setShown] = useState(value)
  const [counting, setCounting] = useState(false)
  // idle → counting → done; a cancelled count (strict-mode remount, value changed meanwhile) goes back to idle
  const phase = useRef<'idle' | 'counting' | 'done'>('idle')
  const prev = useRef(value)

  useEffect(() => {
    if (!inView) return
    if (phase.current !== 'done') {
      prev.current = value
      if (!motionAllowed() || !Number.isFinite(value) || (Math.abs(value) < 10 && decimals === 0)) {
        phase.current = 'done'
        setShown(value)
        return
      }
      phase.current = 'counting'
      setCounting(true)
      let raf = 0
      const t0 = performance.now()
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration)
        setShown(value * (1 - (1 - p) ** 3))
        if (p < 1) raf = requestAnimationFrame(tick)
        else {
          phase.current = 'done'
          setCounting(false)
        }
      }
      raf = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(raf)
        if (phase.current === 'counting') phase.current = 'idle'
      }
    }
    if (prev.current === value) return
    prev.current = value
    setShown(value)
    if (ref.current && motionAllowed()) flash(ref.current)
  }, [inView, value, duration, decimals, ref])

  return (
    <span ref={ref} className={className} data-value={value} style={counting ? { fontVariantNumeric: 'tabular-nums' } : undefined}>
      {fmtNumber(shown, decimals)}
    </span>
  )
}
