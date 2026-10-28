import type { ReactNode } from 'react'
import { Kpi, Kpis } from '@/components/Kpi'
import { fmtCount, fmtMs, fmtPercent } from '@/lib/format'
import type { DailyPayload, ReportCompare, ReportTrendPoint } from '@/lib/types'
import { changeText, changeTone, share } from '../_lib/model'

/** `+4% · ปกติ 17,700` in its tone, then a second line (how many had a problem). */
function foot(c: ReportCompare, fmt: (v: number) => string, neutral: boolean, sub?: { text: string; bad: boolean }): { text: ReactNode } {
  const tone = changeTone(c, neutral)
  return {
    text: (
      <>
        <span className={tone ? `kpi__delta--${tone}` : undefined}>
          {changeText(c)}
          {c.baseline === null ? '' : ` · ปกติ ${fmt(c.baseline)}`}
        </span>
        {sub ? <span className={sub.bad ? 'rp-sub rp-sub--bad' : 'rp-sub'}>{sub.text}</span> : null}
      </>
    ),
  }
}

/** The 5 figures above the tabs: totals with how many had a problem, speed, incidents. */
export function ReportFigures({ p }: { p: DailyPayload }) {
  const f = p.figures
  if (!f.activeUsers || !f.activeOrgs) return <LegacyFigures p={p} />
  const downMinutes = Math.round(p.dependencies.reduce((sum, d) => sum + d.downMinutes, 0) * 10) / 10
  const ongoing = p.incidents.filter((i) => i.state === 'ongoing').length
  const failed = f.failedRequests ?? 0
  return (
    <Kpis cols={5} label="ตัวเลขหลักของช่วงรายงาน" className="rp-figures">
      <Kpi label="การใช้งาน" value={f.requests.value} unit="req" delta={foot(f.requests, fmtCount, true, { text: `ไม่สำเร็จ ${share(failed, f.requests.value)}`, bad: failed > 0 })} />
      <Kpi label="ผู้ใช้งาน" value={f.activeUsers.value} unit="คน" delta={foot(f.activeUsers, fmtCount, true, { text: `เจอปัญหา ${share(f.usersAffected.value, f.activeUsers.value)}`, bad: f.usersAffected.value > 0 })} />
      <Kpi label="โรงเรียนที่ใช้งาน" value={f.activeOrgs.value} unit="แห่ง" delta={foot(f.activeOrgs, fmtCount, true, { text: `ได้รับผลกระทบ ${share(f.orgsAffected.value, f.activeOrgs.value)}`, bad: f.orgsAffected.value > 0 })} />
      <Kpi label="ความเร็ว (p95)" value={fmtMs(f.p95Ms.value)} delta={foot(f.p95Ms, fmtMs, false, { text: `ช้าขึ้น ${p.slowRoutes.length} endpoint`, bad: p.slowRoutes.length > 0 })} />
      <Kpi
        label="เหตุการณ์สำคัญ"
        value={p.incidents.length}
        unit="ครั้ง"
        delta={{
          text: (
            <>
              <span className={downMinutes ? 'kpi__delta--bad' : undefined}>{downMinutes ? `ล่มรวม ${downMinutes} นาที` : 'ไม่มีช่วงที่ล่ม'}</span>
              <span className={ongoing ? 'rp-sub rp-sub--bad' : 'rp-sub'}>ยังเกิดอยู่ {ongoing}</span>
            </>
          ),
        }}
      />
    </Kpis>
  )
}

/** Snapshots before 2026-10-28 have no active users / orgs: the cards they were built with. */
function LegacyFigures({ p }: { p: DailyPayload }) {
  const f = p.figures
  const delta = (c: ReportCompare, fmt: (v: number) => string, neutral = false) => ({
    text: c.baseline === null ? changeText(c) : `${changeText(c)} · ปกติ ${fmt(c.baseline)}`,
    tone: changeTone(c, neutral),
  })
  const spark = (pick: (t: ReportTrendPoint) => number) => p.trend.map(pick)
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
