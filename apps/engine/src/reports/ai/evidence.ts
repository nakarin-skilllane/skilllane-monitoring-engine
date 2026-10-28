/**
 * What the AI may read about a report (pure): the snapshot's numbers already worked out by SQL, as
 * the page shows them, each fact under a stable id it must cite. No user ids, e-mails, bodies, SQL:
 * the payload has none, and error messages were masked when the snapshot was built.
 */
import { clock, count, ms, pct, share, STATUS_TEXT } from '../render/html'
import type { StoredReport } from '../types'

export type Facts = Record<string, string>

export interface EvidenceItem {
  id: string
  kind: 'status' | 'figure' | 'incident' | 'error' | 'dependency' | 'deploy' | 'job' | 'slow' | 'feature'
  facts: Facts
}

export type TargetKind = 'summaryOverview' | 'summaryDetail' | 'error' | 'incident' | 'featureName'

export interface AiTarget {
  /** The aiNotes target: summaryOverview | summaryDetail | an error fingerprint | an incident id | featureName:<featureId>. */
  id: string
  kind: TargetKind
  /** The evidence the note is about (it may cite others too). */
  about: string
}

export interface EvidencePack {
  env: string
  reportDate: string
  window: string
  items: EvidenceItem[]
  targets: AiTarget[]
}

const normal = (baseline: number | null, fmt: (v: number) => string) => (baseline === null ? 'ยังไม่มีค่าปกติ' : fmt(baseline))
const change = (c: { changePct: number | null; baseline: number | null }) =>
  c.baseline === null ? 'ยังไม่มีค่าปกติ' : c.changePct === null ? 'ใหม่' : `${c.changePct > 0 ? '+' : ''}${Math.round(c.changePct * 100)}%`

/** `featureId`s whose name is still the route (`/resource`): the AI may name them. */
export function unnamedFeatures(r: StoredReport): string[] {
  return r.payload.features.filter((f) => f.name.startsWith('/')).map((f) => f.featureId)
}

export function buildEvidence(r: StoredReport, featureRoutes: Record<string, string[]> = {}): EvidencePack {
  const p = r.payload
  const f = p.figures
  const items: EvidenceItem[] = []
  const add = (id: string, kind: EvidenceItem['kind'], facts: Facts) => items.push({ id, kind, facts })

  add('status', 'status', { status: STATUS_TEXT[p.headline.statusAuto], reasons: p.headline.reasons.join(' · ') || '–' })
  add('fig:requests', 'figure', {
    name: 'การใช้งาน (request)', value: count(f.requests.value), change: change(f.requests), normal: normal(f.requests.baseline, count),
    failed: share(f.failedRequests ?? 0, f.requests.value),
  })
  if (f.activeUsers) {
    add('fig:users', 'figure', { name: 'ผู้ใช้งาน', value: count(f.activeUsers.value), change: change(f.activeUsers), normal: normal(f.activeUsers.baseline, count), affected: share(f.usersAffected.value, f.activeUsers.value) })
  } else {
    add('fig:users', 'figure', { name: 'ผู้ใช้ที่เจอปัญหา', value: count(f.usersAffected.value), change: change(f.usersAffected), normal: normal(f.usersAffected.baseline, count) })
  }
  if (f.activeOrgs) {
    add('fig:orgs', 'figure', { name: 'โรงเรียนที่ใช้งาน', value: count(f.activeOrgs.value), change: change(f.activeOrgs), affected: share(f.orgsAffected.value, f.activeOrgs.value) })
  }
  add('fig:errorRate', 'figure', { name: 'อัตราที่ใช้งานไม่สำเร็จ', value: pct(f.errorRate.value), change: change(f.errorRate), normal: normal(f.errorRate.baseline, (v) => pct(v)) })
  add('fig:p95', 'figure', { name: 'ความเร็ว (p95)', value: ms(f.p95Ms.value), change: change(f.p95Ms), normal: normal(f.p95Ms.baseline, ms) })
  for (const i of p.incidents) {
    add(`inc:${i.id}`, 'incident', {
      what: i.what, from: clock(i.startedAtMs), to: i.endedAtMs === null ? 'ยังไม่จบ' : clock(i.endedAtMs),
      users: i.usersAffected === null ? '–' : count(i.usersAffected), source: i.source,
    })
  }
  for (const e of p.topErrors) {
    const deploy = p.deploys.find((d) => d.relatedFingerprints.includes(e.fingerprint))
    add(`err:${e.fingerprint}`, 'error', {
      title: e.errorType || e.logger || 'error', detail: e.errorHint || e.message || '–', service: e.service, route: e.route || '–',
      location: e.location || '–', count: count(e.count), normal: e.count7dAvg === null ? 'ยังไม่มีค่าปกติ' : count(Math.round(e.count7dAvg)),
      trend: e.trend === 'new' ? 'ใหม่ (ไม่เคยพบใน 14 วัน)' : 'เพิ่มขึ้น', firstSeen: clock(e.firstSeenMs),
      afterDeploy: deploy ? `${deploy.service} ${deploy.previousVersion || '–'} → ${deploy.version} เวลา ${clock(deploy.deployedAtMs)}` : '–',
    })
  }
  for (const d of p.dependencies) add(`dep:${d.key}`, 'dependency', { name: d.name, downMinutes: String(d.downMinutes), downEvents: String(d.downEvents), lastError: d.lastError || '–' })
  for (const d of p.deploys) add(`deploy:${d.service}@${d.version}`, 'deploy', { service: d.service, from: d.previousVersion || '–', to: d.version, at: clock(d.deployedAtMs) })
  for (const j of p.jobs.filter((x) => x.failed || x.missed)) add(`job:${j.job}`, 'job', { job: j.job, kind: j.kind, failed: count(j.failed), total: count(j.total), missed: count(j.missed) })
  for (const s of p.slowRoutes) add(`slow:${s.route}`, 'slow', { route: s.route, p95: ms(s.p95Ms), p95Normal: ms(s.p95_7dMs), requests: count(s.requests) })
  for (const x of p.features) {
    add(`feat:${x.featureId}`, 'feature', {
      name: x.name, success: x.successRate === null ? '–' : pct(x.successRate, 1), success7d: x.successRate7d === null ? '–' : pct(x.successRate7d, 1),
      volume: count(x.volume), note: x.note || '–', routes: (featureRoutes[x.featureId] ?? []).join(', ') || '–',
    })
  }

  const targets: AiTarget[] = [
    { id: 'summaryOverview', kind: 'summaryOverview', about: 'status' },
    { id: 'summaryDetail', kind: 'summaryDetail', about: 'status' },
    ...p.topErrors.map((e) => ({ id: e.fingerprint, kind: 'error' as const, about: `err:${e.fingerprint}` })),
    ...p.incidents.map((i) => ({ id: i.id, kind: 'incident' as const, about: `inc:${i.id}` })),
    ...unnamedFeatures(r).map((id) => ({ id: `featureName:${id}`, kind: 'featureName' as const, about: `feat:${id}` })),
  ]
  return { env: p.env, reportDate: p.reportDate, window: `${clock(p.windowStartMs)} เมื่อวาน ถึง ${clock(p.windowEndMs)} วันนี้ (เวลาไทย)`, items, targets }
}
