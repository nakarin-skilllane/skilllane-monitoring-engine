import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { ReleasesService } from '../src/query/releases.service'
import { Reader } from '../src/query/sql'
import { ReportBuilder } from '../src/reports/report-builder'
import { ReportExport } from '../src/reports/report-export'
import { ReportQueries } from '../src/reports/report-queries'
import { ReportStore } from '../src/reports/report-store'
import { GotenbergClient } from '../src/reports/render/gotenberg'
import type { ReportsService } from '../src/reports/reports.service'
import { latestReportDate } from '../src/reports/rules'
import type { DailyPayload, StoredReport } from '../src/reports/types'
// CommonJS fixture shared with scripts/seed-report.js
import { FIXTURE_ENV, resetReportFixture, seedReportFixture } from '../scripts/report-fixture.js'

const DATE = latestReportDate(Date.now())

describe.skipIf(!process.env.REPORT_IT)('daily report on ClickHouse (REPORT_IT=1, pnpm infra:up)', () => {
  const writer = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
    database: config.clickhouse.database,
  })
  const ch = new ClickhouseService()
  const reader = new Reader(ch)
  const builder = new ReportBuilder(new ReportQueries(reader), new ReleasesService(reader))
  let p: DailyPayload
  let ms: number

  beforeAll(async () => {
    await seedReportFixture(writer, { env: FIXTURE_ENV, date: DATE })
    const started = Date.now()
    p = await builder.build(FIXTURE_ENV, DATE)
    ms = Date.now() - started
  })

  afterAll(async () => {
    await resetReportFixture(writer, FIXTURE_ENV)
    await writer.close()
    await ch.writer.close()
    await ch.reader.close()
  })

  it('figures and their normal', () => {
    expect(p.figures.requests.value).toBe(960)
    expect(p.figures.errorRate).toMatchObject({ value: 0.025, baseline: 0.025 })
    expect(p.figures.usersAffected).toMatchObject({ value: 13, baseline: 5 })
    expect(p.figures.orgsAffected).toMatchObject({ value: 3, baseline: 1 })
    expect(p.trend).toHaveLength(7)
  })

  it('bad from the 40-minute outage; the outage and the mail job are incidents', () => {
    expect(p.headline.statusAuto).toBe('bad')
    expect(p.dependencies[0]).toMatchObject({ name: 'redis cache', downMinutes: 40, problem: true })
    expect(p.incidents.map((i) => i.source)).toEqual(['dependency.down', 'job.failed'])
  })

  it('errors: the new one first; the daily one is recurring', () => {
    expect(p.topErrors[0]).toMatchObject({ trend: 'new', users: 8, errorHint: 'Null read' })
    expect(p.figures.errorGroups.new).toBe(2)
    expect(p.followups.some((f) => f.kind === 'recurring' && f.text.startsWith('Value too large'))).toBe(true)
  })

  it('jobs, deploy, slow route', () => {
    expect(p.jobs.find((j) => j.job === 'ReportCron.handle')).toMatchObject({ kind: 'cron', missed: 5 })
    expect(p.jobs.find((j) => j.job === 'SendMail')).toMatchObject({ kind: 'queue', total: 4, failed: 3 })
    expect(p.deploys).toHaveLength(1)
    expect(p.deploys[0]).toMatchObject({ previousVersion: '1.0.0', version: '1.1.0', relatedFingerprints: [p.topErrors[0].fingerprint] })
    expect(p.slowRoutes.map((s) => s.route)).toEqual(['GET /classes/:id'])
  })

  it('main features from usage: the classes routes as one feature, no health probe', () => {
    expect(p.features).toEqual([
      { featureId: 'school-core-api:classes', name: 'ห้องเรียน', successRate: 0.975, successRate7d: 0.975, volume: 960, state: 'ok', note: '' },
    ])
  })

  it('no PII in the payload', () => {
    expect(JSON.stringify(p)).not.toMatch(/"u1\d?"|"org\d"|user_id|organization_id/)
  })

  it('builds in under 30 s', () => {
    console.log(`daily report build: ${ms} ms`)
    expect(ms).toBeLessThan(30_000)
  })

  it('daily_reports: save, then read by date, the latest, and the date list', async () => {
    const store = new ReportStore(ch)
    await store.onModuleInit()
    const report: StoredReport = {
      env: FIXTURE_ENV, reportDate: DATE, windowStartMs: p.windowStartMs, windowEndMs: p.windowEndMs,
      generatedAt: new Date().toISOString(), status: p.headline.statusAuto, payload: p, aiStatus: 'disabled', aiMessage: '',
    }
    await store.save(report)
    expect(await store.get(FIXTURE_ENV, DATE)).toMatchObject({ reportDate: DATE, windowStartMs: p.windowStartMs, status: 'bad' })
    expect((await store.get(FIXTURE_ENV))?.reportDate).toBe(DATE)
    expect(await store.get(FIXTURE_ENV, '2000-01-01')).toBeUndefined()
    expect((await store.dates(FIXTURE_ENV))[0]).toEqual({ reportDate: DATE, status: 'bad' })
  })

  // GOTENBERG_URL=http://localhost:3030 (docker compose up -d gotenberg)
  it.skipIf(!process.env.GOTENBERG_URL)('exports through Gotenberg: PNG 1520 px wide, whole-report PDF of ≥ 4 pages, no PII', async () => {
    const report: StoredReport = {
      env: FIXTURE_ENV, reportDate: DATE, windowStartMs: p.windowStartMs, windowEndMs: p.windowEndMs,
      generatedAt: new Date().toISOString(), status: p.headline.statusAuto, payload: p, aiStatus: 'disabled', aiMessage: '',
    }
    const exporter = new ReportExport({ get: async () => report } as unknown as ReportsService, new GotenbergClient(process.env.GOTENBERG_URL))
    const started = Date.now()
    const png = await exporter.file(FIXTURE_ENV, DATE, 'overview', 'infographic', 'png')
    expect(png.body.subarray(1, 4).toString()).toBe('PNG')
    expect(png.body.readUInt32BE(16)).toBe(1520)
    const pdf = await exporter.file(FIXTURE_ENV, DATE, 'all', 'data', 'pdf')
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.body.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    writeFileSync(join(tmpdir(), `${pdf.filename}`), pdf.body)
    writeFileSync(join(tmpdir(), `${png.filename}`), png.body)
    console.log(`export png + pdf: ${Date.now() - started} ms → ${tmpdir()}`)
  })
})
