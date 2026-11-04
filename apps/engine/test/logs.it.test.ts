import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { LogsService } from '../src/query/logs.service'
import type { LogRow } from '../src/query/rows'
import { Reader } from '../src/query/sql'

/**
 * /api/logs noise (hide, exclude) and repeats (collapse, pattern) on 30 minutes of one service in env `logs-it`.
 * Every line has its own millisecond, so paging with `before` never drops a tie.
 */
const ENV = 'logs-it'
const MIN = 60_000
const ALL = 'probe,preflight,middleware,cache,cron'
const chTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

function fixture(endMs: number): Array<Record<string, unknown>> {
  const start = endMs - 30 * MIN
  const out: Array<Record<string, unknown>> = []
  const log = (ms: number, f: Record<string, unknown>) =>
    out.push({ timestamp: chTime(ms), env: ENV, service: 'svc', role: 'api', version: '1', host: 'h1', level: 'info', logger: 'App', event_code: 'app.log', message: '', ...f })
  const req = (ms: number, method: string, route: string, status: number) =>
    log(ms, {
      level: status >= 500 ? 'error' : 'info', logger: 'HttpRequest', event_code: 'http.request', message: 'request completed',
      http_method: method, http_route: route, url_path: route, http_status: status, duration_ms: 5,
    })
  for (let ms = start; ms < endMs; ms += 4000) {
    req(ms, 'GET', '/api/health', 200) // 450 probe
    log(ms + 1, { message: 'request middleware' }) // 450 middleware
    log(ms + 2, { logger: 'Poller', message: `Polling for new jobs… found ${ms % 3}` }) // 450, a repeat
  }
  for (let ms = start; ms < endMs; ms += 2000) {
    log(ms + 3, { level: 'error', logger: 'RedisClient', event_code: 'app.error', message: 'connect ECONNREFUSED 10.0.3.21:6379' }) // 900, a repeat
  }
  for (let ms = start; ms < endMs; ms += 3000) {
    req(ms + 5, 'GET', '/courses', 200) // 600 real traffic: never collapsed
    log(ms + 6, { logger: 'Worker', event_code: 'job.finished', job_queue: 'mail', job_type: 'SendMail', job_id: String(ms) }) // 600 jobs: never collapsed
  }
  for (let i = 0; i < 3; i++) req(start + i * MIN + 11, 'GET', '/api/health', 503) // a failed probe is never hidden
  for (let i = 0; i < 10; i++) req(start + i * MIN + 7, 'OPTIONS', '/auth/login', 204)
  for (let i = 0; i < 100; i++) log(start + i * 15_000 + 8, { logger: 'RedisCacheManager', message: `Cache hit for key: course-media/${(0xabc000 + i).toString(16)}.png` })
  for (let i = 0; i < 150; i++) log(start + 10 * MIN + i * 200 + 9, { level: 'warn', logger: 'Importer', message: `Import row ${i} failed` }) // a burst: 150 in 30 s
  for (let i = 0; i < 5; i++) log(start + i * 5 * MIN + 10, { logger: 'ExamService', message: `Exam submitted by u_${i}` })
  // a cron every 5 minutes: its started / finished lines are noise, its failure is not; BullMQ jobs above stay
  for (let i = 0; i < 6; i++) {
    const cron = { logger: 'Cron', event_module: 'cron', job_queue: 'cron', job_type: 'AnnouncementCronService.handleCron', job_id: `c${i}` }
    log(start + i * 5 * MIN + 15, { ...cron, event_code: 'job.started', message: 'job started' })
    log(start + i * 5 * MIN + 16, { ...cron, event_code: 'job.finished', message: 'job finished', duration_ms: 4 })
  }
  log(start + 3 * 5 * MIN + 17, { logger: 'Cron', event_module: 'cron', job_queue: 'cron', job_type: 'AnnouncementCronService.handleCron', job_id: 'c3', level: 'error', event_code: 'job.failed', message: 'job failed' })
  // a cron that runs once (a daily 05:00 job): not frequent, never hidden
  const daily = { logger: 'Cron', event_module: 'cron', job_queue: 'cron', job_type: 'ReportCronService.daily', job_id: 'd1' }
  log(start + 20 * MIN + 18, { ...daily, event_code: 'job.started', message: 'job started' })
  log(start + 20 * MIN + 19, { ...daily, event_code: 'job.finished', message: 'job finished', duration_ms: 900 })
  // bursts: 7 lines 50 ms apart, twice 5 s apart (two marked lines); 3 in a row stay (not more than 3)
  for (const at of [start + 5 * MIN, start + 5 * MIN + 5000]) {
    for (let i = 0; i < 7; i++) log(at + i * 50 + 12, { logger: 'DatabaseModule', message: 'Session schema set to: MICA2_DEV' })
  }
  for (let i = 0; i < 3; i++) log(start + 6 * MIN + i * 100 + 13, { level: 'warn', logger: 'OracleAuthProvider', message: 'Token is valid, retrieving user from repository: a@b.th' })
  const handlers = ['GetUsers', 'GetRoles', 'GetMinistries', 'GetJurisdictions', 'GetDepartments', 'ExportUsers', 'GetExamRoom', 'GetProfile']
  // the last three in the same millisecond, as a NestJS start-up writes them: still one line kept
  handlers.forEach((h, i) =>
    log(start + 7 * MIN + Math.min(i, 5) + 14, { level: 'warn', logger: 'QueryBus', message: `Query handler [${h}Handler] is already registered. Overriding previously registered handler.` }),
  )
  return out
}

const TOTAL = 3 * 450 + 900 + 2 * 600 + 3 + 10 + 100 + 150 + 5 + 14 + 3 + 8 + 12 + 1 + 2
const NOISE = 450 + 10 + 450 + 100 + 12

describe.skipIf(!process.env.LOGS_IT)('logs noise + repeats on ClickHouse (LOGS_IT=1, docker compose up -d clickhouse)', () => {
  const writer = createClient({ url: config.clickhouse.url, username: config.clickhouse.user, password: config.clickhouse.password, database: config.clickhouse.database })
  const ch = new ClickhouseService()
  const logs = new LogsService(new Reader(ch))
  const end = Date.now() - MIN
  const range = { env: ENV, from: new Date(end - 31 * MIN).toISOString(), to: new Date(end + MIN).toISOString() }
  const sync = { clickhouse_settings: { mutations_sync: '2' as const } }
  const reset = async () => {
    await writer.command({ query: `DELETE FROM logs WHERE env = '${ENV}'`, ...sync })
    await writer.command({ query: `ALTER TABLE route_usage_1d DELETE WHERE env = '${ENV}'`, ...sync })
  }

  /** Every row of a query, page by page (limit 100 unless given). */
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

  beforeAll(async () => {
    await ch.applySchema()
    await reset()
    await writer.insert({ table: 'logs', values: fixture(end), format: 'JSONEachRow' })
  }, 120_000)

  afterAll(async () => {
    await reset()
    await writer.close()
    await ch.onApplicationShutdown()
  })

  describe('hide / exclude / pattern', () => {
    it('without the new params nothing is hidden or collapsed', async () => {
      const r = await logs.search({ ...range, limit: '1' })
      expect(sumLevels(r.levelCounts)).toBe(TOTAL)
      expect(r.hidden).toEqual({ probe: 450, preflight: 10, middleware: 450, cache: 100, cron: 12, exclude: 0, total: 0 })
      expect(r.collapse).toBeNull()
    })

    it('hide drops the noise groups from rows and counts, never a failed probe', async () => {
      const r = await logs.search({ ...range, hide: ALL, limit: '1' })
      expect(r.hidden).toEqual({ probe: 450, preflight: 10, middleware: 450, cache: 100, cron: 12, exclude: 0, total: NOISE })
      expect(sumLevels(r.levelCounts)).toBe(TOTAL - NOISE)
      expect(r.levelCounts.error).toBe(904)
      const rows = await allRows({ ...range, hide: ALL, limit: '500' })
      expect(rows).toHaveLength(TOTAL - NOISE)
      expect(rows.filter((x) => x.http?.route === '/api/health').map((x) => x.http?.status)).toEqual([503, 503, 503])
      expect(rows.some((x) => x.http?.method === 'OPTIONS' || x.message === 'request middleware' || x.logger === 'RedisCacheManager')).toBe(false)
    })

    it('a 5-minute cron is frequent in a range much longer than its data', async () => {
      const r = await logs.search({ env: ENV, from: new Date(end - 6 * 60 * MIN).toISOString(), to: range.to, hide: ALL, limit: '1' })
      expect(r.hidden.cron).toBe(12)
    })

    it('hidden counts follow the level filter', async () => {
      const r = await logs.search({ ...range, hide: ALL, level: 'error', limit: '1' })
      expect(r.hidden.total).toBe(0)
      expect(r.hidden.probe).toBe(0)
    })

    it('exclude hides the lines whose message has the text (any case)', async () => {
      const r = await logs.search({ ...range, exclude: 'exam SUBMITTED', limit: '500' })
      expect(r.hidden.exclude).toBe(5)
      expect(r.hidden.total).toBe(5)
      expect(sumLevels(r.levelCounts)).toBe(TOTAL - 5)
    })
  })

  describe('collapse', () => {
    it('keeps the latest line of each fast repeat, marked with its count', async () => {
      const r = await logs.search({ ...range, hide: ALL, collapse: '1', limit: '500' })
      expect(r.collapse).toEqual({ patterns: 3, bursts: 3, lines: 900 + 450 + 150 - 3 + 14 - 2 + 8 - 1, skipped: null })
      // the import burst's latest line is 20 minutes old: it sits on a later page, where its time is
      const marked = (await allRows({ ...range, hide: ALL, collapse: '1', limit: '500' })).filter((x) => x.repeat)
      const counts = (kind: string) => marked.filter((x) => x.repeat!.kind === kind).map((x) => x.repeat!.count).sort((a, b) => a - b)
      expect(counts('steady')).toEqual([150, 450, 900])
      expect(counts('burst')).toEqual([7, 7, 8])
      const redis = marked.find((x) => x.logger === 'RedisClient')!
      expect(redis.level).toBe('error')
      expect(redis.repeat!.template).toBe('connect ECONNREFUSED *.*.*.*:*')
      expect(redis.timestamp).toBe(redis.repeat!.lastSeen)
      // the volume still counts every line: an error that floods is seen in the chart and on ERR
      expect(r.levelCounts.error).toBe(904)
    })

    it('a repeat shows up once over every page; jobs and requests are never collapsed', async () => {
      const rows = await allRows({ ...range, hide: ALL, collapse: '1' })
      expect(rows).toHaveLength(TOTAL - NOISE - (900 + 450 + 150) + 3 - (14 - 2) - (8 - 1))
      expect(rows.filter((x) => x.logger === 'RedisClient')).toHaveLength(1)
      expect(rows.filter((x) => x.logger === 'Poller')).toHaveLength(1)
      expect(rows.filter((x) => x.logger === 'Importer')).toHaveLength(1)
      expect(rows.filter((x) => x.eventCode === 'job.finished' && x.job?.queue === 'mail')).toHaveLength(600)
      const crons = rows.filter((x) => x.eventModule === 'cron')
      expect(crons.map((x) => `${x.job?.type} ${x.eventCode}`)).toEqual(['ReportCronService.daily job.finished', 'ReportCronService.daily job.started', 'AnnouncementCronService.handleCron job.failed'])
      expect(rows.filter((x) => x.http?.route === '/courses')).toHaveLength(600)
      expect(rows.filter((x) => x.logger === 'ExamService')).toHaveLength(5)
    })

    it('a burst of more than 3 within 1 s keeps its last line; 3 in a row stay', async () => {
      const rows = await allRows({ ...range, hide: ALL, collapse: '1' })
      const sessions = rows.filter((x) => x.logger === 'DatabaseModule')
      expect(sessions.map((x) => x.repeat?.count)).toEqual([7, 7])
      expect(sessions.every((x) => x.timestamp === x.repeat!.lastSeen)).toBe(true)
      expect(rows.filter((x) => x.logger === 'OracleAuthProvider')).toHaveLength(3)
      const handler = rows.filter((x) => x.logger === 'QueryBus')
      expect(handler).toHaveLength(1)
      expect(handler[0].repeat!.template).toBe('Query handler [*] is already registered. Overriding previously registered handler.')
      expect(handler[0].message).toMatch(/GetExamRoomHandler|GetProfileHandler|ExportUsersHandler/)
    })

    it('pattern lists every line of one repeat', async () => {
      const r = await logs.search({ ...range, hide: ALL, collapse: '1', limit: '500' })
      const id = r.rows.find((x) => x.logger === 'RedisClient')!.repeat!.pattern
      const all = await logs.search({ ...range, pattern: id, limit: '500' })
      expect(all.levelCounts.error).toBe(900)
      expect(sumLevels(all.levelCounts)).toBe(900)
      expect(all.rows.every((x) => x.logger === 'RedisClient')).toBe(true)
    })

    it('a range over 7 days is not collapsed', async () => {
      const r = await logs.search({ env: ENV, from: 'now-8d', hide: ALL, collapse: '1', limit: '1' })
      expect(r.collapse).toEqual({ patterns: 0, bursts: 0, lines: 0, skipped: 'range' })
    })
  })
})
