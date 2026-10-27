import { Kpi, Kpis } from '@/components/Kpi'
import { fmtCount, fmtMs, fmtPercent } from '@/lib/format'
import type { ReportCompare, ReportFigures as Figures, ReportTrendPoint } from '@/lib/types'
import { changeText, changeTone } from '../_lib/model'

/** The 5 figures with `% · ปกติ x` against normal; rendered once above the tabs. */
export function ReportFigures({ f, trend }: { f: Figures; trend: ReportTrendPoint[] }) {
  // Kpi shows delta instead of foot, so the normal goes in the delta text
  const delta = (c: ReportCompare, fmt: (v: number) => string, neutral = false) => ({
    text: c.baseline === null ? changeText(c) : `${changeText(c)} · ปกติ ${fmt(c.baseline)}`,
    tone: changeTone(c, neutral),
  })
  const spark = (pick: (t: ReportTrendPoint) => number) => trend.map(pick)
  return (
    <Kpis cols={5} label="ตัวเลขหลักของช่วงรายงาน" className="rp-figures">
      <Kpi label="ผู้ใช้ที่เจอปัญหา" value={f.usersAffected.value} unit="คน" delta={delta(f.usersAffected, fmtCount)} spark={spark((t) => t.usersAffected)} sparkBad />
      <Kpi label="โรงเรียนที่ได้รับผลกระทบ" value={f.orgsAffected.value} unit="แห่ง" delta={delta(f.orgsAffected, fmtCount)} />
      <Kpi label="อัตราที่ใช้งานไม่สำเร็จ" value={f.errorRate.value * 100} decimals={2} unit="%" delta={delta(f.errorRate, (v) => fmtPercent(v, 2))} spark={spark((t) => t.errorRate)} sparkBad />
      <Kpi label="ความเร็ว (p95)" value={fmtMs(f.p95Ms.value)} delta={delta(f.p95Ms, fmtMs)} spark={spark((t) => t.p95Ms)} />
      <Kpi label="การใช้งานทั้งหมด" value={f.requests.value} delta={delta(f.requests, fmtCount, true)} spark={spark((t) => t.requests)} />
    </Kpis>
  )
}
