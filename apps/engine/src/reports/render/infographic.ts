/**
 * The one-picture summary of a tab (mockup `ig-*`): shown in the monitor through /render and
 * exported as PNG / PDF from the same HTML. Every number comes from the snapshot.
 */
import { DAY_MS } from '../rules'
import type { ReportFeature, ReportIncident, StoredReport } from '../types'
import { aiMissingText, changeText, changeTone, clock, count, EMPTY, esc, ms, pct, STATUS_TEXT, STATUS_TONE, thaiDate, windowText, dateTime } from './html'

export type ReportTab = 'overview' | 'detail'

const FEATURE_TONE: Record<ReportFeature['state'], string> = { ok: 'ok', below: 'warn', bad: 'bad', idle: '' }
const INCIDENT_TONE: Record<ReportIncident['source'], string> = { 'dependency.down': 'r', error_spike: 'w', 'job.failed': 'g' }
const FOLLOWUP_TAG = { new: ['new', 'ใหม่'], recurring: ['same', 'เกิดซ้ำ'], threshold: ['up', 'เกินเกณฑ์'] } as const

function spark(values: number[]): string {
  const max = Math.max(...values, 0)
  return `<div class="ig-spark" aria-hidden="true">${values
    .map((v, i) => `<i class="${i === values.length - 1 ? 'last' : ''}" style="height:${max ? Math.max(4, Math.round((v / max) * 100)) : 4}%"></i>`)
    .join('')}</div>`
}

function kpi(label: string, value: string, note: string, tone: string, sparkValues?: number[]): string {
  return `<div><span>${esc(label)}</span><b>${esc(value)}</b>${sparkValues ? spark(sparkValues) : ''}<em class="${tone}">${esc(note)}</em></div>`
}

const section = (title: string, body: string) => `<div class="ig-sec"><span class="ig-ct">${esc(title)}</span>${body}</div>`
const empty = `<p class="ig-empty">${EMPTY}</p>`

function aiLine(r: StoredReport, target: string): string {
  const note = r.aiStatus === 'ok' ? r.payload.aiNotes.find((n) => n.target === target) : undefined
  return note
    ? `<p class="ig-ailine"><b>AI</b>${esc(note.text)}</p>`
    : `<p class="ig-aimiss">${esc(aiMissingText(r.aiStatus, r.aiMessage))}</p>`
}

function timeline(r: StoredReport): string {
  const p = r.payload
  const at = (t: number) => Math.min(100, Math.max(0, ((t - p.windowStartMs) / DAY_MS) * 100))
  const bars = p.incidents
    .map((i) => {
      const left = at(i.startedAtMs)
      const width = Math.max(0.8, at(i.endedAtMs ?? p.windowEndMs) - left)
      return `<i class="${INCIDENT_TONE[i.source]}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i>`
    })
    .join('')
  const ticks = [0, 6, 12, 18, 24].map((h) => `<span>${clock(p.windowStartMs + h * 3_600_000)}</span>`).join('')
  const legend = p.incidents.length
    ? p.incidents
        .slice(0, 6)
        .map((i) => `<span><i class="${INCIDENT_TONE[i.source]}"></i>${clock(i.startedAtMs)}–${i.endedAtMs === null ? 'ยังไม่จบ' : clock(i.endedAtMs)} ${esc(i.what)}</span>`)
        .join('')
    : `<span>${EMPTY}</span>`
  return `<div class="ig-tl"><div class="ig-tl-bar">${bars}</div><div class="ig-ticks">${ticks}</div></div><div class="ig-tl-leg">${legend}</div>`
}

function overview(r: StoredReport): string {
  const p = r.payload
  const f = p.figures
  const problems = p.features.filter((x) => x.state === 'bad' || x.state === 'below').length
  const kpis = [
    kpi('ผู้ใช้ที่เจอปัญหา', `${count(f.usersAffected.value)} คน`, changeText(f.usersAffected), changeTone(f.usersAffected), p.trend.map((t) => t.usersAffected)),
    kpi('โรงเรียนที่ได้รับผลกระทบ', `${count(f.orgsAffected.value)} แห่ง`, changeText(f.orgsAffected), changeTone(f.orgsAffected)),
    kpi('ฟีเจอร์ที่มีปัญหา', p.features.length ? `${problems}/${p.features.length}` : '–', p.features.length ? (problems ? 'ต่ำกว่าปกติหรือเกณฑ์' : 'ทำงานปกติ') : 'กำลังเก็บข้อมูล', problems ? 'bad' : 'ok'),
    kpi('การใช้งานทั้งหมด', count(f.requests.value), changeText(f.requests), '', p.trend.map((t) => t.requests)),
  ].join('')
  const feats = p.features.length
    ? `<div class="ig-feats">${p.features
        .map((x) => `<span class="ig-feat ${FEATURE_TONE[x.state]}"><i class="dot"></i>${esc(x.name)} <b>${x.successRate === null ? '–' : pct(x.successRate, 1)}</b></span>`)
        .join('')}</div>`
    : '<p class="ig-empty">กำลังเก็บข้อมูลการใช้งานเพื่อเลือกฟีเจอร์หลัก</p>'
  const follow = p.followups.length
    ? `<div class="ig-follow">${p.followups
        .slice(0, 5)
        .map((x) => `<div class="ig-fo"><span class="ig-tag ${FOLLOWUP_TAG[x.kind][0]}">${FOLLOWUP_TAG[x.kind][1]}</span><span>${esc(x.text)}</span></div>`)
        .join('')}</div>`
    : empty
  return [
    `<p class="ig-sum">${esc(p.headline.summaryOverview)}</p>`,
    aiLine(r, 'summaryOverview'),
    `<div class="ig-kpis">${kpis}</div>`,
    section('ฟีเจอร์หลัก', feats),
    section(`เกิดอะไรขึ้นตอนไหน (${windowText(p.windowStartMs, p.windowEndMs)})`, timeline(r)),
    section('ต้องติดตาม', follow),
  ].join('')
}

function detail(r: StoredReport): string {
  const p = r.payload
  const f = p.figures
  const downMinutes = p.dependencies.reduce((sum, d) => sum + d.downMinutes, 0)
  const kpis = [
    kpi('อัตราที่ใช้งานไม่สำเร็จ', pct(f.errorRate.value), changeText(f.errorRate), changeTone(f.errorRate), p.trend.map((t) => t.errorRate)),
    kpi('ความเร็ว (p95)', ms(f.p95Ms.value), changeText(f.p95Ms), changeTone(f.p95Ms), p.trend.map((t) => t.p95Ms)),
    kpi('error กลุ่มใหม่', count(f.errorGroups.new), `เพิ่มขึ้น ${f.errorGroups.up} กลุ่ม`, f.errorGroups.new ? 'bad' : 'ok'),
    kpi('ระบบที่พึ่งพาล่มรวม', `${Math.round(downMinutes * 10) / 10} นาที`, `${p.dependencies.filter((d) => d.problem).length} ระบบมีปัญหา`, downMinutes ? 'bad' : 'ok'),
  ].join('')
  const chips = [
    ...p.dependencies.map((d) => `<span class="ig-feat ${d.problem ? 'bad' : 'warn'}"><i class="dot"></i>${esc(d.name)} <b>ล่ม ${d.downMinutes} นาที</b></span>`),
    ...p.jobs
      .filter((j) => j.failed || j.missed)
      .map((j) => `<span class="ig-feat ${j.failed ? 'bad' : 'warn'}"><i class="dot"></i>${esc(j.job)} <b>${j.failed ? `ล้มเหลว ${count(j.failed)}` : `ไม่รัน ${count(j.missed)} รอบ`}</b></span>`),
    ...p.deploys.map((d) => `<span class="ig-feat"><i class="dot"></i>deploy ${esc(d.service)} <b>${esc(d.previousVersion || '–')} → ${esc(d.version)} · ${clock(d.deployedAtMs)}</b></span>`),
  ]
  const max = Math.max(...p.slowRoutes.map((s) => s.p95Ms), 1)
  const slow = p.slowRoutes.length
    ? `<div class="ig-slow">${p.slowRoutes
        .map(
          (s) =>
            `<div class="ig-sr"><code>${esc(s.route)}</code><span class="trk"><i style="width:${((s.p95_7dMs / max) * 100).toFixed(1)}%"></i><i class="now" style="width:${((s.p95Ms / max) * 100).toFixed(1)}%"></i></span><span>${ms(s.p95_7dMs)} → <b>${ms(s.p95Ms)}</b></span></div>`,
        )
        .join('')}</div>`
    : empty
  const maxCount = Math.max(...p.topErrors.slice(0, 3).flatMap((e) => [e.count, e.count7dAvg ?? 0]), 1)
  const deployOf = (fp: string) => p.deploys.find((d) => d.relatedFingerprints.includes(fp))
  const errors = p.topErrors.length
    ? `<table class="ig-t">${p.topErrors
        .slice(0, 3)
        .map((e) => {
          const ai = r.aiStatus === 'ok' ? p.aiNotes.find((n) => n.target === e.fingerprint) : undefined
          const tag = e.trend === 'new' ? '<span class="ig-tag new">ใหม่</span>' : `<span class="ig-tag up">${e.changePct === null ? 'เพิ่มขึ้น' : `+${Math.round(e.changePct * 100)}%`}</span>`
          const deploy = deployOf(e.fingerprint)
          const meta = [e.location, `เริ่ม ${clock(e.firstSeenMs)}`, deploy ? `หลัง deploy ${deploy.version}` : ''].filter(Boolean).map(esc).join(' · ')
          const normal = e.count7dAvg === null ? 'ยังไม่มีค่าปกติ' : `ปกติ ${count(Math.round(e.count7dAvg))}`
          const bar = `<span class="trk"><i style="width:${(((e.count7dAvg ?? 0) / maxCount) * 100).toFixed(1)}%"></i><i class="now" style="width:${((e.count / maxCount) * 100).toFixed(1)}%"></i></span>`
          return `<tr><td>${tag}</td><td><b>${esc(e.errorHint || e.errorType || e.message || e.logger)}</b><br><span class="rt">${esc(e.route || e.service)}</span><br><span class="meta">${meta}</span></td><td class="n"><b>${count(e.count)} ครั้ง</b> <span class="meta">${esc(normal)}</span>${bar}</td>${ai ? `<td class="ai"><b>AI</b> ${esc(ai.text)}</td>` : ''}</tr>`
        })
        .join('')}</table>`
    : empty
  return [
    `<p class="ig-sum">${esc(p.headline.summaryDetail)}</p>`,
    aiLine(r, 'summaryDetail'),
    `<div class="ig-kpis">${kpis}</div>`,
    section('ระบบที่พึ่งพา · งานเบื้องหลัง · deploy', chips.length ? `<div class="ig-feats">${chips.join('')}</div>` : empty),
    section('endpoint ที่ช้าขึ้น (p95 เทียบ 7 วัน)', slow),
    section('error ที่ต้องดูก่อน (จำนวนครั้ง เทียบค่าเฉลี่ย 7 วัน)', errors),
  ].join('')
}

/** One card: header band, summary, 4 figures, the tab's sections, footer. */
export function infographic(r: StoredReport, tab: ReportTab): string {
  const p = r.payload
  const tone = STATUS_TONE[p.headline.statusAuto]
  return `<article class="ig ig--${tab}">
  <header class="ig-band"><div><span class="ig-kicker">สรุปรายวัน · ${esc(p.env)} · ${tab === 'overview' ? 'ภาพรวม' : 'รายละเอียด'}</span><b>${esc(thaiDate(p.reportDate))}</b></div><span class="ig-pill ${tone}"><i class="dot"></i>${STATUS_TEXT[p.headline.statusAuto]}</span></header>
  ${tab === 'overview' ? overview(r) : detail(r)}
  <footer class="ig-foot"><span>skilllane-monitoring · ${esc(windowText(p.windowStartMs, p.windowEndMs))}</span><span>สร้างเมื่อ ${esc(dateTime(r.generatedAt))}</span></footer>
</article>`
}
