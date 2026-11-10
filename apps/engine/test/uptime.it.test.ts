import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { LogsService } from '../src/query/logs.service'
import { Reader } from '../src/query/sql'
import { TracesService } from '../src/query/traces.service'

/**
 * The probe noise group also takes an uptime checker: `GET /` answered 2xx to a python-requests client (an internal
 * script polls school-core-api every 3 minutes). Logs carry no user agent, so their lines are matched through the
 * trace of the checker's span. Env `uptime-it`, 30 minutes.
 */
const ENV = 'uptime-it'
const MIN = 60_000
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

interface Fixture {
  spans: Array<Record<string, unknown>>
  logs: Array<Record<string, unknown>>
}

function fixture(endMs: number): Fixture {
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
  /** One request: its SERVER span, its http.request line and the two lines the app writes around it. */
  const req = (ms: number, route: string, status: number, attributes: Record<string, string>) => {
    const trace = hex(32)
    spans.push({
      timestamp: chTime(ms), duration_ns: 2_000_000, env: ENV, service: 'svc', role: 'api', version: '1', host: 'h1',
      trace_id: trace, span_id: hex(16), parent_span_id: '', is_entry: 1, kind: 'SERVER', status_code: status >= 500 ? 'ERROR' : 'UNSET',
      scope_name: 'test', name: `GET ${route}`, http_method: 'GET', http_route: route, url_path: route, http_status: status,
      events: '[]', attributes,
    })
    log(ms + 1, trace, { logger: 'LoggingMiddleware', message: 'incoming request', labels: { request_id: trace.slice(0, 8) } })
    log(ms + 2, trace, { logger: 'LoggingMiddleware', message: 'request done', labels: { request_id: trace.slice(0, 8), response_code: String(status) } })
    log(ms + 3, trace, {
      level: status >= 500 ? 'error' : 'info', logger: 'HttpRequest', event_code: 'http.request', message: 'request completed',
      http_method: 'GET', http_route: route, url_path: route, http_status: status, duration_ms: 2,
    })
    return trace
  }
  const python = { 'http.user_agent': 'python-requests/2.31.0' }
  for (let i = 0; i < 10; i++) req(start + i * 3 * MIN, '/', 200, python) // the uptime script: hidden
  const newer = req(start + 4, '/', 200, { 'user_agent.original': 'python-requests/2.32.3' }) // newer semconv key: hidden
  log(start + 4 + 5, newer, { level: 'warn', logger: 'AppController', message: 'version file missing' }) // a warning in it: shown
  req(start + 15 * MIN + 5, '/', 503, python) // the API failing the check: shown
  for (let i = 0; i < 3; i++) req(start + i * MIN + 6, '/', 200, { 'http.user_agent': 'Mozilla/5.0' }) // a person: shown
  for (let i = 0; i < 2; i++) req(start + i * MIN + 7, '/courses', 200, python) // not `/`: shown
  return { spans, logs }
}

// spans: 11 checks hidden; 1 failed check + 3 browsers + 2 other paths shown
const SPANS_SHOWN = 1 + 3 + 2
// logs: 3 lines per request; the 11 checks' 33 quiet lines hidden, their warning and the other 18 lines shown
const LOGS_HIDDEN = 11 * 3
const LOGS_SHOWN = 1 + 6 * 3

describe.skipIf(!process.env.LOGS_IT)('uptime checks as probe noise on ClickHouse (LOGS_IT=1, docker compose up -d clickhouse)', () => {
  const writer = createClient({ url: config.clickhouse.url, username: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database })
  const ch = new ClickhouseService()
  const reader = new Reader(ch)
  const logs = new LogsService(reader)
  const traces = new TracesService(reader)
  const end = Date.now() - MIN
  const range = { env: ENV, from: new Date(end - 31 * MIN).toISOString(), to: new Date(end + MIN).toISOString() }
  const sync = { clickhouse_settings: { mutations_sync: '2' as const } }
  const reset = async () => {
    await writer.command({ query: `DELETE FROM logs WHERE env = '${ENV}'`, ...sync })
    for (const table of ['spans', 'trace_index', 'route_stats_1m', 'route_usage_1d']) {
      await writer.command({ query: `ALTER TABLE ${table} DELETE WHERE env = '${ENV}'`, ...sync })
    }
  }

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

  it('traces: the checks are probes; a failed check, a person and other paths are not', async () => {
    const all = await traces.list({ ...range, limit: '500' })
    expect(all.total).toBe(SPANS_SHOWN + 11)
    expect(all.hidden.probe).toBe(11)
    const r = await traces.list({ ...range, hide: 'probe', limit: '500' })
    expect(r.total).toBe(SPANS_SHOWN)
    expect(r.rows.filter((t) => t.route === 'GET /' && t.status === 200)).toHaveLength(3)
  })

  it('logs: every quiet line of a check is a probe, through its trace; its warning and a failed check stay', async () => {
    const all = await logs.search({ ...range, limit: '500' })
    expect(all.rows).toHaveLength(LOGS_HIDDEN + LOGS_SHOWN)
    expect(all.hidden.probe).toBe(LOGS_HIDDEN)
    const r = await logs.search({ ...range, hide: 'probe', limit: '500' })
    expect(r.rows).toHaveLength(LOGS_SHOWN)
    expect(r.hidden).toMatchObject({ probe: LOGS_HIDDEN, total: LOGS_HIDDEN })
    expect(r.rows.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual(['version file missing'])
    expect(r.rows.filter((l) => l.eventCode === 'http.request' && l.http?.status === 503)).toHaveLength(1)
  })
})
