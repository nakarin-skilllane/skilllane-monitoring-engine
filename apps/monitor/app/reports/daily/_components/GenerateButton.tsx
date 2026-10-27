'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api } from '@/lib/admin-api'

/** Builds (or rebuilds) a report; only for reports_manage. */
export function GenerateButton({ env, date, label = 'สร้างรายงาน' }: { env: string; date?: string; label?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <span className="rp-generate">
      <button
        type="button"
        className="btn btn--sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          const res = await api('POST', '/reports/daily/generate', date ? { env, date } : { env })
          setBusy(false)
          if (res.ok) router.refresh()
          else setError(res.message)
        }}
      >
        {busy ? 'กำลังสร้าง…' : label}
      </button>
      {error ? <span role="alert" className="rp-generate__error">{error}</span> : null}
    </span>
  )
}
