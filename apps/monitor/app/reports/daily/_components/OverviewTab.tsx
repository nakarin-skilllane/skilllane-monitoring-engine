import { Panel } from '@/components/Panel'
import { Table, TableWrap } from '@/components/table'
import { fmtCount } from '@/lib/format'
import type { DailyReport } from '@/lib/types'
import { clock, EMPTY } from '../_lib/model'
import { SourceTag } from './SourceTag'
import { StatusBlock } from './StatusBlock'
import { TrendCharts } from './TrendCharts'

const SOURCE_TEXT = { 'dependency.down': 'ระบบที่พึ่งพาล่ม', error_spike: 'error สูงผิดปกติ', 'job.failed': 'งานเบื้องหลังล้มเหลว' } as const
const FOLLOWUP_TEXT = { new: 'ใหม่', recurring: 'เกิดซ้ำ', threshold: 'เกินเกณฑ์' } as const

export function OverviewTab({ report }: { report: DailyReport }) {
  const p = report.payload
  return (
    <div className="rp-tab">
      <StatusBlock status={p.headline.statusAuto} summary={p.headline.summaryOverview} aiStatus={report.aiStatus} aiMessage={report.aiMessage} />
      <Panel title={<>เหตุการณ์สำคัญ <SourceTag kind="rule" /></>} meta="ช่วงเวลาที่ผู้ใช้ได้รับผลกระทบ (เวลาไทย)" flush>
        {p.incidents.length ? (
          <TableWrap>
            <Table dense caption="เหตุการณ์สำคัญ">
              <thead><tr><th>เวลา</th><th>เกิดอะไร</th><th className="num">ผู้ใช้</th><th>สถานะ</th><th>ที่มา</th></tr></thead>
              <tbody>
                {p.incidents.map((i) => (
                  <tr key={i.id}>
                    <td>{clock(i.startedAtMs)}–{i.endedAtMs === null ? 'ยังไม่จบ' : clock(i.endedAtMs)}</td>
                    <td>{i.what}</td>
                    <td className="num">{i.usersAffected === null ? '–' : fmtCount(i.usersAffected)}</td>
                    <td>{i.state === 'ongoing' ? 'ยังเกิดอยู่' : 'จบแล้ว'}</td>
                    <td>{SOURCE_TEXT[i.source]}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        ) : (
          <p className="rp-empty">{EMPTY}</p>
        )}
      </Panel>
      <div className="rp-grid">
        <Panel title={<>ฟีเจอร์หลักทำงานไหม <SourceTag kind="rule" /></>} meta="สัดส่วนที่ใช้งานสำเร็จ เทียบ 7 วัน · ระบบเลือกฟีเจอร์เองจากการใช้งาน">
          <p className="rp-empty">กำลังเก็บข้อมูลการใช้งานเพื่อเลือกฟีเจอร์หลัก</p>
        </Panel>
        <Panel title={<>ต้องติดตาม <SourceTag kind="rule" /></>} meta="ปัญหาใหม่ที่ยังเกิดอยู่ เกิดซ้ำ หรือตัวเลขเกินเกณฑ์" flush>
          {p.followups.length ? (
            <TableWrap>
              <Table dense caption="ต้องติดตาม">
                <thead><tr><th>ประเภท</th><th>เรื่อง</th></tr></thead>
                <tbody>
                  {p.followups.map((f) => (
                    <tr key={`${f.kind}:${f.key}`}><td>{FOLLOWUP_TEXT[f.kind]}</td><td>{f.text}</td></tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : (
            <p className="rp-empty">{EMPTY}</p>
          )}
        </Panel>
      </div>
      <TrendCharts trend={p.trend} metrics={['usersAffected', 'p95Ms']} />
    </div>
  )
}
