import { describe, expect, it } from 'vitest'
import {
  addDays,
  bangkokDate,
  classifyError,
  compare,
  decideStatus,
  dueDates,
  latestReportDate,
  reportDateProblem,
  reportWindow,
} from '../src/reports/rules'
import { R } from './rules-fixture'

const six = (n: number) => Array(6).fill(n)

describe('report windows: 09:00 to 09:00 Asia/Bangkok', () => {
  it('report 2026-10-21 = 20 Oct 02:00 UTC to 21 Oct 02:00 UTC', () => {
    expect(reportWindow('2026-10-21')).toEqual({ fromMs: Date.UTC(2026, 9, 20, 2), toMs: Date.UTC(2026, 9, 21, 2) })
  })
  it('rejects a date that does not exist', () => {
    expect(() => reportWindow('2026-02-30')).toThrow('YYYY-MM-DD')
  })
  it('bangkokDate and addDays', () => {
    expect(bangkokDate(Date.UTC(2026, 9, 20, 16, 59, 59))).toBe('2026-10-20')
    expect(bangkokDate(Date.UTC(2026, 9, 20, 17))).toBe('2026-10-21')
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31')
  })
  it('the latest report is today from 09:00, before that yesterday', () => {
    expect(latestReportDate(Date.UTC(2026, 9, 21, 1, 59, 59))).toBe('2026-10-20')
    expect(latestReportDate(Date.UTC(2026, 9, 21, 2))).toBe('2026-10-21')
  })
  it('a report can be built for the latest date back to 89 days before it', () => {
    const now = Date.UTC(2026, 9, 21, 3)
    expect(reportDateProblem('2026-10-21', now)).toBeUndefined()
    expect(reportDateProblem('2026-10-22', now)).toMatch('ยังไม่ครบ')
    expect(reportDateProblem('2026-07-24', now)).toBeUndefined()
    expect(reportDateProblem('2026-07-23', now)).toMatch('90 วัน')
    expect(reportDateProblem('21-10-2026', now)).toMatch('YYYY-MM-DD')
  })
  it('dueDates: the missing ones of the last N, oldest first', () => {
    const now = Date.UTC(2026, 9, 21, 3)
    expect(dueDates(now, new Set(['2026-10-21', '2026-10-19']), 3)).toEqual(['2026-10-20'])
    expect(dueDates(Date.UTC(2026, 9, 21, 1), new Set(), 2)).toEqual(['2026-10-19', '2026-10-20'])
  })
})

describe('compare against the 6 windows before', () => {
  it('the average of the windows with data', () => {
    expect(compare(10, six(5))).toEqual({ value: 10, baseline: 5, changePct: 1 })
    expect(compare(10, [null, null, null, 5, 5, 5])).toEqual({ value: 10, baseline: 5, changePct: 1 })
  })
  it('fewer than 3 windows with data: no baseline', () => {
    expect(compare(10, [null, null, null, null, 5, 5])).toEqual({ value: 10, baseline: null, changePct: null })
  })
  it('0 against 0 is 0 %, more than 0 against 0 is new (null)', () => {
    expect(compare(0, six(0)).changePct).toBe(0)
    expect(compare(3, six(0)).changePct).toBeNull()
  })
})

describe('classifyError', () => {
  it('not seen in the 14 days before = new', () => {
    expect(classifyError(5, six(0), false, R)).toBe('new')
  })
  it('up needs more than average × 1.5 and more than 10', () => {
    expect(classifyError(16, six(10), true, R)).toBe('up')
    expect(classifyError(15, six(10), true, R)).toBe('same')
    expect(classifyError(12, six(2), true, R)).toBe('up')
    expect(classifyError(9, six(2), true, R)).toBe('same')
  })
  it('down below half the average', () => {
    expect(classifyError(4, six(10), true, R)).toBe('down')
  })
})

describe('decideStatus', () => {
  const base = { errorRate: 0.01, errorRateBaseline: 0.01, outageMinutes: 0, features: [], incidents: 0 }
  it('ok', () => {
    expect(decideStatus(base, R)).toEqual({ status: 'ok', reasons: [] })
  })
  it('error rate over baseline × 2 is bad', () => {
    const r = decideStatus({ ...base, errorRate: 0.021 }, R)
    expect(r).toEqual({ status: 'bad', reasons: ['error rate 2.10% สูงกว่าค่าปกติ (1.00%) เกิน 2 เท่า'] })
  })
  it('exactly × 2 and over × 1.5 are partial', () => {
    expect(decideStatus({ ...base, errorRate: 0.02 }, R).status).toBe('partial')
    expect(decideStatus({ ...base, errorRate: 0.016 }, R).status).toBe('partial')
    expect(decideStatus({ ...base, errorRate: 0.015 }, R).status).toBe('ok')
  })
  it('no baseline, or a baseline of 0: the rate rules do not apply', () => {
    expect(decideStatus({ ...base, errorRate: 0.5, errorRateBaseline: null }, R).status).toBe('ok')
    expect(decideStatus({ ...base, errorRate: 0.5, errorRateBaseline: 0 }, R).status).toBe('ok')
  })
  it('outage over 30 minutes is bad; any incident is partial', () => {
    expect(decideStatus({ ...base, outageMinutes: 31, incidents: 1 }, R).reasons).toEqual([
      'ระบบที่พึ่งพาล่มรวม 31 นาที',
      'มีเหตุการณ์สำคัญ 1 ครั้ง',
    ])
    expect(decideStatus({ ...base, outageMinutes: 30, incidents: 1 }, R).status).toBe('partial')
  })
  it('a feature under 95 % is bad', () => {
    const r = decideStatus({ ...base, features: [{ name: 'สอบ', successRate: 0.94 }, { name: 'คอร์ส', successRate: 0.99 }] }, R)
    expect(r).toEqual({ status: 'bad', reasons: ['ฟีเจอร์ สอบ ใช้งานสำเร็จ 94.0%'] })
  })
})
