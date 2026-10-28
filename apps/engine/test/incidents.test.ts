import { describe, expect, it } from 'vitest'
import {
  type ClassifiedError,
  DAY_MS,
  type DependencyEvent,
  followups,
  headlines,
  jobIncidents,
  missedCrons,
  outageTargets,
  spikeIncidents,
} from '../src/reports/rules'
import type { Compare, ReportDependency, ReportFigures } from '../src/reports/types'
import { R } from './rules-fixture'

const H = 3_600_000
const M = 60_000

describe('spikeIncidents', () => {
  const buckets = [
    { t: 0, requests: 100, errors: 1 },
    { t: 5 * M, requests: 100, errors: 10 },
    { t: 10 * M, requests: 100, errors: 5 },
    { t: 15 * M, requests: 40, errors: 20 },
    { t: 20 * M, requests: 100, errors: 10 },
  ]
  it('joins adjacent 5-minute windows over baseline × 3 with at least 50 requests', () => {
    expect(spikeIncidents(buckets, 0.01, R)).toEqual([
      { fromMs: 5 * M, toMs: 15 * M, requests: 200, errors: 15, peakRate: 0.1 },
      { fromMs: 20 * M, toMs: 25 * M, requests: 100, errors: 10, peakRate: 0.1 },
    ])
  })
  it('no baseline: no spikes', () => {
    expect(spikeIncidents(buckets, null, R)).toEqual([])
  })
})

describe('outageTargets', () => {
  const redis = { type: 'redis', name: 'cache', host: '10.0.3.21', port: 6379, reason: '', message: '', durationMs: null }
  const oracle = { type: 'oracle', name: 'main', host: 'db', port: 1521, reason: '', message: '', durationMs: null }
  const events: DependencyEvent[] = [
    { ...redis, process: 'core/h1', code: 'dependency.down', atMs: 2 * H, message: 'ECONNREFUSED' },
    { ...redis, process: 'core/h1', code: 'dependency.up', atMs: 2 * H + 40 * M, durationMs: 40 * M, reason: 'recovered' },
    { ...redis, process: 'core/h2', code: 'dependency.down', atMs: 2 * H + 10 * M },
    { ...redis, process: 'core/h2', code: 'dependency.up', atMs: 2 * H + 50 * M, durationMs: 40 * M, reason: 'recovered' },
    { ...redis, process: 'core/h3', code: 'dependency.up', atMs: 3 * H, reason: 'connected' },
    { ...oracle, process: 'etl/h1', code: 'dependency.still_down', atMs: 1 * H },
  ]
  it('unions the windows of every process per target; still down at the start and the end is clipped to the window', () => {
    expect(outageTargets(events, 0, DAY_MS)).toEqual([
      {
        key: 'oracle:main@db:1521', type: 'oracle', name: 'main', host: 'db', port: 1521,
        windows: [{ fromMs: 0, toMs: DAY_MS, ongoing: true }], minutes: 1440, downEvents: 0, message: '',
      },
      {
        key: 'redis:cache@10.0.3.21:6379', type: 'redis', name: 'cache', host: '10.0.3.21', port: 6379,
        windows: [{ fromMs: 2 * H, toMs: 2 * H + 50 * M, ongoing: false }], minutes: 50, downEvents: 2, message: 'ECONNREFUSED',
      },
    ])
  })
})

describe('missedCrons', () => {
  const D = DAY_MS
  const hourly = (from: number, to: number, skip: (ms: number) => boolean = () => false) => {
    const out: number[] = []
    for (let ms = from; ms < to; ms += H) if (!skip(ms)) out.push(ms)
    return out
  }
  it('a gap in the window longer than median × 2; missed runs from the usual gap', () => {
    const rows = [
      { type: 'ReportCron.handle', starts: hourly(-6 * D, 2 * D, (ms) => ms >= D + 5 * H && ms <= D + 9 * H) },
      { type: 'Clean.run', starts: hourly(-6 * D, 2 * D) },
      { type: 'Rare.run', starts: [D - 2 * H, D - H, D + 10 * H] },
    ]
    expect(missedCrons(rows, D, 2 * D, 3 * D)).toEqual([{ key: 'ReportCron.handle', medianGapMin: 60, longestGapMin: 360, missedRuns: 5 }])
  })
  it('a cron that stopped: the gap from its last start to the end of the window', () => {
    const rows = [{ type: 'Stop.run', starts: hourly(-6 * D, D + 21 * H) }]
    expect(missedCrons(rows, D, 2 * D, 3 * D)).toEqual([{ key: 'Stop.run', medianGapMin: 60, longestGapMin: 240, missedRuns: 3 }])
  })
})

describe('jobIncidents', () => {
  it('one per failing job; resolved when a run finished after the last failure', () => {
    expect(
      jobIncidents([
        { job: 'SendMail', kind: 'bullmq', service: 'core', total: 4, failed: 3, first_failed_ms: 10 * H, last_failed_ms: 10 * H + 2 * M, last_ok_ms: 11 * H },
        { job: 'Sync', kind: 'cron', service: 'etl', total: 2, failed: 1, first_failed_ms: 12 * H, last_failed_ms: 12 * H, last_ok_ms: 0 },
        { job: 'Ok', kind: 'cron', service: 'etl', total: 5, failed: 0, first_failed_ms: 0, last_failed_ms: 0, last_ok_ms: 9 * H },
      ]),
    ).toEqual([
      { id: 'job:SendMail', source: 'job.failed', startedAtMs: 10 * H, endedAtMs: 10 * H + 2 * M, what: 'งาน SendMail ล้มเหลว 3 ครั้ง', usersAffected: null, state: 'resolved' },
      { id: 'job:Sync', source: 'job.failed', startedAtMs: 12 * H, endedAtMs: null, what: 'งาน Sync ล้มเหลว 1 ครั้ง', usersAffected: null, state: 'ongoing' },
    ])
  })
})

const c = (value: number, baseline: number | null, changePct: number | null): Compare => ({ value, baseline, changePct })
const FIGURES: ReportFigures = {
  usersAffected: c(12, 10, 0.2),
  orgsAffected: c(3, 1, 2),
  errorRate: c(0.021, 0.01, 1.1),
  p95Ms: c(300, 300, 0),
  requests: c(960, 960, 0),
  baselineWindows: 6,
  errorGroups: { new: 1, up: 1 },
}
const err = (over: Partial<ClassifiedError>): ClassifiedError => ({
  fingerprint: '1', service: 'core', errorType: 'TypeError', errorHint: 'Null read', route: 'GET /a', location: '',
  count: 30, count7dAvg: 0, changePct: null, users: 8, firstSeenMs: 0, trend: 'new', sampleTraceId: '',
  seenWindows: 1, ...over,
})
const DEP: ReportDependency = {
  key: 'redis:cache@r:6379', name: 'redis cache', host: 'r', port: 6379, downMinutes: 40, downEvents: 1,
  windows: [], lastError: '', problem: true, note: '',
}

describe('headlines', () => {
  it('templates from the numbers', () => {
    expect(headlines({ status: 'bad', reasons: ['x'], figures: FIGURES })).toEqual({
      summaryOverview: 'มีปัญหา · ผู้ใช้ที่เจอปัญหา 12 คน · x',
      summaryDetail: 'มีปัญหา · error rate 2.10% · error กลุ่มใหม่ 1 · เพิ่มขึ้น 1',
    })
  })
})

describe('followups', () => {
  it('new errors with users, recurring errors, figures over the normal by > 20 % (not orgs), dependency problems', () => {
    expect(followups([err({}), err({ fingerprint: '2', trend: 'same', seenWindows: 4, errorHint: 'Value too large', route: 'POST /b' })], FIGURES, [DEP])).toEqual([
      { kind: 'new', key: '1', text: 'ปัญหาใหม่ Null read ที่ GET /a กระทบผู้ใช้ 8 คน' },
      { kind: 'recurring', key: '2', text: 'Value too large ที่ POST /b เกิดซ้ำ 4 ใน 7 ช่วงล่าสุด' },
      { kind: 'threshold', key: 'errorRate', text: 'อัตราที่ใช้งานไม่สำเร็จ สูงกว่าค่าปกติ 110%' },
      { kind: 'threshold', key: 'redis:cache@r:6379', text: 'redis cache ล่มรวม 40 นาที' },
    ])
  })
})
