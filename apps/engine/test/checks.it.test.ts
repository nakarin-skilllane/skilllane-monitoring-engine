import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { LogsService } from '../src/query/logs.service'
import type { LogRow } from '../src/query/rows'
import { Reader } from '../src/query/sql'

/**
 * /api/logs collapse=1 folds scheduled checks: one caller (service + method + route + user agent) that got 2xx
 * without logging in, on a steady interval, keeps only its latest http.request line, marked `repeat.kind: 'check'`;
 * `check=<id>` opens every line of it. Logs carry no user agent: the lines go by the trace of the caller's span.
 * Env `checks-it`, 30 minutes.
 */
const ENV = 'checks-it'
const MIN = 60_000
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

function fixture(endMs: number): { spans: Array<Record<string, unknown>>; logs: Array<Record<string, unknown>> } {
  const start = endMs - 30 * MIN
  const spans: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  let seq = 0
  const hex = (len: number) => (++seq).toString(16).padStart(len, '0')
  const log = (ms: number, trace: string, f: Record<string, unknown>) =>
    logs.push({
      timestamp: chTime(ms), env: ENV, service: 'svc', role: 'api', version: '1', host: 'h1', level: 'info', logger: 'App',
      event_code: 'app.log', message: '', trace_id: trace, ...f,
    })
  /** One request: its SERVER span, the two lines the app writes around it and its http.request line. */
  const req = (ms: number, route: string, status: number, ua: string, headers: Record<string, string> = {}) => {
    const trace = hex(32)
    spans.push({
      timestamp: chTime(ms), duration_ns: 2_000_000, env: ENV, service: 'svc', role: 'api', version: '1', host: 'h1',
      trace_id: trace, span_id: hex(16), parent_span_id: '', is_entry: 1, kind: 'SERVER', status_code: status >= 500 ? 'ERROR' : 'UNSET',
      scope_name: 'test', name: `GET ${route}`, http_method: 'GET', http_route: route, url_path: route, http_status: status,
      events: '[]', attributes: { 'http.user_agent': ua }, req_headers: JSON.stringify({ 'user-agent': ua, ...headers }),
    })
    log(ms + 1, trace, { logger: 'LoggingMiddleware', message: `incoming request ${trace.slice(-6)}` })
    log(ms + 2, trace, { logger: 'LoggingMiddleware', message: `request done ${trace.slice(-6)}` })
    log(ms + 3, trace, {
      level: status >= 500 ? 'error' : 'info', logger: 'HttpRequest', event_code: 'http.request', message: 'request completed',
      http_method: 'GET', http_route: route, url_path: route, http_status: status, duration_ms: 2,
    })
    return trace
  }
  // an uptime script every 3 minutes (a second or so late now and then): folded; its warning stays
  const checks = Array.from({ length: 10 }, (_, i) => req(start + i * 3 * MIN + (i === 4 ? 900 : 0), '/', 200, 'python-requests/2.31.0'))
  log(start + 3 * MIN + 5, checks[1], { level: 'warn', logger: 'AppController', message: 'version file missing' })
  req(start + 16 * MIN + 40_000, '/', 503, 'python-requests/2.31.0') // the API failing the check: shown
  for (let i = 0; i < 30; i++) req(start + i * MIN + 30_000, '/status', 200, 'curl/8.5.0') // another checker, every minute: folded
  for (const at of [0, 67_000, 9 * MIN, 22 * MIN + 13_000]) req(start + at + 9, '/', 200, 'Mozilla/5.0') // people: shown
  // a page left open by a signed-in user, polling every 30 s: steady, but a person's activity: shown
  for (let i = 0; i < 60; i++) req(start + i * 30_000 + 11, '/notifications', 200, 'Mozilla/5.0', { authorization: '[REDACTED]' })
  return { spans, logs }
}

const TOTAL = 10 * 3 + 1 + 3 + 30 * 3 + 4 * 3 + 60 * 3
/** Quiet lines of the two checkers, less the line each keeps. */
const FOLDED = 10 * 3 - 1 + (30 * 3 - 1)

describe.skipIf(!process.env.LOGS_IT)('scheduled checks folded on ClickHouse (LOGS_IT=1, docker compose up -d clickhouse)', () => {
  const writer = createClient({ url: config.clickhouse.url, username: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database })
  const ch = new ClickhouseService()
  const logs = new LogsService(new Reader(ch))
  const end = Date.now() - MIN
  const range = { env: ENV, from: new Date(end - 31 * MIN).toISOString(), to: new Date(end + MIN).toISOString() }
  const sync = { clickhouse_settings: { mutations_sync: '2' as const } }
  const reset = async () => {
    await writer.command({ query: `DELETE FROM logs WHERE env = '${ENV}'`, ...sync })
    for (const table of ['spans', 'trace_index', 'route_stats_1m', 'route_usage_1d']) {
      await writer.command({ query: `ALTER TABLE ${table} DELETE WHERE env = '${ENV}'`, ...sync })
    }
  }
  const checkRows = (rows: LogRow[]) => rows.filter((r) => r.repeat?.kind === 'check')

  beforeAll(async () => {
    await ch.applySchema()
    await reset()
    const f = fixture(end)
    await writer.insert({ table: 'spans', values: f.spans, format: 'JSONEachRow' })
    await writer.insert({ table: 'logs', values: f.logs, format: 'JSONEachRow' })
  }, 120_000)

  afterAll(async () => {
    await reset()
    await writer.close()
    await ch.onApplicationShutdown()
  })

  it('without collapse every line is there', async () => {
    const r = await logs.search({ ...range, limit: '500' })
    expect(r.rows).toHaveLength(TOTAL)
    expect(checkRows(r.rows)).toEqual([])
  })

  it('collapse keeps the latest http.request line of each scheduled caller, marked; a failure, people and a signed-in poller stay', async () => {
    const r = await logs.search({ ...range, collapse: '1', limit: '500' })
    expect(r.rows).toHaveLength(TOTAL - FOLDED)
    expect(r.collapse).toMatchObject({ checks: 2, lines: FOLDED })
    const marks = checkRows(r.rows).map((row) => ({ route: row.http?.route, eventCode: row.eventCode, ...row.repeat }))
    expect(marks).toEqual([
      expect.objectContaining({ route: '/status', eventCode: 'http.request', kind: 'check', count: 30, everyS: 60, client: 'curl/8.5.0', template: 'GET /status' }),
      expect.objectContaining({ route: '/', eventCode: 'http.request', kind: 'check', count: 10, everyS: 180, client: 'python-requests/2.31.0', template: 'GET /' }),
    ])
    expect(r.rows.filter((row) => row.level === 'warn').map((row) => row.message)).toEqual(['version file missing'])
    expect(r.rows.filter((row) => row.http?.status === 503)).toHaveLength(1)
    expect(r.rows.filter((row) => row.eventCode === 'http.request' && row.http?.route === '/notifications')).toHaveLength(60)
    expect(r.rows.filter((row) => row.eventCode === 'http.request' && row.http?.route === '/' && row.http.status === 200)).toHaveLength(1 + 4)
  })

  it('check=<id> opens every line of that caller, nothing folded', async () => {
    const folded = await logs.search({ ...range, collapse: '1', limit: '500' })
    const uptime = checkRows(folded.rows).find((row) => row.http?.route === '/')
    const r = await logs.search({ ...range, check: uptime?.repeat?.pattern ?? '', limit: '500' })
    expect(r.rows).toHaveLength(10 * 3 + 1)
    expect(new Set(r.rows.map((row) => row.traceId)).size).toBe(10)
    await expect(logs.search({ ...range, check: 'nope' })).rejects.toThrow(/check/)
  })
})
