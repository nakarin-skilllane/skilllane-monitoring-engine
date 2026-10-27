'use client'

import { useRouter } from 'next/navigation'
import type { ReportDateItem } from '@/lib/types'
import { reportHref, STATUS_TEXT } from '../_lib/model'

/** The report date dropdown; each option shows its status. */
export function DatePicker({ env, tab, view, current, dates }: { env: string; tab: string; view: string; current: string; dates: ReportDateItem[] }) {
  const router = useRouter()
  const options: Array<{ reportDate: string; status?: ReportDateItem['status'] }> = dates.some((d) => d.reportDate === current)
    ? dates
    : [{ reportDate: current }, ...dates]
  return (
    <label className="rp-date">
      <span className="sr-only">วันที่รายงาน</span>
      <select value={current} onChange={(e) => router.push(reportHref({ env, date: e.target.value, tab, view }))}>
        {options.map((d) => (
          <option key={d.reportDate} value={d.reportDate}>
            {d.reportDate}
            {d.status ? ` · ${STATUS_TEXT[d.status]}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
