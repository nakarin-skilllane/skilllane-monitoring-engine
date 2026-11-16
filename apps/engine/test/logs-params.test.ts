import { describe, expect, it } from 'vitest'
import { type PodDb, podsOf } from '../src/query/logs.service'
import { parseHosts, parseLogScope, parseSources, parseTraceIds } from '../src/query/params'
import { scoped, scopeOnly } from '../src/query/sql'

const id = (c: string) => c.repeat(32)

describe('/api/logs sources', () => {
  it('service/role, a bare service (every role), split at the last /', () => {
    expect(parseSources({ sources: 'api/web, worker ,ns/svc/cron' })).toEqual([
      { service: 'api', role: 'web' },
      { service: 'worker', role: '' },
      { service: 'ns/svc', role: 'cron' },
    ])
    expect(parseSources({})).toBeUndefined()
    expect(parseSources({ sources: ' , ' })).toBeUndefined()
  })

  it('drops duplicates', () => {
    expect(parseSources({ sources: 'api/web,api/web, api/web,api' })).toEqual([
      { service: 'api', role: 'web' },
      { service: 'api', role: '' },
    ])
  })

  it('at most 20, each part a name', () => {
    const many = Array.from({ length: 21 }, (_, i) => `s${i}/api`).join(',')
    expect(parseSources({ sources: many.split(',').slice(0, 20).join(',') })).toHaveLength(20)
    expect(() => parseSources({ sources: many })).toThrow(/sources may list at most 20/)
    expect(() => parseSources({ sources: 'api/web,bad name' })).toThrow(/^sources must be/)
    expect(() => parseSources({ sources: 'api/' })).toThrow(/^sources must be/)
    expect(() => parseSources({ sources: '/web' })).toThrow(/^sources must be/)
    expect(() => parseSources({ sources: ['api', 'web'] })).toThrow(/sources must be given once/)
  })

  it('either sources or service / role', () => {
    expect(parseLogScope({ sources: 'api/web' }).sources).toEqual([{ service: 'api', role: 'web' }])
    expect(parseLogScope({ service: 'api', role: 'web' })).toMatchObject({ service: 'api', role: 'web' })
    expect(parseLogScope({ service: 'api', role: 'web' }).sources).toBeUndefined()
    expect(() => parseLogScope({ sources: 'api/web', service: 'api' })).toThrow('use either sources or service/role')
    expect(() => parseLogScope({ sources: 'api/web', role: 'web' })).toThrow('use either sources or service/role')
  })

  it('reaches the SQL only as parameters', () => {
    const c = parseLogScope({ env: 'prod', sources: 'api/web,worker' })
    const w = scoped(c)
    expect(w.sql).toContain('service IN {srcServices:Array(String)}')
    expect(w.sql).toContain("arrayExists((s, r) -> s = service AND (r = '' OR r = role), {srcSvc:Array(String)}, {srcRole:Array(String)})")
    expect(w.sql).not.toMatch(/api|web|worker/)
    expect(w.params).toMatchObject({ env: 'prod', srcServices: ['api', 'worker'], srcSvc: ['api', 'worker'], srcRole: ['web', ''] })
    expect(() => parseLogScope({ sources: "x'; DROP TABLE logs" })).toThrow(/^sources must be/)
  })

  it('services go to the primary key once each', () => {
    const w = scopeOnly({ sources: [{ service: 'api', role: 'web' }, { service: 'api', role: 'cron' }] })
    expect(w.params).toEqual({ srcServices: ['api'], srcSvc: ['api', 'api'], srcRole: ['web', 'cron'] })
    expect(scopeOnly({ sources: [] }).sql).toBe('1')
  })
})

describe('/api/logs host', () => {
  it('one host or a comma list, duplicates removed', () => {
    expect(parseHosts({ host: 'h1' })).toEqual(['h1'])
    expect(parseHosts({ host: 'api-7d9f-x2, api-7d9f-y3,h1,api-7d9f-x2' })).toEqual(['api-7d9f-x2', 'api-7d9f-y3', 'h1'])
    expect(parseHosts({})).toBeUndefined()
  })

  it('at most 50 names', () => {
    const hosts = Array.from({ length: 51 }, (_, i) => `h${i}`)
    expect(parseHosts({ host: hosts.slice(0, 50).join(',') })).toHaveLength(50)
    expect(() => parseHosts({ host: hosts.join(',') })).toThrow(/host may list at most 50/)
    expect(() => parseHosts({ host: 'h1,bad host' })).toThrow(/^host must be/)
  })
})

describe('/api/logs/traces traceIds', () => {
  it('a comma list of full trace ids, lower-cased, duplicates removed', () => {
    expect(parseTraceIds({ traceIds: `${id('A')}, ${id('b')},${id('a')}` })).toEqual([id('a'), id('b')])
  })

  it('1 to 100 well-formed ids', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(32, '0'))
    expect(parseTraceIds({ traceIds: ids.slice(0, 100).join(',') })).toHaveLength(100)
    expect(() => parseTraceIds({ traceIds: ids.join(',') })).toThrow(/traceIds may list at most 100/)
    expect(() => parseTraceIds({})).toThrow(/traceIds is required/)
    expect(() => parseTraceIds({ traceIds: ' , ' })).toThrow(/traceIds is required/)
    expect(() => parseTraceIds({ traceIds: `${id('a')},abcd` })).toThrow(/^traceIds must be/)
    expect(() => parseTraceIds({ traceIds: id('g') })).toThrow(/^traceIds must be/)
  })
})

describe('/api/logs/pods gone + order', () => {
  const T = Date.parse('2026-11-16T10:00:00Z')
  const ch = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
  const pod = (service: string, role: string, host: string, lastMs: number, shutdownMs = 0): PodDb => ({
    service, role, host, lines: '10' as unknown as number, errors: 2, warns: 1,
    first_ts: ch(T - 3600_000), last_ts: ch(lastMs), last_ms: String(lastMs) as unknown as number, shutdown_ms: shutdownMs,
  })

  it('marks a pod gone after app.shutdown or 5 minutes behind its service / role', () => {
    const pods = podsOf([
      pod('api', 'web', 'web-c', T),
      pod('api', 'web', 'web-a', T - 60_000),
      pod('api', 'web', 'web-old', T - 30 * 60_000), // replaced mid-range
      pod('api', 'web', 'web-down', T - 40 * 60_000 + 20_000, T - 40 * 60_000), // app.shutdown, then 20 s of closing
      pod('api', 'web', 'web-back', T - 2 * 60_000, T - 50 * 60_000), // shut down, then wrote on: not gone
      pod('api', 'cron', 'cron-1', T - 30 * 60_000), // the only cron pod: newest of its role
    ])
    expect(pods.map((p) => [p.role, p.host, p.gone])).toEqual([
      ['cron', 'cron-1', false],
      ['web', 'web-a', false],
      ['web', 'web-back', false],
      ['web', 'web-c', false],
      ['web', 'web-down', true],
      ['web', 'web-old', true],
    ])
    expect(pods[1]).toEqual({
      service: 'api', role: 'web', host: 'web-a', lines: 10, errors: 2, warns: 1,
      firstSeen: '2026-11-16T09:00:00.000Z', lastSeen: '2026-11-16T09:59:00.000Z', gone: false,
    })
  })

  it('a pod 4 minutes behind stays live; exactly 5 minutes is gone', () => {
    const pods = podsOf([pod('w', 'r', 'a', T), pod('w', 'r', 'b', T - 4 * 60_000), pod('w', 'r', 'c', T - 5 * 60_000)])
    expect(pods.map((p) => [p.host, p.gone])).toEqual([['a', false], ['b', false], ['c', true]])
  })

  it('orders by service, then role, then live pods by host, then gone pods oldest first', () => {
    const pods = podsOf([
      pod('b', 'r', 'z', T),
      pod('a', 'r', 'gone-new', T - 10 * 60_000),
      pod('a', 'r', 'gone-old', T - 20 * 60_000),
      pod('a', 'r', 'live', T),
    ])
    expect(pods.map((p) => `${p.service}/${p.host}`)).toEqual(['a/live', 'a/gone-old', 'a/gone-new', 'b/z'])
  })
})
