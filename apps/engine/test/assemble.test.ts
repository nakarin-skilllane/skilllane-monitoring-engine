import { describe, expect, it } from 'vitest'
import { assembleReport, maskMessage, type RawReportData } from '../src/reports/report-builder'
import { reportWindow } from '../src/reports/rules'
import { R } from './rules-fixture'

const DATE = '2026-10-21'
const W = reportWindow(DATE)
const H = 3_600_000
const SLOTS = [0, 1, 2, 3, 4, 5, 6]

function raw(over: Partial<RawReportData> = {}): RawReportData {
  return {
    env: 'prod', reportDate: DATE, fromMs: W.fromMs, toMs: W.toMs, nowMs: W.toMs + 60_000,
    figureSlots: SLOTS.map((slot) => ({ slot, requests: 1000, errors: 10, p95: 200 })),
    userSlots: SLOTS.map((slot) => ({ slot, users: slot === 6 ? 13 : 5, orgs: slot === 6 ? 3 : 1 })),
    errors: [
      { fingerprint: '111', service: 'core', error_type: 'TypeError', error_hint: 'Null read',
        route: 'GET /classes/:id/exams/:examId/result', origin_file: 'src/a.ts', origin_function: 'A.b',
        count: 30, users: 8, first_ms: W.fromMs + 10 * H, trace_id: 't1' },
      { fingerprint: '222', service: 'core', error_type: 'OracleError', error_hint: 'Value too large',
        route: 'POST /classes/:id/exams/:examId/submit', origin_file: 'src/b.ts', origin_function: 'B.c',
        count: 10, users: 5, first_ms: W.fromMs, trace_id: 't2' },
    ],
    errorHistory: [0, 1, 2, 3, 4, 5].map((slot) => ({ fingerprint: '222', slot, count: 10, first_ms: W.fromMs - (6 - slot) * 86_400_000 })),
    spikeBuckets: [],
    dependencyEvents: [
      { process: 'core/h1', type: 'redis', name: 'cache', host: 'r', port: 6379, code: 'dependency.down', atMs: W.fromMs + 2 * H, durationMs: null, reason: '', message: 'ECONNREFUSED' },
      { process: 'core/h1', type: 'redis', name: 'cache', host: 'r', port: 6379, code: 'dependency.up', atMs: W.fromMs + 2 * H + 40 * 60_000, durationMs: 40 * 60_000, reason: 'recovered', message: '' },
    ],
    jobs: [{ job: 'SendMail', kind: 'bullmq', service: 'core', total: 4, failed: 3, first_failed_ms: W.fromMs + 12 * H, last_failed_ms: W.fromMs + 12 * H, last_ok_ms: W.fromMs + 13 * H }],
    cronStarts: [],
    deploys: [{ service: 'core', env: 'prod', version: '1.1.0', previousVersion: '1.0.0', at: new Date(W.fromMs + 9 * H).toISOString() }],
    routes: [
      { route: 'GET /a', service: 'core', requests: 100, p95: 300, p95_prev: 200 },
      { route: 'GET /b', service: 'core', requests: 100, p95: 210, p95_prev: 200 },
      { route: 'GET /c', service: 'core', requests: 10, p95: 900, p95_prev: 200 },
    ],
    ...over,
  }
}

describe('assembleReport', () => {
  const p = assembleReport(raw(), R)

  it('figures against the 6 windows before; trend of 7 windows', () => {
    expect(p.figures.usersAffected).toEqual({ value: 13, baseline: 5, changePct: 1.6 })
    expect(p.figures.orgsAffected).toEqual({ value: 3, baseline: 1, changePct: 2 })
    expect(p.figures.errorRate).toEqual({ value: 0.01, baseline: 0.01, changePct: 0 })
    expect(p.figures.baselineWindows).toBe(6)
    expect(p.trend.map((t) => t.reportDate)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'])
    expect(p.rulesUsed).toEqual(R)
  })

  it('a 40-minute outage makes it bad; the outage and the failed job are incidents', () => {
    expect(p.headline.statusAuto).toBe('bad')
    expect(p.headline.reasons[0]).toBe('ระบบที่พึ่งพาล่มรวม 40 นาที')
    expect(p.incidents.map((i) => [i.source, i.state])).toEqual([['dependency.down', 'resolved'], ['job.failed', 'resolved']])
    expect(p.incidents[0]).toMatchObject({ what: 'redis cache ล่ม 40 นาที', endedAtMs: W.fromMs + 2 * H + 40 * 60_000 })
    expect(p.dependencies[0]).toMatchObject({ name: 'redis cache', downMinutes: 40, downEvents: 1, problem: true })
  })

  it('topErrors: only new / increased; the daily one is recurring', () => {
    expect(p.topErrors.map((e) => [e.fingerprint, e.trend, e.users])).toEqual([['111', 'new', 8]])
    expect(p.topErrors[0]).toMatchObject({ location: 'src/a.ts › A.b', count7dAvg: 0, firstSeenMs: W.fromMs + 10 * H })
    expect(p.figures.errorGroups).toEqual({ new: 1, up: 0 })
    expect(p.followups.map((f) => f.kind)).toEqual(['new', 'recurring', 'threshold', 'threshold', 'threshold'])
  })

  it('the deploy links the new error that started within 2 h', () => {
    expect(p.deploys).toEqual([{ service: 'core', version: '1.1.0', previousVersion: '1.0.0', deployedAtMs: W.fromMs + 9 * H, relatedFingerprints: ['111'] }])
  })

  it('slow routes: p95 over × 1.2 with at least 50 requests', () => {
    expect(p.slowRoutes).toEqual([{ route: 'GET /a', service: 'core', requests: 100, p95Ms: 300, p95_7dMs: 200 }])
  })

  it('jobs; no features without usage; no AI notes yet', () => {
    expect(p.jobs).toEqual([{ job: 'SendMail', kind: 'queue', service: 'core', total: 4, failed: 3, missed: 0, note: '' }])
    expect(p.features).toEqual([])
    expect(p.aiNotes).toEqual([])
  })

  it('an error without type or hint (a plain logger.error) is shown by its logger and masked message', () => {
    const q = assembleReport(
      raw({
        errors: [{ fingerprint: '333', service: 'core', error_type: '', error_hint: '', logger: 'kafkajs:Connection', message: 'Connection error to ops@example.com\n  id 12345678',
          route: '', origin_file: '', origin_function: '', count: 24, users: 2, first_ms: W.fromMs, trace_id: '' }],
        dependencyEvents: [], jobs: [],
      }),
      R,
    )
    expect(q.topErrors[0]).toMatchObject({ logger: 'kafkajs:Connection', message: 'Connection error to <email> id <n>', errorType: '', errorHint: '' })
    expect(q.followups[0].text).toBe('ปัญหาใหม่ Connection error to <email> id <n> ที่ core กระทบผู้ใช้ 2 คน')
  })

  it('topErrors: the most frequent first, users only break ties', () => {
    const e = (fingerprint: string, count: number, users: number) => ({ fingerprint, service: 'core', error_type: 'E', error_hint: fingerprint, route: '', origin_file: '', origin_function: '', count, users, first_ms: W.fromMs, trace_id: '' })
    const q = assembleReport(raw({ errors: [e('few-many-users', 5, 9), e('loud', 50, 1), e('tie', 50, 2)], errorHistory: [] }), R)
    expect(q.topErrors.map((x) => x.fingerprint)).toEqual(['tie', 'loud', 'few-many-users'])
  })

  it('maskMessage hides e-mails, UUIDs and long numbers, and keeps 160 characters', () => {
    expect(maskMessage('user 3fa85f64-5717-4562-b3fc-2c963f66afa6 phone 0812345678 port 6379')).toBe('user <uuid> phone <n> port 6379')
    expect(maskMessage('x'.repeat(200))).toHaveLength(160)
  })

  it('a feature under 95 % makes it bad and needs a look', () => {
    const group = { featureId: 'core:classes', service: 'core', resource: 'classes', routes: ['GET /classes/:id'], requests: 0, score: 1, rank: 1 }
    const q = assembleReport(
      raw({ dependencyEvents: [], jobs: [], featureGroups: [group], featureSlots: [{ featureId: 'core:classes', slot: 6, requests: 100, errors: 10 }] }),
      R,
    )
    expect(q.features).toEqual([{ featureId: 'core:classes', name: 'ห้องเรียน', successRate: 0.9, successRate7d: null, volume: 100, state: 'bad', note: 'ต่ำกว่าเกณฑ์ 95%' }])
    expect(q.headline).toMatchObject({ statusAuto: 'bad', reasons: ['ฟีเจอร์ ห้องเรียน ใช้งานสำเร็จ 90.0%'] })
    expect(q.followups.at(-1)).toEqual({ kind: 'threshold', key: 'core:classes', text: 'ฟีเจอร์ ห้องเรียน ต่ำกว่าเกณฑ์ 95%' })
  })

  it('fewer than 3 windows with data: no baseline, no rate rule, no spikes', () => {
    const q = assembleReport(raw({ figureSlots: [{ slot: 5, requests: 1000, errors: 10, p95: 200 }, { slot: 6, requests: 1000, errors: 500, p95: 200 }], dependencyEvents: [], jobs: [] }), R)
    expect(q.figures.errorRate.baseline).toBeNull()
    expect(q.figures.baselineWindows).toBe(1)
    expect(q.headline.statusAuto).toBe('ok')
  })
})
