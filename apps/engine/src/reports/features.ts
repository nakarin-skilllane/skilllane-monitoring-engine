/**
 * Main features of the daily report, picked from usage without anyone listing them (pure).
 * A feature = the HTTP routes of one service sharing their first path segment (resource).
 * Each day of the RANK_DAYS before the report is ranked by a score over the SCORE_DAYS before
 * that day; membership is replayed over those days (enter: top 6 for 7 days running; leave:
 * outside the top 8 for 14 days running), so a rebuild of any date gives the same list.
 */
import { featureName } from './feature-names'
import { addDays, round } from './rules'
import type { ReportFeature, ReportRules } from './types'

/** Ranked days replayed: 14 to settle the list, 14 for the leave rule to act. */
export const RANK_DAYS = 28
export const SCORE_DAYS = 30
const ENTER_RANK = 6
const ENTER_DAYS = 7
const LEAVE_RANK = 8
const LEAVE_DAYS = 14
const MAX_FEATURES = 8
const MIN_REQUESTS = 50
const MIN_USER_SHARE = 0.05
/** Probes and plumbing, never a feature. */
const NOT_FEATURES = new Set(['health', 'healthz', 'ready', 'readiness', 'live', 'liveness', 'metrics', 'version', 'env', 'ping', 'status', 'favicon.ico'])
const WEIGHTS = { users: 0.3, orgs: 0.15, success: 0.25, days: 0.1, writes: 0.1, peak: 0.1 } as const

/**
 * First path segment after `api/` and `v1/`…: `GET /api/v1/courses/:id` → `courses`. A path that
 * starts with a parameter has none. report-queries uses the same pattern in ClickHouse (RE2).
 */
export const RESOURCE_RE = '^[A-Z]+ /(?:(?:api|v[0-9]+)/)*([A-Za-z][A-Za-z0-9_.-]*)'
const RESOURCE = new RegExp(RESOURCE_RE)

export const resourceOf = (route: string): string => RESOURCE.exec(route)?.[1] ?? ''

export const isFeatureResource = (resource: string): boolean => resource !== '' && !NOT_FEATURES.has(resource.toLowerCase())

/** One group on one Bangkok day (report-queries usageDays). */
export interface UsageDay {
  day: string
  service: string
  resource: string
  requests: number
  ok: number
  withUser: number
  writes: number
  /** Share of the 10 hours 08–17 with requests. */
  peak: number
  routes: string[]
}

/** Distinct users / orgs of a group over the SCORE_DAYS before rank day k (report-queries usageUniq). */
export interface UsageUniq {
  k: number
  service: string
  resource: string
  users: number
  orgs: number
}

export interface RankedGroup {
  featureId: string
  service: string
  resource: string
  routes: string[]
  requests: number
  score: number
  rank: number
}

const idOf = (service: string, resource: string) => `${service}:${resource}`

/** Rank day k (0 … RANK_DAYS − 1) of a report: the last one is the report date. */
export const rankDay = (reportDate: string, k: number): string => addDays(reportDate, k - (RANK_DAYS - 1))

/** min–max over the groups; all equal = 1 when above 0. */
function normalize(values: number[]): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return values.map((v) => (v > 0 ? 1 : 0))
  return values.map((v) => (v - min) / (max - min))
}

/** The ranking of each of the RANK_DAYS (index k), best first. */
export function rankDays(days: UsageDay[], uniq: UsageUniq[], reportDate: string): RankedGroup[][] {
  const uniqBy = new Map(uniq.map((u) => [`${u.k}\u0000${idOf(u.service, u.resource)}`, u]))
  const out: RankedGroup[][] = []
  for (let k = 0; k < RANK_DAYS; k++) {
    const ref = rankDay(reportDate, k)
    const from = addDays(ref, -SCORE_DAYS)
    const groups = new Map<string, { service: string; resource: string; requests: number; ok: number; withUser: number; writes: number; days: Set<string>; peak: number[]; routes: Set<string> }>()
    for (const d of days) {
      if (d.day < from || d.day >= ref || d.requests <= 0 || !isFeatureResource(d.resource)) continue
      const id = idOf(d.service, d.resource)
      const g = groups.get(id) ?? { service: d.service, resource: d.resource, requests: 0, ok: 0, withUser: 0, writes: 0, days: new Set<string>(), peak: [], routes: new Set<string>() }
      g.requests += d.requests
      g.ok += d.ok
      g.withUser += d.withUser
      g.writes += d.writes
      g.days.add(d.day)
      g.peak.push(d.peak)
      for (const r of d.routes) g.routes.add(r)
      groups.set(id, g)
    }
    const kept = [...groups.entries()].filter(([, g]) => g.requests >= MIN_REQUESTS && g.withUser / g.requests >= MIN_USER_SHARE)
    const parts = {
      users: normalize(kept.map(([id]) => uniqBy.get(`${k}\u0000${id}`)?.users ?? 0)),
      orgs: normalize(kept.map(([id]) => uniqBy.get(`${k}\u0000${id}`)?.orgs ?? 0)),
      success: normalize(kept.map(([, g]) => g.ok / g.requests)),
      days: normalize(kept.map(([, g]) => g.days.size / SCORE_DAYS)),
      writes: normalize(kept.map(([, g]) => g.writes / g.requests)),
      peak: normalize(kept.map(([, g]) => g.peak.reduce((a, b) => a + b, 0) / g.peak.length)),
    }
    const ranked = kept
      .map(([id, g], i) => ({
        featureId: id,
        service: g.service,
        resource: g.resource,
        routes: [...g.routes].sort(),
        requests: g.requests,
        score: round(
          (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce((sum, key) => sum + WEIGHTS[key] * parts[key][i], 0),
          4,
        ),
        rank: 0,
      }))
      .sort((a, b) => b.score - a.score || b.requests - a.requests || a.featureId.localeCompare(b.featureId))
    ranked.forEach((g, i) => (g.rank = i + 1))
    out.push(ranked)
  }
  return out
}

/** Replays enter / leave over the ranked days; the members at the last day, best rank first (≤ 8). */
export function activeFeatures(ranks: RankedGroup[][]): RankedGroup[] {
  if (!ranks.length) return []
  const rankOf = (k: number, id: string) => ranks[k].find((g) => g.featureId === id)?.rank ?? Number.POSITIVE_INFINITY
  const active = new Set(ranks[0].filter((g) => g.rank <= ENTER_RANK).map((g) => g.featureId))
  const span = (k: number, n: number) => Array.from({ length: n }, (_, i) => k - i)
  for (let k = 1; k < ranks.length; k++) {
    if (k >= ENTER_DAYS - 1) {
      for (const g of ranks[k]) {
        if (!active.has(g.featureId) && span(k, ENTER_DAYS).every((j) => rankOf(j, g.featureId) <= ENTER_RANK)) active.add(g.featureId)
      }
    }
    if (k >= LEAVE_DAYS - 1) {
      for (const id of [...active]) {
        if (span(k, LEAVE_DAYS).every((j) => rankOf(j, id) > LEAVE_RANK)) active.delete(id)
      }
    }
  }
  // the last ranking of each member: today's, or the latest day it was ranked
  const latest = new Map<string, RankedGroup>()
  for (const day of ranks) for (const g of day) if (active.has(g.featureId)) latest.set(g.featureId, g)
  const last = ranks[ranks.length - 1]
  const today = (id: string) => last.find((g) => g.featureId === id)
  return [...latest.values()]
    .map((g) => today(g.featureId) ?? { ...g, rank: Number.POSITIVE_INFINITY })
    .sort((a, b) => a.rank - b.rank || b.score - a.score)
    .slice(0, MAX_FEATURES)
}

/** Requests / errors of a feature in one slot (0–5 the windows before, 6 the report). */
export interface FeatureSlot {
  featureId: string
  slot: number
  requests: number
  errors: number
}

/** The features of the report with their success in the window and over the 6 windows before. */
export function featureValues(active: RankedGroup[], slots: FeatureSlot[], r: ReportRules): ReportFeature[] {
  const names = active.map((g) => featureName(g.resource).name)
  return active.map((g, i) => {
    const mine = slots.filter((s) => s.featureId === g.featureId)
    const sum = (rows: FeatureSlot[], key: 'requests' | 'errors') => rows.reduce((a, s) => a + s[key], 0)
    const now = mine.filter((s) => Number(s.slot) === 6)
    const before = mine.filter((s) => Number(s.slot) >= 0 && Number(s.slot) < 6)
    const volume = sum(now, 'requests')
    const prev = sum(before, 'requests')
    const successRate = volume ? round(1 - sum(now, 'errors') / volume, 4) : null
    const successRate7d = prev ? round(1 - sum(before, 'errors') / prev, 4) : null
    let state: ReportFeature['state'] = 'ok'
    let note = ''
    if (successRate === null) {
      state = 'idle'
      note = 'ไม่มีการใช้งานในช่วงนี้'
    } else if (successRate < r.badFeatureSuccess) {
      state = 'bad'
      note = `ต่ำกว่าเกณฑ์ ${round(r.badFeatureSuccess * 100, 1)}%`
    } else if (successRate7d !== null && (successRate7d - successRate) * 100 > r.featureDropPt) {
      state = 'below'
      note = `ต่ำกว่าปกติ ${round((successRate7d - successRate) * 100, 1)} จุด`
    }
    // two services with the same resource: tell them apart
    const name = names.filter((n) => n === names[i]).length > 1 ? `${names[i]} (${g.service})` : names[i]
    return { featureId: g.featureId, name, successRate, successRate7d, volume, state, note }
  })
}
