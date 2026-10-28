import Link from 'next/link'
import { Panel } from '@/components/Panel'
import { ServiceChip } from '@/components/badges'
import { Table, TableWrap } from '@/components/table'
import { fmtCount, fmtMs } from '@/lib/format'
import type { DailyReport, ReportError } from '@/lib/types'
import { clock, EMPTY } from '../_lib/model'
import { SourceTag } from './SourceTag'
import { StatusBlock } from './StatusBlock'
import { TrendCharts } from './TrendCharts'

/** spans keep 14 days: an older sample trace cannot open. */
const TRACE_TTL_MS = 14 * 86_400_000

const compareText = (e: ReportError): string =>
  e.trend === 'new' ? 'ใหม่' : e.changePct === null ? 'เพิ่มขึ้น' : `+${Math.round(e.changePct * 100)}%`

export function DetailTab({ report, nowMs }: { report: DailyReport; nowMs: number }) {
  const p = report.payload
  const range = new URLSearchParams({ env: p.env, from: new Date(p.windowStartMs).toISOString(), to: new Date(p.windowEndMs).toISOString() }).toString()
  const traceAlive = nowMs - p.windowEndMs < TRACE_TTL_MS
  const empty = <p className="rp-empty">{EMPTY}</p>
  return (
    <div className="rp-tab">
      <StatusBlock status={p.headline.statusAuto} summary={p.headline.summaryDetail} aiStatus={report.aiStatus} aiMessage={report.aiMessage} />
      <Panel title={<>ปัญหาใหม่ / เพิ่มขึ้น <SourceTag kind="rule" /></>} meta="จัดกลุ่มด้วย error_fingerprint · เรียงตามจำนวนครั้ง · ใหม่ = ไม่เคยพบใน 14 วัน · เพิ่มขึ้น = มากกว่าค่าเฉลี่ย 7 วัน × 1.5" flush>
        {p.topErrors.length ? (
          <TableWrap>
            <Table dense caption="ปัญหาใหม่ / เพิ่มขึ้น">
              <thead><tr><th>#</th><th>ปัญหา</th><th>เทียบ 7 วัน</th><th>route</th><th>จุดในโค้ด</th><th className="num">ครั้ง</th><th className="num">ผู้ใช้</th><th>พบครั้งแรก</th><th>trace</th></tr></thead>
              <tbody>
                {p.topErrors.map((e, i) => (
                  <tr key={e.fingerprint} className="is-bad">
                    <td>{i + 1}</td>
                    <td><Link href={`/errors/${e.fingerprint}?${range}`}><strong>{e.errorType || e.logger}</strong> {e.errorHint || e.message}</Link><br /><ServiceChip service={e.service} /></td>
                    <td>{compareText(e)}</td>
                    <td><code>{e.route || '–'}</code></td>
                    <td><code>{e.location || '–'}</code></td>
                    <td className="num">{fmtCount(e.count)}</td>
                    <td className="num">{fmtCount(e.users)}</td>
                    <td>{clock(e.firstSeenMs)}</td>
                    <td>{e.sampleTraceId ? (traceAlive ? <Link href={`/traces/${e.sampleTraceId}?env=${p.env}`}>เปิด</Link> : <span title="spans เก็บ 14 วัน">หมดอายุ</span>) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        ) : empty}
      </Panel>
      <div className="rp-grid">
        <Panel title={<>ระบบที่พึ่งพา <SourceTag kind="rule" /></>} meta="นาทีที่ล่มรวมในช่วงรายงาน" flush>
          {p.dependencies.length ? (
            <TableWrap>
              <Table dense caption="ระบบที่พึ่งพา">
                <thead><tr><th>ระบบ</th><th>สถานะ</th><th className="num">ล่ม (นาที)</th><th>error ล่าสุด</th><th>หมายเหตุ</th></tr></thead>
                <tbody>
                  {p.dependencies.map((d) => (
                    <tr key={d.key} className={d.problem ? 'is-bad' : undefined}>
                      <td>{d.name}<br /><code>{d.host}:{d.port}</code></td>
                      <td>{d.problem ? 'มีปัญหา' : 'สะดุดสั้น'}</td>
                      <td className="num">{d.downMinutes}</td>
                      <td>{d.lastError || '–'}</td>
                      <td>{d.note || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : empty}
        </Panel>
        <Panel title={<>งานเบื้องหลัง <SourceTag kind="rule" /></>} meta="cron และคิวงาน" flush>
          {p.jobs.length ? (
            <TableWrap>
              <Table dense caption="งานเบื้องหลัง">
                <thead><tr><th>งาน</th><th>ชนิด</th><th className="num">ล้มเหลว</th><th className="num">ทั้งหมด</th><th className="num">ไม่รันตามรอบ</th><th>หมายเหตุ</th></tr></thead>
                <tbody>
                  {p.jobs.map((j) => (
                    <tr key={j.job} className={j.failed || j.missed ? 'is-bad' : undefined}>
                      <td>{j.job}</td><td>{j.kind}</td>
                      <td className="num">{fmtCount(j.failed)}</td><td className="num">{fmtCount(j.total)}</td><td className="num">{fmtCount(j.missed)}</td>
                      <td>{j.note || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : empty}
        </Panel>
        <Panel title={<>deploy ในช่วงรายงาน <SourceTag kind="rule" /></>} meta="version ที่เปลี่ยน และปัญหาที่เริ่มภายใน 2 ชม. หลังจากนั้น" flush>
          {p.deploys.length ? (
            <TableWrap>
              <Table dense caption="deploy ในช่วงรายงาน">
                <thead><tr><th>service</th><th>version</th><th>เวลา</th><th>โยงกับปัญหา</th></tr></thead>
                <tbody>
                  {p.deploys.map((d) => (
                    <tr key={`${d.service}:${d.deployedAtMs}`}>
                      <td><ServiceChip service={d.service} /></td>
                      <td>{d.previousVersion || '–'} → {d.version}</td>
                      <td>{clock(d.deployedAtMs)}</td>
                      <td>{d.relatedFingerprints.length ? d.relatedFingerprints.map((fp) => <Link key={fp} href={`/errors/${fp}?${range}`}>{fp.slice(0, 6)} </Link>) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : empty}
        </Panel>
        <Panel title={<>endpoint ที่ช้าขึ้น <SourceTag kind="rule" /></>} meta="p95 ในช่วงรายงาน เทียบ 7 วัน (ms) · แดง = ช้ากว่า 20%" flush>
          {p.slowRoutes.length ? (
            <TableWrap>
              <Table dense caption="endpoint ที่ช้าขึ้น">
                <thead><tr><th>route</th><th className="num">request</th><th className="num">7 วัน</th><th className="num">ช่วงนี้</th></tr></thead>
                <tbody>
                  {p.slowRoutes.map((s) => (
                    <tr key={s.route} className="is-slow">
                      <td><code>{s.route}</code></td><td className="num">{fmtCount(s.requests)}</td><td className="num">{fmtMs(s.p95_7dMs)}</td><td className="num">{fmtMs(s.p95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          ) : empty}
        </Panel>
      </div>
      <TrendCharts trend={p.trend} metrics={['errorRate', 'p95Ms']} />
    </div>
  )
}
