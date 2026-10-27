'use strict'
/**
 * 15 report windows of telemetry for the daily report (docs/superpowers/plans/2026-10-27-daily-report-v2-stage1.md,
 * Task 7): steady traffic and one old error every window, an hourly cron, and in the report window a
 * deploy, a new error after it, a missed cron stretch, a 40-minute Redis outage, a failing mail job
 * and a slower endpoint. A window of report date D = [D-1 09:00, D 09:00) Asia/Bangkok.
 * Rows carry labels['seed'] = 'report' (logs) and resource['seed'] = 'report' (spans).
 * Env `production`: its TTL keeps logs 90 days, so 15-day-old rows survive merges.
 */
const DAY = 86_400_000
const HOUR = 3_600_000
const MIN = 60_000
const FIXTURE_ENV = 'production'
const SERVICE = 'school-core-api'
const SEED = 'report'

/** [D-1 02:00 UTC, D 02:00 UTC). */
const windowOf = (date) => {
  const toMs = Date.parse(`${date}T00:00:00Z`) + 2 * HOUR
  return { fromMs: toMs - DAY, toMs }
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const chTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

function buildReportFixture({ env = FIXTURE_ENV, date }) {
  let seq = 0
  const hex = (len) => (++seq).toString(16).padStart(len, '0')
  const report = windowOf(date)
  const deployAt = report.fromMs + 9 * HOUR
  const versionAt = (ms) => (ms >= deployAt ? '1.1.0' : '1.0.0')
  const logs = []
  const spans = []
  const log = (ms, fields) =>
    logs.push({
      timestamp: chTime(ms), env, service: SERVICE, role: 'api', version: versionAt(ms), host: 'h1',
      level: 'info', logger: 'app', event_code: 'app.log', message: '', labels: { seed: SEED }, ...fields,
    })
  const span = (ms, method, route, status, durMs) =>
    spans.push({
      timestamp: chTime(ms), duration_ns: durMs * 1_000_000, env, service: SERVICE, role: 'api', version: versionAt(ms),
      host: 'h1', trace_id: hex(32), span_id: hex(16), parent_span_id: '', is_entry: 1, name: `${method} ${route}`,
      kind: 'server', status_code: status >= 500 ? 'ERROR' : 'UNSET', scope_name: '@opentelemetry/instrumentation-http',
      http_method: method, http_route: route, http_status: status, url_path: route, resource: { seed: SEED }, events: '[]',
    })

  // the SDK's request line (route_usage_1d reads it); a 500 is at level error, by u0–u4 of org1 like the old error
  const request = (ms, method, route, status, durMs, user, org) =>
    log(ms, {
      level: status >= 500 ? 'error' : 'info', logger: 'HttpRequest', event_code: 'http.request',
      http_method: method, http_route: route, url_path: route, http_status: status, duration_ms: durMs,
      user_id: user, organization_id: org,
    })

  for (let d = -14; d <= 0; d++) {
    const { fromMs } = windowOf(addDays(date, d))
    for (let h = 0; h < 24; h++) {
      const hourMs = fromMs + h * HOUR
      for (let i = 0; i < 20; i++) {
        const ms = hourMs + i * 3 * MIN
        const getMs = d === 0 ? 300 : 80
        span(ms, 'GET', '/classes/:id', 200, getMs)
        request(ms, 'GET', '/classes/:id', 200, getMs, `u${20 + i}`, `org${1 + (i % 2)}`)
        const failed = i === 0
        span(ms + 1000, 'POST', '/classes/:id/exams/:examId/submit', failed ? 500 : 201, failed ? 900 : 200)
        request(ms + 1000, 'POST', '/classes/:id/exams/:examId/submit', failed ? 500 : 201, failed ? 900 : 200,
          failed ? `u${h % 5}` : `u${40 + i}`, failed ? 'org1' : `org${3 + (i % 2)}`)
      }
      // a probe without users: never a feature
      for (let i = 0; i < 4; i++) request(hourMs + i * 15 * MIN, 'GET', '/health', 200, 2, '', '')
      if (h < 10) {
        log(hourMs + 30 * MIN, {
          level: 'error', event_code: 'app.error', message: 'value too large for column',
          error_type: 'OracleError', error_code: 'ORA-12899', error_hint: 'Value too large',
          origin_function: 'ExamService.submit', origin_file: 'src/exam/exam.service.ts',
          http_method: 'POST', http_route: '/classes/:id/exams/:examId/submit',
          user_id: `u${h % 5}`, organization_id: 'org1', trace_id: hex(32),
        })
      }
      if (!(d === 0 && h >= 5 && h <= 9)) {
        const cron = { event_module: 'cron', job_queue: 'cron', job_type: 'ReportCron.handle', job_id: hex(8) }
        log(hourMs + MIN, { ...cron, event_code: 'job.started' })
        log(hourMs + MIN + 30_000, { ...cron, event_code: 'job.finished', duration_ms: 30_000 })
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    log(deployAt + HOUR + i * MIN, {
      level: 'error', event_code: 'app.error', message: "Cannot read properties of null (reading 'score')",
      error_type: 'TypeError', error_hint: 'Null read', origin_function: 'ExamController.result',
      origin_file: 'src/exam/exam.controller.ts', http_method: 'GET', http_route: '/classes/:id/exams/:examId/result',
      user_id: `u${10 + (i % 8)}`, organization_id: `org${2 + (i % 2)}`, trace_id: hex(32),
    })
  }
  const redis = { dependency_type: 'redis', dependency_name: 'cache', dependency_host: '10.0.3.21', dependency_port: 6379 }
  log(report.fromMs + 2 * HOUR, { ...redis, level: 'error', event_code: 'dependency.down', error_message: 'connect ECONNREFUSED 10.0.3.21:6379' })
  log(report.fromMs + 2 * HOUR + 40 * MIN, { ...redis, event_code: 'dependency.up', duration_ms: 40 * MIN, reason: 'recovered' })
  const mail = { event_module: 'bullmq', job_queue: 'mail', job_type: 'SendMail' }
  for (let i = 0; i < 3; i++) {
    log(report.fromMs + 12 * HOUR + i * MIN, {
      ...mail, job_id: hex(8), level: 'error', event_code: 'job.failed', error_type: 'SmtpError', error_hint: 'SMTP refused',
      message: 'connect ECONNREFUSED smtp:25',
    })
  }
  log(report.fromMs + 13 * HOUR, { ...mail, job_id: hex(8), event_code: 'job.finished', duration_ms: 1200 })
  return { logs, spans }
}

function checkedEnv(env) {
  // ALTER / DELETE take no query parameters here: the env goes in as a literal, checked
  if (!/^[a-z0-9_-]{1,32}$/.test(env)) throw new Error(`invalid env ${env}`)
  return env
}

async function resetReportFixture(client, env = FIXTURE_ENV) {
  const e = checkedEnv(env)
  const sync = { clickhouse_settings: { mutations_sync: '2' } }
  await client.command({ query: `DELETE FROM logs WHERE env = '${e}' AND labels['seed'] = '${SEED}'`, ...sync })
  await client.command({ query: `ALTER TABLE spans DELETE WHERE env = '${e}' AND resource['seed'] = '${SEED}'`, ...sync })
  // the materialized views' rows of this env: the env is reserved for the fixture
  await client.command({ query: `ALTER TABLE route_stats_1m DELETE WHERE env = '${e}'`, ...sync })
  await client.command({ query: `ALTER TABLE trace_index DELETE WHERE env = '${e}'`, ...sync })
  await client.command({ query: `ALTER TABLE route_usage_1d DELETE WHERE env = '${e}'`, ...sync })
}

async function seedReportFixture(client, { env = FIXTURE_ENV, date }) {
  await resetReportFixture(client, env)
  const { logs, spans } = buildReportFixture({ env, date })
  for (let i = 0; i < spans.length; i += 5000) {
    await client.insert({ table: 'spans', values: spans.slice(i, i + 5000), format: 'JSONEachRow' })
  }
  await client.insert({ table: 'logs', values: logs, format: 'JSONEachRow' })
  return { logs: logs.length, spans: spans.length }
}

module.exports = { FIXTURE_ENV, buildReportFixture, seedReportFixture, resetReportFixture, windowOf, addDays }
