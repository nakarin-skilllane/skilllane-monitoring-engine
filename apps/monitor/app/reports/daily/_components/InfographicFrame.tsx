'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * The engine's infographic page (/api/reports/daily/render through the /engine rewrite, same
 * origin, so the session cookie goes along) in an iframe as tall as its content: the picture on
 * screen is the HTML the PNG / PDF export prints.
 */
export function InfographicFrame({ env, date, tab }: { env: string; date: string; tab: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const fit = useCallback(() => {
    const frame = ref.current
    const html = frame?.contentDocument?.documentElement
    // offsetHeight: the content (scrollHeight is never below the iframe's own height); 0 while the tab is hidden
    if (frame && html && html.offsetHeight > 0) frame.style.height = `${html.offsetHeight}px`
  }, [])
  const watch = useCallback(() => {
    const body = ref.current?.contentDocument?.body
    if (!body) return
    observer.current?.disconnect()
    // also fires when a hidden tab is shown: its page lays out then
    observer.current = new ResizeObserver(fit)
    observer.current.observe(body)
    fit()
  }, [fit])
  useEffect(() => {
    // the page may have loaded before hydration attached onLoad
    if (ref.current?.contentDocument?.readyState === 'complete') watch()
    return () => observer.current?.disconnect()
  }, [watch])
  const src = `/engine/reports/daily/render?${new URLSearchParams({ env, date, tab, view: 'infographic' })}`
  return <iframe ref={ref} className="rp-frame" src={src} title={`Infographic ${tab === 'detail' ? 'รายละเอียด' : 'ภาพรวม'} ${date}`} onLoad={watch} />
}
