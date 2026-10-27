#!/usr/bin/env node
'use strict'
/**
 * Seeds 15 report windows ending at the latest finished one (09:00 Asia/Bangkok) into env `production`.
 *   node apps/engine/scripts/seed-report.js            replace the fixture
 *   node apps/engine/scripts/seed-report.js --reset    only delete it
 *   --date=YYYY-MM-DD                                  another report date
 * Then open /reports/daily?env=production and press "สร้างรายงาน".
 */
const fs = require('node:fs')
const path = require('node:path')
const { createClient } = require('@clickhouse/client')
const { FIXTURE_ENV, resetReportFixture, seedReportFixture } = require('./report-fixture')

const repoEnv = path.resolve(__dirname, '../../../.env')
if (fs.existsSync(repoEnv) && typeof process.loadEnvFile === 'function') process.loadEnvFile(repoEnv)

const args = process.argv.slice(2)
// latest finished window: today (Bangkok) from 09:00 = 02:00 UTC, else yesterday
const now = Date.now()
const today = new Date(now + 7 * 3_600_000).toISOString().slice(0, 10)
const latest = now >= Date.parse(`${today}T02:00:00Z`) ? today : new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
const date = (args.find((a) => a.startsWith('--date=')) || `--date=${latest}`).slice(7)
const client = createClient({
  url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'skilllane_monitoring',
  password: process.env.CLICKHOUSE_PASSWORD || 'skilllane_monitoring',
  database: process.env.CLICKHOUSE_DATABASE || 'skilllane_monitoring',
})

;(async () => {
  if (args.includes('--reset')) {
    await resetReportFixture(client, FIXTURE_ENV)
    console.log(`report fixture removed from env ${FIXTURE_ENV}`)
  } else {
    const n = await seedReportFixture(client, { env: FIXTURE_ENV, date })
    console.log(`report fixture for ${date} in env ${FIXTURE_ENV}: ${n.spans} spans, ${n.logs} log lines`)
  }
  await client.close()
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
