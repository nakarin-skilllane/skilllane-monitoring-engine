import type { Metadata } from 'next'
import { Tabs } from '@/components/Tabs'
import { EmptyState, EngineErrorState } from '@/components/states'
import { engine, getMe, getMeta } from '@/lib/engine'
import { Params, type RawSearchParams } from '@/lib/params'
import { AI_STATUS_TEXT, isDate, pickEnv } from './_lib/model'
import { DetailTab } from './_components/DetailTab'
import { GenerateButton } from './_components/GenerateButton'
import { OverviewTab } from './_components/OverviewTab'
import { ReportFigures } from './_components/ReportFigures'
import { ReportHeader } from './_components/ReportHeader'
import { SourceTag } from './_components/SourceTag'
import './screen.css'

export const metadata: Metadata = { title: 'รายงานประจำวัน' }

/** Daily report: reads the snapshot only. URL: env, date (YYYY-MM-DD, default the latest), tab=overview|detail. */
export default async function DailyReportPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const p = new Params(await searchParams)
  const [meta, me] = await Promise.all([getMeta(), getMe()])
  const permissions = me.ok ? me.data.permissions : undefined
  const env = pickEnv(p.str('env', 128), meta.ok ? meta.data.envs : [], permissions?.reports)
  const wanted = p.str('date', 10)
  const tab = p.str('tab', 16) === 'detail' ? 'detail' : 'overview'
  const canManage = !!permissions?.reports_manage
  if (!env) return <EmptyState title="ยังไม่มี env ที่ดูรายงานได้" text="ขอสิทธิ์ รายงาน จากผู้ดูแลระบบ" />

  const [reportRes, datesRes] = await Promise.all([
    engine.dailyReport({ env, date: isDate(wanted) ? wanted : undefined }),
    engine.reportDates({ env }),
  ])
  const dates = datesRes.ok ? datesRes.data.dates : []
  if (!reportRes.ok) {
    if (reportRes.error.status !== 404) return <EngineErrorState error={reportRes.error} />
    return (
      <EmptyState
        title={isDate(wanted) ? `ยังไม่มีรายงานของวันที่ ${wanted}` : 'ยังไม่มีรายงาน'}
        text={`env ${env} · รายงานสร้างทุกวัน 09:00`}
        actions={canManage ? <GenerateButton env={env} date={isDate(wanted) ? wanted : undefined} /> : undefined}
      />
    )
  }

  const report = reportRes.data
  return (
    <>
      <ReportHeader report={report} dates={dates} tab={tab} canManage={canManage} />
      <ReportFigures f={report.payload.figures} trend={report.payload.trend} />
      <p className="rp-legend">
        <span className="rp-chip">{AI_STATUS_TEXT[report.aiStatus]}</span>
        ป้ายบอกที่มา: <SourceTag kind="rule" /> คำนวณจาก query ตามเกณฑ์ ผลเหมือนกันทุกครั้ง · <SourceTag kind="ai" /> ข้อความวิเคราะห์โดย AI เป็นข้อสันนิษฐาน ถ้า AI ไม่พร้อม ส่วนนี้จะหายไป ตัวเลขยังครบ
      </p>
      <Tabs
        label="ส่วนของรายงาน"
        param="tab"
        defaultKey={tab}
        items={[
          { key: 'overview', label: 'ภาพรวม', panel: <OverviewTab report={report} /> },
          { key: 'detail', label: 'รายละเอียด', panel: <DetailTab report={report} nowMs={Date.now()} /> },
        ]}
      />
    </>
  )
}
