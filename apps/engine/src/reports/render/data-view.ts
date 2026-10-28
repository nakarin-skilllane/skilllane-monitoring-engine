/**
 * The data view of a tab as printable HTML (the PDF export): the cards of /reports/daily as
 * tables, with the same numbers. The monitor page itself stays React.
 */
import type { ReportFeature, StoredReport, TrendPoint } from '../types'
import { aiMissingText, changeText, clock, count, EMPTY, esc, ms, pct, STATUS_TEXT, STATUS_TONE } from './html'
import type { ReportTab } from './infographic'

type Row = Array<string | number>

/** A card: title with its กฎ label, a meta line, a table or the empty text. */
function card(title: string, meta: string, head: string[], rows: Row[], numeric: number[] = []): string {
  const body = rows.length
    ? `<table><thead><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : `<p class="dv-empty">${EMPTY}</p>`
  return `<section class="dv-card"><h3>${esc(title)} <span class="src">กฎ</span></h3>${meta ? `<p class="dv-meta">${esc(meta)}</p>` : ''}${body}</section>`
}

/** A small line chart of the 7 windows (inline SVG: no script, prints as is). */
function chart(title: string, trend: TrendPoint[], pick: (t: TrendPoint) => number, fmt: (v: number) => string): string {
  const w = 320
  const h = 110
  const pad = { l: 18, r: 18, t: 14, b: 22 }
  const values = trend.map(pick)
  const max = Math.max(...values, 0) || 1
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, values.length - 1)
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b)
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const labels = trend.map((t, i) => `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(t.reportDate.slice(5))}</text>`).join('')
  const last = values.length - 1
  return `<section class="dv-card dv-chart"><h3>${esc(title)} <span class="src">กฎ</span></h3><svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}"><polyline points="${points}" fill="none" stroke="#2e8b65" stroke-width="2"/>${values
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === last ? 3.5 : 2}" fill="${i === last ? '#c0503a' : '#2e8b65'}"/>`)
    .join('')}<text x="${x(last).toFixed(1)}" y="${(y(values[last] ?? 0) - 6).toFixed(1)}" text-anchor="end" class="v">${esc(fmt(values[last] ?? 0))}</text>${labels}</svg></section>`
}

const FEATURE_TEXT: Record<ReportFeature['state'], string> = { ok: 'ปกติ', below: 'ต่ำกว่าปกติ', bad: 'มีปัญหา', idle: 'ไม่มีการใช้งาน' }
const SOURCE_TEXT = { 'dependency.down': 'ระบบที่พึ่งพาล่ม', error_spike: 'error สูงผิดปกติ', 'job.failed': 'งานเบื้องหลังล้มเหลว' } as const
const FOLLOWUP_TEXT = { new: 'ใหม่', recurring: 'เกิดซ้ำ', threshold: 'เกินเกณฑ์' } as const
const rate = (v: number | null) => (v === null ? '–' : pct(v, 1))

function figures(r: StoredReport): string {
  const f = r.payload.figures
  const cell = (label: string, value: string, c: typeof f.requests, fmt: (v: number) => string) =>
    `<div><span>${esc(label)}</span><b>${esc(value)}</b><em>${esc(changeText(c))}${c.baseline === null ? '' : ` · ปกติ ${esc(fmt(c.baseline))}`}</em></div>`
  return `<div class="dv-figures">${[
    cell('ผู้ใช้ที่เจอปัญหา', `${count(f.usersAffected.value)} คน`, f.usersAffected, count),
    cell('โรงเรียนที่ได้รับผลกระทบ', `${count(f.orgsAffected.value)} แห่ง`, f.orgsAffected, count),
    cell('อัตราที่ใช้งานไม่สำเร็จ', pct(f.errorRate.value), f.errorRate, (v) => pct(v)),
    cell('ความเร็ว (p95)', ms(f.p95Ms.value), f.p95Ms, ms),
    cell('การใช้งานทั้งหมด', count(f.requests.value), f.requests, count),
  ].join('')}</div>`
}

function status(r: StoredReport, summary: string, target: string): string {
  const p = r.payload
  const note = r.aiStatus === 'ok' ? p.aiNotes.find((n) => n.target === target) : undefined
  return `<div class="dv-status"><p><span class="pill ${STATUS_TONE[p.headline.statusAuto]}">${STATUS_TEXT[p.headline.statusAuto]}</span> ${esc(summary)} <span class="src">กฎ</span></p>${
    note ? `<p class="dv-ai"><span class="src ai">AI</span> ${esc(note.text)}</p>` : `<p class="dv-aimiss">${esc(aiMissingText(r.aiStatus, r.aiMessage))}</p>`
  }</div>`
}

function overview(r: StoredReport): string {
  const p = r.payload
  return [
    status(r, p.headline.summaryOverview, 'summaryOverview'),
    card('เหตุการณ์สำคัญ', 'ช่วงเวลาที่ผู้ใช้ได้รับผลกระทบ (เวลาไทย)', ['เวลา', 'เกิดอะไร', 'ผู้ใช้', 'สถานะ', 'ที่มา'],
      p.incidents.map((i) => [`${clock(i.startedAtMs)}–${i.endedAtMs === null ? 'ยังไม่จบ' : clock(i.endedAtMs)}`, i.what, i.usersAffected === null ? '–' : count(i.usersAffected), i.state === 'ongoing' ? 'ยังเกิดอยู่' : 'จบแล้ว', SOURCE_TEXT[i.source]]), [2]),
    p.features.length
      ? card('ฟีเจอร์หลักทำงานไหม', 'สัดส่วนที่ใช้งานสำเร็จ เทียบ 7 วัน · ระบบเลือกฟีเจอร์เองจากการใช้งาน', ['ฟีเจอร์', 'สถานะ', 'ช่วงนี้', '7 วัน', 'ครั้ง', 'หมายเหตุ'],
          p.features.map((f) => [f.name, FEATURE_TEXT[f.state], rate(f.successRate), rate(f.successRate7d), count(f.volume), f.note || '–']), [2, 3, 4])
      : `<section class="dv-card"><h3>ฟีเจอร์หลักทำงานไหม <span class="src">กฎ</span></h3><p class="dv-empty">กำลังเก็บข้อมูลการใช้งานเพื่อเลือกฟีเจอร์หลัก</p></section>`,
    card('ต้องติดตาม', 'ปัญหาใหม่ที่ยังเกิดอยู่ เกิดซ้ำ หรือตัวเลขเกินเกณฑ์', ['ประเภท', 'เรื่อง'], p.followups.map((f) => [FOLLOWUP_TEXT[f.kind], f.text])),
    `<div class="dv-charts">${chart('ผู้ใช้ที่เจอปัญหา · 7 วัน', p.trend, (t) => t.usersAffected, count)}${chart('ความเร็ว (p95) · 7 วัน', p.trend, (t) => t.p95Ms, ms)}</div>`,
  ].join('')
}

function detail(r: StoredReport): string {
  const p = r.payload
  return [
    status(r, p.headline.summaryDetail, 'summaryDetail'),
    card('ปัญหาใหม่ / เพิ่มขึ้น', 'ใหม่ = ไม่เคยพบใน 14 วัน · เพิ่มขึ้น = มากกว่าค่าเฉลี่ย 7 วัน × 1.5 · เรียงตามผู้ใช้', ['#', 'ปัญหา', 'เทียบ 7 วัน', 'route', 'จุดในโค้ด', 'ครั้ง', 'ผู้ใช้', 'พบครั้งแรก'],
      p.topErrors.map((e, i) => [i + 1, `${e.errorType || e.logger} ${e.errorHint || e.message}`.trim(), e.trend === 'new' ? 'ใหม่' : e.changePct === null ? 'เพิ่มขึ้น' : `+${Math.round(e.changePct * 100)}%`, e.route || '–', e.location || '–', count(e.count), count(e.users), clock(e.firstSeenMs)]), [5, 6]),
    card('ระบบที่พึ่งพา', 'นาทีที่ล่มรวมในช่วงรายงาน', ['ระบบ', 'สถานะ', 'ล่ม (นาที)', 'error ล่าสุด', 'หมายเหตุ'],
      p.dependencies.map((d) => [`${d.name} (${d.host}:${d.port})`, d.problem ? 'มีปัญหา' : 'สะดุดสั้น', d.downMinutes, d.lastError || '–', d.note || '–']), [2]),
    card('งานเบื้องหลัง', 'cron และคิวงาน', ['งาน', 'ชนิด', 'ล้มเหลว', 'ทั้งหมด', 'ไม่รันตามรอบ', 'หมายเหตุ'],
      p.jobs.map((j) => [j.job, j.kind, count(j.failed), count(j.total), count(j.missed), j.note || '–']), [2, 3, 4]),
    card('deploy ในช่วงรายงาน', 'version ที่เปลี่ยน และปัญหาที่เริ่มภายใน 2 ชม. หลังจากนั้น', ['service', 'version', 'เวลา', 'โยงกับปัญหา'],
      p.deploys.map((d) => [d.service, `${d.previousVersion || '–'} → ${d.version}`, clock(d.deployedAtMs), d.relatedFingerprints.map((f) => f.slice(0, 6)).join(', ') || '–'])),
    card('endpoint ที่ช้าขึ้น', 'p95 ในช่วงรายงาน เทียบ 7 วัน', ['route', 'request', '7 วัน', 'ช่วงนี้'],
      p.slowRoutes.map((s) => [s.route, count(s.requests), ms(s.p95_7dMs), ms(s.p95Ms)]), [1, 2, 3]),
    `<div class="dv-charts">${chart('error rate · 7 วัน', p.trend, (t) => t.errorRate, (v) => pct(v))}${chart('ความเร็ว (p95) · 7 วัน', p.trend, (t) => t.p95Ms, ms)}</div>`,
  ].join('')
}

/** The figures (same on both tabs) and the tab's cards. */
export function dataView(r: StoredReport, tab: ReportTab): string {
  return `<article class="dv"><h2>${tab === 'overview' ? 'ภาพรวม' : 'รายละเอียด'}</h2>${figures(r)}${tab === 'overview' ? overview(r) : detail(r)}</article>`
}

