'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api } from '@/lib/admin-api'

/** Runs the AI again on this snapshot (numbers unchanged); only for reports_manage. */
export function AnalyzeButton({ env, date }: { env: string; date: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <span className="rp-generate">
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        title="ให้ AI วิเคราะห์รายงานฉบับนี้ใหม่ ตัวเลขไม่เปลี่ยน"
        onClick={async () => {
          setBusy(true)
          setError('')
          const res = await api('POST', '/reports/daily/analyze', { env, date })
          setBusy(false)
          if (res.ok) router.refresh()
          else setError(res.message)
        }}
      >
        {busy ? 'กำลังส่ง…' : 'วิเคราะห์ใหม่'}
      </button>
      {error ? <span role="alert" className="rp-generate__error">{error}</span> : null}
    </span>
  )
}
