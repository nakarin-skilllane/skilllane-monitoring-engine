'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { ReportView } from '../_lib/model'

type Option = { label: string; tab: 'overview' | 'detail' | 'all'; view: ReportView; format: 'png' | 'pdf' }

/**
 * Export ▾: the files of the current view (Infographic: PNG, PDF; data: PDF) of the open tab, and
 * the whole report as one PDF. Fetched, not linked, so an engine error (503 without Gotenberg)
 * shows here instead of a JSON page.
 */
export function ExportMenu({ env, date, view }: { env: string; date: string; view: ReportView }) {
  const sp = useSearchParams()
  const tab = sp.get('tab') === 'detail' ? 'detail' : 'overview'
  const tabName = tab === 'detail' ? 'รายละเอียด' : 'ภาพรวม'
  const options: Option[] = [
    ...(view === 'infographic' ? [{ label: `PNG · ${tabName}`, tab, view, format: 'png' } as const] : []),
    { label: `PDF · ${tabName}`, tab, view, format: 'pdf' },
    { label: 'PDF ทั้งรายงาน', tab: 'all', view, format: 'pdf' },
  ]
  const menu = useRef<HTMLDetailsElement>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  // a <details> stays open on a click elsewhere: close it on a click outside, Esc, or a click in the
  // infographic iframe (which reaches this page only as the window losing focus)
  useEffect(() => {
    if (!open) return
    const close = () => {
      if (menu.current) menu.current.open = false
    }
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open])

  async function download(o: Option) {
    if (menu.current) menu.current.open = false
    setBusy(o.label)
    setError('')
    try {
      const res = await fetch(`/engine/reports/daily/export?${new URLSearchParams({ env, date, tab: o.tab, view: o.view, format: o.format })}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(body?.message || `export ไม่สำเร็จ (${res.status})`)
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `skilllane-report.${o.format}`
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <span className="rp-export">
      <details ref={menu} className="rp-export__menu" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="btn btn--sm" aria-busy={!!busy}>{busy ? `กำลังสร้าง ${busy}…` : 'Export ▾'}</summary>
        <ul role="menu">
          {options.map((o) => (
            <li key={o.label} role="none">
              <button type="button" role="menuitem" disabled={!!busy} onClick={() => void download(o)}>{o.label}</button>
            </li>
          ))}
        </ul>
      </details>
      {error ? <span role="alert" className="rp-generate__error">{error}</span> : null}
    </span>
  )
}
