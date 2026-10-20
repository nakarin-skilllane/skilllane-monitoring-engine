'use client'

/**
 * Re-renders the page's server components every `seconds` (router.refresh keeps the old
 * view until the new one is ready: no flash, no loading state). Pauses while the tab is
 * hidden; the button toggles it (aria-pressed = on). Put it in the page-head actions.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { Icon } from './icons'

export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter()
  const [on, setOn] = useState(true)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') startTransition(() => router.refresh())
    }, seconds * 1000)
    return () => window.clearInterval(id)
  }, [on, seconds, router])

  const label = on ? `อัปเดตทุก ${seconds} วินาที` : 'หยุดอัปเดตอยู่'
  return (
    <button
      className={`btn btn--quiet ui-refresh${pending ? ' is-pending' : ''}`}
      type="button"
      aria-pressed={on}
      title={on ? 'กดเพื่อหยุดอัปเดตอัตโนมัติ' : 'กดเพื่ออัปเดตอัตโนมัติอีกครั้ง'}
      onClick={() => setOn((v) => !v)}
    >
      <Icon name={on ? 'refresh' : 'pause'} />
      <span>{label}</span>
    </button>
  )
}
