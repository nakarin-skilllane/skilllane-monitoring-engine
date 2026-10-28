import { assembleReport, type RawReportData } from '../src/reports/report-builder'
import { reportWindow } from '../src/reports/rules'
import type { StoredReport } from '../src/reports/types'
import { R } from './rules-fixture'

const DATE = '2026-10-21'
const W = reportWindow(DATE)
const H = 3_600_000

/** A report with an outage, a failed job, a new error, a deploy and a slow route (render tests). */
export function sampleReport(over: Partial<RawReportData> = {}, report: Partial<StoredReport> = {}): StoredReport {
  const raw: RawReportData = {
    env: 'prod', reportDate: DATE, fromMs: W.fromMs, toMs: W.toMs, nowMs: W.toMs + 60_000,
    figureSlots: [0, 1, 2, 3, 4, 5, 6].map((slot) => ({ slot, requests: 1000, errors: 10, p95: 200 })),
    userSlots: [0, 1, 2, 3, 4, 5, 6].map((slot) => ({ slot, users: slot === 6 ? 13 : 5, orgs: slot === 6 ? 3 : 1 })),
    activeSlots: [0, 1, 2, 3, 4, 5, 6].map((slot) => ({ slot, users: slot === 6 ? 1240 : 1200, orgs: 86 })),
    errors: [
      { fingerprint: '111', service: 'core', error_type: 'TypeError', error_hint: 'Null read', route: 'GET /classes/:id/result',
        origin_file: 'src/a.ts', origin_function: 'A.b', count: 30, users: 8, first_ms: W.fromMs + 10 * H, trace_id: 't1' },
    ],
    errorHistory: [],
    spikeBuckets: [],
    dependencyEvents: [
      { process: 'core/h1', type: 'redis', name: 'cache', host: 'r', port: 6379, code: 'dependency.down', atMs: W.fromMs + 2 * H, durationMs: null, reason: '', message: 'ECONNREFUSED' },
      { process: 'core/h1', type: 'redis', name: 'cache', host: 'r', port: 6379, code: 'dependency.up', atMs: W.fromMs + 2 * H + 40 * 60_000, durationMs: 40 * 60_000, reason: 'recovered', message: '' },
    ],
    jobs: [{ job: 'SendMail', kind: 'bullmq', service: 'core', total: 4, failed: 3, first_failed_ms: W.fromMs + 12 * H, last_failed_ms: W.fromMs + 12 * H, last_ok_ms: W.fromMs + 13 * H }],
    cronStarts: [],
    deploys: [{ service: 'core', env: 'prod', version: '1.1.0', previousVersion: '1.0.0', at: new Date(W.fromMs + 9 * H).toISOString() }],
    routes: [{ route: 'GET /a', service: 'core', requests: 100, p95: 300, p95_prev: 200 }],
    featureGroups: [{ featureId: 'core:classes', service: 'core', resource: 'classes', routes: [], requests: 0, score: 1, rank: 1 }],
    featureSlots: [{ featureId: 'core:classes', slot: 6, requests: 1000, errors: 2 }],
    ...over,
  }
  const payload = assembleReport(raw, R)
  return {
    env: 'prod', reportDate: DATE, windowStartMs: W.fromMs, windowEndMs: W.toMs, generatedAt: '2026-10-21T02:00:05.000Z',
    status: payload.headline.statusAuto, payload, aiStatus: 'disabled', aiMessage: '', ...report,
  }
}
