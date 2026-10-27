import { createClient } from '@clickhouse/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickhouseService } from '../src/clickhouse/clickhouse.service'
import { config } from '../src/config'
import { ReleasesService } from '../src/query/releases.service'
import { Reader } from '../src/query/sql'
import { ReportBuilder } from '../src/reports/report-builder'
import { ReportQueries } from '../src/reports/report-queries'
import { latestReportDate } from '../src/reports/rules'
import type { DailyPayload } from '../src/reports/types'
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

  it('no PII in the payload', () => {
    expect(JSON.stringify(p)).not.toMatch(/"u1\d?"|"org\d"|user_id|organization_id/)
  })

  it('builds in under 30 s', () => {
    console.log(`daily report build: ${ms} ms`)
    expect(ms).toBeLessThan(30_000)
  })
})
