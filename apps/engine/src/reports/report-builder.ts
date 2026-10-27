/**
 * The data layer of the daily report: ReportBuilder reads (ReportQueries, ReleasesService)
 * and assembleReport turns the rows into the payload (pure, tested).
 */
import { Injectable } from '@nestjs/common'
import { config } from '../config'
import { type Deploy, ReleasesService } from '../query/releases.service'
import { type ErrorDb, ReportQueries, type RouteDb } from './report-queries'
import {
  addDays,
  BASELINE_WINDOWS,
  type ClassifiedError,
  classifyError,
  compare,
  DAY_MS,
  type DependencyEvent,
  decideStatus,
  followups,
  headlines,
  type JobDb,
  jobIncidents,
  mean,
  MIN_BASELINE,
  missedCrons,
  outageTargets,
  pct,
  reportWindow,
  round,
  type SpikeBucket,
  spikeIncidents,
} from './rules'
import {
  type DailyPayload,
  REPORT_SCHEMA_VERSION,
  type ReportDependency,
  type ReportDeploy,
  type ReportError,
  type ReportIncident,
  type ReportJob,
  type ReportRules,
  type SlowRoute,
  type TrendPoint,
} from './types'

/** Slot of the report window; 0–5 are the windows before. */
const THIS = BASELINE_WINDOWS
const DEPLOY_WINDOW_MS = 2 * 3_600_000
const SLOW_MIN_REQUESTS = 50
const TOP_ERRORS = 5
const TOP_SLOW = 5
const MAX_INCIDENT_USER_QUERIES = 20

export interface RawReportData {
  env: string
  reportDate: string
  fromMs: number
  toMs: number
  nowMs: number
  /** Slots 0–6. */
  figureSlots: Array<{ slot: number; requests: number; errors: number; p95: number }>
  userSlots: Array<{ slot: number; users: number; orgs: number }>
  errors: ErrorDb[]
  /** Slots < 6 back to newLookbackDays before the window. */
  errorHistory: Array<{ fingerprint: string; slot: number; count: number; first_ms: number }>
  spikeBuckets: SpikeBucket[]
  dependencyEvents: DependencyEvent[]
  jobs: JobDb[]
  /** The window and the 6 before it. */
  cronStarts: Array<{ type: string; starts: number[] }>
  deploys: Deploy[]
  routes: RouteDb[]
}

const minutesText = (ms: number): string => `${round(ms / 60_000, 1)} นาที`

export function assembleReport(raw: RawReportData, r: ReportRules): DailyPayload {
  // ---------- figures + trend
  const figBy = new Map(raw.figureSlots.map((s) => [Number(s.slot), s]))
  const userBy = new Map(raw.userSlots.map((s) => [Number(s.slot), s]))
  const trend: TrendPoint[] = Array.from({ length: THIS + 1 }, (_, slot) => {
    const f = figBy.get(slot)
    const u = userBy.get(slot)
    const requests = f?.requests ?? 0
    return {
      reportDate: addDays(raw.reportDate, slot - THIS),
      hasData: requests > 0,
      usersAffected: u?.users ?? 0,
      orgsAffected: u?.orgs ?? 0,
      errorRate: requests ? round((f?.errors ?? 0) / requests, 5) : 0,
      p95Ms: round(f?.p95 ?? 0, 1),
      requests,
    }
  })
  const now = trend[THIS]
  const before = trend.slice(0, THIS)
  const hist = (pick: (t: TrendPoint) => number) => before.map((t) => (t.hasData ? pick(t) : null))
  const baselineWindows = before.filter((t) => t.hasData).length

  // ---------- errors
  const histBy = new Map<string, { slots: Map<number, number>; firstMs: number }>()
  for (const h of raw.errorHistory) {
    const e = histBy.get(h.fingerprint) ?? { slots: new Map<number, number>(), firstMs: Number(h.first_ms) }
    e.slots.set(Number(h.slot), (e.slots.get(Number(h.slot)) ?? 0) + h.count)
    e.firstMs = Math.min(e.firstMs, Number(h.first_ms))
    histBy.set(h.fingerprint, e)
  }
  const dataSlots = before.map((t, slot) => (t.hasData ? slot : -1)).filter((s) => s >= 0)
  const classified: ClassifiedError[] = raw.errors.map((e) => {
    const h = histBy.get(e.fingerprint)
    const counts = dataSlots.map((s) => h?.slots.get(s) ?? 0)
    const count7dAvg = counts.length >= MIN_BASELINE ? round(mean(counts), 2) : null
    const c = compare(e.count, dataSlots.length >= MIN_BASELINE ? counts : [])
    return {
      fingerprint: e.fingerprint,
      service: e.service,
      errorType: e.error_type,
      errorHint: e.error_hint,
      route: e.route,
      location: e.origin_file || e.origin_function ? `${e.origin_file} › ${e.origin_function}` : '',
      count: e.count,
      count7dAvg,
      changePct: c.changePct,
      users: e.users,
      firstSeenMs: Math.min(Number(e.first_ms), h?.firstMs ?? Number.POSITIVE_INFINITY),
      trend: classifyError(e.count, counts, !!h, r),
      sampleTraceId: e.trace_id,
      seenWindows: 1 + [0, 1, 2, 3, 4, 5].filter((s) => (h?.slots.get(s) ?? 0) > 0).length,
    }
  })
  const topErrors: ReportError[] = classified
    .filter((e): e is ClassifiedError & { trend: 'new' | 'up' } => e.trend === 'new' || e.trend === 'up')
    .sort((a, b) => b.users - a.users || b.count - a.count)
    .slice(0, TOP_ERRORS)
    .map(({ seenWindows: _seen, ...e }) => e)

  const figures = {
    usersAffected: compare(now.usersAffected, hist((t) => t.usersAffected)),
    orgsAffected: compare(now.orgsAffected, hist((t) => t.orgsAffected)),
    errorRate: compare(now.errorRate, hist((t) => t.errorRate)),
    p95Ms: compare(now.p95Ms, hist((t) => t.p95Ms)),
    requests: compare(now.requests, hist((t) => t.requests)),
    baselineWindows,
    errorGroups: {
      new: classified.filter((e) => e.trend === 'new').length,
      up: classified.filter((e) => e.trend === 'up').length,
    },
  }

  // ---------- dependencies, jobs, incidents
  const dependencies: ReportDependency[] = outageTargets(raw.dependencyEvents, raw.fromMs, raw.toMs).map((t) => ({
    key: t.key,
    name: `${t.type} ${t.name}`,
    host: t.host,
    port: t.port,
    downMinutes: t.minutes,
    downEvents: t.downEvents,
    windows: t.windows,
    lastError: t.message,
    problem: t.minutes >= r.dependencyMin,
    note: t.windows.some((w) => w.ongoing) ? 'ยังล่มอยู่ตอนจบช่วง' : '',
  }))
  const missed = new Map(missedCrons(raw.cronStarts, raw.fromMs, raw.toMs, raw.nowMs).map((m) => [m.key, m]))
  const jobs: ReportJob[] = raw.jobs.map((j) => ({
    job: j.job,
    kind: j.kind === 'cron' ? ('cron' as const) : ('queue' as const),
    service: j.service,
    total: j.total,
    failed: j.failed,
    missed: 0,
    note: '',
  }))
  for (const m of missed.values()) {
    if (!jobs.some((j) => j.job === m.key)) jobs.push({ job: m.key, kind: 'cron', service: '', total: 0, failed: 0, missed: 0, note: '' })
    const row = jobs.find((j) => j.job === m.key)!
    row.missed = m.missedRuns
    row.note = `ไม่รันตามรอบประมาณ ${m.missedRuns} ครั้ง (ปกติทุก ${m.medianGapMin} นาที)`
  }
  jobs.sort((a, b) => b.failed - a.failed || b.missed - a.missed || b.total - a.total)

  const incidents: ReportIncident[] = [
    ...dependencies
      .filter((d) => d.problem)
      .flatMap((d) =>
        d.windows.map((w, i) => ({
          id: `dependency:${d.key}:${i}`,
          source: 'dependency.down' as const,
          startedAtMs: w.fromMs,
          endedAtMs: w.ongoing ? null : w.toMs,
          what: `${d.name} ล่ม ${minutesText(w.toMs - w.fromMs)}`,
          usersAffected: null,
          state: w.ongoing ? ('ongoing' as const) : ('resolved' as const),
        })),
      ),
    ...spikeIncidents(raw.spikeBuckets, figures.errorRate.baseline, r).map((s) => {
      const ongoing = s.toMs >= raw.toMs
      return {
        id: `spike:${s.fromMs}`,
        source: 'error_spike' as const,
        startedAtMs: s.fromMs,
        endedAtMs: ongoing ? null : s.toMs,
        what: `error สูงผิดปกติ ${minutesText(s.toMs - s.fromMs)} (สูงสุด ${pct(s.peakRate)})`,
        usersAffected: null,
        state: ongoing ? ('ongoing' as const) : ('resolved' as const),
      }
    }),
    ...jobIncidents(raw.jobs),
  ].sort((a, b) => a.startedAtMs - b.startedAtMs)

  const { status, reasons } = decideStatus(
    {
      errorRate: figures.errorRate.value,
      errorRateBaseline: figures.errorRate.baseline,
      outageMinutes: dependencies.reduce((sum, d) => sum + d.downMinutes, 0),
      features: [],
      incidents: incidents.length,
    },
    r,
  )

  // ---------- deploys
  const newErrors = classified.filter((e) => e.trend === 'new')
  const deploys: ReportDeploy[] = raw.deploys
    .map((d) => ({ d, atMs: Date.parse(d.at) }))
    .filter(({ atMs }) => atMs >= raw.fromMs && atMs < raw.toMs)
    .map(({ d, atMs }) => ({
      service: d.service,
      version: d.version,
      previousVersion: d.previousVersion,
      deployedAtMs: atMs,
      relatedFingerprints: newErrors
        .filter((e) => e.service === d.service && e.firstSeenMs >= atMs && e.firstSeenMs < atMs + DEPLOY_WINDOW_MS)
        .map((e) => e.fingerprint),
    }))
    .sort((a, b) => a.deployedAtMs - b.deployedAtMs)

  // ---------- slow routes
  const slowRoutes: SlowRoute[] = raw.routes
    .filter((x) => x.requests >= SLOW_MIN_REQUESTS && x.p95_prev > 0 && x.p95 > x.p95_prev * r.slowX)
    .sort((a, b) => b.p95 / b.p95_prev - a.p95 / a.p95_prev)
    .slice(0, TOP_SLOW)
    .map((x) => ({ route: x.route, service: x.service, requests: x.requests, p95Ms: round(x.p95, 1), p95_7dMs: round(x.p95_prev, 1) }))

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    env: raw.env,
    reportDate: raw.reportDate,
    windowStartMs: raw.fromMs,
    windowEndMs: raw.toMs,
    rulesUsed: r,
    headline: { statusAuto: status, reasons, ...headlines({ status, reasons, figures }) },
    figures,
    trend,
    features: [],
    incidents,
    followups: followups(classified, figures, dependencies),
    topErrors,
    dependencies,
    jobs: jobs.slice(0, 20),
    deploys,
    slowRoutes,
    aiNotes: [],
  }
}

@Injectable()
export class ReportBuilder {
  constructor(
    private readonly queries: ReportQueries,
    private readonly releases: ReleasesService,
  ) {}

  async build(env: string, reportDate: string, nowMs = Date.now()): Promise<DailyPayload> {
    const r = config.report.rules
    const { fromMs, toMs } = reportWindow(reportDate)
    const originMs = fromMs - BASELINE_WINDOWS * DAY_MS
    const window = { env, fromMs, toMs }
    const seven = { env, fromMs: originMs, toMs, originMs }
    const [figureSlots, userSlots, errors, spikeBuckets, dependencyEvents, jobs, cronStarts, releases, routes] = await Promise.all([
      this.queries.figureSlots(seven),
      this.queries.userSlots(seven),
      this.queries.errors(window),
      this.queries.spikeBuckets(window),
      this.queries.dependencyEvents(window),
      this.queries.jobs(window),
      this.queries.cronStarts({ env, fromMs: originMs, toMs }),
      this.releases.releases({ env }),
      this.queries.routes({ env, fromMs: originMs, toMs, windowFromMs: fromMs }),
    ])
    const errorHistory = await this.queries.errorHistory(
      { env, fromMs: fromMs - r.newLookbackDays * DAY_MS, toMs: fromMs, originMs },
      errors.map((e) => e.fingerprint),
    )
    const payload = assembleReport(
      { env, reportDate, fromMs, toMs, nowMs, figureSlots, userSlots, errors, errorHistory, spikeBuckets, dependencyEvents, jobs, cronStarts, deploys: releases.deploys, routes },
      r,
    )
    // users per incident: one small query each, outages and spikes only
    await Promise.all(
      payload.incidents
        .filter((i) => i.source !== 'job.failed')
        .slice(0, MAX_INCIDENT_USER_QUERIES)
        .map(async (i) => {
          i.usersAffected = await this.queries.usersBetween({ env, fromMs: i.startedAtMs, toMs: i.endedAtMs ?? toMs })
        }),
    )
    return payload
  }
}
