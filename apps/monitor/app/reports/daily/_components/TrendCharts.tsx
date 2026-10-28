import { Panel } from '@/components/Panel'
import { TimeLine } from '@/components/charts/TimeCharts'
import { fmtCount, fmtMs } from '@/lib/format'
import type { ReportTrendPoint } from '@/lib/types'
import { SourceTag } from './SourceTag'

type Metric = 'users' | 'usersAffected' | 'errorRate' | 'p95Ms'
type Line = { key: string; label: string; className: string; values: (t: ReportTrendPoint[]) => number[]; area?: boolean }

/** Error rate is drawn in percent, so the axis ticks (whole numbers) read 1, 2, 3 and not 0. */
const META: Record<Metric, { title: string; sub: string; format: (v: number) => string; lines: Line[] }> = {
  users: {
    title: 'ผู้ใช้งาน · 7 วัน',
    sub: 'คนต่อช่วง · ใช้งานทั้งหมด เทียบกับที่เจอปัญหา',
    format: fmtCount,
    lines: [
      { key: 'active', label: 'ผู้ใช้งาน', className: 'svc-1', values: (t) => t.map((p) => p.activeUsers ?? 0), area: true },
      { key: 'affected', label: 'เจอปัญหา', className: 'c-lvl-err', values: (t) => t.map((p) => p.usersAffected) },
    ],
  },
  usersAffected: {
    title: 'ผู้ใช้ที่เจอปัญหา · 7 วัน',
    sub: 'คนต่อช่วง · จุดสุดท้าย = ช่วงที่เลือก',
    format: fmtCount,
    lines: [{ key: 'affected', label: 'ผู้ใช้ที่เจอปัญหา', className: 'svc-1', values: (t) => t.map((p) => p.usersAffected), area: true }],
  },
  errorRate: {
    title: 'error rate · 7 วัน',
    sub: 'สัดส่วน request ที่ไม่สำเร็จต่อช่วง (%)',
    format: (v) => `${v.toFixed(2)}%`,
    lines: [{ key: 'rate', label: 'error rate', className: 'svc-1', values: (t) => t.map((p) => p.errorRate * 100), area: true }],
  },
  p95Ms: {
    title: 'ความเร็ว (p95) · 7 วัน',
    sub: 'มิลลิวินาที ยิ่งต่ำยิ่งดี',
    format: fmtMs,
    lines: [{ key: 'p95', label: 'p95', className: 'svc-1', values: (t) => t.map((p) => p.p95Ms), area: true }],
  },
}

/** One chart per metric (different units); buckets = the 7 windows, by their end (09:00 of the report date). */
export function TrendCharts({ trend, metrics }: { trend: ReportTrendPoint[]; metrics: Metric[] }) {
  const buckets = trend.map((t) => `${t.reportDate}T09:00:00+07:00`)
  return (
    <div className="rp-grid">
      {metrics.map((m) => (
        <Panel key={m} title={<>{META[m].title} <SourceTag kind="rule" /></>} meta={META[m].sub}>
          <TimeLine
            label={META[m].title}
            buckets={buckets}
            stepSeconds={86_400}
            formatValue={META[m].format}
            formatTime={(ms) => new Date(ms).toISOString().slice(5, 10)}
            series={META[m].lines.map((l) => ({ key: l.key, label: l.label, className: l.className, values: l.values(trend), area: l.area }))}
          />
        </Panel>
      ))}
    </div>
  )
}
