import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { Reader } from '../src/query/sql'
import { TracesService } from '../src/query/traces.service'

/** /api/traces noise (hide) on 30 minutes of entry spans of one service in env `traces-it`. */
const ENV = 'traces-it'
const MIN = 60_000
const ALL = 'probe,preflight,cron,outside'
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

function fixture(endMs: number): Array<Record<string, unknown>> {
  const start = endMs - 30 * MIN
  let seq = 0
  const hex = (len: number) => (++seq).toString(16).padStart(len, '0')
  const out: Array<Record<string, unknown>> = []
  const span = (ms: number, f: Record<string, unknown>) =>
    out.push({
      timestamp: chTime(ms), duration_ns: 5_000_000, env: ENV, service: 'svc', role: 'api', version: '1', host: 'h1',
      trace_id: hex(32), span_id: hex(16), parent_span_id: '', is_entry: 1, kind: 'SERVER', status_code: 'UNSET',
      scope_name: 'test', name: '', http_method: '', http_route: '', http_status: 0, url_path: '', events: '[]', ...f,
    })
  const req = (ms: number, method: string, route: string, status: number) =>
    span(ms, { name: `${method} ${route}`, http_method: method, http_route: route, url_path: route, http_status: status, status_code: status >= 500 ? 'ERROR' : 'UNSET' })
  for (let ms = start; ms < endMs; ms += 10_000) req(ms, 'GET', '/api/health', 200) // 180 probes
  for (let i = 0; i < 2; i++) req(start + i * MIN + 1, 'GET', '/api/health', 503) // failed probes: shown
  for (let i = 0; i < 5; i++) req(start + i * MIN + 2, 'OPTIONS', '/auth/login', 204)
  for (let i = 0; i < 6; i++) span(start + i * 5 * MIN + 3, { kind: 'INTERNAL', name: 'cron AnnouncementCronService.handleCron' }) // a frequent cron
  span(start + 17 * MIN, { kind: 'INTERNAL', name: 'cron AnnouncementCronService.handleCron', status_code: 'ERROR' }) // its failed run: shown
  span(start + 20 * MIN + 4, { kind: 'INTERNAL', name: 'cron ReportCronService.daily', duration_ns: 900_000_000 }) // a daily job: shown
  for (let i = 0; i < 20; i++) span(start + i * MIN + 5, { kind: 'CLIENT', name: 'oracledb.Pool.getConnection' }) // outside any request
  span(start + 25 * MIN + 6, { kind: 'CLIENT', name: 'oracledb.Pool.getConnection', status_code: 'ERROR' }) // its failure: shown
  for (let ms = start; ms < endMs; ms += 30_000) req(ms + 7, 'GET', '/courses', 200) // 60 real requests
  return out
}

const SHOWN = 2 + 1 + 1 + 1 + 60
const HIDDEN = { probe: 180, preflight: 5, cron: 6, outside: 20 }
const TOTAL = SHOWN + 180 + 5 + 6 + 20

describe.skipIf(!process.env.LOGS_IT)('traces noise on ClickHouse (LOGS_IT=1, docker compose up -d clickhouse)', () => {
  const writer = createClient({ url: config.clickhouse.url, username: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database })
  const ch = new ClickhouseService()
  const traces = new TracesService(new Reader(ch))
  const end = Date.now() - MIN
  const range = { env: ENV, from: new Date(end - 31 * MIN).toISOString(), to: new Date(end + MIN).toISOString() }
  const sync = { clickhouse_settings: { mutations_sync: '2' as const } }
  const reset = async () => {
    for (const table of ['spans', 'trace_index', 'route_stats_1m']) {
      await writer.command({ query: `ALTER TABLE ${table} DELETE WHERE env = '${ENV}'`, ...sync })
    }
  }

  beforeAll(async () => {
    await ch.applySchema()
    await reset()
    await writer.insert({ table: 'spans', values: fixture(end), format: 'JSONEachRow' })
  }, 120_000)

  afterAll(async () => {
    await reset()
    await writer.close()
    await ch.onApplicationShutdown()
  })

  it('without hide nothing is hidden; the groups are still counted', async () => {
    const r = await traces.list({ ...range, limit: '500' })
    expect(r.total).toBe(TOTAL)
    expect(r.hidden).toEqual({ ...HIDDEN, total: 0 })
  })

  it('hide leaves out the noise from rows and totals, never a failure or a daily cron', async () => {
    const r = await traces.list({ ...range, hide: ALL, limit: '500' })
    expect(r.total).toBe(SHOWN)
    expect(r.totalErrors).toBe(2 + 1 + 1)
    expect(r.hidden).toEqual({ ...HIDDEN, total: 180 + 5 + 6 + 20 })
    expect(r.rows).toHaveLength(SHOWN)
    expect(r.rows.filter((x) => x.httpRoute === '/api/health').map((x) => x.status)).toEqual([503, 503])
    expect(r.rows.some((x) => x.method === 'OPTIONS')).toBe(false)
    expect(r.rows.filter((x) => x.name.startsWith('cron ')).map((x) => `${x.name} ${x.isError}`).sort()).toEqual([
      'cron AnnouncementCronService.handleCron true',
      'cron ReportCronService.daily false',
    ])
    expect(r.rows.filter((x) => x.kind === 'CLIENT').map((x) => x.isError)).toEqual([true])
  })

  it('the sample (spread) picks only from what is shown', async () => {
    const r = await traces.list({ ...range, hide: ALL, sample: 'spread', limit: '500' })
    expect(r.rows).toHaveLength(SHOWN)
  })

  it('hide takes only known groups', async () => {
    await expect(traces.list({ ...range, hide: 'probe,nope' })).rejects.toThrow(/unknown value/)
  })
})
