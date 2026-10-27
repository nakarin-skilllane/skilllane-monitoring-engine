import { Panel } from '@/components/Panel'
import { TimeLine } from '@/components/charts/TimeCharts'
import { fmtCount, fmtMs } from '@/lib/format'
import type { ReportTrendPoint } from '@/lib/types'
import { SourceTag } from './SourceTag'

type Metric = 'usersAffected' | 'errorRate' | 'p95Ms'
/** `scale`: error rate is drawn in percent, so the axis ticks (whole numbers) read 1, 2, 3 and not 0. */
const META: Record<Metric, { title: string; sub: string; format: (v: number) => string; scale: number }> = {
  usersAffected: { title: 'ผู้ใช้ที่เจอปัญหา · 7 วัน', sub: 'คนต่อช่วง · จุดสุดท้าย = ช่วงที่เลือก', format: fmtCount, scale: 1 },
  errorRate: { title: 'error rate · 7 วัน', sub: 'สัดส่วน request ที่ไม่สำเร็จต่อช่วง (%)', format: (v) => `${v.toFixed(2)}%`, scale: 100 },
  p95Ms: { title: 'ความเร็ว (p95) · 7 วัน', sub: 'มิลลิวินาที ยิ่งต่ำยิ่งดี', format: fmtMs, scale: 1 },
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
            series={[{ key: m, label: META[m].title, className: 'svc-1', values: trend.map((t) => t[m] * META[m].scale), area: true }]}
          />
        </Panel>
      ))}
    </div>
  )
}
