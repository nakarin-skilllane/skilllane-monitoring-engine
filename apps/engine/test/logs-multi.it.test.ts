import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { LogsService } from '../src/query/logs.service'
import type { LogRow } from '../src/query/rows'
import { Reader } from '../src/query/sql'

/**
 * /api/logs `sources` + `host` lists and `job`, /api/logs/traces and /api/logs/pods on 30 minutes of three service / roles
 * (shop/api, shop/worker, auth/api) and seven pods in env `logs-multi-it`. Every line has its own millisecond.
 */
const ENV = 'logs-multi-it'
const MIN = 60_000
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const msOf = (row: Record<string, unknown>) => Date.parse(`${String(row.timestamp).replace(' ', 'T')}Z`)
/** A request across shop/api, auth/api and shop/worker; one with more lines than a trace may return. */
const T1 = 'a1'.repeat(16)
const T2 = 'b2'.repeat(16)

function fixture(endMs: number): Array<Record<string, unknown>> {
  const start = endMs - 30 * MIN
  const out: Array<Record<string, unknown>> = []
  const log = (ms: number, service: string, role: string, host: string, f: Record<string, unknown> = {}) =>
    out.push({ timestamp: chTime(ms), env: ENV, service, role, version: '1', host, level: 'info', logger: 'App', event_code: 'app.log', message: `tick ${host}`, ...f })
  // shop/api: web-old replaced by web-new at 10 min, web-a all along
  for (let i = 0; i < 10; i++) log(start + i * MIN + 1, 'shop', 'api', 'shop-api-old')
  log(start + 5 * MIN + 2, 'shop', 'api', 'shop-api-old', { level: 'error', message: 'boom' })
  for (let i = 0; i < 30; i++) log(start + i * MIN + 3, 'shop', 'api', 'shop-api-a')
  for (let i = 0; i < 2; i++) log(start + i * MIN + 4, 'shop', 'api', 'shop-api-a', { level: 'warn', message: 'slow' })
  for (let i = 10; i < 30; i++) log(start + i * MIN + 5, 'shop', 'api', 'shop-api-new')
  // shop/worker: wk-2 shuts down at 20 min
  for (let i = 0; i < 30; i++) log(start + i * MIN + 6, 'shop', 'worker', 'shop-wk-1')
  log(start + 3 * MIN + 7, 'shop', 'worker', 'shop-wk-1', { level: 'fatal', message: 'out of memory' })
  for (let i = 0; i < 20; i++) log(start + i * MIN + 8, 'shop', 'worker', 'shop-wk-2')
  log(start + 20 * MIN + 500, 'shop', 'worker', 'shop-wk-2', { logger: 'process', event_code: 'app.shutdown', message: 'app shutting down' })
  log(start + 20 * MIN + 10_500, 'shop', 'worker', 'shop-wk-2', { message: 'Closing connections' })
  // auth/api: auth-2 shuts down 2 minutes before the end, only a minute behind auth-1
  for (let i = 0; i < 30; i++) log(start + i * MIN + 9, 'auth', 'api', 'auth-1')
  for (let i = 0; i < 3; i++) log(start + i * MIN + 10, 'auth', 'api', 'auth-1', { level: 'error', message: 'token invalid' })
  for (let i = 0; i < 27; i++) log(start + i * MIN + 11, 'auth', 'api', 'auth-2')
  log(start + 28 * MIN + 12, 'auth', 'api', 'auth-2', { logger: 'process', event_code: 'app.shutdown', message: 'app shutting down' })
  log(start + 28 * MIN + 5_012, 'auth', 'api', 'auth-2', { message: 'Closing connections' })
  // T1: the gateway call 5 minutes before (inside the 10-minute widening) and one 15 minutes before (outside)
  const at = start + 12 * MIN
  const t1 = { trace_id: T1 }
  log(at - 15 * MIN + 600, 'shop', 'worker', 'shop-wk-1', { ...t1, message: 'too early' })
  log(at - 5 * MIN + 601, 'shop', 'worker', 'shop-wk-1', { ...t1, logger: 'Worker', message: 'prepared cart' })
  log(at + 602, 'shop', 'api', 'shop-api-a', { ...t1, message: 'Loading cart' })
  log(at + 603, 'auth', 'api', 'auth-1', { ...t1, message: 'Checking token' })
  log(at + 604, 'auth', 'api', 'auth-1', {
    ...t1, logger: 'HttpRequest', event_code: 'http.request', message: 'request completed',
    http_method: 'GET', http_route: '/auth/me', url_path: '/auth/me', http_status: 200, duration_ms: 3,
  })
  log(at + 605, 'shop', 'api', 'shop-api-new', {
    ...t1, logger: 'HttpRequest', event_code: 'http.request', message: 'request completed',
    http_method: 'GET', http_route: '/cart', url_path: '/cart', http_status: 200, duration_ms: 9,
  })
  // T2: 105 lines, more than a trace may return (100)
  for (let i = 0; i < 105; i++) log(start + 15 * MIN + 100 + i * 3, 'shop', 'api', 'shop-api-a', { trace_id: T2, message: `step ${i}` })
  // lines written inside two jobs on shop/worker (the `job` filter)
  const report = { job_queue: 'report', job_type: 'report:generate', job_id: '88412', job_attempt: 1, job_max_attempts: 3 }
  log(start + 16 * MIN + 20, 'shop', 'worker', 'shop-wk-1', { ...report, logger: 'ReportProcessor', message: 'Rendering report' })
  log(start + 16 * MIN + 21, 'shop', 'worker', 'shop-wk-1', { ...report, logger: 'ReportProcessor', message: 'Report built' })
  log(start + 17 * MIN + 22, 'shop', 'worker', 'shop-wk-1', { job_queue: 'notify', job_type: 'notify:email', job_id: '5501', logger: 'Mailer', message: 'Sending email' })
  return out
}

describe.skipIf(!process.env.LOGS_IT)('logs sources / hosts / traces / pods on ClickHouse (LOGS_IT=1, docker compose up -d clickhouse)', () => {
  const writer = createClient({ url: config.clickhouse.url, username: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database })
  const ch = new ClickhouseService()
  const logs = new LogsService(new Reader(ch))
  const end = Date.now() - MIN
  const start = end - 30 * MIN
  const range = { env: ENV, from: new Date(end - 31 * MIN).toISOString(), to: new Date(end + MIN).toISOString() }
  const lines = fixture(end)
  const inRange = lines.filter((l) => msOf(l) >= start)
  const sync = { clickhouse_settings: { mutations_sync: '2' as const } }
  const reset = async () => {
    await writer.command({ query: `DELETE FROM logs WHERE env = '${ENV}'`, ...sync })
    await writer.command({ query: `ALTER TABLE route_usage_1d DELETE WHERE env = '${ENV}'`, ...sync })
  }

  /** Every row of a query, page by page. */
  async function allRows(q: Record<string, string>): Promise<LogRow[]> {
    const out: LogRow[] = []
    let before: string | undefined
    for (let page = 0; page < 100; page++) {
      const r = await logs.search({ limit: '100', ...q, ...(before ? { before } : {}) })
      out.push(...r.rows)
      if (!r.nextBefore) return out
      before = r.nextBefore
    }
    throw new Error('more than 100 pages')
  }
  const sumLevels = (c: Record<string, number>) => c.debug + c.info + c.warn + c.error + c.fatal
  const count = (pred: (l: Record<string, unknown>) => boolean) => inRange.filter(pred).length
  const src = (l: Record<string, unknown>) => `${l.service}/${l.role}`

  beforeAll(async () => {
    await ch.applySchema()
    await reset()
    await writer.insert({ table: 'logs', values: lines, format: 'JSONEachRow' })
  }, 120_000)

  afterAll(async () => {
    await reset()
    await writer.close()
    await ch.onApplicationShutdown()
  })

  describe('/api/logs sources and host', () => {
    it('sources keeps rows, histogram and levelCounts to the listed service / roles', async () => {
      const want = count((l) => src(l) === 'shop/api' || src(l) === 'auth/api')
      const q = { ...range, sources: 'shop/api,auth/api' }
      const r = await logs.search({ ...q, limit: '1' })
      expect(sumLevels(r.levelCounts)).toBe(want)
      expect(r.levelCounts.error).toBe(1 + 3)
      expect(r.levelCounts.fatal).toBe(0)
      expect(r.histogram.reduce((a, b) => a + sumLevels(b), 0)).toBe(want)
      const rows = await allRows(q)
      expect(rows).toHaveLength(want)
      expect(new Set(rows.map((x) => `${x.service}/${x.role}`))).toEqual(new Set(['shop/api', 'auth/api']))
    })

    it('the helper queries (cron, start-up, checks, repeats, bursts, check=) take sources too', async () => {
      const q = { ...range, sources: 'shop/api,auth', hide: 'cron,startup' }
      const folded = await logs.search({ ...q, collapse: '1', limit: '1' })
      expect(sumLevels(folded.levelCounts)).toBe(count((l) => l.service === 'auth' || src(l) === 'shop/api'))
      expect(folded.collapse).toMatchObject({ checks: 0, skipped: null })
      const check = await logs.search({ ...q, check: '1', limit: '1' })
      expect(sumLevels(check.levelCounts)).toBe(0)
    })

    it('a bare service stands for every role of it', async () => {
      const r = await logs.search({ ...range, sources: 'shop', limit: '1' })
      expect(sumLevels(r.levelCounts)).toBe(count((l) => l.service === 'shop'))
      expect(r.levelCounts.fatal).toBe(1)
      const mixed = await logs.search({ ...range, sources: 'shop,auth/api', limit: '1' })
      expect(sumLevels(mixed.levelCounts)).toBe(inRange.length)
    })

    it('host takes a comma list', async () => {
      const q = { ...range, host: 'shop-api-a,auth-1' }
      const r = await logs.search({ ...q, limit: '1' })
      expect(sumLevels(r.levelCounts)).toBe(count((l) => l.host === 'shop-api-a' || l.host === 'auth-1'))
      const rows = await allRows(q)
      expect(new Set(rows.map((x) => x.host))).toEqual(new Set(['shop-api-a', 'auth-1']))
      const one = await logs.search({ ...range, host: 'auth-2', limit: '1' })
      expect(sumLevels(one.levelCounts)).toBe(count((l) => l.host === 'auth-2'))
    })

    it('service + role still work alone, and match the same source', async () => {
      const single = await logs.search({ ...range, service: 'shop', role: 'api', limit: '1' })
      const listed = await logs.search({ ...range, sources: 'shop/api', limit: '1' })
      expect(sumLevels(single.levelCounts)).toBe(count((l) => src(l) === 'shop/api'))
      expect(listed.levelCounts).toEqual(single.levelCounts)
    })

    it('sources with service or role is a 400', async () => {
      await expect(logs.search({ ...range, sources: 'shop/api', service: 'shop' })).rejects.toThrow('use either sources or service/role')
      await expect(logs.pods({ ...range, sources: 'shop/api', role: 'api' })).rejects.toThrow('use either sources or service/role')
    })

    it('job matches part of a job name (queue type #id, any case), lines of jobs only', async () => {
      const report = await allRows({ ...range, job: 'REPORT:gen' })
      expect(report.map((x) => x.message).sort()).toEqual(['Rendering report', 'Report built'])
      const counts = await logs.search({ ...range, job: 'report:gen', limit: '1' })
      expect(sumLevels(counts.levelCounts)).toBe(2)
      expect(counts.histogram.reduce((a, b) => a + sumLevels(b), 0)).toBe(2)
      expect((await allRows({ ...range, job: '#5501' })).map((x) => x.message)).toEqual(['Sending email'])
      expect((await allRows({ ...range, job: 'notify' })).map((x) => x.job?.id)).toEqual(['5501'])
      // a word of the messages around does not match a line outside a job
      expect(await allRows({ ...range, job: 'tick' })).toEqual([])
    })
  })

  describe('/api/logs/traces', () => {
    it('returns every line of the traces across services and hosts, the range widened by 10 minutes', async () => {
      const at = start + 12 * MIN
      const r = await logs.traceLines({ env: ENV, from: new Date(at).toISOString(), to: new Date(at + 1000).toISOString(), traceIds: T1.toUpperCase() })
      expect(r.truncated).toEqual([])
      expect(r.rows.map((x) => x.message)).toEqual(['request completed', 'request completed', 'Checking token', 'Loading cart', 'prepared cart'])
      expect(new Set(r.rows.map((x) => x.host))).toEqual(new Set(['shop-wk-1', 'shop-api-a', 'auth-1', 'shop-api-new']))
      const token = r.rows.find((x) => x.message === 'Checking token')!
      expect([token.requestRoute, token.origin]).toEqual(['GET /auth/me', 'request'])
      // shop/api's request line was written on another pod: still the same trace + service + role
      expect(r.rows.find((x) => x.message === 'Loading cart')!.requestRoute).toBe('GET /cart')
    })

    it('keeps the newest 100 lines of a trace and names it in truncated', async () => {
      const r = await logs.traceLines({ ...range, traceIds: `${T2},${T1}` })
      const t2 = r.rows.filter((x) => x.traceId === T2)
      expect(t2).toHaveLength(100)
      expect(t2[0].message).toBe('step 104')
      expect(t2[99].message).toBe('step 5')
      // the wide range reaches 'too early' too (3 minutes before the data, within the 10-minute widening)
      expect(r.rows.filter((x) => x.traceId === T1)).toHaveLength(6)
      expect(r.truncated).toEqual([T2])
      expect(r.rows.map((x) => x.timestamp)).toEqual([...r.rows.map((x) => x.timestamp)].sort().reverse())
    })

    it('rejects a bad trace id list', async () => {
      await expect(logs.traceLines({ ...range })).rejects.toThrow(/traceIds is required/)
      await expect(logs.traceLines({ ...range, traceIds: 'abc' })).rejects.toThrow(/traceIds must be/)
    })
  })

  describe('/api/logs/pods', () => {
    it('counts lines per pod and marks the pods that stopped', async () => {
      const { pods } = await logs.pods(range)
      expect(pods.map((p) => [`${p.service}/${p.role}`, p.host, p.gone])).toEqual([
        ['auth/api', 'auth-1', false],
        ['auth/api', 'auth-2', true], // app.shutdown, only a minute behind auth-1
        ['shop/api', 'shop-api-a', false],
        ['shop/api', 'shop-api-new', false],
        ['shop/api', 'shop-api-old', true], // replaced mid-range
        ['shop/worker', 'shop-wk-1', false],
        ['shop/worker', 'shop-wk-2', true],
      ])
      const auth1 = pods.find((p) => p.host === 'auth-1')!
      expect([auth1.lines, auth1.errors, auth1.warns]).toEqual([count((l) => l.host === 'auth-1'), 3, 0])
      const old = pods.find((p) => p.host === 'shop-api-old')!
      expect([old.lines, old.errors]).toEqual([11, 1])
      expect(old.firstSeen).toBe(new Date(start + 1).toISOString())
      expect(old.lastSeen).toBe(new Date(start + 9 * MIN + 1).toISOString())
      expect(pods.find((p) => p.host === 'shop-wk-1')!.errors).toBe(1)
    })

    it('takes the same scope as /api/logs', async () => {
      expect((await logs.pods({ ...range, sources: 'auth' })).pods.map((p) => p.host)).toEqual(['auth-1', 'auth-2'])
      expect((await logs.pods({ ...range, service: 'shop', role: 'worker' })).pods.map((p) => p.host)).toEqual(['shop-wk-1', 'shop-wk-2'])
    })
  })
})
