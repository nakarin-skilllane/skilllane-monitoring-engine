import { describe, expect, it } from 'vitest'
import { activeFeatures, featureValues, isFeatureResource, RANK_DAYS, type RankedGroup, rankDays, resourceOf, type UsageDay } from '../src/reports/features'
import { addDays } from '../src/reports/rules'
import { R } from './rules-fixture'

describe('resourceOf', () => {
  it('the first segment after api/ and versions; none for a parameter', () => {
    expect(resourceOf('GET /api/v1/courses/:id')).toBe('courses')
    expect(resourceOf('POST /classes/:id/exams/:examId/submit')).toBe('classes')
    expect(resourceOf('GET /v2/api/users')).toBe('users')
    expect(resourceOf('GET /')).toBe('')
    expect(resourceOf('GET /:id')).toBe('')
    expect(resourceOf('school-import importStudents')).toBe('')
  })
  it('probes are never features', () => {
    expect(isFeatureResource('Health')).toBe(false)
    expect(isFeatureResource('metrics')).toBe(false)
    expect(isFeatureResource('')).toBe(false)
    expect(isFeatureResource('courses')).toBe(true)
  })
})

const D = '2026-10-27'
const day = (resource: string, n: number, over: Partial<UsageDay> = {}): UsageDay => ({
  day: addDays(D, -n), service: 'core', resource, requests: 100, ok: 100, withUser: 100, writes: 50, peak: 1,
  routes: [`GET /${resource}`], ...over,
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

describe('rankDays', () => {
  const days = [
    ...range(1, 30).map((n) => day('courses', n)),
    ...range(1, 15).map((n) => day('exams', n, { ok: 90, writes: 10, peak: 0.5 })),
    ...range(1, 30).map((n) => day('health', n, { withUser: 0 })),
    day('tiny', 1, { requests: 40, ok: 40, withUser: 40 }),
    ...range(1, 30).map((n) => day('bots', n, { withUser: 2 })),
  ]
  const uniq = [
    { k: RANK_DAYS - 1, service: 'core', resource: 'courses', users: 50, orgs: 5 },
    { k: RANK_DAYS - 1, service: 'core', resource: 'exams', users: 10, orgs: 1 },
  ]
  const ranks = rankDays(days, uniq, D)

  it('one ranking per day; probes, small and user-less groups are left out', () => {
    expect(ranks).toHaveLength(RANK_DAYS)
    expect(ranks[RANK_DAYS - 1].map((g) => [g.featureId, g.score, g.rank])).toEqual([
      ['core:courses', 1, 1],
      ['core:exams', 0, 2],
    ])
    expect(ranks[RANK_DAYS - 1][0].routes).toEqual(['GET /courses'])
  })
})

/** 28 rankings from a function of the day index. */
const ranksOf = (order: (k: number) => string[]): RankedGroup[][] =>
  Array.from({ length: RANK_DAYS }, (_, k) =>
    order(k).map((id, i) => ({ featureId: id, service: 'core', resource: id, routes: [], requests: 100, score: 1 - i / 100, rank: i + 1 })),
  )
const ids = (list: RankedGroup[]) => list.map((g) => g.featureId)

describe('activeFeatures', () => {
  it('enters after 7 days in the top 6; leaves after 14 days outside the top 8', () => {
    const base = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']
    const ranks = ranksOf((k) =>
      k < 14 ? base : k < 21 ? ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'B'] : ['J', 'A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'B'],
    )
    expect(ids(activeFeatures(ranks))).toEqual(['J', 'A', 'C', 'D', 'E', 'F', 'G'])
  })

  it('13 days outside the top 8 is not enough to leave', () => {
    const ranks = ranksOf((k) => (k < 15 ? ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] : ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'B']))
    expect(ids(activeFeatures(ranks))).toEqual(['A', 'C', 'D', 'E', 'F', 'G', 'B'])
  })

  it('at most 8, the best ranked', () => {
    const first = ['A', 'B', 'C', 'D', 'E', 'F']
    const next = ['G', 'H', 'I', 'J', 'K', 'L']
    const ranks = ranksOf((k) => (k < 15 ? [...first, ...next] : [...next, ...first]))
    expect(ids(activeFeatures(ranks))).toEqual(['G', 'H', 'I', 'J', 'K', 'L', 'A', 'B'])
  })
})

describe('featureValues', () => {
  const g = (service: string, resource: string): RankedGroup => ({ featureId: `${service}:${resource}`, service, resource, routes: [], requests: 0, score: 0, rank: 1 })
  const before = (featureId: string, requests: number, errors: number) => range(0, 5).map((slot) => ({ featureId, slot, requests, errors }))
  it('success in the window and the 6 before; below normal, under the bar, idle; duplicate names get the service', () => {
    const slots = [
      { featureId: 'core:courses', slot: 6, requests: 1000, errors: 2 },
      ...before('core:courses', 1000, 1),
      { featureId: 'core:exams', slot: 6, requests: 1000, errors: 20 },
      ...before('core:exams', 1000, 1),
      { featureId: 'etl:exams', slot: 6, requests: 100, errors: 10 },
      ...before('core:zzz', 10, 0),
    ]
    expect(featureValues([g('core', 'courses'), g('core', 'exams'), g('etl', 'exams'), g('core', 'zzz')], slots, R)).toEqual([
      { featureId: 'core:courses', name: 'คอร์สเรียน', successRate: 0.998, successRate7d: 0.999, volume: 1000, state: 'ok', note: '' },
      { featureId: 'core:exams', name: 'การสอบ (core)', successRate: 0.98, successRate7d: 0.999, volume: 1000, state: 'below', note: 'ต่ำกว่าปกติ 1.9 จุด' },
      { featureId: 'etl:exams', name: 'การสอบ (etl)', successRate: 0.9, successRate7d: null, volume: 100, state: 'bad', note: 'ต่ำกว่าเกณฑ์ 95%' },
      { featureId: 'core:zzz', name: '/zzz', successRate: null, successRate7d: 1, volume: 0, state: 'idle', note: 'ไม่มีการใช้งานในช่วงนี้' },
    ])
  })
})
