'use client'

/**
 * Top bar refresh, next to the time range (one control for every screen): `⟳ รีเฟรช` re-renders the page's server
 * components now (router.refresh keeps the old view until the new one is ready: no flash, filters and open rows
 * stay), the select refreshes on its own every 10 s … 5 min or never. The choice is remembered in this browser;
 * a fixed past window (isPastWindow) never refreshes on its own but the button still works (late lines). Paused
 * while the tab is hidden. `r` refreshes too, unless typing.
 */
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, useTransition } from 'react'
import { fmtTimeSec } from '@/lib/format'
import { Icon } from '../icons'

const INTERVALS = [
  { s: 0, label: 'ปิด' },
  { s: 10, label: '10 วิ' },
  { s: 30, label: '30 วิ' },
  { s: 60, label: '1 นาที' },
  { s: 300, label: '5 นาที' },
]
const KEY = 'sm.autoRefresh'
const DEFAULT_S = 30

function stored(): number {
  try {
    const v = Number(window.localStorage.getItem(KEY))
    return INTERVALS.some((i) => i.s === v) && window.localStorage.getItem(KEY) !== null ? v : DEFAULT_S
  } catch {
    return DEFAULT_S
  }
}

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export function RefreshControl({ fixed }: { fixed: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [seconds, setSeconds] = useState(DEFAULT_S)
  const [at, setAt] = useState<number | null>(null)

  useEffect(() => setSeconds(stored()), [])

  const refresh = useCallback(() => {
    startTransition(() => router.refresh())
    setAt(Date.now())
  }, [router])

  const auto = fixed ? 0 : seconds
  useEffect(() => {
    if (!auto) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, auto * 1000)
    return () => window.clearInterval(id)
  }, [auto, refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      e.preventDefault()
      refresh()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refresh])

  const pick = (s: number) => {
    setSeconds(s)
    try {
      window.localStorage.setItem(KEY, String(s))
    } catch {
      // private window: the choice lasts this page only
    }
  }

  return (
    <div className="topbar__refresh" role="group" aria-label="รีเฟรช">
      <button
        className={`btn ui-refresh${pending ? ' is-pending' : ''}`}
        type="button"
        onClick={refresh}
        title={`โหลดข้อมูลใหม่ (กด r)${at ? ` · ล่าสุด ${fmtTimeSec(at)}` : ''}`}
      >
        <Icon name="refresh" />
        <span className="topbar__refresh-label">รีเฟรช</span>
      </button>
      <label className="select topbar__auto" title={fixed ? 'ช่วงเวลาในอดีตไม่อัปเดตอัตโนมัติ' : 'อัปเดตอัตโนมัติ (จำไว้ในเครื่องนี้)'}>
        <span className="sr-only">อัปเดตอัตโนมัติ</span>
        <select className="select__control" value={auto} disabled={fixed} onChange={(e) => pick(Number(e.target.value))}>
          {INTERVALS.map((i) => (
            <option key={i.s} value={i.s}>
              {i.s ? `อัตโนมัติ ${i.label}` : 'อัตโนมัติ ปิด'}
            </option>
          ))}
        </select>
        <Icon name="chevron" className="select__chev" />
      </label>
    </div>
  )
}
