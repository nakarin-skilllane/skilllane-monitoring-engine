import Link from 'next/link'
import { EnvTag } from '@/components/badges'
import { fmtDateTime } from '@/lib/format'
import type { DailyReport, ReportDateItem } from '@/lib/types'
import { neighbours, reportHref, thaiDate, windowText } from '../_lib/model'
import { DatePicker } from './DatePicker'
import { GenerateButton } from './GenerateButton'

/** Title, env, ‹ previous · date · next ›, the window, when it was built. The same on every tab. */
export function ReportHeader({ report, dates, tab, view, canManage }: { report: DailyReport; dates: ReportDateItem[]; tab: string; view: string; canManage: boolean }) {
  const { prev, next } = neighbours(dates, report.reportDate)
  return (
    <header className="page-head rp-head">
      <div className="page-head__text">
        <h1 className="page-title">รายงานประจำวัน <EnvTag env={report.env} /></h1>
        <p className="rp-window">
          <strong>{thaiDate(report.reportDate)}</strong>{' '}
          <span className="rp-muted">สรุป 24 ชม. ล่าสุดก่อน 09:00 · {windowText(report.windowStartMs, report.windowEndMs)}</span>
        </p>
        <p className="page-sub">สร้างทุกวัน 09:00 · ฉบับนี้สร้างเมื่อ {fmtDateTime(report.generatedAt)}</p>
      </div>
      <nav className="page-actions rp-nav" aria-label="เลือกวันรายงาน">
        {prev ? <Link href={reportHref({ env: report.env, date: prev, tab, view })}>‹ วันก่อน</Link> : <span className="rp-muted">‹ วันก่อน</span>}
        <DatePicker env={report.env} tab={tab} view={view} current={report.reportDate} dates={dates} />
        {next ? <Link href={reportHref({ env: report.env, date: next, tab, view })}>วันถัดไป ›</Link> : <span className="rp-muted">วันถัดไป ›</span>}
        {canManage ? <GenerateButton env={report.env} date={report.reportDate} label="สร้างใหม่" /> : null}
      </nav>
    </header>
  )
}
