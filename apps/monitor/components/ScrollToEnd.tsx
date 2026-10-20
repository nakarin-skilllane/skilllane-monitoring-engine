'use client'

/**
 * `.chart__plot[data-time-axis]`: on a narrow screen the plot scrolls sideways inside
 * itself; it starts at the newest bucket (right edge), like app.js §1b.
 */
import { type ReactNode, useEffect, useRef } from 'react'

export function TimeAxisPlot({ children, className = 'chart__plot' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  return (
    <div ref={ref} className={className} data-time-axis="">
      {children}
    </div>
  )
}
