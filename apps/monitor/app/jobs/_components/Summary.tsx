/**
 * Top of /jobs (server): callouts that point into the page (real job failures, dependencies down, rejected
 * calls, an outage that just ended) and the five KPIs, all summed from /api/jobs and /api/dependencies.
 */
import { Kpi, Kpis } from '@/components/Kpi'
import { Icon } from '@/components/icons'
import { fmtCount, fmtDuration, fmtNumber } from '@/lib/format'
import { inRange } from '@/lib/params'
import type { JobStat, LogRow } from '@/lib/types'
import { codeCounts, type DepRow, depName, durationThai, hostPort, isCronLike, jobKey, moduleLabel, MODULE_ORDER, outageMs, rejectAdvice, statName, statusCounts, typeLabel } from '../_data'
import type { Clock } from './parts'

interface CalloutSpec {
  key: string
  tone: 'error' | 'warn' | 'info'
  title: string
  text: string
  href: string
  action: string
}

function Callouts({ items }: { items: CalloutSpec[] }) {
  if (!items.length) return null
  return (
    <div className="callouts">
      {items.map((c) => (
        <div key={c.key} className={c.tone === 'info' ? 'callout' : `callout callout--${c.tone}`} role="status">
          <Icon name={c.tone === 'error' ? 'alert-octagon' : c.tone === 'warn' ? 'alert-triangle' : 'info'} className="callout__icon" />
          <p className="callout__title">{c.title}</p>
          <p className="callout__text">{c.text}</p>
          <div className="callout__actions">
            <a className="btn btn--sm" href={c.href}>
              {c.action}
            </a>
          </div>
        </div>
      ))}
    </div>
  )
}

export interface SummaryProps {
  /** null when /api/jobs failed. */
  stats: JobStat[] | null
  featured: JobStat | null
  finals: Map<string, LogRow[]>
  /** null when /api/dependencies failed. */
  deps: DepRow[] | null
  fromMs: number
  toMs: number
  rangeLabel: string
  rangeShort: string
  clock: Clock
}

export function Summary({ stats, featured, finals, deps, fromMs, toMs, rangeLabel, rangeShort, clock }: SummaryProps) {
  const callouts: CalloutSpec[] = []

  // dependencies down now
  for (const d of deps ?? []) {
    if (d.state !== 'down') continue
    const o = d.outages[d.outages.length - 1]
    const codes = o ? codeCounts(o.lines) : []
    callouts.push({
      key: `down-${d.id}`,
      tone: 'error',
      title: `${typeLabel(d.type)} "${d.name}" ล่มอยู่ตั้งแต่ ${d.since ? clock.sec(d.since) : '–'}`,
      text: [
        `down มาแล้ว ${d.since ? durationThai(toMs - Date.parse(d.since)) : '–'}`,
        hostPort(d),
        ...codes.map((c) => `${c.code} ${fmtCount(c.n)} ครั้ง`),
      ].join(' · '),
      href: `#${d.id}`,
      action: 'ดูช่วงที่ล่ม',
    })
  }

  // real job failures of the featured queue
  if (featured && featured.failed > 0) {
    const fails = finals.get(jobKey(featured)) ?? []
    const last = fails[0]
    const hint = last?.error?.hint || last?.message || ''
    const max = last?.job?.maxAttempts ?? 0
    const target = last?.error?.target || last?.http?.domain || ''
    const latest = last ? ` (ล่าสุด${last.job?.id ? ` #${last.job.id}` : ''} ${clock.min(last.timestamp)})` : ''
    const what =
      max > 1
        ? `retry ${fmtCount(featured.retried)} ครั้ง และครบ ${max}/${max} attempt ${fmtCount(featured.failed)} job${latest}`
        : `ล้มเหลว ${fmtCount(featured.failed)} ${isCronLike(featured.module) ? 'รอบ' : 'job'}${latest}`
    callouts.push({
      key: 'jobs',
      tone: 'warn',
      title: `${statName(featured)} ล้มเหลวจริง ${fmtCount(featured.failed)} ${isCronLike(featured.module) ? 'รอบ' : 'job'}${hint ? `: ${hint}` : ''}`,
      text: [`${rangeShort}: ${what}`, target].filter(Boolean).join(' · '),
      href: '#failures',
      action: 'ดูรายการ',
    })
  }

  // calls rejected without an outage (degraded)
  for (const d of deps ?? []) {
    if (d.state !== 'degraded') continue
    const codes = statusCounts(d.outbound)
    const codeText = codes.map((c) => c.status).join(', ') || '4xx'
    const last = d.outbound[0]
    callouts.push({
      key: `deg-${d.id}`,
      tone: 'warn',
      title: `${d.name} ปฏิเสธ request ${fmtCount(d.outboundFailures)} ครั้ง (${codeText}) ${inRange(rangeLabel)}`,
      text: `${d.host} ยังตอบอยู่ (ไม่มี dependency.down) แต่ตอบ ${codeText} · ${rejectAdvice(d.name, codes[0]?.status ?? 0, last?.error?.hint ?? '')}`,
      href: `#${d.id}`,
      action: 'ดู dependency',
    })
  }

  // outages that ended within the range (latest per dependency)
  for (const d of deps ?? []) {
    if (d.state === 'down') continue
    const o = d.outages[d.outages.length - 1]
    if (!o || o.end === null) continue
    const codes = codeCounts(o.lines)
    callouts.push({
      key: `up-${d.id}`,
      tone: 'info',
      title: `${typeLabel(d.type)} "${d.name}" กลับมาแล้วตั้งแต่ ${clock.sec(o.end)}`,
      text: [
        `down ${durationThai(outageMs(o, toMs))} (${clock.sec(o.start)}–${clock.sec(o.end)})`,
        hostPort(d),
        ...codes.map((c) => `${c.code} ${fmtCount(c.n)} ครั้ง`),
      ].join(' · '),
      href: `#${d.id}`,
      action: 'ดูช่วงที่ล่ม',
    })
  }

  // KPIs
  const list = stats ?? []
  const sum = (xs: JobStat[], f: (s: JobStat) => number) => xs.reduce((n, s) => n + f(s), 0)
  const byLabel = (xs: JobStat[], f: (s: JobStat) => number, label: (s: JobStat) => string) => {
    const m = new Map<string, number>()
    for (const s of xs) if (f(s) > 0) m.set(label(s), (m.get(label(s)) ?? 0) + f(s))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const failed = sum(list, (s) => s.failed)
  const failParts = byLabel(list, (s) => s.failed, (s) => (isCronLike(s.module) ? s.module : statName(s)))
  const retried = sum(list, (s) => s.retried)
  const retryParts = byLabel(list, (s) => s.retried, (s) => (s.module === 'rabbitmq' ? `${s.queue} redeliver` : `${statName(s)} retry`))
  const jobs = list.filter((s) => s.module !== 'kafka')
  const modules = [...new Set(jobs.map((s) => s.module))].sort((a, b) => {
    const ra = MODULE_ORDER.indexOf(a)
    const rb = MODULE_ORDER.indexOf(b)
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
  })
  const kafka = list.filter((s) => s.module === 'kafka')
  const kafkaStarted = sum(kafka, (s) => s.started)
  const perMin = kafkaStarted / Math.max(1, (toMs - fromMs) / 60_000)
  const kafkaP95 = Math.max(0, ...kafka.map((s) => s.p95Ms))

  const downNow = (deps ?? []).filter((d) => d.state === 'down')
  const outages = (deps ?? []).flatMap((d) => d.outages.map((o) => ({ d, o }))).sort((a, b) => b.o.start - a.o.start)
  const lastOutage = outages[0]
  const depFoot = !deps
    ? 'อ่าน /api/dependencies ไม่ได้'
    : downNow.length
      ? downNow.map((d) => `${depName(d)} ตั้งแต่ ${d.since ? clock.min(d.since) : '–'}`).join(' · ')
      : lastOutage
        ? `ล่าสุด ${depName(lastOutage.d)} down ${fmtDuration(outageMs(lastOutage.o, toMs))} เมื่อ ${clock.sec(lastOutage.o.start)}`
        : `ไม่ได้ล่ม${inRange(rangeShort)}`

  return (
    <>
      <Callouts items={callouts} />
      <Kpis cols={5} label={`สรุป ${rangeLabel}`} className="jb-kpis">
        <Kpi
          label="Job ที่ล้มเหลวจริง"
          icon={failed > 0 ? <Icon name="alert-octagon" size="sm" /> : undefined}
          tone={failed > 0 ? 'alert' : undefined}
          value={stats ? failed : '–'}
          unit={stats ? 'ครั้ง' : undefined}
          foot={stats ? (failParts.length ? failParts.map(([k, n]) => `${k} ${fmtCount(n)}`).join(' · ') : `ไม่มี${inRange(rangeShort)}`) : 'อ่าน /api/jobs ไม่ได้'}
        />
        <Kpi
          label="Retry และ redeliver"
          value={stats ? retried : '–'}
          unit={stats ? 'ครั้ง' : undefined}
          foot={stats ? (retryParts.length ? retryParts.map(([k, n]) => `${k} ${fmtCount(n)}`).join(' · ') : 'ไม่มี retry') : undefined}
        />
        <Kpi
          label="Dependency ที่ down ตอนนี้"
          tone={downNow.length ? 'alert' : undefined}
          value={deps ? downNow.length : '–'}
          unit={deps ? `จาก ${deps.length}` : undefined}
          foot={depFoot}
        />
        <Kpi
          label="Job ที่เริ่ม (นับทุก attempt)"
          value={stats ? sum(jobs, (s) => s.started) : '–'}
          foot={stats ? modules.map((m) => `${moduleLabel(m)} ${fmtCount(sum(jobs.filter((s) => s.module === m), (s) => s.started))}`).join(' · ') || `ไม่มี${inRange(rangeShort)}` : undefined}
        />
        <Kpi
          label="Kafka message"
          value={stats ? kafkaStarted : '–'}
          foot={
            stats
              ? kafka.length
                ? `${fmtNumber(perMin, perMin < 10 ? 1 : 0)} ต่อนาที · p95 ${kafkaP95 ? fmtDuration(kafkaP95) : '–'} · ล้มเหลว ${fmtCount(sum(kafka, (s) => s.failed))}`
                : `ไม่มี consumer ของ Kafka ${inRange(rangeShort)}`
              : undefined
          }
        />
      </Kpis>
    </>
  )
}
