#!/usr/bin/env node
'use strict'
/**
 * Seeds a realistic demo dataset into ClickHouse for env `prod`, ending at the
 * current time: about 24 h of traffic (scaled down to tens of thousands of
 * requests) that mirrors design/monitoring-ui/BRIEF.md: services and roles, the
 * 8 routes, the 8 error groups (the ones the live demo apps also produce with
 * the live SDK's fields, so seeded and live lines share one fingerprint),
 * traces A/B/C with their ids, BullMQ/Kafka/RabbitMQ/cron job lines, the outage
 * of the cache Redis (dependency 'redis') and the ThaID 401s. Times in the brief (now = 14:20 ICT) are
 * placed relative to now, e.g. trace A = now - 1 min 52.588 s. The deploy is
 * real clock time: school-core-api runs 31.3.2 until 08:00 ICT (UTC+7) of the
 * seeded day window and 31.4.0 after it; NULL_READ exists only in 31.4.0, so
 * /api/errors marks it isNew while ORA-12899 (seen in 31.3.2 too) is not.
 * Spans carry the I/O the SDK captures (headers, query string, bodies, SQL bind values,
 * queue messages; skilllane_monitoring.spans I/O columns), masked like the SDK masks it.
 *
 * Usage (any cwd):
 *   node apps/engine/scripts/seed-demo.js            delete the previous seed, insert a fresh one
 *   node apps/engine/scripts/seed-demo.js --reset    only delete the seeded rows
 *   node apps/engine/scripts/seed-demo.js --dry-run  generate only (no ClickHouse): counts and sizes;
 *     --dump=<file>                                  also write the demo traces' span rows (JSONEachRow)
 *   --env=<name>                                     another env (default prod)
 *
 * Inserts as the writer user into skilllane_monitoring.logs and skilllane_monitoring.spans; the materialized
 * views fill trace_index and route_stats_1m. Seeded rows carry labels['seed']='1'
 * (logs) and resource['seed']='1' (spans). A reset deletes only those rows (and
 * the trace_index rows of their traces), then rebuilds route_stats_1m for the
 * seeded minutes from the spans that remain, so live data of the same env survives.
 * Connection: CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DATABASE
 * (defaults http://localhost:8123, skilllane_monitoring/skilllane_monitoring, skilllane_monitoring); <repo root>/.env is read when present.
 */
const fs = require('node:fs')
const path = require('node:path')
const { createClient } = require('@clickhouse/client')
// The SDK's own masking rules (skilllane-monitoring/contract, src/contract/mask of the SDK).
const mask = require('skilllane-monitoring/contract')

// ---------------------------------------------------------------- config
const repoEnv = path.resolve(__dirname, '../../../.env')
if (fs.existsSync(repoEnv) && typeof process.loadEnvFile === 'function') process.loadEnvFile(repoEnv)

const args = process.argv.slice(2)
const RESET_ONLY = args.includes('--reset')
const DRY_RUN = args.includes('--dry-run')
const DUMP = (args.find((a) => a.startsWith('--dump=')) || '').slice(7)
const ENV = (args.find((a) => a.startsWith('--env=')) || '--env=prod').slice(6)
if (!/^[a-z0-9_-]{1,32}$/.test(ENV)) {
  console.error(`invalid --env=${ENV}`)
  process.exit(2)
}
const DB = process.env.CLICKHOUSE_DATABASE || 'skilllane_monitoring'
if (!/^[a-zA-Z0-9_]+$/.test(DB)) throw new Error(`invalid CLICKHOUSE_DATABASE ${DB}`)
const client = createClient({
  url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'skilllane_monitoring',
  password: process.env.CLICKHOUSE_PASSWORD || 'skilllane_monitoring',
  database: DB,
  clickhouse_settings: { date_time_input_format: 'best_effort' },
})

// ---------------------------------------------------------------- random + time
let seedState = 20261017 >>> 0
function rand() {
  seedState = (seedState + 0x6d2b79f5) >>> 0
  let t = seedState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + (b - a) * rand()
const int = (a, b) => Math.floor(between(a, b + 1))
const chance = (p) => rand() < p
const pick = (list) => list[Math.floor(rand() * list.length)]
/** Mostly near `a`, a long tail toward `b`. */
const skew = (a, b, k = 2) => a + (b - a) * Math.pow(rand(), k)
function hex(n) {
  let out = ''
  while (out.length < n) out += Math.floor(rand() * 0x100000000).toString(16).padStart(8, '0')
  return out.slice(0, n)
}
const round3 = (x) => Math.round(x * 1000) / 1000

const NOW = Date.now()
const HOUR = 3600_000
const DAY = 24 * HOUR
const START = NOW - DAY
/** The brief's "now": 17 Oct 2026 14:20 ICT. */
const BRIEF_NOW = Date.UTC(2026, 9, 17, 7, 20, 0)
/** A brief clock time (ICT, `HH:MM[:SS.mmm]`, dayOffset -1 = 16 Oct) → epoch ms relative to now. */
function at(clock, dayOffset = 0) {
  const [h, m, s = '0'] = clock.split(':')
  const t = Date.UTC(2026, 9, 17 + dayOffset, Number(h) - 7, Number(m), 0) + Number(s) * 1000
  return NOW - (BRIEF_NOW - t)
}
/** Brief-clock ICT hour of a time: traffic follows the brief's day, whatever the real clock says. */
function briefHour(ms) {
  const d = new Date(ms + (BRIEF_NOW - NOW) + 7 * HOUR)
  return d.getUTCHours() + d.getUTCMinutes() / 60
}
const pad = (n, w = 2) => String(n).padStart(w, '0')
function fmt3(ms) {
  const d = new Date(Math.floor(ms))
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  )
}
const fmt6 = (us) => fmt3(Math.floor(us / 1000)) + pad(Math.floor(us % 1000), 3)

/** School traffic by ICT hour: quiet nights, peak 08:00-16:30, lunch dip. */
function diurnal(h) {
  if (h < 5) return 0.1
  if (h < 7) return 0.1 + (h - 5) * 0.25
  if (h < 8) return 0.6 + (h - 7) * 0.8
  if (h < 12) return 1.45
  if (h < 13) return 1.15
  if (h < 16.5) return 1.5
  if (h < 19) return 1.0
  if (h < 22) return 0.65
  return 0.3
}
/** Random times in [from, to) following the diurnal curve. */
function sampler(from, to) {
  const minutes = Math.max(1, Math.ceil((to - from) / 60_000))
  const cum = new Float64Array(minutes)
  let total = 0
  for (let i = 0; i < minutes; i++) {
    total += diurnal(briefHour(from + i * 60_000))
    cum[i] = total
  }
  return () => {
    const x = rand() * total
    let lo = 0
    let hi = minutes - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid] < x) lo = mid + 1
      else hi = mid
    }
    return Math.min(to - 50, from + lo * 60_000 + rand() * 60_000)
  }
}
const inDay = sampler(START, NOW - 5_000)

// ---------------------------------------------------------------- reference data
const CORE = 'school-core-api'
const ETL = 'school-etl-api'
const VIDEO = 'video-transcoder-api'
/** 08:00 ICT (01:00 UTC) inside the seeded day window: the latest one at or before now. */
function deployTime() {
  const d = new Date(NOW)
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 0, 0)
  return t > NOW ? t - DAY : t
}
const DEPLOY = deployTime()
/** A time that must be in 31.4.0 (after the deploy) and not in the future. */
const afterDeploy = (t) => Math.min(NOW - 5_000, Math.max(t, DEPLOY + 60_000))
const OUTAGE_START = at('13:42:35')
const OUTAGE_END = at('13:43:20.2')
const TRACE_A = '4bf92f3577b34da6a3ce929d0e0e4736'
const TRACE_B = '9a1c4e0b7d2f4c8e8b3a6f5d2e1c0b9a'
const TRACE_C = 'e7c3d2a1f09e885ca13e9b0a8d4f21b6'

const HOSTS = {
  [`${CORE}/api`]: {
    old: ['school-core-api-6f7d9c8b5-2x8kq', 'school-core-api-6f7d9c8b5-h4m2p'],
    new: ['school-core-api-7b9c4d6f8-k9t2w', 'school-core-api-7b9c4d6f8-p3v7n'],
  },
  [`${CORE}/worker`]: { old: ['school-core-worker-5c8d7b9f6-q2wz4'], new: ['school-core-worker-84f6c9d7b-m8x2c'] },
  [`${CORE}/persister`]: { old: ['school-core-persister-7d5f8c6b9-r4n8t'], new: ['school-core-persister-9b7c5d8f4-j6k1s'] },
  [`${ETL}/api`]: { all: ['school-etl-api-5f6d9b7c8-8kq2n'] },
  [`${VIDEO}/api`]: { all: ['video-transcoder-api-79c4b8d6f-ms3vd', 'video-transcoder-api-79c4b8d6f-zt5qp'] },
}
const VERSIONS = { [ETL]: '4.2.1', [VIDEO]: '2.7.0' }

/** service/role/version/host at time t (school-core-api 31.3.2 → 31.4.0 at the deploy). */
function res(service, role, t, hostIndex) {
  const hosts = HOSTS[`${service}/${role}`]
  if (service === CORE) {
    const post = t >= DEPLOY
    const list = post ? hosts.new : hosts.old
    return { service, role, version: post ? '31.4.0' : '31.3.2', host: list[hostIndex ?? int(0, list.length - 1)] }
  }
  return { service, role, version: VERSIONS[service], host: hosts.all[hostIndex ?? int(0, hosts.all.length - 1)] }
}
const resourceCache = new Map()
function resourceMap(r) {
  const key = `${r.service}|${r.role}|${r.version}|${r.host}`
  if (!resourceCache.has(key)) {
    resourceCache.set(key, {
      'service.name': r.service,
      'service.version': r.version,
      'deployment.environment.name': ENV,
      'host.name': r.host,
      'app.role': r.role,
      'telemetry.sdk.name': 'opentelemetry',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.version': '2.0.1',
      seed: '1',
    })
  }
  return resourceCache.get(key)
}

const USERS = [
  { id: 'u_1029', role: 'teacher', school: 's_118' },
  { id: 'u_2201', role: 'student', school: 's_118' },
  { id: 'u_0412', role: 'admin', school: 's_007' },
  { id: 'u_3318', role: 'teacher', school: 's_042' },
]
for (let n = USERS.length; n < 420; n++) {
  const x = rand()
  USERS.push({
    id: `u_${4000 + n * 13}`,
    role: x < 0.6 ? 'student' : x < 0.92 ? 'teacher' : 'admin',
    school: `s_${pad(int(1, 160), 3)}`,
  })
}
const pickUser = () => USERS[Math.floor(Math.pow(rand(), 1.8) * USERS.length)]
const pickTeacher = () => {
  for (;;) {
    const u = pickUser()
    if (u.role !== 'student') return u
  }
}
const userCols = (u) => (u ? { user_id: u.id, user_roles: [u.role], organization_id: u.school } : {})

const ORACLE_PEER = 'oracle-prod.example.internal:1521'
/** The app's Redis (cache): the SDK watches it by itself as dependency 'redis'. */
const REDIS_CACHE = { host: '10.0.3.21', port: 6379 }
/** The BullMQ connection: dependency 'queue'. */
const REDIS_QUEUE = { host: '10.0.3.22', port: 6379 }
const S3_PEER = 's3.ap-southeast-1.amazonaws.com:443'
const SCOPE_HTTP = '@opentelemetry/instrumentation-http'
const SCOPE_EXPRESS = '@opentelemetry/instrumentation-express'
const SCOPE_REDIS = '@opentelemetry/instrumentation-ioredis'
const SCOPE_AWS = '@opentelemetry/instrumentation-aws-sdk'
const SCOPE_JOB = 'skilllane-monitoring'
const SCOPE_DB = 'oracle'

// ---------------------------------------------------------------- error catalog (BRIEF error groups)
const STACK = (head, frames) => [head, ...frames.map((f) => `    at ${f}`)].join('\n')
/**
 * The groups the live demo apps (apps/demo-api) also produce carry exactly the
 * fields the SDK writes for them there (live is the truth): the same error_type,
 * error_code, error_hint and origin_function give the same error_fingerprint
 * (clickhouse/schema.sql), so seeded and live lines are one group. Paths are
 * the demo app's, under /app.
 */
const NEST = '/app/node_modules/@nestjs/core/router'
const ORACLEDB = '/app/node_modules/oracledb/lib'
const ERR = {
  /** 1 · Value too long for column (data): node-oracledb error from saveQuestions. */
  ora12899: (actual) => ({
    error_type: 'Error',
    error_code: 'ORA-12899',
    error_message: `ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: ${actual}, maximum: 255)`,
    error_hint: 'Value too long for column',
    error_hint_detail: 'A text value exceeds the column size. Common in Excel imports; validate length before saving.',
    error_fix: `QuestionBankEntity.title got ${actual} (max 255). Validate the length in the DTO or import before saving.`,
    error_category: 'data',
    error_target: 'QuestionBankEntity.title',
    origin_function: 'ImportQuestionBankHandler.saveQuestions',
    origin_file: 'src/core/question-bank.handlers.ts',
    usecase: 'ImportQuestionBankCommand',
    failed_step: 'oracle INSERT QUESTION_BANK',
    dependency_type: 'oracle',
    error_stack: STACK(
      `Error: ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: ${actual}, maximum: 255)`,
      [
        `Protocol._processMessage (${ORACLEDB}/thin/protocol/protocol.js:179:17)`,
        'process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
        `async ThinConnectionImpl._execute (${ORACLEDB}/thin/connection.js:195:7)`,
        `async ThinConnectionImpl.execute (${ORACLEDB}/thin/connection.js:927:14)`,
        `async Connection.execute (${ORACLEDB}/connection.js:861:16)`,
        'ImportQuestionBankHandler.saveQuestions (/app/dist/src/core/question-bank.handlers.js:85:45)',
        'async /app/dist/src/infra/oracle.js:76:24',
        'async ImportQuestionBankHandler.execute (/app/dist/src/core/question-bank.handlers.js:76:9)',
        'async /app/node_modules/skilllane-monitoring/dist/logger/usecase.js:43:20',
        `async ${NEST}/router-execution-context.js:55:62`,
      ],
    ),
  }),
  /** 2 · Read from undefined value (bug), new since 31.4.0. */
  nullRead: () => ({
    error_type: 'TypeError',
    error_code: 'NULL_READ',
    error_message: "Cannot read properties of undefined (reading 'school')",
    error_hint: 'Read from undefined value',
    error_hint_detail:
      'Code read a property (see target) of undefined or null. The value was likely not found or not loaded; guard it at the origin function.',
    error_fix:
      '"school" is a relation of ClassroomEntity: the parent object was undefined, or school was not loaded. Check relations / leftJoinAndSelect.',
    error_category: 'bug',
    error_target: 'school',
    origin_function: 'GetClassReportHandler.execute',
    origin_file: 'src/core/classes.handlers.ts',
    usecase: 'GetClassReportQuery',
    error_stack: STACK("TypeError: Cannot read properties of undefined (reading 'school')", [
      'GetClassReportHandler.execute (/app/dist/src/core/classes.handlers.js:66:34)',
      'async QueryBus.execute (/app/node_modules/@nestjs/cqrs/dist/query-bus.js:70:17)',
      'async /app/node_modules/skilllane-monitoring/dist/logger/usecase.js:43:20',
      `async ${NEST}/router-execution-context.js:55:62`,
      `async ${NEST}/router-proxy.js:9:17`,
    ]),
  }),
  /** 3 · Google rate limit hit (dependency), BullMQ report:generate: no origin (thrown in a callback), no fix. */
  google429: () => ({
    error_type: 'GaxiosError',
    error_code: 'rateLimitExceeded',
    error_message:
      "Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:418820214735'.",
    error_hint: 'Google rate limit hit',
    error_hint_detail: 'Too many requests to the Google API. The rate-limit service retries with backoff; reduce concurrency if frequent.',
    error_category: 'dependency',
    origin_file: 'src/infra/google-sheets.ts',
    failed_step: 'POST sheets.googleapis.com',
    url_domain: 'sheets.googleapis.com',
    http_status: 429,
    dependency_type: 'google',
    error_stack: STACK(
      "GaxiosError: Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:418820214735'.",
      [
        '/app/dist/src/infra/google-sheets.js:56:27',
        'async GoogleSheetsClient.appendReport (/app/dist/src/infra/google-sheets.js:43:9)',
        'async ReportProcessor.process (/app/dist/src/worker/report.processor.js:39:9)',
        'async /app/node_modules/skilllane-monitoring/dist/jobs/run-job.js:62:28',
        'async /app/node_modules/bullmq/dist/cjs/classes/worker.js:636:32',
      ],
    ),
  }),
  /**
   * 4 · Redis "redis" unreachable (dependency): the dependency.down line of the
   * app's own Redis, which the SDK watches by itself under the name 'redis'
   * (live: scripts/chaos-redis.sh). Node reports a refused dual-stack connect as
   * an AggregateError without a message.
   */
  redisDown: (target) => ({
    error_type: 'AggregateError',
    error_code: 'ECONNREFUSED',
    error_message: '',
    error_hint: 'Redis "redis" unreachable',
    error_hint_detail: `Nothing is listening at ${target.host}:${target.port}. Redis may be stopped or restarting, or its connection env vars is wrong.`,
    error_category: 'dependency',
    error_cause: JSON.stringify({ type: 'Error', message: `connect ECONNREFUSED ${target.host}:${target.port}`, code: 'ECONNREFUSED' }),
    error_stack: STACK('AggregateError [ECONNREFUSED]: ', [
      'internalConnectMultiple (node:net:1122:18)',
      'afterConnectMultiple (node:net:1689:7)',
      'TCPConnectWrap.callbackTrampoline (node:internal/async_hooks:130:17)',
    ]),
  }),
  /** The cache read of GET /question-bank/my while that Redis is down (warn; the request falls back to Oracle). */
  redisOffline: () => ({
    error_type: 'Error',
    error_code: 'REDIS_OFFLINE',
    error_message: "Stream isn't writeable and enableOfflineQueue options is false",
    error_hint: 'Redis unavailable',
    error_hint_detail:
      'The command failed at once because the connection is down and enableOfflineQueue is false. See the dependency.down line for the cause.',
    error_category: 'dependency',
    origin_function: 'CacheService.getJson',
    origin_file: 'src/infra/cache.service.ts',
    usecase: 'GetMyQuestionsQuery',
    error_stack: STACK("Error: Stream isn't writeable and enableOfflineQueue options is false", [
      'EventEmitter.sendCommand (/app/node_modules/ioredis/built/Redis.js:376:32)',
      'EventEmitter.get (/app/node_modules/ioredis/built/utils/Commander.js:90:25)',
      'CacheService.getJson (/app/dist/src/infra/cache.service.js:34:44)',
      'GetMyQuestionsHandler.execute (/app/dist/src/core/question-bank.handlers.js:46:41)',
    ]),
  }),
  /** 5 · Record not found (input): ExamsController.findOneOrFail inside the oracle SELECT EXAM span; the filter answers 404. */
  notFound: (id) => ({
    error_type: 'EntityNotFoundError',
    error_code: '',
    error_message: `Could not find any entity of type "ExamEntity" matching: {\n    "id": ${id}\n}`,
    error_hint: 'Record not found',
    error_hint_detail: 'findOneOrFail found no row. Usually a wrong or deleted id from the client; the filter answers 404.',
    error_fix: 'No ExamEntity found by (id). Check the id the client sent, or whether the row was deleted.',
    error_category: 'input',
    error_target: 'ExamEntity',
    origin_function: 'ExamsController.findOneOrFail',
    origin_file: 'src/core/exams.controller.ts',
    failed_step: 'oracle SELECT EXAM',
    error_stack: STACK(`EntityNotFoundError: Could not find any entity of type "ExamEntity" matching: {\n    "id": ${id}\n}`, [
      'ExamsController.findOneOrFail (/app/dist/src/core/exams.controller.js:32:19)',
      'async /app/dist/src/infra/oracle.js:76:24',
      `async ${NEST}/router-execution-context.js:55:62`,
      `async ${NEST}/router-proxy.js:9:17`,
    ]),
  }),
  /** 6 · Invalid request (input): BadRequestException(messages) thrown in ExamsController.submit. */
  invalid: () => ({
    error_type: 'BadRequestException',
    error_code: 'HTTP_400',
    error_message: 'Bad Request Exception',
    error_hint: 'Invalid request',
    error_hint_detail: 'The request failed validation or business rules. The response message says which field.',
    error_fix: 'Rejected fields: answers.*.choice. The response message lists the rule each one broke.',
    error_category: 'input',
    error_target: 'answers.*.choice',
    origin_function: 'ExamsController.submit',
    origin_file: 'src/core/exams.controller.ts',
    http_status: 400,
    error_stack: STACK('BadRequestException: Bad Request Exception', [
      'ExamsController.submit (/app/dist/src/core/exams.controller.js:47:19)',
      `${NEST}/router-execution-context.js:39:29`,
      'process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      `async ${NEST}/router-execution-context.js:55:62`,
      `async ${NEST}/router-proxy.js:9:17`,
    ]),
  }),
  /** 7 · Query cancelled (dependency). */
  ora01013: (table, timeoutMs, origin, file, usecase, fix) => ({
    error_type: 'QueryFailedError',
    error_code: 'ORA-01013',
    error_message: 'ORA-01013: user requested cancel of current operation',
    error_hint: 'Query cancelled',
    error_hint_detail: 'The database cancelled the call because it ran longer than the call timeout. The query is too slow, or the database is overloaded.',
    error_fix: fix,
    error_category: 'dependency',
    error_target: table,
    origin_function: origin,
    origin_file: file,
    usecase,
    failed_step: `oracle SELECT ${table}`,
    db_statement: `SELECT * FROM "${table}" WHERE "CLASS_ID" = :1 ORDER BY "NAME"`,
    error_cause: `{"errorNum":1013,"callTimeout":${timeoutMs}}`,
    error_stack: STACK('QueryFailedError: ORA-01013: user requested cancel of current operation', [
      'OracleQueryRunner.query (/app/node_modules/typeorm/driver/oracle/OracleQueryRunner.js:186:19)',
      `async ${origin} (/app/${file}:33:21)`,
    ]),
  }),
  /** 8 · DB deadlock (data). */
  ora00060: () => ({
    error_type: 'QueryFailedError',
    error_code: 'ORA-00060',
    error_message: 'ORA-00060: deadlock detected while waiting for resource',
    error_hint: 'DB deadlock',
    error_hint_detail: 'Two sessions locked the same rows in opposite order and Oracle rolled one back. Usually fixed by retrying, or by locking rows in a fixed order.',
    error_fix: 'EXAM_SUBMISSION: two transactions waited on each other and this one was rolled back. Retry SubmitExamCommand once, and lock rows in the same order.',
    error_category: 'data',
    error_target: 'EXAM_SUBMISSION',
    origin_function: 'SubmitExamHandler.execute',
    origin_file: 'src/domain/exam/submit-exam.handler.ts',
    usecase: 'SubmitExamCommand',
    failed_step: 'oracle INSERT EXAM_SUBMISSION',
    db_statement: 'INSERT INTO "EXAM_SUBMISSION" ("EXAM_ID", "STUDENT_ID", "ANSWERS", "SUBMITTED_AT") VALUES (:1, :2, :3, :4)',
    error_cause: '{"errorNum":60,"offset":0}',
    error_stack: STACK('QueryFailedError: ORA-00060: deadlock detected while waiting for resource', [
      'OracleQueryRunner.query (/app/node_modules/typeorm/driver/oracle/OracleQueryRunner.js:186:19)',
      'async SubmitExamHandler.execute (/app/src/domain/exam/submit-exam.handler.ts:47:7)',
    ]),
  }),
  /** ThaID answered 401 (config): outbound, the request itself still succeeds. */
  thaid401: () => ({
    error_type: 'AxiosError',
    error_code: 'HTTP_401',
    error_message: 'Request failed with status code 401',
    error_hint: 'Remote API rejected the credentials',
    error_hint_detail: 'The remote service answered 401 Unauthorized: the client id, secret or token we send is missing, expired or wrong.',
    error_fix: 'ThaID (imauth.bora.dopa.go.th) answered 401. Check THAID_CLIENT_ID / THAID_CLIENT_SECRET and whether the access token expired.',
    error_category: 'config',
    error_target: 'imauth.bora.dopa.go.th',
    origin_function: 'ThaidService.fetchUserInfo',
    origin_file: 'src/integrations/thaid/thaid.service.ts',
    url_domain: 'imauth.bora.dopa.go.th',
    http_status: 401,
    dependency_type: 'http',
    dependency_name: 'ThaID',
    dependency_host: 'imauth.bora.dopa.go.th',
    dependency_port: 443,
    error_stack: STACK('AxiosError: Request failed with status code 401', [
      'settle (/app/node_modules/axios/dist/node/axios.cjs:2031:12)',
      'async ThaidService.fetchUserInfo (/app/src/integrations/thaid/thaid.service.ts:64:22)',
    ]),
  }),
  /** Cron AttendanceSyncService.sync timed out once. */
  attendanceTimeout: () => ({
    error_type: 'AxiosError',
    error_code: 'ETIMEDOUT',
    error_message: 'timeout of 30000ms exceeded',
    error_hint: 'Request timed out',
    error_hint_detail: 'The remote service did not answer within the timeout. It is slow, overloaded or unreachable.',
    error_fix: 'attendance-api.example.internal did not answer within 30000 ms. Check that service, or raise the timeout of AttendanceSyncService.sync.',
    error_category: 'dependency',
    error_target: 'attendance-api.example.internal',
    origin_function: 'AttendanceSyncService.sync',
    origin_file: 'src/domain/attendance/attendance-sync.service.ts',
    url_domain: 'attendance-api.example.internal',
    failed_step: 'GET attendance-api.example.internal',
    error_stack: STACK('AxiosError: timeout of 30000ms exceeded', [
      'RedirectableRequest.handleRequestTimeout (/app/node_modules/axios/dist/node/axios.cjs:3138:16)',
      'async AttendanceSyncService.sync (/app/src/domain/attendance/attendance-sync.service.ts:28:20)',
    ]),
  }),
  /** video-transcoder-api: S3 throttled an upload. */
  s3SlowDown: () => ({
    error_type: 'S3ServiceException',
    error_code: 'SlowDown',
    error_message: 'Please reduce your request rate.',
    error_hint: 'S3 throttled the request',
    error_hint_detail: 'S3 answered 503 SlowDown: too many requests to one key prefix. The AWS SDK retries; spread keys over more prefixes or lower the rate.',
    error_fix: 'Bucket demo-video-prod throttled PutObject under uploads/. Spread keys across prefixes, or add backoff in TranscodeService.start.',
    error_category: 'dependency',
    error_target: 'demo-video-prod',
    origin_function: 'TranscodeService.start',
    origin_file: 'src/transcode/transcode.service.ts',
    url_domain: 's3.ap-southeast-1.amazonaws.com',
    failed_step: 'S3.PutObject',
    error_stack: STACK('S3ServiceException: Please reduce your request rate.', [
      'throwDefaultError (/app/node_modules/@smithy/smithy-client/dist-cjs/index.js:867:20)',
      'async TranscodeService.start (/app/src/transcode/transcode.service.ts:52:5)',
    ]),
  }),
}

// ---------------------------------------------------------------- captured I/O (the Network view)
/**
 * What the SDK captures on a span (skilllane_monitoring.spans I/O columns, SPEC.md section 7), masked
 * with the SDK's own rules: the shared module skilllane-monitoring/contract (src/contract/mask) that
 * skilllane-monitoring and the engine use, not a copy. Key rule (isSensitiveKey: password,
 * token, secret, session, cookie, authorization, api-key, x-api-key, pin, otp, auth …;
 * not tokenType / PASSWORD_CHANGED_AT), value rule (redactValue: JWT, Bearer / Basic,
 * sensitive name=value pairs, URL userinfo, JSON in a string, email, Thai national id
 * with its checksum), cookie and Set-Cookie names kept, bind values by their column
 * (dbParametersJson), Redis commands as redisCommand writes them. Bodies are capped at
 * LOG_BODY_MAX_BYTES (64 KiB). The content comes from its own random stream, so every
 * other seeded value stays the same.
 */
const REDACTED = mask.REDACTED
const BODY_MAX_BYTES = 65536
const PARAMS_OPTIONS = { maxBytes: BODY_MAX_BYTES, valueMax: BODY_MAX_BYTES / 4 }

const maskText = (text) => mask.redactValue(text)
const isSensitive = (key) => mask.isSensitiveKey(key)
const maskDeep = (value) => mask.maskObject(value)

// Its own stream: I/O content never shifts the seeded traffic.
let ioState = 0x5eed10 >>> 0
function ioRand() {
  ioState = (ioState + 0x6d2b79f5) >>> 0
  let t = ioState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const ioInt = (a, b) => Math.floor(a + (b - a + 1) * ioRand())
const ioPick = (list) => list[Math.floor(ioRand() * list.length)]
function ioHex(n) {
  let out = ''
  while (out.length < n) out += Math.floor(ioRand() * 0x100000000).toString(16).padStart(8, '0')
  return out.slice(0, n)
}
/** A Thai national id with a valid checksum (masked as [REDACTED] by the value patterns). */
function thaiId() {
  const d = [ioInt(1, 8), ...Array.from({ length: 11 }, () => ioInt(0, 9))]
  let sum = 0
  for (let i = 0; i < 12; i++) sum += d[i] * (13 - i)
  return [...d, (11 - (sum % 11)) % 10].join('')
}
const fakeJwt = (sub) =>
  `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ sub, iss: 'https://auth.skilllane_monitoring.app', iat: 1760000000 })).toString('base64url')}.${ioHex(43)}`
const emailOf = (u) => `${u.id.replace('_', '.')}@${u.school.replace('_', '')}.skilllane_monitoring.ac.th`
const isoAt = (ms) => new Date(Math.floor(ms)).toISOString()

// Body specs: what the app sent or answered, before masking.
const json = (value, type) => ({ kind: 'json', value, type })
const textBody = (value, type) => ({ kind: 'text', value, type })
const binary = (size, type) => ({ kind: 'binary', size, type })
/** A multipart upload; one boundary per form (a forwarded form gets its own). */
const multipart = (fields, files, boundary = `----WebKitFormBoundary${ioHex(16)}`) => ({ kind: 'multipart', fields, files, boundary })

/** Masked text, original size and content-type of a body, cut at BODY_MAX_BYTES like the SDK. */
function bodyOf(spec) {
  if (!spec) return null
  if (spec.kind === 'binary') return { text: '', size: spec.size, truncated: 0, type: spec.type }
  if (spec.kind === 'multipart') {
    const files = spec.files.map((f) => ({ name: f.name, filename: maskText(f.filename), type: f.type, size: f.size }))
    const fields = Array.isArray(spec.fields)
      ? spec.fields
      : Object.fromEntries(Object.entries(spec.fields).map(([k, v]) => [k, isSensitive(k) ? REDACTED : maskText(String(v))]))
    const size = files.reduce((n, f) => n + f.size + 180, 0) + Object.keys(spec.fields).length * 120 + 46
    return { text: JSON.stringify({ fields, files }), size, truncated: 0, type: `multipart/form-data; boundary=${spec.boundary}` }
  }
  const raw = spec.kind === 'json' ? JSON.stringify(spec.value) : spec.value
  let text = spec.kind === 'json' ? mask.maskJsonText(raw) : maskText(spec.value)
  let truncated = 0
  if (Buffer.byteLength(text) > BODY_MAX_BYTES) {
    text = Buffer.from(text).subarray(0, BODY_MAX_BYTES).toString().replace(/�+$/, '')
    truncated = 1
  }
  return { text, size: Buffer.byteLength(raw), truncated, type: spec.type || (spec.kind === 'json' ? 'application/json; charset=utf-8' : 'text/plain') }
}

/** Headers JSON: names lower case (HTTP) or as sent (message headers), values masked (cookie names kept). */
function headersJson(headers, lower = true) {
  return JSON.stringify(mask.maskHeaders(headers, lower))
}
const withBody = (headers, body) =>
  body ? { ...headers, 'content-type': headers['content-type'] ?? body.type, 'content-length': headers['content-length'] ?? String(body.size) } : headers

/** Query params → url.query (no '?'), masked like the SDK masks a query string. */
function queryString(params) {
  return mask.maskQuery(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&'),
  )
}

/** One bind value as the SDK types it (before masking). */
function typedParam(key, v) {
  if (v === null || v === undefined) return { key, type: 'null', value: '' }
  if (v instanceof Date) return { key, type: 'date', value: v.toISOString() }
  if (Buffer.isBuffer(v)) return { key, type: 'buffer', value: v.toString('hex') }
  if (typeof v === 'number') return { key, type: 'number', value: String(v) }
  if (typeof v === 'boolean') return { key, type: 'boolean', value: String(v) }
  if (typeof v === 'object') return { key, type: 'object', value: JSON.stringify(maskDeep(v)) }
  return { key, type: 'string', value: String(v) }
}

/** Bind values (an array: :1, :2 …; an object: :name binds) → skilllane.monitoring.db.parameters JSON, masked by their columns in `stmt`. */
function paramsJson(values, stmt) {
  const entries = Array.isArray(values) ? values.map((v, i) => [String(i + 1), v]) : Object.entries(values)
  return mask.dbParametersJson(stmt || undefined, entries.length, (i) => typedParam(entries[i][0], entries[i][1]), PARAMS_OPTIONS)
}

/**
 * The I/O columns of one span (only the non-empty ones; ClickHouse fills the rest), with the
 * header / bind counts the ingest stores next to them.
 * io: { query: {k: v}, reqHeaders: {} | (spanId) => {}, resHeaders, req, res (body specs),
 * params (bind values), msg: { body, headers } }; a body's content-type / -length join its headers.
 */
function captured(io, spanId, stmt) {
  if (!io) return {}
  const out = {}
  if (io.query) out.url_query = queryString(io.query)
  const req = bodyOf(io.req)
  const res = bodyOf(io.res)
  const reqHeaders = typeof io.reqHeaders === 'function' ? io.reqHeaders(spanId) : io.reqHeaders
  if (reqHeaders) {
    const all = withBody(reqHeaders, req)
    out.req_headers = headersJson(all)
    out.req_header_count = Object.keys(all).length
  }
  if (io.resHeaders) {
    const all = withBody(io.resHeaders, res)
    out.res_headers = headersJson(all)
    out.res_header_count = Object.keys(all).length
  }
  if (req) Object.assign(out, { req_body: req.text, req_body_size: req.size, req_body_truncated: req.truncated })
  if (res) Object.assign(out, { res_body: res.text, res_body_size: res.size, res_body_truncated: res.truncated })
  if (io.params) {
    out.db_params = paramsJson(io.params, stmt)
    // the SDK's last { key: '…', value: '<n> more' } marks a cut list; it is not a bind
    out.db_param_count = out.db_params ? JSON.parse(out.db_params).filter((p) => p.key !== '…').length : 0
  }
  if (io.msg) {
    const body = bodyOf(json(io.msg.body))
    Object.assign(out, { msg_body: body.text, msg_body_size: body.size, msg_body_truncated: body.truncated })
    if (io.msg.headers) out.msg_headers = headersJson(io.msg.headers, false)
  }
  return out
}

const WEB = 'https://school.skilllane_monitoring.app'
const PUBLIC_HOST = { [CORE]: 'api.school.skilllane_monitoring.app', [VIDEO]: 'video.example.app', [ETL]: 'etl.school.skilllane_monitoring.app' }
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36'
const SUBJECTS = [['MATH-M2', 'คณิตศาสตร์ ม.2'], ['SCI-M1', 'วิทยาศาสตร์ ม.1'], ['THAI-M3', 'ภาษาไทย ม.3'], ['ENG-M2', 'ภาษาอังกฤษ ม.2']]
const FIRST = ['กิตติพัฒน์', 'ณัฐวุฒิ', 'ปภาวรินทร์', 'ศุภิสรา', 'ธนกฤต', 'พิมพ์ชนก', 'วรเมธ', 'ชญานิศ', 'อัครพล', 'กัญญาณัฐ']
const LAST = ['ใจดี', 'ศรีสุข', 'วงศ์ไทย', 'แก้วมณี', 'บุญมา', 'ทองคำ', 'สุขสวัสดิ์', 'พรหมมา']
const personName = () => `${ioPick(FIRST)} ${ioPick(LAST)}`

/** Request headers of a browser call through the ingress, as the app receives them. */
function browserHeaders(service, user, ua, referer) {
  const ip = `203.150.${ioInt(1, 254)}.${ioInt(1, 254)}`
  return {
    host: PUBLIC_HOST[service],
    'x-forwarded-for': `${ip}, 10.0.1.${ioInt(10, 40)}`,
    'x-forwarded-proto': 'https',
    'x-real-ip': ip,
    'user-agent': ua,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
    'accept-encoding': 'gzip, deflate, br, zstd',
    origin: WEB,
    referer: `${WEB}${referer}`,
    ...(user
      ? {
          authorization: `Bearer ${fakeJwt(user.id)}`,
          cookie: `_ga=GA1.1.${ioInt(1e8, 9e8)}.${ioInt(1.7e9, 1.76e9)}; sl_session=${ioHex(32)}`,
          'x-demo-user': user.id,
          'x-demo-school': user.school,
          'current-role': user.role,
        }
      : {}),
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  }
}

/** Response headers of the Nest/Express app (the SDK answers with request-id = trace id). */
function serverHeaders(trace, t, extra = {}) {
  return {
    'x-powered-by': 'Express',
    'access-control-allow-origin': WEB,
    'access-control-allow-credentials': 'true',
    vary: 'Origin, Accept-Encoding',
    'request-id': trace,
    ...extra,
    date: new Date(t).toUTCString(),
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
  }
}

/** Request headers of an outgoing axios / SDK call; traceparent names the client span. */
const clientHeaders = (trace, ua, extra = {}) => (spanId) => ({
  accept: 'application/json, text/plain, */*',
  'user-agent': ua,
  'accept-encoding': 'gzip, compress, deflate, br',
  traceparent: `00-${trace}-${spanId}-01`,
  ...extra,
})

const nestError = (statusCode, message, error) => json(error ? { statusCode, message, error } : { statusCode, message })

// ---------------------------------------------------------------- row builders
const LOGS = []
const SPANS = []
const SEED_LABELS = { seed: '1' }

function logLine(t, r, level, eventCode, logger, message, cols = {}) {
  const { fields, ...rest } = cols
  LOGS.push({
    timestamp: fmt3(t),
    env: ENV,
    service: r.service,
    role: r.role,
    version: r.version,
    host: r.host,
    level,
    logger,
    event_code: eventCode,
    message,
    labels: SEED_LABELS,
    ...(fields ? { fields } : {}),
    ...rest,
  })
}

function stringMap(attrs) {
  const out = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

/**
 * One span. o: { name, kind, start (ms), dur (ms), parent, remote, scope, method, route, status,
 * path, db, stmt, peer, statusCode, exception: { type, message, stack }, attrs, io (captured()) }.
 */
function addSpan(traceId, r, o) {
  const spanId = o.spanId || hex(16)
  const ex = o.exception
  const endMs = o.start + o.dur
  SPANS.push({
    timestamp: fmt6(Math.round(o.start * 1000)),
    duration_ns: Math.max(1000, Math.round(o.dur * 1e6)),
    env: ENV,
    service: r.service,
    role: r.role,
    version: r.version,
    host: r.host,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: o.parent || '',
    is_entry: !o.parent || o.remote ? 1 : 0,
    name: o.name,
    kind: o.kind,
    status_code: o.statusCode || (ex ? 'ERROR' : 'UNSET'),
    status_message: o.statusMessage || (ex ? ex.message : ''),
    scope_name: o.scope || '',
    http_method: o.method || '',
    http_route: o.route || '',
    http_status: o.status || 0,
    url_path: o.path || '',
    db_system: o.db || '',
    db_statement: o.stmt || '',
    peer: o.peer || '',
    exception_type: ex ? ex.type : '',
    exception_message: ex ? ex.message : '',
    attributes: stringMap(o.attrs || {}),
    resource: resourceMap(r),
    events: ex
      ? JSON.stringify([
          {
            name: 'exception',
            timeUnixNano: (BigInt(Math.round(endMs * 1000)) * 1000n).toString(),
            attributes: stringMap({ 'exception.type': ex.type, 'exception.message': ex.message, 'exception.stacktrace': ex.stack }),
          },
        ])
      : '[]',
    ...captured(o.io, spanId, o.stmt),
  })
  return spanId
}
const exceptionOf = (e) => ({ type: e.error_type, message: e.error_message, stack: e.error_stack })

/** Bind values the generic statements below take, when the call site gives none. */
function defaultParams(op, start) {
  if (op === 'SELECT') return [ioInt(1, 99_999)]
  if (op === 'INSERT') return [ioInt(100_000, 999_999), ioHex(8), ioInt(1, 900), new Date(start)]
  if (op === 'MERGE') return [ioInt(1, 99_999), ioInt(0, 100)]
  if (op === 'UPDATE') return [new Date(start), ioInt(1, 99_999)]
  if (op === 'DELETE') return [new Date(start - 30 * DAY)]
  return null
}

/** q: { stmt, params } of the call site (else a generic statement on the ID and made-up binds). */
function oracle(ctx, parent, op, table, start, dur, exception, q = {}) {
  const stmt =
    q.stmt ||
    (op === 'SELECT'
      ? `SELECT * FROM "${table}" WHERE "ID" = :1`
      : op === 'INSERT'
        ? `INSERT INTO "${table}" VALUES (:1, :2, :3, :4)`
        : op === 'MERGE'
          ? `MERGE INTO "${table}" t USING (SELECT :1 AS ID FROM DUAL) s ON (t."ID" = s.ID) WHEN MATCHED THEN UPDATE SET t."VALUE" = :2`
          : op === 'UPDATE'
            ? `UPDATE "${table}" SET "SYNCED_AT" = :1 WHERE "ID" = :2`
            : op === 'DELETE'
              ? `DELETE FROM "${table}" WHERE "CREATED_AT" < :1`
              : op)
  const params = q.params ?? defaultParams(op, start)
  return addSpan(ctx.trace, ctx.r, {
    name: table ? `oracle ${op} ${table}` : `oracle ${op}`,
    kind: 'CLIENT',
    start,
    dur,
    parent,
    scope: SCOPE_DB,
    db: 'oracle',
    stmt,
    peer: ORACLE_PEER,
    exception,
    attrs: {
      'db.system.name': 'oracle',
      'db.operation.name': op,
      'db.collection.name': table || undefined,
      'db.namespace': 'APP',
      'server.address': 'oracle-prod.example.internal',
      'server.port': 1521,
    },
    io: params ? { params } : undefined,
  })
}

/** `args`: the arguments after the key (the SDK records the whole command, masked and quoted as redis-cli reads it). */
function redisCall(ctx, parent, cmd, key, start, dur, target, exception, args = []) {
  const stmt = mask.redisCommand(cmd.toLowerCase(), [key, ...args], BODY_MAX_BYTES)
  return addSpan(ctx.trace, ctx.r, {
    name: cmd,
    kind: 'CLIENT',
    start,
    dur,
    parent,
    scope: SCOPE_REDIS,
    db: 'redis',
    stmt,
    peer: `${target.host}:${target.port}`,
    exception,
    attrs: { 'db.system.name': 'redis', 'server.address': target.host, 'server.port': target.port },
  })
}

/** io: { query, reqHeaders, req, resHeaders, res } of the call (captured()). */
function httpClient(ctx, parent, method, host, port, urlPath, start, dur, status, exception, io) {
  return addSpan(ctx.trace, ctx.r, {
    name: method,
    kind: 'CLIENT',
    start,
    dur,
    parent,
    scope: SCOPE_HTTP,
    method,
    status,
    path: urlPath,
    peer: `${host}:${port}`,
    statusCode: status >= 400 || exception ? 'ERROR' : 'UNSET',
    exception,
    attrs: {
      'http.request.method': method,
      'url.full': `${port === 443 ? 'https' : 'http'}://${host}${port === 443 ? '' : `:${port}`}${urlPath}`,
      'server.address': host,
      'server.port': port,
      'http.response.status_code': status,
    },
    io,
  })
}

/** The HTTP exchange under an S3 call. obj: { key, req, res, status, error } (body specs). */
function s3(ctx, parent, op, bucket, start, dur, exception, obj = {}) {
  const host = `${bucket}.s3.ap-southeast-1.amazonaws.com`
  const method = op === 'PutObject' ? 'PUT' : 'GET'
  const status = obj.status || 200
  return addSpan(ctx.trace, ctx.r, {
    name: `S3.${op}`,
    kind: 'CLIENT',
    start,
    dur,
    parent,
    scope: SCOPE_AWS,
    peer: S3_PEER,
    exception,
    attrs: {
      'rpc.system': 'aws-api', 'rpc.service': 'S3', 'rpc.method': op, 'aws.s3.bucket': bucket, 'cloud.region': 'ap-southeast-1',
      'http.request.method': method, 'url.full': `https://${host}/${obj.key || ''}`, 'http.response.status_code': status,
    },
    io: {
      reqHeaders: {
        host,
        'user-agent': 'aws-sdk-js/3.667.0 ua/2.1 os/linux#6.1 lang/js md/nodejs#20.19.6 api/s3#3.667.0',
        'x-amz-date': isoAt(start).replace(/[-:]|\.\d{3}/g, ''),
        'x-amz-content-sha256': method === 'PUT' ? ioHex(64) : 'UNSIGNED-PAYLOAD',
        'x-amz-security-token': `IQoJb3JpZ2luX2VjE${ioHex(40)}`,
        authorization: `AWS4-HMAC-SHA256 Credential=ASIA${ioHex(16).toUpperCase()}/20261017/ap-southeast-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${ioHex(64)}`,
      },
      req: obj.req,
      resHeaders: {
        'x-amz-request-id': ioHex(16).toUpperCase(),
        'x-amz-id-2': `${ioHex(40)}=`,
        ...(status < 300 ? { etag: `"${ioHex(32)}"` } : {}),
        ...(status < 300 && method === 'GET' ? { 'last-modified': new Date(start - ioInt(1, 30) * DAY).toUTCString(), 'accept-ranges': 'bytes' } : {}),
        server: 'AmazonS3',
        date: new Date(start + dur).toUTCString(),
      },
      res: obj.res,
    },
  })
}

/**
 * One HTTP request: SERVER span + express handler span + the http.request log
 * line; `children(ctx)` adds the route's own spans and lines. o.io: { query, req, res,
 * reqHeaders (over the browser's), resHeaders } — a downstream call (o.parent) passes
 * the caller's request headers in o.io.callerHeaders.
 */
function httpRequest(o) {
  const trace = o.trace || hex(32)
  const r = o.r || res(o.service, o.role || 'api', o.t0, o.hostIndex)
  const { method, route, path: urlPath, t0, dur, status } = o
  const io = o.io || {}
  const ua = o.userAgent || CHROME
  const reqHeaders = io.callerHeaders || { ...browserHeaders(r.service, o.user, ua, io.referer || '/'), ...io.reqHeaders }
  const serverId = addSpan(trace, r, {
    name: `${method} ${route}`,
    kind: 'SERVER',
    start: t0,
    dur,
    parent: o.parent,
    remote: !!o.parent,
    scope: SCOPE_HTTP,
    method,
    route,
    status,
    path: urlPath,
    statusCode: status >= 500 ? 'ERROR' : 'UNSET',
    attrs: {
      'http.request.method': method,
      'http.route': route,
      'http.response.status_code': status,
      'url.path': urlPath,
      'url.scheme': 'http',
      'server.port': r.service === ETL ? 5102 : r.service === CORE ? 5101 : 5103,
      'user_agent.original': ua,
      'client.address': reqHeaders['x-real-ip'] || '10.0.4.17',
    },
    io: {
      query: io.query,
      reqHeaders,
      req: io.req,
      resHeaders: serverHeaders(trace, t0 + dur, io.resHeaders),
      res: io.res,
    },
  })
  const lead = o.handlerLead ?? Math.min(2, dur * 0.05)
  const handlerId = addSpan(trace, r, {
    name: `request handler - ${route}`,
    kind: 'INTERNAL',
    start: t0 + lead,
    dur: Math.max(0.2, o.handlerDur ?? dur - lead * 2),
    parent: serverId,
    scope: SCOPE_EXPRESS,
    attrs: { 'http.route': route, 'express.type': 'request_handler', 'express.name': route },
  })
  const ctx = { trace, r, serverId, handlerId, t0, dur, user: o.user, method, route, path: urlPath }
  if (o.children) o.children(ctx)
  logLine(t0 + dur, r, status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'http.request', 'HttpRequest', 'HTTP request', {
    trace_id: trace,
    span_id: serverId,
    correlation_id: trace,
    ...userCols(o.user),
    http_method: method,
    http_route: route,
    url_path: urlPath,
    http_status: status,
    duration_ms: round3(dur),
  })
  return ctx
}

/** An error / warn line inside a request (the SDK adds method, route and path of the request). */
function requestLine(ctx, t, level, logger, err, extra = {}) {
  logLine(t, ctx.r, level, extra.event || 'app.log', logger, extra.message || err.error_message, {
    trace_id: ctx.trace,
    span_id: ctx.handlerId,
    correlation_id: ctx.trace,
    ...userCols(ctx.user),
    http_method: ctx.method,
    http_route: ctx.route,
    url_path: ctx.path,
    ...err,
    ...(extra.cols || {}),
  })
}

// ---------------------------------------------------------------- school-core-api / api routes
const etag = () => `W/"${ioInt(200, 4000).toString(16)}-${ioHex(27)}"`

function questionBankMy(t0) {
  const user = pickUser()
  const outage = t0 >= OUTAGE_START && t0 <= OUTAGE_END
  const miss = outage || chance(0.3)
  const redisDur = outage ? between(0.4, 1.5) : between(0.6, 2.8)
  const dbDur = miss ? skew(38, 135, 1.3) : 0
  const dur = 4 + redisDur + dbDur + between(2, 22)
  const page = ioRand() < 0.15 ? ioInt(2, 4) : 1
  const total = ioInt(3, 64)
  const items = Array.from({ length: Math.max(0, Math.min(5, total - (page - 1) * 20)) }, () => {
    const [subjectId, subject] = ioPick(SUBJECTS)
    return { id: ioInt(10_000, 99_999), title: `${subject} ชุดที่ ${ioInt(1, 30)}`, subjectId, questions: ioInt(10, 60), updatedAt: isoAt(t0 - ioInt(1, 900) * HOUR) }
  })
  httpRequest({
    service: CORE, t0, dur, status: 200, user, method: 'GET', route: '/question-bank/my', path: '/question-bank/my',
    io: {
      query: { page, limit: 20, sort: '-updatedAt' }, referer: '/question-bank',
      res: json({ items, page, limit: 20, total, source: miss ? 'oracle' : 'cache' }),
      resHeaders: { etag: etag(), 'cache-control': 'private, max-age=0' },
    },
    children: (ctx) => {
      const s = t0 + 2.5
      const e = outage ? ERR.redisOffline() : undefined
      redisCall(ctx, ctx.handlerId, 'GET', `qb:my:${user.id}`, s, redisDur, REDIS_CACHE, e ? exceptionOf(e) : undefined)
      if (e) requestLine(ctx, s + redisDur + 0.2, 'warn', 'CacheService', e, { message: 'Cache read failed; reading from Oracle' })
      if (miss) {
        oracle(ctx, ctx.handlerId, 'SELECT', 'QUESTION_BANK', s + redisDur + 1, dbDur, undefined, {
          stmt: 'SELECT "ID", "TITLE", "SUBJECT_ID", "QUESTION_COUNT", "UPDATED_AT" FROM "QUESTION_BANK" WHERE "OWNER_ID" = :ownerId ORDER BY "UPDATED_AT" DESC OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY',
          params: { ownerId: user.id, offset: (page - 1) * 20, limit: 20 },
        })
      }
    },
  })
}

const THAID_FAILS = new Set()
function me(t0, opts = {}) {
  const missingUser = !opts.thaid && chance(0.006)
  const user = missingUser ? undefined : pickUser()
  const thaid = opts.thaid || (!missingUser && chance(0.03) ? 'ok' : undefined)
  const thaidDur = thaid ? between(60, 190) : 0
  const dur = missingUser ? between(1, 4) : between(5, 20) + thaidDur + (chance(0.04) ? between(5, 18) : 0)
  const profile = user && {
    id: user.id, displayName: personName(), email: emailOf(user), roles: [user.role], schoolId: user.school,
    thaid: thaid ? { linked: true, verifiedAt: thaid === 'ok' ? isoAt(t0) : null } : { linked: false }, locale: 'th-TH',
  }
  httpRequest({
    service: CORE, t0, dur, status: missingUser ? 401 : 200, user, method: 'GET', route: '/me', path: '/me',
    io: {
      referer: '/', res: missingUser ? nestError(401, 'Unauthorized') : json(profile),
      resHeaders: missingUser ? {} : { etag: etag(), 'cache-control': 'no-store' },
    },
    children: (ctx) => {
      if (missingUser) {
        logLine(t0 + dur - 0.5, ctx.r, 'warn', 'auth.rejected', 'AuthGuard', 'Authentication rejected', {
          trace_id: ctx.trace, span_id: ctx.handlerId, correlation_id: ctx.trace,
          http_method: 'GET', http_route: '/me', url_path: '/me', http_status: 401, reason: 'missing_user_header',
        })
        return
      }
      if (thaid) {
        const rejected = thaid === 'rejected'
        const e = ERR.thaid401()
        httpClient(ctx, ctx.handlerId, 'GET', 'imauth.bora.dopa.go.th', 443, '/api/v2/oauth2/userinfo', t0 + 3, thaidDur, rejected ? 401 : 200,
          rejected ? exceptionOf(e) : undefined, {
            reqHeaders: clientHeaders(ctx.trace, 'axios/1.7.7', { authorization: `Bearer ${ioHex(48)}` }),
            resHeaders: rejected
              ? { 'www-authenticate': 'Bearer error="invalid_token", error_description="The access token expired"', 'cache-control': 'no-store', server: 'nginx' }
              : { 'cache-control': 'no-store', pragma: 'no-cache', server: 'nginx' },
            res: rejected
              ? json({ error: 'invalid_token', error_description: 'The access token expired' })
              : json({ sub: `thaid-${ioHex(12)}`, pid: thaiId(), name: profile.displayName, given_name: profile.displayName.split(' ')[0], birthdate: `25${ioInt(10, 55)}-0${ioInt(1, 9)}-1${ioInt(0, 9)}`, address: { formatted: `${ioInt(1, 299)}/${ioInt(1, 30)} ถนนพหลโยธิน กรุงเทพฯ` } }),
          })
        if (rejected) {
          logLine(t0 + 3 + thaidDur + 0.4, ctx.r, 'warn', 'http.outbound_failed', 'http:ThaID', 'Outbound HTTP request failed', {
            trace_id: ctx.trace, span_id: ctx.handlerId, correlation_id: ctx.trace, ...userCols(user),
            http_method: 'GET', url_path: '/api/v2/oauth2/userinfo', ...e,
          })
        }
      }
    },
  })
}

/** A class's students: guardian contact included on request (emails and ids masked by the SDK). */
function studentsOf(classId, n, guardian) {
  return Array.from({ length: n }, (_, i) => ({
    id: `st_${classId}${String(i + 1).padStart(3, '0')}`, studentNo: `2569${String(ioInt(1, 9999)).padStart(4, '0')}`,
    name: `${ioRand() < 0.5 ? 'ด.ช.' : 'ด.ญ.'} ${personName()}`, citizenId: thaiId(), classId,
    ...(guardian ? { guardian: { name: personName(), phone: `08${ioInt(10_000_000, 99_999_999)}`, email: `parent${ioInt(100, 9999)}@gmail.com` } } : {}),
  }))
}

function classStudents(t0, opts = {}) {
  const user = opts.user || pickTeacher()
  const id = opts.id || int(1000, 1999)
  const cancelled = !!opts.cancelled
  const studentDur = opts.studentDur ?? (cancelled ? 3000 + between(2, 9) : skew(1080, 2560, 1.35))
  const dur = opts.dur ?? studentDur + between(25, 60)
  // Trace B asks for the whole class with guardians: the answer passes 64 KiB and is cut (truncated).
  const all = !!opts.trace
  const students = cancelled ? [] : studentsOf(id, all ? 1250 : ioInt(25, 45), all)
  httpRequest({
    service: CORE, t0, dur, status: cancelled ? 500 : 200, user, method: 'GET', route: '/classes/:id/students', path: `/classes/${id}/students`,
    trace: opts.trace, hostIndex: opts.hostIndex,
    io: {
      query: all ? { limit: 'all', include: 'guardian' } : { page: 1, limit: 50, sort: 'name' }, referer: `/classes/${id}`,
      res: cancelled ? nestError(500, 'Internal server error') : json({ classId: id, page: 1, limit: all ? students.length : 50, total: students.length, items: students }),
      resHeaders: cancelled ? {} : { etag: etag() },
    },
    children: (ctx) => {
      const c0 = t0 + 5
      const cDur = opts.trace ? 16 : between(6, 18)
      oracle(ctx, ctx.handlerId, 'SELECT', 'CLASSROOM', c0, cDur, undefined, { params: [id] })
      const sStart = opts.trace ? t0 + 24 : c0 + cDur + 2
      const e = cancelled
        ? ERR.ora01013('STUDENT', 3000, 'GetClassStudentsHandler.execute', 'src/domain/classroom/get-class-students.handler.ts', 'GetClassStudentsQuery',
            'oracle SELECT STUDENT was cancelled after 3000 ms (callTimeout). Add an index on STUDENT(CLASS_ID) or page GET /classes/:id/students.')
        : undefined
      oracle(ctx, ctx.handlerId, 'SELECT', 'STUDENT', sStart, studentDur, e ? exceptionOf(e) : undefined, {
        stmt: 'SELECT * FROM "STUDENT" WHERE "CLASS_ID" = :1 ORDER BY "NAME"', params: [id],
      })
      if (e) requestLine(ctx, sStart + studentDur + 1, 'error', 'GetClassStudentsHandler', e)
    },
  })
}

function examGet(t0) {
  const user = pickUser()
  const id = int(1, 930)
  const missing = id > 900
  const dbDur = skew(6, 70, 1.6)
  const dur = dbDur + between(6, 26)
  const [subjectId, subject] = ioPick(SUBJECTS)
  httpRequest({
    service: CORE, t0, dur, status: missing ? 404 : 200, user, method: 'GET', route: '/exams/:id', path: `/exams/${id}`,
    io: {
      referer: '/exams',
      res: missing
        ? nestError(404, 'Record not found', 'Not Found')
        : json({ id, title: `สอบกลางภาค ${subject}`, subjectId, durationMin: ioPick([30, 45, 60, 90]), questionCount: ioInt(10, 50), opensAt: isoAt(t0 - DAY), closesAt: isoAt(t0 + 6 * DAY) }),
      resHeaders: missing ? {} : { etag: etag() },
    },
    children: (ctx) => {
      oracle(ctx, ctx.handlerId, 'SELECT', 'EXAM', t0 + 3, dbDur, undefined, { params: [id] })
      // No logger context in the filter: the SDK names the origin class.
      if (missing) requestLine(ctx, t0 + 3 + dbDur + 0.6, 'warn', 'ExamsController', ERR.notFound(id))
    },
  })
}

function examSubmit(t0, opts = {}) {
  const user = pickUser()
  const id = int(1, 900)
  const invalid = !opts.deadlock && chance(0.107)
  const insertDur = opts.deadlock ? between(900, 2600) : skew(18, 120, 1.4)
  const dur = invalid ? between(2, 9) : insertDur + between(12, 40)
  const answers = Array.from({ length: ioInt(5, 12) }, (_, i) => ({ questionId: id * 100 + i + 1, choice: ioPick(['A', 'B', 'C', 'D']) }))
  if (invalid) answers[0].choice = 'E'
  const submittedAt = new Date(t0)
  const status = invalid ? 400 : opts.deadlock ? 500 : 201
  httpRequest({
    service: CORE, t0, dur, status, user, method: 'POST', route: '/exams/:id/submit', path: `/exams/${id}/submit`,
    io: {
      referer: `/exams/${id}`,
      req: json({ answers, startedAt: isoAt(t0 - ioInt(10, 60) * 60_000), clientTime: submittedAt.toISOString() }, 'application/json'),
      res: invalid
        ? nestError(400, ['answers.0.choice must be one of A, B, C, D'], 'Bad Request')
        : opts.deadlock
          ? nestError(500, 'Internal server error')
          : json({ submissionId: ioInt(1_000_000, 9_999_999), examId: id, answered: answers.length, submittedAt: submittedAt.toISOString() }),
    },
    children: (ctx) => {
      if (invalid) {
        requestLine(ctx, t0 + dur - 0.5, 'warn', 'ExamsController', ERR.invalid())
        return
      }
      oracle(ctx, ctx.handlerId, 'SELECT', 'EXAM', t0 + 3, between(4, 10), undefined, { params: [id] })
      const iStart = t0 + 16
      const e = opts.deadlock ? ERR.ora00060() : undefined
      oracle(ctx, ctx.handlerId, 'INSERT', 'EXAM_SUBMISSION', iStart, insertDur, e ? exceptionOf(e) : undefined, {
        stmt: 'INSERT INTO "EXAM_SUBMISSION" ("EXAM_ID", "STUDENT_ID", "ANSWERS", "SUBMITTED_AT") VALUES (:1, :2, :3, :4)',
        params: [id, user.id, JSON.stringify(answers), submittedAt],
      })
      oracle(ctx, ctx.handlerId, e ? 'ROLLBACK' : 'COMMIT', '', iStart + insertDur + 1, between(2, 8))
      if (e) requestLine(ctx, iStart + insertDur + 0.8, 'error', 'SubmitExamHandler', e)
    },
  })
}

function classReport(t0, opts = {}) {
  const user = pickTeacher()
  const id = opts.id || int(100, 999)
  const post = t0 >= DEPLOY
  const broken = opts.broken || (post && id % 10 === 7 && chance(0.25))
  const c1 = between(5, 20)
  const scoreDur = post ? skew(60, 400, 1.5) : skew(50, 290, 1.5)
  const dur = broken ? c1 + between(8, 20) : c1 + scoreDur + between(10, 40)
  const students = ioInt(28, 45)
  httpRequest({
    service: CORE, t0, dur, status: broken ? 500 : 200, user, method: 'GET', route: '/classes/:id/report', path: `/classes/${id}/report`,
    io: {
      query: { term: '2569-1', format: 'json' }, referer: `/classes/${id}`,
      res: broken
        ? nestError(500, 'Internal server error')
        : json({ classId: id, term: '2569-1', students, average: ioInt(520, 860) / 10, distribution: { A: ioInt(2, 9), B: ioInt(5, 12), C: ioInt(5, 12), D: ioInt(1, 6), F: ioInt(0, 3) }, generatedAt: isoAt(t0 + dur) }),
    },
    children: (ctx) => {
      oracle(ctx, ctx.handlerId, 'SELECT', 'CLASSROOM', t0 + 3, c1, undefined, { params: [id] })
      if (broken) {
        requestLine(ctx, t0 + 3 + c1 + 2, 'error', 'GetClassReportHandler', ERR.nullRead())
        return
      }
      oracle(ctx, ctx.handlerId, 'SELECT', 'SCORE', t0 + 5 + c1, scoreDur, undefined, {
        stmt: 'SELECT "STUDENT_ID", "SCORE", "GRADE" FROM "SCORE" WHERE "CLASS_ID" = :classId AND "TERM" = :term',
        params: { classId: id, term: '2569-1' },
      })
    },
  })
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** A question title `n` characters long (ORA-12899 shows the 312-character one). */
const longTitle = (n) => 'แบบฝึกหัดคณิตศาสตร์ ม.2 เรื่องสมการเชิงเส้นตัวแปรเดียว พร้อมเฉลยละเอียดทุกข้อ และโจทย์ประยุกต์ '.repeat(8).slice(0, n)

/** POST /question-bank/import → school-etl-api POST /etl/parse-excel → oracle (13 spans, like trace A). */
function questionBankImport(t0, opts = {}) {
  const fixed = opts.trace === TRACE_A
  const fail = !!opts.fail
  const user = opts.user || pickTeacher()
  const rows = fixed ? 120 : int(40, 400)
  const actual = opts.actual || int(256, 420)
  let T
  if (fixed) {
    T = { redisS: 6, redisE: 8, httpS: 12, etlS: 16, etlHS: 17, s3S: 22, s3E: 305, parseS: 308, parseE: 1302, etlHE: 1317, etlE: 1318, httpE: 1322,
      sel1S: 1330, sel1E: 1362, sel2S: 1365, sel2E: 1381, insS: 1390, insE: 1812, endS: 1815, endE: 1826, respS: 1828, respE: 1840, end: 1842 }
  } else {
    T = {}
    T.redisS = between(3, 7); T.redisE = T.redisS + between(1, 3)
    T.httpS = T.redisE + between(2, 6); T.etlS = T.httpS + between(2, 5); T.etlHS = T.etlS + 1
    T.s3S = T.etlHS + between(3, 6); T.s3E = T.s3S + between(110, 380)
    T.parseS = T.s3E + between(2, 4); T.parseE = T.parseS + 180 + rows * between(1.4, 3.2)
    T.etlHE = T.parseE + between(10, 16); T.etlE = T.etlHE + 1; T.httpE = T.etlE + between(2, 5)
    T.sel1S = T.httpE + between(5, 10); T.sel1E = T.sel1S + between(15, 40)
    T.sel2S = T.sel1E + between(2, 4); T.sel2E = T.sel2S + between(8, 20)
    T.insS = T.sel2E + between(6, 10); T.insE = T.insS + (fail ? between(150, 450) : 50 + rows * between(0.4, 1.1))
    T.endS = T.insE + between(2, 4); T.endE = T.endS + between(6, 14)
    T.respS = T.endE + 2; T.respE = T.respS + between(8, 14); T.end = T.respE + 2
  }
  const e = fail ? ERR.ora12899(actual) : undefined
  const etlR = res(ETL, 'api', t0)
  const [subjectId] = fixed ? SUBJECTS[0] : ioPick(SUBJECTS)
  const filename = `question-bank-${user.school}-${ioInt(1, 60)}.xlsx`
  const fileSize = 9000 + rows * ioInt(260, 420)
  // fields with their values, the way the SDK stores a multipart summary ({ fields: { name: value }, files })
  const upload = multipart({ subjectId, overwrite: 'false' }, [{ name: 'file', filename, type: XLSX, size: fileSize }])
  // The file as school-core-api forwards it (form-data's boundary): what school-etl-api receives.
  const forwarded = multipart({ subjectId }, [{ name: 'file', filename, type: XLSX, size: fileSize }], `--------------------------${String(ioInt(1e11, 9e11))}${String(ioInt(1e11, 9e11))}`)
  const columns = ['title', 'choiceA', 'choiceB', 'choiceC', 'choiceD', 'answer', 'score']
  const parsed = json({
    rows, sheets: 1, columns,
    preview: [
      { row: 2, title: fail ? `${longTitle(40)}…` : 'จงหาค่า x จากสมการ 2x + 5 = 17', choiceA: '4', choiceB: '6', choiceC: '8', choiceD: '11', answer: 'B', score: 1 },
      { row: 3, title: 'ข้อใดเป็นสมการเชิงเส้นตัวแปรเดียว', choiceA: 'x² = 4', choiceB: '3x - 1 = 8', choiceC: 'xy = 2', choiceD: '1/x = 3', answer: 'B', score: 1 },
    ],
    warnings: fail ? [`row ${ioInt(4, rows)}: title has ${actual} characters`] : [],
  })
  const callHeaders = clientHeaders('', 'axios/1.7.7', { authorization: `Bearer ${fakeJwt('svc:school-core-api')}`, 'x-demo-user': user.id })
  httpRequest({
    service: CORE, t0, dur: T.end, status: fail ? 500 : 201, user, method: 'POST', route: '/question-bank/import', path: '/question-bank/import',
    trace: opts.trace, handlerLead: 2, handlerDur: T.end - 4,
    io: {
      referer: '/question-bank/import', req: upload,
      res: fail ? nestError(500, 'Internal server error') : json({ batchId: `qb_${ioHex(10)}`, subjectId, imported: rows, skipped: 0 }),
    },
    children: (ctx) => {
      const at0 = (ms) => t0 + ms
      const usecaseCols = { trace_id: ctx.trace, span_id: ctx.handlerId, correlation_id: ctx.trace, ...userCols(user), usecase: 'ImportQuestionBankCommand',
        http_method: 'POST', http_route: '/question-bank/import', url_path: '/question-bank/import' }
      // The file number was drawn here before the upload was captured; still drawn, so the rest of the seed stays the same.
      void int(1, 60)
      logLine(at0(2), ctx.r, 'info', 'app.log', 'ImportQuestionBankHandler', 'Importing question bank file', {
        ...usecaseCols, fields: { 'file.name': filename },
      })
      redisCall(ctx, ctx.handlerId, 'GET', `qb:import-lock:${user.school}`, at0(T.redisS), T.redisE - T.redisS, REDIS_CACHE)
      const headersOf = (spanId) => ({ host: 'school-etl-api:5102', ...callHeaders(spanId), traceparent: `00-${ctx.trace}-${spanId}-01` })
      // What school-etl-api answers is what the client span received.
      const etlResHeaders = serverHeaders(ctx.trace, at0(T.etlE))
      const clientId = httpClient(ctx, ctx.handlerId, 'POST', 'school-etl-api', 5102, '/etl/parse-excel', at0(T.httpS), T.httpE - T.httpS, 200, undefined,
        { reqHeaders: headersOf, req: forwarded, resHeaders: etlResHeaders, res: parsed })
      // school-etl-api side, same trace, remote parent = the http client span.
      httpRequest({
        r: etlR, trace: ctx.trace, parent: clientId, t0: at0(T.etlS), dur: T.etlE - T.etlS, status: 200, user,
        method: 'POST', route: '/etl/parse-excel', path: '/etl/parse-excel', handlerLead: 1, handlerDur: T.etlHE - T.etlHS,
        userAgent: 'axios/1.7.7',
        io: { callerHeaders: headersOf(clientId), req: forwarded, res: parsed, resHeaders: etlResHeaders },
        children: (etl) => {
          s3(etl, etl.handlerId, 'GetObject', 'demo-imports-prod', at0(T.s3S), T.s3E - T.s3S, undefined,
            { key: `imports/${user.school}/${filename}`, res: binary(fileSize, XLSX) })
          addSpan(etl.trace, etl.r, { name: 'parse-excel', kind: 'INTERNAL', start: at0(T.parseS), dur: T.parseE - T.parseS, parent: etl.handlerId,
            scope: 'school-etl-api', attrs: { 'excel.rows': rows, 'excel.sheets': 1 } })
          logLine(at0(T.etlHE), etl.r, 'info', 'app.log', 'ParseExcelService', 'Parsed excel', {
            trace_id: etl.trace, span_id: etl.handlerId, correlation_id: etl.trace, ...userCols(user),
            http_method: 'POST', http_route: '/etl/parse-excel', url_path: '/etl/parse-excel', fields: { rows: String(rows) },
          })
        },
      })
      oracle(ctx, ctx.handlerId, 'SELECT', 'QUESTION_BANK', at0(T.sel1S), T.sel1E - T.sel1S, undefined, {
        stmt: 'SELECT COUNT(*) FROM "QUESTION_BANK" WHERE "SUBJECT_ID" = :1 AND "OWNER_ID" = :2', params: [subjectId, user.id],
      })
      oracle(ctx, ctx.handlerId, 'SELECT', 'SUBJECT', at0(T.sel2S), T.sel2E - T.sel2S, undefined, { params: [subjectId] })
      // The batch's first bind row, or the row Oracle rejected (its 312-character title).
      oracle(ctx, ctx.handlerId, 'INSERT', 'QUESTION_BANK', at0(T.insS), T.insE - T.insS, e ? exceptionOf(e) : undefined, {
        stmt: 'INSERT INTO "QUESTION_BANK" ("ID", "TITLE", "SUBJECT_ID", "CREATED_BY", "CREATED_AT") VALUES (:1, :2, :3, :4, :5)',
        params: [ioInt(100_000, 999_999), fail ? longTitle(actual) : 'จงหาค่า x จากสมการ 2x + 5 = 17', subjectId, emailOf(user), new Date(at0(T.insS))],
      })
      oracle(ctx, ctx.handlerId, fail ? 'ROLLBACK' : 'COMMIT', '', at0(T.endS), T.endE - T.endS)
      addSpan(ctx.trace, ctx.r, { name: 'POST /question-bank/import response write', kind: 'INTERNAL', start: at0(T.respS), dur: T.respE - T.respS,
        parent: ctx.handlerId, scope: SCOPE_EXPRESS })
      if (fail) {
        requestLine(ctx, at0(T.insE + 2), 'error', 'ImportQuestionBankHandler', e)
      } else {
        logLine(at0(T.endE), ctx.r, 'info', 'app.log', 'ImportQuestionBankHandler', 'Question bank imported', {
          ...usecaseCols, fields: { rows: String(rows) },
        })
      }
    },
  })
}

/**
 * POST /reports/:id/generate (202) + its BullMQ report:generate attempts on the worker,
 * all in the request's trace. plan: per attempt 'ok' | '429' | '429long'.
 */
function reportGenerate(t0, plan, jobId, opts = {}) {
  const user = opts.user || pickTeacher()
  const reportId = int(1000, 9999)
  const evalDur = between(0.8, 2.6)
  const dur = opts.trace ? 48 : skew(14, 66, 1.3)
  const data = { reportId, classId: ioInt(1000, 1999), term: '2569-1', format: 'xlsx', requestedBy: user.id, notifyEmail: emailOf(user) }
  const job = { data, queuedAt: t0 + 4 + evalDur }
  httpRequest({
    service: CORE, t0, dur, status: 202, user, method: 'POST', route: '/reports/:id/generate', path: `/reports/${reportId}/generate`,
    trace: opts.trace,
    io: {
      referer: `/reports/${reportId}`,
      req: json({ format: 'xlsx', term: '2569-1', notify: { email: emailOf(user) } }, 'application/json'),
      res: json({ jobId: String(jobId), queue: 'report', status: 'queued' }),
    },
    children: (ctx) => {
      // BullMQ's addJob script: keys, then the job name, data and options (the SDK masks the e-mail in it).
      const keys = ['wait', 'paused', 'meta', 'id', 'delayed', 'prioritized', 'events', 'marker'].map((k) => `bull:report:${k}`)
      redisCall(ctx, ctx.handlerId, 'EVALSHA', ioHex(40), t0 + 4, evalDur, REDIS_QUEUE, undefined,
        ['8', ...keys, 'bull:report:', String(jobId), 'report:generate', String(Math.floor(job.queuedAt)), JSON.stringify(data), '{"attempts":3,"backoff":{"type":"exponential","delay":1000}}'])
      let start = t0 + dur + between(8, 30)
      plan.forEach((outcome, i) => {
        const attempt = i + 1
        const end = reportAttempt(ctx, start, attempt, 3, outcome, jobId, job)
        start = end + 1000 * Math.pow(2, i) + between(5, 40)
      })
    },
  })
}

/** One report:generate attempt as the SDK's BullMQ wrapper logs it (logger Queue:report, no user on the worker). */
function reportAttempt(reqCtx, start, attempt, maxAttempts, outcome, jobId, job) {
  const r = res(CORE, 'worker', start)
  const dur = outcome === 'ok' ? between(1000, 4400) : outcome === '429long' ? 10_040 : between(400, 1500)
  const ok = outcome === 'ok'
  const final = !ok && attempt >= maxAttempts
  const e = ok ? undefined : ERR.google429()
  const ctx = { trace: reqCtx.trace, r }
  const consumerId = addSpan(ctx.trace, r, {
    name: 'report report:generate', kind: 'CONSUMER', start, dur, parent: reqCtx.handlerId, remote: true, scope: SCOPE_JOB,
    exception: e ? exceptionOf(e) : undefined,
    attrs: jobSpanAttrs('bullmq', 'report', 'report:generate', String(jobId), attempt, maxAttempts),
    io: {
      msg: {
        body: job.data,
        headers: { name: 'report:generate', attempts: '3', backoff: '{"type":"exponential","delay":1000}', attemptsMade: String(attempt - 1), timestamp: String(Math.floor(job.queuedAt)) },
      },
    },
  })
  const scoreDur = between(80, Math.min(600, dur * 0.3))
  oracle(ctx, consumerId, 'SELECT', 'SCORE', start + 3, scoreDur, undefined, {
    stmt: 'SELECT "STUDENT_ID", "SCORE", "GRADE" FROM "SCORE" WHERE "CLASS_ID" = :classId AND "TERM" = :term',
    params: { classId: job.data.classId, term: job.data.term },
  })
  const exportStart = start + 5 + scoreDur
  const exportDur = dur - (exportStart - start) - 3
  const exportId = addSpan(ctx.trace, r, { name: 'GoogleSheetsService.exportReport', kind: 'INTERNAL', start: exportStart, dur: exportDur,
    parent: consumerId, scope: 'school-core-api', exception: e ? exceptionOf(e) : undefined })
  const rowsOut = ioInt(28, 45)
  httpClient(ctx, exportId, 'POST', 'sheets.googleapis.com', 443, '/v4/spreadsheets/1x9Qd/values:batchUpdate', exportStart + 2, exportDur - 4,
    ok ? 200 : 429, e ? exceptionOf(e) : undefined, {
      reqHeaders: clientHeaders(ctx.trace, 'google-api-nodejs-client/7.2.0 (gzip)', {
        authorization: `Bearer ya29.${ioHex(60)}`, 'x-goog-api-client': 'gdcl/7.2.0 gl-node/20.19.6', 'content-type': 'application/json',
      }),
      req: json({
        valueInputOption: 'RAW',
        data: [{ range: `Report!A1:F${rowsOut + 1}`, values: [['รหัสนักเรียน', 'ชื่อ', 'คะแนนเก็บ', 'สอบกลางภาค', 'สอบปลายภาค', 'เกรด'], ['25690412', personName(), 28, 24, 31, 'B+'], ['25690413', personName(), 30, 27, 35, 'A']] }],
      }, 'application/json'),
      resHeaders: { 'content-type': 'application/json; charset=UTF-8', vary: 'Origin, X-Origin, Referer', server: 'ESF', ...(ok ? {} : { 'retry-after': '30' }) },
      res: ok
        ? json({ spreadsheetId: '1x9Qd', totalUpdatedRows: rowsOut + 1, totalUpdatedColumns: 6, totalUpdatedCells: (rowsOut + 1) * 6 }, 'application/json; charset=UTF-8')
        : json({ error: { code: 429, message: e.error_message, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com' }] } }, 'application/json; charset=UTF-8'),
    })
  const jobCols = {
    trace_id: ctx.trace, span_id: consumerId, event_module: 'bullmq',
    job_queue: 'report', job_type: 'report:generate', job_id: String(jobId), job_attempt: attempt, job_max_attempts: maxAttempts,
  }
  logLine(start + 0.4, r, 'info', 'job.started', 'Queue:report', 'Job started', jobCols)
  if (ok) {
    logLine(start + dur, r, 'info', 'job.finished', 'Queue:report', 'Job finished', { ...jobCols, duration_ms: round3(dur) })
  } else {
    logLine(start + dur, r, final ? 'error' : 'warn', final ? 'job.failed' : 'job.retry', 'Queue:report',
      final ? 'Job failed' : 'Job failed and will be retried', { ...jobCols, ...e, job_final: final ? 1 : 0, duration_ms: round3(dur) })
  }
  return start + dur
}

// ---------------------------------------------------------------- other services
function etlOwn(t0) {
  const user = pickTeacher()
  if (chance(0.68)) {
    const name = pick(['question-bank', 'students', 'scores', 'attendance'])
    const dur = between(8, 38)
    const size = ioInt(9_000, 24_000)
    httpRequest({ service: ETL, t0, dur, status: 200, user, method: 'GET', route: '/etl/templates/:name', path: `/etl/templates/${name}`,
      io: {
        referer: '/imports', res: binary(size, XLSX),
        resHeaders: { 'content-disposition': `attachment; filename="${name}-template.xlsx"`, 'cache-control': 'public, max-age=3600' },
      },
      children: (ctx) => s3(ctx, ctx.handlerId, 'GetObject', 'skilllane-monitoring-templates-prod', t0 + 3, dur - 6, undefined,
        { key: `templates/${name}-template.xlsx`, res: binary(size, XLSX) }) })
    return
  }
  const rows = int(50, 900)
  const s3Dur = between(80, 300)
  const parseDur = 150 + rows * between(1.0, 1.9)
  const dur = s3Dur + parseDur + between(10, 30)
  const fileKey = `imports/${user.school}/students-2569-${ioInt(1, 40)}.csv`
  httpRequest({
    service: ETL, t0, dur, status: 200, user, method: 'POST', route: '/etl/parse-csv', path: '/etl/parse-csv',
    io: {
      referer: '/imports',
      req: json({ fileKey, delimiter: ',', hasHeader: true, encoding: 'utf-8' }, 'application/json'),
      res: json({ rows, columns: ['studentNo', 'name', 'classId', 'citizenId'], errors: [], sample: { studentNo: '25690412', name: personName(), classId: ioInt(1000, 1999), citizenId: thaiId() } }),
    },
    children: (ctx) => {
      s3(ctx, ctx.handlerId, 'GetObject', 'demo-imports-prod', t0 + 4, s3Dur, undefined, { key: fileKey, res: binary(rows * ioInt(60, 90), 'text/csv') })
      addSpan(ctx.trace, ctx.r, { name: 'parse-csv', kind: 'INTERNAL', start: t0 + 6 + s3Dur, dur: parseDur, parent: ctx.handlerId, scope: 'school-etl-api',
        attrs: { 'csv.rows': rows } })
      logLine(t0 + 6 + s3Dur + parseDur, ctx.r, 'info', 'app.log', 'ParseCsvService', 'Parsed csv', {
        trace_id: ctx.trace, span_id: ctx.handlerId, correlation_id: ctx.trace, ...userCols(user),
        http_method: 'POST', http_route: '/etl/parse-csv', url_path: '/etl/parse-csv', fields: { rows: String(rows) },
      })
    },
  })
}

const m3u8 = (id) =>
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', `${id}/360p/index.m3u8`,
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720', `${id}/720p/index.m3u8`].join('\n')

function video(t0) {
  const user = pickUser()
  const id = `v_${int(10000, 99999)}`
  const x = rand()
  if (x < 0.6) {
    const dur = skew(6, 42, 1.6)
    const manifest = m3u8(id)
    return httpRequest({ service: VIDEO, t0, dur, status: 200, user, method: 'GET', route: '/videos/:id/manifest', path: `/videos/${id}/manifest`,
      io: { referer: `/lessons/${id}`, res: textBody(manifest, 'application/vnd.apple.mpegurl'), resHeaders: { 'cache-control': 'public, max-age=60' } },
      children: (ctx) => s3(ctx, ctx.handlerId, 'GetObject', 'demo-video-prod', t0 + 2, dur * 0.7, undefined,
        { key: `hls/${id}/master.m3u8`, res: textBody(manifest, 'application/vnd.apple.mpegurl') }) })
  }
  if (x < 0.85) {
    const dur = skew(9, 70, 1.5)
    const size = ioInt(18_000, 64_000)
    return httpRequest({ service: VIDEO, t0, dur, status: 200, user, method: 'GET', route: '/videos/:id/thumbnail', path: `/videos/${id}/thumbnail`,
      io: { query: { w: 480 }, referer: `/lessons/${id}`, res: binary(size, 'image/jpeg'), resHeaders: { 'cache-control': 'public, max-age=86400' } },
      children: (ctx) => s3(ctx, ctx.handlerId, 'GetObject', 'demo-video-prod', t0 + 2, dur * 0.75, undefined,
        { key: `thumbs/${id}.jpg`, res: binary(size, 'image/jpeg') }) })
  }
  if (x < 0.95) {
    const dur = between(25, 98)
    const file = `lesson-${String(ioInt(1, 40)).padStart(2, '0')}.mp4`
    return httpRequest({ service: VIDEO, t0, dur, status: 201, user, method: 'POST', route: '/videos/upload-url', path: '/videos/upload-url',
      io: {
        referer: '/lessons/new',
        req: json({ filename: file, contentType: 'video/mp4', size: ioInt(40, 900) * 1_048_576 }, 'application/json'),
        res: json({
          videoId: id, expiresIn: 900,
          uploadUrl: `https://demo-video-prod.s3.ap-southeast-1.amazonaws.com/uploads/${id}/${file}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Security-Token=IQoJb3JpZ2luX2VjE${ioHex(24)}&X-Amz-SignedHeaders=host`,
        }),
      } })
  }
  const throttled = chance(0.02)
  const dur = throttled ? between(380, 900) : skew(55, 210, 1.4)
  httpRequest({
    service: VIDEO, t0, dur, status: throttled ? 500 : 202, user, method: 'POST', route: '/videos/:id/transcode', path: `/videos/${id}/transcode`,
    io: {
      referer: `/lessons/${id}`,
      req: json({ preset: ioPick(['hls-720p', 'hls-1080p']), source: `uploads/${id}/lesson.mp4` }, 'application/json'),
      res: throttled ? nestError(500, 'Internal server error') : json({ jobId: `tr_${ioHex(12)}`, status: 'queued' }),
    },
    children: (ctx) => {
      const e = throttled ? ERR.s3SlowDown() : undefined
      s3(ctx, ctx.handlerId, 'PutObject', 'demo-video-prod', t0 + 4, dur - 12, e ? exceptionOf(e) : undefined, {
        key: `jobs/${id}/transcode.json`, status: throttled ? 503 : 200,
        req: json({ videoId: id, preset: 'hls-720p', requestedBy: user.id }, 'application/json'),
        res: throttled
          ? textBody(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>${ioHex(16).toUpperCase()}</RequestId></Error>`, 'application/xml')
          : undefined,
      })
      if (e) requestLine(ctx, t0 + dur - 4, 'error', 'TranscodeService', e)
    },
  })
}

/** The job span attributes the SDK's runJob sets (skilllane-monitoring/packages/monitoring/src/jobs/run-job.ts); /api/traces reads job.*. */
function jobSpanAttrs(module, queue, type, id, attempt, maxAttempts) {
  return {
    'event.module': module, 'job.queue': queue, 'job.type': type, 'job.id': id || undefined,
    'job.attempt': attempt || undefined, 'job.max_attempts': maxAttempts || undefined,
  }
}

/** A queue / cron job that starts its own trace (no producer span). o.msg: { body, headers } of the message / job. */
function rootJob(o) {
  const trace = hex(32)
  const r = res(CORE, o.role || 'worker', o.start)
  const ctx = { trace, r }
  const e = o.error
  const consumerId = addSpan(trace, r, {
    name: `${o.queue} ${o.type}`, kind: o.module === 'cron' ? 'INTERNAL' : 'CONSUMER', start: o.start, dur: o.dur, scope: SCOPE_JOB,
    exception: e ? exceptionOf(e) : undefined,
    attrs: jobSpanAttrs(o.module, o.queue, o.type, o.id, o.attempt, o.maxAttempts),
    io: o.msg ? { msg: o.msg } : undefined,
  })
  if (o.children) o.children(ctx, consumerId)
  const jobCols = {
    trace_id: trace, span_id: consumerId, event_module: o.module, job_queue: o.queue, job_type: o.type, job_id: o.id || '',
    job_attempt: o.attempt || 0, job_max_attempts: o.maxAttempts || 0,
  }
  if (o.redelivered) {
    logLine(o.start - 2, r, 'warn', 'job.redelivered', o.logger, 'Message redelivered', { ...jobCols, reason: 'consumer_restarted' })
  }
  logLine(o.start + 0.3, r, 'info', 'job.started', o.logger, 'Job started', jobCols)
  if (e) {
    logLine(o.start + o.dur, r, 'error', 'job.failed', o.logger, e.error_message, { ...jobCols, ...e, job_final: 1, duration_ms: round3(o.dur) })
  } else {
    logLine(o.start + o.dur, r, 'info', 'job.finished', o.logger, 'Job finished', { ...jobCols, duration_ms: round3(o.dur) })
  }
}

const bullHeaders = (name, attempts, t) => ({ name, attempts: String(attempts), attemptsMade: '0', timestamp: String(Math.floor(t - ioInt(20, 900))) })

function notificationJob(t, n) {
  const dur = between(30, 330)
  const u = USERS[ioInt(0, USERS.length - 1)]
  const note = { title: 'ประกาศคะแนนสอบกลางภาค', body: `คะแนนวิชา${ioPick(SUBJECTS)[1]} ออกแล้ว` }
  const deviceToken = `${ioHex(22)}:APA91b${ioHex(60)}`
  rootJob({ module: 'bullmq', queue: 'notification', type: 'notification:send', id: String(510000 + n), attempt: 1, maxAttempts: 3,
    start: t, dur, logger: 'NotificationProcessor',
    msg: { body: { userId: u.id, channel: 'push', deviceToken, ...note }, headers: bullHeaders('notification:send', 3, t) },
    children: (ctx, parent) => httpClient(ctx, parent, 'POST', 'fcm.googleapis.com', 443, '/v1/projects/demo-prod/messages:send', t + 3, dur - 8, 200, undefined, {
      reqHeaders: clientHeaders(ctx.trace, 'google-api-nodejs-client/7.2.0 (gzip)', { authorization: `Bearer ya29.${ioHex(60)}`, 'content-type': 'application/json' }),
      req: json({ message: { token: deviceToken, notification: note, data: { userId: u.id, kind: 'score' } } }, 'application/json'),
      resHeaders: { 'content-type': 'application/json; charset=UTF-8', server: 'ESF' },
      res: json({ name: `projects/demo-prod/messages/0:${Math.floor(t)}%${ioHex(16)}` }, 'application/json; charset=UTF-8'),
    }) })
}

function exportJob(t, n, fail) {
  const dur = fail ? 30_000 + between(5, 40) : between(3000, 13_200)
  const e = fail
    ? ERR.ora01013('SCORE', 30_000, 'ExportClassScoreService.build', 'src/domain/export/export-class-score.service.ts', '',
        'oracle SELECT SCORE was cancelled after 30000 ms (callTimeout). Export the class in pages, or add an index on SCORE(CLASS_ID).')
    : undefined
  const classId = ioInt(1000, 1999)
  const u = USERS[ioInt(0, 40)]
  rootJob({ module: 'bullmq', queue: 'export', type: 'export:class-score', id: String(7200 + n), attempt: 1, maxAttempts: 1, start: t, dur,
    logger: 'ExportProcessor', error: e,
    msg: { body: { classId, term: '2569-1', format: 'csv', requestedBy: u.id, notifyEmail: emailOf(u) }, headers: bullHeaders('export:class-score', 1, t) },
    children: (ctx, parent) => {
      const q = fail ? dur - 10 : dur * between(0.55, 0.8)
      oracle(ctx, parent, 'SELECT', 'SCORE', t + 4, q, e ? exceptionOf(e) : undefined, {
        stmt: 'SELECT * FROM "SCORE" WHERE "CLASS_ID" = :1 ORDER BY "STUDENT_ID"', params: [classId],
      })
      if (!fail) {
        s3(ctx, parent, 'PutObject', 'skilllane-monitoring-exports-prod', t + 8 + q, dur - q - 14, undefined,
          { key: `exports/${classId}/score-2569-1.csv`, req: binary(ioInt(4_000, 40_000), 'text/csv') })
      }
    } })
}

function persisterMessage(t, n) {
  const dur = between(4, 40)
  const partition = n % 3
  const event = { eventId: ioHex(24), type: 'score.recorded', studentId: `st_${ioInt(100_000, 199_999)}`, examId: ioInt(1, 900), score: ioInt(0, 100), recordedAt: isoAt(t - ioInt(5, 900)) }
  rootJob({ module: 'kafka', role: 'persister', queue: 'school.events.score', type: 'score.recorded',
    id: `${partition}-${418000 + Math.floor(n / 3)}`, start: t, dur, logger: 'kafka:school.events.score',
    msg: { body: event, headers: { 'content-type': 'application/json', 'event-type': 'score.recorded', producer: 'school-exam-service' } },
    children: (ctx, parent) => oracle(ctx, parent, 'MERGE', 'SCORE', t + 1.5, dur * 0.7, undefined, { params: [event.examId, event.score] }) })
}

function lmsSync(t, n, redelivered) {
  const dur = between(20, 160)
  const courseId = ioInt(100, 4000)
  rootJob({ module: 'rabbitmq', queue: 'lms.sync', type: 'lms.course.updated', id: `amq-${pad(93000 + n, 6)}`, start: t, dur,
    logger: 'LmsSyncConsumer', redelivered,
    msg: {
      body: { courseId, lmsId: `crs_${ioHex(8)}`, title: `${ioPick(SUBJECTS)[1]} ภาคเรียนที่ 1/2569`, updatedAt: isoAt(t - ioInt(1, 60) * 1000), updatedBy: `teacher${ioInt(1, 400)}@skilllane_monitoring.ac.th` },
      headers: { 'content-type': 'application/json', 'x-delivery-count': redelivered ? '2' : '1', 'x-lms-event': 'course.updated' },
    },
    children: (ctx, parent) => oracle(ctx, parent, 'UPDATE', 'COURSE', t + 2, dur * 0.6, undefined, { params: [new Date(t), courseId] }) })
}

function cronRun(t, name, fail) {
  const e = fail ? ERR.attendanceTimeout() : undefined
  const dur = fail ? 30_000 + between(20, 80) : name.startsWith('Report') ? between(180, 900) : between(1800, 6200)
  const since = isoAt(Math.floor((t - 15 * 60_000) / 60_000) * 60_000)
  rootJob({ module: 'cron', queue: 'cron', type: name, start: t, dur, logger: 'tracked', error: e,
    children: (ctx, parent) => {
      if (name.startsWith('Report')) oracle(ctx, parent, 'DELETE', 'REPORT_FILE', t + 3, dur - 10, undefined, { params: [new Date(t - 30 * DAY)] })
      else {
        httpClient(ctx, parent, 'GET', 'attendance-api.example.internal', 8080, '/v1/attendance/changes', t + 4, dur - 12, fail ? 0 : 200,
          e ? exceptionOf(e) : undefined, {
            query: { since, limit: 500 },
            reqHeaders: clientHeaders(ctx.trace, 'axios/1.7.7', { 'x-api-key': `att_${ioHex(32)}` }),
            ...(fail
              ? {}
              : {
                  resHeaders: { 'content-type': 'application/json; charset=utf-8', 'x-total-count': '3' },
                  res: json({ since, changes: Array.from({ length: 3 }, () => ({ studentId: `st_${ioInt(100_000, 199_999)}`, date: since.slice(0, 10), status: ioPick(['present', 'late', 'absent']) })), next: null }),
                }),
          })
      }
    } })
}

// ---------------------------------------------------------------- events: deploy, outage, rebalance
function deployEvents() {
  for (const role of ['api', 'worker', 'persister']) {
    const n = HOSTS[`${CORE}/${role}`].old.length
    for (let i = 0; i < n; i++) {
      const old = res(CORE, role, DEPLOY - 1, i)
      logLine(DEPLOY - between(4000, 12_000), old, 'info', 'app.shutdown', 'skilllane-monitoring', 'Application shutting down', { fields: { signal: 'SIGTERM' } })
      const neu = res(CORE, role, DEPLOY + 1, i)
      const started = DEPLOY + between(18_000, 45_000)
      // The SDK writes one dependency.up (reason connected) per watched dependency at start:
      // the app's Redis as 'redis' (no affects), the BullMQ connection as 'queue'.
      if (role !== 'worker') connected(started - between(400, 1500), neu, 'redis', REDIS_CACHE)
      if (role !== 'persister') {
        connected(started - between(300, 1200), neu, 'queue', REDIS_QUEUE, '["queue:report","queue:notification","queue:export"]', 'bullmq')
      }
      logLine(started, neu, 'info', 'app.started', 'skilllane-monitoring', 'Application started', {
        duration_ms: round3(between(2100, 3400)),
        ...(role === 'api' ? { fields: { 'server.port': '5101' } } : {}),
      })
    }
  }
}

function connected(t, r, name, target, affects, module) {
  logLine(t, r, 'info', 'dependency.up', `dependency:${name}`, 'Dependency connected', {
    dependency_type: 'redis', dependency_name: name, dependency_host: target.host, dependency_port: target.port,
    reason: 'connected', ...(module ? { event_module: module } : {}), fields: affects ? { 'dependency.affects': affects } : {},
  })
}

/** The app's Redis (dependency 'redis') down 45 s, as scripts/chaos-redis.sh makes the live apps log it. */
function cacheOutage() {
  const affected = [res(CORE, 'api', OUTAGE_START, 0), res(CORE, 'api', OUTAGE_START, 1), res(CORE, 'persister', OUTAGE_START, 0)]
  const dep = { dependency_type: 'redis', dependency_name: 'redis', dependency_host: REDIS_CACHE.host, dependency_port: REDIS_CACHE.port }
  affected.forEach((r, i) => {
    const down = OUTAGE_START + i * 140 + between(0, 90)
    const up = OUTAGE_END + i * 60 + between(0, 50)
    logLine(down, r, 'error', 'dependency.down', 'dependency:redis', 'Dependency is down', {
      ...dep, ...ERR.redisDown(REDIS_CACHE), fields: { 'dependency.attempt': '1' },
    })
    logLine(down + 30_000, r, 'warn', 'dependency.still_down', 'dependency:redis', 'Dependency is still down', {
      ...dep, duration_ms: 30_000, fields: { 'dependency.attempt': String(int(14, 19)) },
    })
    logLine(up, r, 'info', 'dependency.up', 'dependency:redis', 'Dependency is back up', {
      ...dep, duration_ms: round3(up - down), reason: 'recovered', fields: { 'dependency.attempt': String(int(20, 25)) },
    })
  })
}

function rebalance() {
  const t = at('13:05:00') + between(0, 900)
  const r = res(CORE, 'persister', t, 0)
  const cols = { event_module: 'kafka', job_queue: 'school.events.score', fields: { 'consumer.group': 'school-core-persister', partitions: '[0,1,2]' } }
  logLine(t, r, 'warn', 'consumer.rebalancing', 'kafka:school-core-persister', 'Kafka consumer group is rebalancing', cols)
  logLine(t + 3200, r, 'info', 'consumer.joined', 'kafka:school-core-persister', 'Kafka consumer joined group', cols)
}

// ---------------------------------------------------------------- generate
/** n random times in the day, as a sorted array. */
const times = (n, sample = inDay) => Array.from({ length: n }, sample).sort((a, b) => a - b)
/** k distinct random indices below n. */
function indices(n, k) {
  const out = new Set()
  while (out.size < Math.min(k, n)) out.add(int(0, n - 1))
  return out
}
/** The steady error groups (not the deploy's) also occur in 31.3.2, so they are not "new since deploy". */
function withOneBeforeDeploy(list, chosen) {
  if ([...chosen].some((i) => list[i] < DEPLOY)) return chosen
  const before = list.findIndex((t) => t >= DEPLOY)
  if (before <= 0) return chosen
  const out = new Set(chosen)
  out.delete([...out][0])
  out.add(int(0, before - 1))
  return out
}
const nearestOf = (list, target) => list.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), list[0])

function generate() {
  // school-core-api / api: the brief's per-hour mix x24, scaled to 1/40.
  for (const t of times(8526)) questionBankMy(t)
  for (const t of times(7680)) me(t)
  const studentTimes = times(5922)
  const cancelled = withOneBeforeDeploy(studentTimes, indices(studentTimes.length, 12))
  studentTimes.forEach((t, i) => classStudents(t, { cancelled: cancelled.has(i) }))
  for (const t of times(5364)) examGet(t)
  const submitTimes = times(3672)
  const deadlocks = withOneBeforeDeploy(submitTimes, indices(submitTimes.length, 4))
  submitTimes.forEach((t, i) => examSubmit(t, { deadlock: deadlocks.has(i) }))
  for (const t of times(2088)) classReport(t)
  classReport(afterDeploy(DEPLOY + 3 * 60_000 + between(0, 20_000)), { broken: true, id: 207 }) // first seen 08:03, right after 31.4.0
  classReport(afterDeploy(at('14:16:10')), { broken: true, id: 1147 }) // last seen 14:16

  // Imports: the day plus a tail back to 16 Oct 09:12 (first seen of ORA-12899).
  const firstImport = at('09:12:00', -1)
  questionBankImport(firstImport, { fail: true, actual: 288 })
  const importTimes = [...times(54, sampler(firstImport + 60_000, START)), ...times(247)]
  for (const t of importTimes) questionBankImport(t, { fail: chance(0.12) })
  questionBankImport(at('14:18:07.412'), { trace: TRACE_A, fail: true, actual: 312, user: USERS[0] })
  classStudents(at('14:11:52.090'), { trace: TRACE_B, user: USERS[0], id: 1180, studentDur: 2430, dur: 2712, hostIndex: 0 })

  // ThaID: 4 rejected calls in the last hour, 14 earlier, all inside GET /me (which still answers 200).
  for (const ago of [52, 31, 17, 6]) me(NOW - ago * 60_000 - between(0, 30_000), { thaid: 'rejected' })
  for (const t of times(14, sampler(START, NOW - HOUR))) me(t, { thaid: 'rejected' })

  // POST /reports/:id/generate + BullMQ report:generate: started 380 · finished 339 · retried 38 · failed 3.
  const reportTimes = times(341, sampler(START, NOW - 3 * 60_000))
  const allFail = indices(reportTimes.length, 3)
  const failOnce = new Set()
  while (failOnce.size < 30) {
    const i = int(0, reportTimes.length - 1)
    if (!allFail.has(i)) failOnce.add(i)
  }
  const traceCTime = NOW - (14 * 60 + 29) * 1000
  const before = reportTimes.filter((t) => t < traceCTime).length
  const jobBase = 88412 - before
  reportTimes.forEach((t, i) => {
    const plan = allFail.has(i) ? ['429', '429', '429'] : failOnce.has(i) ? ['429', 'ok'] : ['ok']
    reportGenerate(t, plan, jobBase + i + (t >= traceCTime ? 1 : 0))
  })
  reportGenerate(traceCTime, ['429', '429long', 'ok'], 88412, { trace: TRACE_C, user: USERS[0] })

  // Other BullMQ queues, Kafka persister, RabbitMQ, cron.
  times(2410).forEach((t, n) => notificationJob(t, n))
  const exportTimes = times(120)
  const exportFail = int(20, 100)
  exportTimes.forEach((t, n) => exportJob(t, n, n === exportFail))
  times(8640).forEach((t, n) => persisterMessage(t, n))
  const lmsTimes = times(856)
  lmsTimes.forEach((t, n) => lmsSync(t, n, false))
  for (let i = 0; i < 4; i++) lmsSync(DEPLOY + 30_000 + i * 220, 900 + i, true) // redelivered after the worker restarted

  const hourly = []
  const quarter = []
  for (let t = Math.ceil(START / (15 * 60_000)) * 15 * 60_000; t < NOW; t += 15 * 60_000) {
    quarter.push(t)
    if (t % HOUR === 0) hourly.push(t)
  }
  const failedSync = nearestOf(quarter, at('11:45:00'))
  for (const t of hourly) cronRun(t + between(5, 300), 'ReportCleanupService.purge', false)
  for (const t of quarter) cronRun(t + between(5, 200), 'AttendanceSyncService.sync', t === failedSync)

  // school-etl-api own traffic; video-transcoder-api.
  for (const t of times(1944)) etlOwn(t)
  for (const t of times(11_160)) video(t)

  deployEvents()
  cacheOutage()
  rebalance()
}

// ---------------------------------------------------------------- reset + insert
async function command(query) {
  await client.command({ query, clickhouse_settings: { mutations_sync: '2' } })
}
async function rows(query) {
  const rs = await client.query({ query, format: 'JSONEachRow', clickhouse_settings: { output_format_json_quote_64bit_integers: 0 } })
  return rs.json()
}

/** Deletes the seeded rows of ENV only, then rebuilds route_stats_1m for the seeded minutes. */
async function reset() {
  const SEED_SPANS = `env = '${ENV}' AND resource['seed'] = '1'`
  const [win] = await rows(
    `SELECT count() AS n, toString(toStartOfMinute(min(timestamp))) AS lo, toString(toStartOfMinute(max(timestamp))) AS hi
     FROM ${DB}.spans WHERE ${SEED_SPANS}`,
  )
  const [logCount] = await rows(`SELECT count() AS n FROM ${DB}.logs WHERE env = '${ENV}' AND labels['seed'] = '1'`)
  if (!win.n && !logCount.n) {
    console.log(`reset: no seeded rows in env ${ENV}`)
    return
  }
  console.log(`reset: deleting ${win.n} seeded spans and ${logCount.n} seeded log lines of env ${ENV}`)
  await command(
    `ALTER TABLE ${DB}.trace_index DELETE WHERE env = '${ENV}' AND trace_id IN (SELECT trace_id FROM ${DB}.spans WHERE ${SEED_SPANS})`,
  )
  await command(`ALTER TABLE ${DB}.spans DELETE WHERE ${SEED_SPANS}`)
  await command(`ALTER TABLE ${DB}.logs DELETE WHERE env = '${ENV}' AND labels['seed'] = '1'`)
  if (win.n) {
    const lo = `toDateTime('${win.lo}', 'UTC')`
    const hi = `toDateTime('${win.hi}', 'UTC')`
    await command(`ALTER TABLE ${DB}.route_stats_1m DELETE WHERE env = '${ENV}' AND minute >= ${lo} AND minute <= ${hi}`)
    // Same SELECT as route_stats_1m_mv in clickhouse/schema.sql, over the spans that remain.
    await client.command({
      query: `INSERT INTO ${DB}.route_stats_1m
        SELECT toStartOfMinute(toDateTime(timestamp)) AS minute, env, service, role, kind,
               if(http_route != '', concat(http_method, ' ', http_route), name) AS route,
               count() AS requests, countIf(status_code = 'ERROR' OR http_status >= 500) AS errors,
               sum(duration_ns / 1e6) AS duration_sum_ms, max(duration_ns / 1e6) AS duration_max_ms,
               quantilesTDigestState(0.5, 0.95, 0.99)(duration_ns / 1e6) AS duration_q
        FROM ${DB}.spans
        WHERE is_entry = 1 AND env = '${ENV}' AND timestamp >= ${lo} AND timestamp < ${hi} + INTERVAL 1 MINUTE
        GROUP BY minute, env, service, role, kind, route`,
    })
  }
}

async function insert(table, values) {
  const CHUNK = 20_000
  for (let i = 0; i < values.length; i += CHUNK) {
    await client.insert({ table: `${DB}.${table}`, values: values.slice(i, i + CHUNK), format: 'JSONEachRow' })
  }
}

const IO_COLUMNS = ['url_query', 'req_headers', 'res_headers', 'req_body', 'res_body', 'db_params', 'msg_body', 'msg_headers']

/** --dry-run: what an insert would write, without ClickHouse. */
function dryRun() {
  const t0 = Date.now()
  generate()
  console.log(`dry run: generated ${SPANS.length} spans and ${LOGS.length} log lines (env ${ENV}, ${fmt3(START)} .. ${fmt3(NOW)} UTC) in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  const byKind = new Map()
  let bytes = 0
  for (const s of SPANS) {
    const key = `${s.kind} ${s.scope_name}`
    const k = byKind.get(key) || { spans: 0, withIo: 0, bytes: 0 }
    const b = IO_COLUMNS.reduce((n, c) => n + (s[c] ? Buffer.byteLength(s[c]) : 0), 0)
    k.spans += 1
    if (b) k.withIo += 1
    k.bytes += b
    bytes += b
    byKind.set(key, k)
  }
  for (const [key, k] of [...byKind].sort((a, b) => b[1].spans - a[1].spans)) {
    console.log(`  ${key.padEnd(52)} ${String(k.spans).padStart(7)} spans, ${String(k.withIo).padStart(7)} with I/O, ${(k.bytes / 1e6).toFixed(1).padStart(6)} MB`)
  }
  console.log(`  captured I/O text: ${(bytes / 1e6).toFixed(1)} MB before compression; truncated bodies: ${SPANS.filter((s) => s.req_body_truncated || s.res_body_truncated).length}`)
  const demo = SPANS.filter((s) => s.trace_id === TRACE_A || s.trace_id === TRACE_B || s.trace_id === TRACE_C)
  for (const id of [TRACE_A, TRACE_B, TRACE_C]) {
    const spans = demo.filter((s) => s.trace_id === id)
    const io = spans.filter((s) => IO_COLUMNS.some((c) => s[c]))
    console.log(`  trace ${id}: ${spans.length} spans, ${io.length} with I/O (${io.map((s) => s.name).join(', ')})`)
  }
  if (DUMP) {
    fs.writeFileSync(DUMP, demo.map((s) => JSON.stringify(s)).join('\n') + '\n')
    console.log(`  wrote ${demo.length} span rows of the demo traces to ${DUMP}`)
  }
}

async function main() {
  if (DRY_RUN) {
    dryRun()
    await client.close()
    return
  }
  const t0 = Date.now()
  await reset()
  if (RESET_ONLY) {
    await client.close()
    return
  }
  generate()
  console.log(`generated ${SPANS.length} spans and ${LOGS.length} log lines (env ${ENV}, ${fmt3(START)} .. ${fmt3(NOW)} UTC)`)
  await insert('spans', SPANS)
  await insert('logs', LOGS)
  const [s] = await rows(
    `SELECT (SELECT count() FROM ${DB}.logs WHERE env = '${ENV}') AS logs,
            (SELECT count() FROM ${DB}.spans WHERE env = '${ENV}') AS spans,
            (SELECT count() FROM (SELECT trace_id FROM ${DB}.trace_index WHERE env = '${ENV}' GROUP BY trace_id)) AS traces,
            (SELECT sum(requests) FROM ${DB}.route_stats_1m WHERE env = '${ENV}') AS requests`,
  )
  console.log(`env ${ENV} now holds: logs ${s.logs}, spans ${s.spans}, traces ${s.traces}, entry requests ${s.requests}`)
  console.log(`trace A ${TRACE_A} · trace B ${TRACE_B} · trace C ${TRACE_C} · done in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await client.close()
}

main().catch(async (err) => {
  console.error('seed failed:', err && err.message ? err.message : err)
  await client.close().catch(() => {})
  process.exit(1)
})
