#!/usr/bin/env node
/**
 * The benchmark's fixture, from the engine's own mappers and the SDK's own mask rules (never hand-written):
 *
 *   envelopes.jsonl      2,000 envelopes (logs + spans; some from a sender that masked, most not) — the input
 *   expected-logs.jsonl  the rows apps/engine mapLog makes of them, in order
 *   expected-spans.jsonl the rows mapSpan makes, every column (the 18 captured-I/O columns too)
 *   mask-cases.json      every exported mask rule of skilllane-monitoring/contract with inputs and outputs, all
 *                        `required`: a port must pass every one
 *
 * Spans carry the captured I/O the SDK (and other instrumentations) write: request / response headers and
 * bodies (JSON with secrets, markup, forms, one body cut at 1000 + '...', one over the 256 KiB mask cap),
 * `url.query`, `skilllane.monitoring.db.parameters`, semconv per-key binds and headers, typeorm / pg binds,
 * queue messages with headers; from senders that masked (the SDK's own output) and senders that did not.
 *
 * Run from the repo root after `pnpm --filter @skilllane/monitoring-engine build`:
 *   node bench/fixture/generate.mjs
 * then `gzip -9 -k -f bench/fixture/*.jsonl` (only the .gz files are committed).
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// resolved from the engine package: the SDK is its dependency, not the root's
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'engine', 'package.json'))
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const { mapLog, mapSpan } = require(join(root, 'apps/engine/dist/ingest/mappers.js'))
const c = require('skilllane-monitoring/contract')

// ---------- a deterministic generator ----------
let seed = 20261105
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const int = (a, b) => a + Math.floor(rand() * (b - a + 1))
const pick = (list) => list[Math.floor(rand() * list.length)]
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('')
const T0 = Date.parse('2026-11-05T02:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

const SERVICES = [
  ['school-core-api', 'api'],
  ['school-core-api', 'worker'],
  ['school-etl-api', 'api'],
  ['video-transcoder-api', 'api'],
]
const ROUTES = ['/classes/:id/students', '/me', '/exams/:id/submit', '/question-bank/import', '/reports/:id/generate', '/health']
const LOGGERS = ['ExamService', 'ClassController', 'ImportQuestionBankHandler', 'RedisCacheManager', 'OracleAuthProvider', 'App']
const THAI = ['ส่งข้อสอบสำเร็จ', 'นักเรียนไม่พบในห้องเรียน', 'นำเข้าคลังข้อสอบ 312 ข้อ', 'ครูอัปเดตคะแนน']

/** Messages that exercise the value rule: emails, JWT, bearer, Thai id, key=value secrets, URLs with query. */
const SENSITIVE = [
  'login ok for somchai.p@ndlp.go.th from 10.0.3.17',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEwMjkifQ.c2lnbmF0dXJl',
  'citizen id 1101700230451 verified',
  'retry with password=S3cret! token=abc123def456 apiKey: "k-9981"',
  'GET https://api.thaid.go.th/userinfo?access_token=abc&state=xyz took 120 ms',
  'user { "email": "teacher@school.ac.th", "otp": "482913" } rejected',
  'redis set session:a1b2c3 EX 3600',
  'Connection refused by amqp://guest:guest@rabbit:5672/',
  'ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)',
]
const SQL = [
  `SELECT * FROM "STUDENT" WHERE "CITIZEN_ID" = '1101700230451' AND "SCHOOL_ID" = 118`,
  `INSERT INTO "QUESTION_BANK"("ID", "TITLE", "SCHOOL_ID") VALUES (:1, :2, :3)`,
  `UPDATE users SET password_hash = 'x9$abc', last_login = '2026-11-05' WHERE email = 'a@b.th'`,
  `SELECT id FROM exam WHERE title LIKE '%คณิต%' AND created_at > TIMESTAMP '2026-01-01 00:00:00'`,
]
/** Statements with binds, and the binds a sender captured for them (the SDK's DbParameter shape, unmasked). */
const BOUND = [
  {
    sql: `INSERT INTO "QUESTION_BANK"("ID", "TITLE", "SCHOOL_ID", "CREATED_AT") VALUES (:1, :2, :3, :4)`,
    params: [
      { key: '1', type: 'number', value: '4402' },
      { key: '2', type: 'string', value: 'ข้อสอบ teacher@school.ac.th' },
      { key: '3', type: 'number', value: '118' },
      { key: '4', type: 'date', value: '2026-11-05T02:00:00.000Z' },
    ],
  },
  {
    sql: `UPDATE users SET password_hash = :hash, otp = :otp, last_login = :at WHERE email = :email AND citizen_id = :cid`,
    params: [
      { key: 'hash', type: 'string', value: 'x9$abc' },
      { key: 'otp', type: 'string', value: '482913' },
      { key: 'at', type: 'date', value: '2026-11-05T02:00:00.000Z' },
      { key: 'email', type: 'string', value: 'a@b.th' },
      { key: 'cid', type: 'number', value: '1101700230451' },
    ],
  },
  {
    sql: `SELECT * FROM api_keys WHERE lower(owner) = lower(?) AND created_at BETWEEN ? AND ? LIMIT ? OFFSET ?`,
    params: [
      { key: '1', type: 'string', value: 'somchai' },
      { key: '2', type: 'date', value: '2026-01-01T00:00:00Z' },
      { key: '3', type: 'date', value: '2026-12-31T23:59:59.999+07:00' },
      { key: '4', type: 'number', value: '50' },
      { key: '5', type: 'number', value: '0' },
    ],
  },
  {
    sql: `INSERT INTO audit(payload, blob, flag, note) VALUES ($1, $2, $3, $4)`,
    params: [
      { key: '1', type: 'object', value: '{"email":"a@b.th","token":"t-1","n":1}' },
      { key: '2', type: 'buffer', value: 'deadbeef' },
      { key: '3', type: 'boolean', value: 'true' },
      { key: '4', type: 'null', value: '' },
    ],
  },
]
const LONG_SQL = 'SELECT "QB"."ID", "QB"."TITLE" FROM "QUESTION_BANK" "QB" WHERE "QB"."SCHOOL_ID" = :1 ' + 'AND 1=1 '.repeat(300)

const REQ_HEADERS = [
  {
    'content-type': 'application/json',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEwMjkifQ.c2lnbmF0dXJl',
    cookie: 'sid=a1b2c3; theme=dark; csrf=xyz',
    'x-forwarded-for': '10.0.0.5',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)',
    accept: ['application/json', 'text/plain'],
    'x-user-email': 'teacher@school.ac.th',
    'content-length': '512',
  },
  { 'Content-Type': 'text/xml', 'X-Api-Key': 'k-9981', Referer: 'https://school.ac.th/login?token=abc&next=%2Fme', Accept: '*/*' },
]
const RES_HEADERS = [
  {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': ['sid=zzz9; Path=/; HttpOnly; Secure', 'theme=dark; Path=/'],
    'x-request-id': 'req-1029',
    location: '/exams/4402?token=abc',
    'cache-control': 'no-store',
  },
  { 'Content-Type': 'text/html', 'Set-Cookie': 'session=abc; Path=/', 'X-Powered-By': 'Express' },
]
const BODIES = [
  JSON.stringify({ email: 'teacher@school.ac.th', password: 'hunter2', otp: '482913', citizenId: '1101700230451', profile: { phone: '0812345678', apiKey: 'k-9981', name: 'สมชาย' } }),
  JSON.stringify({ items: [{ id: 1, title: 'คณิตศาสตร์', ownerEmail: 'a@b.th' }, { id: 2, title: 'Science', 'x@y.th': 1 }], total: 2, token: 'abc' }),
  JSON.stringify([{ password: 'p', note: 'citizen 1101700230451' }, { refreshToken: 'r' }]),
  '<user><name>somchai</name><password>S3cret!</password><email>a@b.th</email><input name="token" value="abc"/><![CDATA[x]]></user>',
  '<?xml version="1.0"?><login><field key="password">x</field><meta name="csrf-token" content="xyz"></login>',
  'name=somchai&password=S3cret!&email=a%40b.th&page=2',
  'plain text with token=abc123 and somchai.p@ndlp.go.th',
  '  {"leading":"space","secret":"s"}',
  '{"cut":"json","email":"a@b.th","password":"p","list":[1,2,',
]
const MESSAGES = [
  JSON.stringify({ event: 'exam.submitted', examId: 4402, studentEmail: 'student@school.ac.th', token: 'abc', citizenId: 1101700230451 }),
  JSON.stringify({ job: 'report:generate', password: 'x', payload: { ids: [1, 2, 3], note: 'ok' } }),
  'raw message with somchai.p@ndlp.go.th and otp=482913',
]
const MSG_HEADERS = [
  { 'x-token': 'abc', 'Content-Type': 'application/json', 'x-correlation-id': 'corr-1', 'X-User-Email': 'a@b.th' },
  { authorization: 'Bearer x', 'x-attempt': 2, 'x-retry': ['1', '2'], 'x-nil': null },
]
/** school-core-api's hook: the body cut at 1000 chars + '...' (no size, no flag). */
const CUT_1000 = ('{"rows":[' + '{"email":"a@b.th","password":"p","n":1},'.repeat(60)).slice(0, 1000) + '...'
/** A body over FALLBACK_MAX_BYTES (256 KiB): the engine masks the first 256 KiB and marks the row cut. */
const HUGE = '{"rows":[' + '{"email":"a@b.th","token":"t","n":1},'.repeat(8000) + '{"end":true}]}'
const FALLBACK_MAX_BYTES = 262144
const SDK_CAP = { maxBytes: 8192, valueMax: 2048 }

function resource(service, role, extra = {}) {
  return {
    'service.name': service,
    'service.version': '1.4.2',
    'deployment.environment.name': 'bench',
    'host.name': `ip-10-0-3-${int(10, 40)}`,
    'app.role': role,
    'telemetry.sdk.name': 'skilllane-monitoring',
    'telemetry.sdk.version': '0.2.0',
    ...extra,
  }
}

function logItem(t, service, role, i) {
  const kind = rand()
  const base = {
    '@timestamp': iso(t),
    'log.level': kind < 0.02 ? 'error' : kind < 0.07 ? 'warn' : 'info',
    'log.logger': pick(LOGGERS),
    'service.name': `${service}/${role}`,
    'event.code': 'app.log',
    'trace.id': hex(32),
    'span.id': hex(16),
    labels: { usecase: pick(['exam.submit', 'class.list', 'import']), password: 'hunter2', 'x-request-id': hex(8) },
  }
  if (kind < 0.02) {
    return {
      ...base,
      message: pick(SENSITIVE),
      'error.type': 'OracleError',
      'error.code': 'ORA-12899',
      'error.message': pick(SENSITIVE),
      'error.hint': 'Value too large',
      'error.detail': `row ${i} of teacher@school.ac.th failed`,
      'error.how_to_fix': 'shorten the title',
      'error.stack_trace': `OracleError: ORA-12899\n    at ExamService.submit (src/exam/exam.service.ts:81:13)\n    user=1101700230451`,
      'error.cause': { code: 'ECONNRESET', token: 'secret-token-value' },
      'log.origin.function': 'ExamService.submit',
      'log.origin.file.name': 'src/exam/exam.service.ts',
      'db.statement': pick(SQL),
      'http.request.method': 'POST',
      'http.route': pick(ROUTES),
      'url.path': '/exams/4402/submit?token=abc',
      'http.response.status_code': 500,
      'user.id': `u_${int(1000, 9999)}`,
      'user.roles': ['teacher'],
      'organization.id': `s_${int(100, 999)}`,
    }
  }
  if (kind < 0.4) {
    const route = pick(ROUTES)
    return {
      ...base,
      'event.code': 'http.request',
      'log.logger': 'HttpRequest',
      message: 'request completed',
      'http.request.method': pick(['GET', 'POST']),
      'http.route': route,
      'url.path': route.replace(':id', String(int(1, 5000))) + (rand() < 0.3 ? '?page=2&email=x@y.th' : ''),
      'http.response.status_code': pick([200, 200, 200, 201, 304, 404]),
      duration_ms: int(2, 900) + rand(),
      'user.id': `u_${int(1000, 9999)}`,
      'user.roles': ['student'],
      'organization.id': `s_${int(100, 999)}`,
    }
  }
  if (kind < 0.5) {
    return {
      ...base,
      'event.code': pick(['job.started', 'job.finished']),
      'event.module': 'bullmq',
      message: 'job finished',
      'job.queue': 'report',
      'job.type': 'report:generate',
      'job.id': String(int(80000, 99999)),
      'job.attempt': 1,
      'job.max_attempts': 3,
      duration_ms: int(50, 5000),
    }
  }
  return {
    ...base,
    message: rand() < 0.3 ? pick(SENSITIVE) : rand() < 0.4 ? pick(THAI) : `Cache hit for key: course-media/${hex(32)}.png`,
    reason: rand() < 0.1 ? 'connect ECONNREFUSED 10.0.3.21:6379' : undefined,
    'extra.note': `teacher ${int(1, 99)}@school.ac.th`,
    'extra.secret': 'should-be-redacted-by-key',
  }
}

/** What a sender that masked (the SDK) would have written: its own rules on the captured value. */
const sdk = {
  headers: (h) => c.maskHeaderJson(JSON.stringify(h), true, 65536),
  msgHeaders: (h) => c.maskHeaderJson(JSON.stringify(h), false, 65536),
  body: (b) => c.maskBodyText(b, FALLBACK_MAX_BYTES),
  query: (q) => c.maskQuery(q),
  params: (sql, params) => c.dbParametersJson(sql, params.length, (i) => params[i], SDK_CAP),
}

/** The attributes of one span kind, with captured I/O as the sender (masked = the SDK) sends it. */
function spanAttributes(kind, route, masked) {
  switch (kind) {
    case 'http': {
      const req = pick(REQ_HEADERS)
      const res = pick(RES_HEADERS)
      const reqBody = pick(BODIES)
      const resBody = pick(BODIES)
      const query = pick(['page=2&email=a%40b.th', '?token=abc&next=%2Fme', 'code=xyz&state=1', '', 'q=คณิต&sort=asc'])
      const sizeOf = (b) => Buffer.byteLength(b)
      const attrs = {
        'http.request.method': pick(['GET', 'POST', 'PUT']),
        'http.route': route,
        'url.path': route.replace(':id', String(int(1, 5000))),
        'url.full': `https://school.ac.th${route}?token=abc`,
        'http.response.status_code': pick([200, 200, 201, 400, 404, 500]),
        'user_agent.original': 'Mozilla/5.0',
        'client.address': '10.0.0.5',
        'skilllane.user.email': 'a@b.th',
      }
      if (query) attrs['url.query'] = masked ? sdk.query(query.replace(/^\?/, '')) : query
      attrs['http.request.headers'] = masked ? sdk.headers(req) : JSON.stringify(req)
      attrs['http.response.headers'] = masked ? sdk.headers(res) : JSON.stringify(res)
      const variant = rand()
      if (variant < 0.15) {
        // school-core-api's own hook: cut at 1000 chars, no size / flag
        attrs['http.request.body'] = CUT_1000
        attrs['http.response.body'] = masked ? sdk.body(resBody) : resBody
      } else if (variant < 0.2 && !masked) {
        attrs['http.request.body'] = HUGE
        attrs['http.response.body'] = resBody
        attrs['http.response.body.size'] = sizeOf(resBody)
      } else {
        attrs['http.request.body'] = masked ? sdk.body(reqBody) : reqBody
        attrs['http.response.body'] = masked ? sdk.body(resBody) : resBody
        attrs['http.request.body.size'] = pick([sizeOf(reqBody), String(sizeOf(reqBody) + 40), sizeOf(reqBody) + 1000])
        attrs['http.response.body.size'] = sizeOf(resBody)
        attrs['http.request.body.truncated'] = pick([false, true, 'true', 1, 0])
        attrs['http.response.body.truncated'] = pick([false, false, 'false', true])
      }
      return attrs
    }
    case 'http-semconv': {
      // per-key headers of @opentelemetry/instrumentation-http (headersToSpanAttributes): always masked here
      return {
        'http.request.method': 'POST',
        'http.route': route,
        'url.path': route.replace(':id', String(int(1, 5000))),
        'url.query': '?page=2&token=abc',
        'http.response.status_code': 201,
        'http.request.header.content_type': ['application/json'],
        'http.request.header.authorization': ['Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'],
        'http.request.header.x_forwarded_for': '10.0.0.5, 10.0.0.6',
        'http.request.header.cookie': ['sid=abc; theme=dark'],
        'http.request.header.X_User_Email': 'a@b.th',
        'http.request.header.content_length': 512,
        'http.response.header.set_cookie': ['sid=zzz; Path=/; HttpOnly', 'theme=dark; Path=/'],
        'http.response.header.content_type': ['text/html'],
        'http.response.header.location': '/exams/4402?token=abc',
        'http.request.body': pick(BODIES),
        'http.response.body': pick(BODIES),
      }
    }
    case 'db-sdk': {
      const { sql, params } = pick(BOUND)
      const statement = rand() < 0.1 ? LONG_SQL : sql
      return {
        'db.system.name': 'oracle',
        'db.query.text': masked ? c.maskStatement(statement, 'oracle', FALLBACK_MAX_BYTES) : statement,
        'skilllane.monitoring.db.parameters': masked ? sdk.params(statement, params) : JSON.stringify(params),
        'db.operation.name': statement.split(' ')[0],
        'server.address': 'oracle-db.internal',
        'server.port': 1521,
        'oracle.rows': int(0, 5),
      }
    }
    case 'db-semconv': {
      // semconv per-key binds: 0-based positional (sorted by position) or named; oracledb's db.operation.parameter.*
      const { sql } = pick(BOUND.slice(0, 3))
      const prefix = pick(['db.query.parameter.', 'db.operation.parameter.'])
      const attrs = { 'db.system': 'oracle', 'db.statement': sql, 'server.address': 'oracle-db.internal', 'db.user': 'app' }
      if (sql.includes(':hash')) {
        attrs[`${prefix}hash`] = 'x9$abc'
        attrs[`${prefix}otp`] = '482913'
        attrs[`${prefix}at`] = '2026-11-05T02:00:00.000Z'
        attrs[`${prefix}email`] = 'a@b.th'
        attrs[`${prefix}cid`] = 1101700230451
      } else {
        attrs[`${prefix}10`] = 'tenth'
        attrs[`${prefix}2`] = { type: 'Buffer', data: [222, 173, 190, 239, 256, -1, 1.7, '12', 'x'] }
        attrs[`${prefix}0`] = 4402
        attrs[`${prefix}1`] = 'ข้อสอบ teacher@school.ac.th'
        attrs[`${prefix}3`] = '2026-11-05T02:00:00.000Z'
        attrs[`${prefix}4`] = { email: 'a@b.th', ids: [1, 2], token: 't' }
        attrs[`${prefix}5`] = true
        attrs[`${prefix}6`] = null
      }
      return attrs
    }
    case 'db-pg':
      return {
        'db.system': 'postgresql',
        'db.statement': 'SELECT * FROM users WHERE email = $1 AND password_hash = $2 AND deleted_at IS $3',
        'db.postgresql.values': ['a@b.th', 'x9$abc', 'null'],
        'db.name': 'school',
        'net.peer.name': 'pg.internal',
        'net.peer.port': 5432,
      }
    case 'db-typeorm':
      return {
        'db.system': 'postgres',
        'db.statement': pick([
          'SELECT "u"."id" FROM "users" "u" WHERE "u"."email" = :email AND "u"."api_key" = :apiKey',
          'UPDATE "users" SET "token" = $1, "name" = $2 WHERE "id" = $3',
        ]),
        'db.statement.parameters': pick([
          JSON.stringify({ email: 'a@b.th', apiKey: 'k-9981' }),
          JSON.stringify(['t-1', 'สมชาย', 4402]),
          'not json',
        ]),
        'db.user': 'app',
      }
    case 'messaging': {
      const body = pick(MESSAGES)
      const headers = pick(MSG_HEADERS)
      const attrs = {
        'messaging.system': pick(['kafka', 'rabbitmq']),
        'messaging.destination.name': 'skilllane.events',
        'messaging.operation.type': pick(['publish', 'process']),
        'messaging.message.id': 'session:abc:1',
        'messaging.kafka.message.key': 'user:1029',
        'messaging.message.body': masked ? sdk.body(body) : body,
        'messaging.message.headers': masked ? sdk.msgHeaders(headers) : JSON.stringify(headers),
      }
      const variant = rand()
      if (variant < 0.3) {
        attrs['messaging.message.body.size'] = Buffer.byteLength(body)
        attrs['messaging.message.body.truncated'] = pick([false, 'false', 0])
      } else if (variant < 0.5) {
        // cut by the sender: the size is the original's, the flag says so
        attrs['messaging.message.body'] = body.slice(0, 20)
        attrs['messaging.message.body.size'] = Buffer.byteLength(body)
        attrs['messaging.message.body.truncated'] = pick([true, 'true', 1])
      } else if (variant < 0.7) {
        // size bigger than the text, no flag: cut when the text is no longer whole JSON
        attrs['messaging.message.body'] = pick([body.slice(0, 25), body])
        attrs['messaging.message.body.size'] = Buffer.byteLength(body) + 100
      }
      return attrs
    }
    default:
      return null
  }
}

function spanItem(t, service, masked) {
  const start = BigInt(t) * 1000000n + BigInt(int(0, 999999))
  const dur = BigInt(int(1, 900)) * 1000000n
  const route = pick(ROUTES)
  const roll = rand()
  const kind =
    roll < 0.2 ? 'plain-db' : roll < 0.35 ? 'plain-http' : roll < 0.55 ? 'http' : roll < 0.62 ? 'http-semconv' : roll < 0.77 ? 'db-sdk' : roll < 0.84 ? 'db-semconv' : roll < 0.88 ? 'db-pg' : roll < 0.92 ? 'db-typeorm' : 'messaging'
  const isDb = kind.startsWith('db') || kind === 'plain-db'
  const attributes =
    kind === 'plain-db'
      ? { 'db.system': 'oracle', 'db.statement': pick(SQL), 'server.address': 'oracle', 'server.port': 1521, 'db.user': 'app' }
      : kind === 'plain-http'
        ? {
            'http.request.method': 'GET',
            'http.route': route,
            'url.path': route.replace(':id', String(int(1, 5000))),
            'url.full': `https://school.ac.th${route}?token=abc`,
            'http.response.status_code': pick([200, 200, 404, 500]),
            'user_agent.original': 'Mozilla/5.0',
            'client.address': '10.0.0.5',
            'skilllane.user.email': 'a@b.th',
          }
        : spanAttributes(kind, route, masked)
  const name = isDb ? 'oracledb.Connection.execute:SELECT' : kind === 'messaging' ? 'skilllane.events publish' : `GET ${route}`
  return {
    traceId: hex(32),
    spanId: hex(16),
    parentSpanId: isDb || kind === 'messaging' ? hex(16) : '',
    name,
    kind: isDb ? 'CLIENT' : kind === 'messaging' ? 'PRODUCER' : 'SERVER',
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + dur).toString(),
    status: { code: rand() < 0.03 ? 'ERROR' : 'UNSET', message: rand() < 0.03 ? 'token=abc rejected for a@b.th' : '' },
    scope: { name: isDb ? '@opentelemetry/instrumentation-oracledb' : kind === 'messaging' ? 'skilllane-monitoring' : '@opentelemetry/instrumentation-http' },
    attributes,
    events: rand() < 0.05 ? [{ name: 'exception', timeUnixNano: start.toString(), attributes: { 'exception.type': 'Error', 'exception.message': 'password=abc for x@y.th' } }] : [],
  }
}

// ---------- envelopes ----------
const envelopes = []
let t = T0
for (let i = 0; i < 2000; i++) {
  const [service, role] = pick(SERVICES)
  const masked = rand() < 0.15
  const res = resource(service, role, masked ? { [c.MASK_RESOURCE_KEY]: c.MASK_VERSION } : {})
  const stream = rand() < 0.7 ? 'logs' : 'spans'
  const n = int(20, 50)
  const items = Array.from({ length: n }, (_, k) => (stream === 'logs' ? logItem(t + k * 7, service, role, i * 100 + k) : spanItem(t + k * 7, service, masked)))
  envelopes.push({ v: c.CONTRACT_VERSION, stream, resource: res, sentAt: iso(t + n * 7 + 50), items })
  t += n * 7 + 100
}

const expectedLogs = []
const expectedSpans = []
for (const e of envelopes) {
  for (const item of e.items) {
    if (e.stream === 'logs') expectedLogs.push(mapLog(item, e.resource, e.sentAt))
    else expectedSpans.push(mapSpan(item, e.resource))
  }
}

// ---------- mask cases: every exported rule, from the SDK itself ----------
const texts = [
  ...SENSITIVE,
  'plain text with no secrets ไทย 123',
  'ids 1101700230451 and 1101700230452 (second fails checksum)',
  'nested key = "value" and other: 42, token=xyz; x',
  'email runs a@b.th,c@d.org and not-an-email@',
  'https://u:p@host/path?x=1#frag',
  '',
]
const keys = ['password', 'confirmPassword', 'token', 'secret', 'apiKey', 'x-api-key', 'authorization', 'email', 'name', 'format', 'tokenType', 'passwordChangedAt', 'user_id', 'citizen_id', 'otp', 'pin', 'JWTToken', 'license_key', 'keyboard', '']
const paths = [
  ['/classes/118/students', '/classes/:id/students'],
  ['/users/u_1029/profile', ''],
  ['/exams/4402/submit?token=abc', '/exams/:id/submit'],
  ['/files/a%40b.th/download', '/files/:name/download'],
  ['/t/abc/x', '/t/:token/x'],
  ['/u/1/k/2?x=1', '/u/{id}/k/{apiKey}'],
  ['/a/[REDACTED]', '/a/:token'],
  ['/a/b', '/a/:token?'],
]
const sqlCases = SQL.concat(BOUND.map((b) => b.sql), [`SELECT 1`, `select * from t where a in (1,2,3) and b = ?`, LONG_SQL, `SELECT password FROM users WHERE name = 'x' LIMIT 10`])
const markup = [
  '<user><name>somchai</name><password>S3cret!</password></user>',
  '<input name="password" value="x"/><input name="user" value="u"/>',
  '<field key="token">abc</field><field key="name">n</field>',
  '<meta name="csrf-token" content="xyz"><meta name="viewport" content="w">',
  '<password><![CDATA[x]]></password>',
  '<secret><![CDATA[v]]>y</x>]]></secret>',
  '<a><![CDATA[x]]>y</b>]]></a>',
  '<Token Value="1">t</Token>',
  '<ns:apiKey attr="1">k</ns:apiKey>',
  '<password>unclosed',
  '<param name = \'otp\' value = \'1\' />',
  '<x name="pin">1</x><y>2</y>',
  'no markup at all',
  '<password>ไทย</password> ยาว',
]
const csv = [
  'email,password,name\na@b.th,x,ann\n"c@d.org","y",bob\n',
  'name;token;n\r\nann;t;1\r\nbob;"t;2";2',
  'name\tapi_key\tx\nann\tk\t1\n\nbob\tk2\t2',
  'a|b|c\n1|2|3',
  'name,age\nann,1',
  '"password","note"\n"p","n"',
  '',
]
const cookies = ['a=1; session=2; x', 'sid=abc', ' ; =v; k=', '', 'theme=dark; csrf=xyz']
const setCookies = ['sid=zzz; Path=/; HttpOnly; Secure, theme=dark; Path=/', 'a=1', 'x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Domain=a@b.th', 'noname; Path=/', '']
const headerObjects = [
  { Authorization: 'Bearer x', Cookie: 'a=1', Accept: ['a', 'b'], 'X-N': 5, Nul: null, 'content-type': 'x', 'Content-Type': 'y', 'X-Url': '/p?token=1', 'X-Email': 'a@b.th' },
  { 'Set-Cookie': ['a=1; Path=/', 'b=2'], 'x-obj': { a: 1 }, 'x-arr': [1, null, 'z'] },
  {},
]
const jsonTexts = ['{"email":"a@b.th","token":"x","n":1}', '[{"password":"p"}]', 'not json token=abc', '{"a@b.th":{"pin":"1"},"n":1101700230451,"k":[1,2,{"otp":"3"}]}', '{"cut":"json","email":"a@b.th","pass', '  ﻿{"bom":"a@b.th"}']
const bodies = [...BODIES, CUT_1000, 'หัวข้อ: a@b.th', '<x>', '']
const objects = [
  { email: 'a@b.th', password: 'p', n: 1101700230451, m: 42, nested: { otp: '1', list: ['a@b.th', 2, null, true] }, 'x@y.th': 1, '12345': 'v' },
  ['a@b.th', { token: 't' }, 7],
  'plain a@b.th',
  1101700230451,
  null,
  true,
]
const dbParams = [
  [BOUND[0].sql, BOUND[0].params, SDK_CAP],
  [BOUND[1].sql, BOUND[1].params, SDK_CAP],
  [BOUND[2].sql, BOUND[2].params, SDK_CAP],
  [BOUND[3].sql, BOUND[3].params, SDK_CAP],
  [
    `UPDATE users SET password_hash = $1, name = $2 WHERE id = $3`,
    [
      { key: '1', type: 'string', value: 'x' },
      { key: '2', type: 'string', value: 'สมชาย a@b.th' },
      { key: '3', type: 'number', value: '7' },
    ],
    SDK_CAP,
  ],
  [
    `SELECT password FROM users WHERE lower(name) = concat(?, 'x') AND ? > 1 LIMIT ? OFFSET ?`,
    [
      { key: '1', type: 'string', value: 'somchai' },
      { key: '2', type: 'number', value: '1101700230451' },
      { key: '3', type: 'number', value: '10' },
      { key: '4', type: 'bigint', value: '9007199254740993' },
    ],
    SDK_CAP,
  ],
  [
    null,
    [
      { key: 'a', type: 'object', value: '{"email":"a@b.th","token":"t"}' },
      { key: 'b', type: 'object', value: '[Lob]' },
      { key: 'c', type: 'buffer', value: 'deadbeef' },
      { key: 'd', type: 'date', value: '2026-11-05T02:00:00.000Z' },
      { key: 'e', type: 'number', value: '1101700230451' },
      { key: 'f', type: 'bigint', value: '1101700230451' },
      { key: 'g', type: 'boolean', value: 'true' },
      { key: 'h', type: 'null', value: '' },
      { key: 'i', type: 'string', value: 'a@b.th', column: 'note' },
      { key: 'token', type: 'string', value: 'x', truncated: true },
      { key: 'j', type: 'string', value: 'y', column: 'password', truncated: true },
      { key: 'k', type: 'string', value: '[REDACTED]', masked: 'unresolved' },
      { key: 'l', type: 'weird', value: 'w' },
    ],
    SDK_CAP,
  ],
  [
    `INSERT INTO t(a, b) VALUES (?, ?)`,
    Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), type: 'string', value: `value-${i}-${'x'.repeat(40)}` })),
    { maxBytes: 400, valueMax: 24 },
  ],
  [`SELECT 1`, [], SDK_CAP],
  [`SELECT * FROM t WHERE k = :k AND k = :k`, [{ key: 'k', type: 'string', value: 'v' }], SDK_CAP],
  [`SELECT * FROM t WHERE (a, b) = (?, ?) AND c IN (?, ?)`, [1, 2, 3, 4].map((i) => ({ key: String(i), type: 'number', value: String(i * 10) })), SDK_CAP],
]
const placeholderSql = [
  ...BOUND.map((b) => b.sql),
  `SELECT * FROM t WHERE a IN (?, ?) LIMIT ? OFFSET ?`,
  `INSERT INTO t(a, b) SELECT ?, ? FROM dual`,
  `SELECT @p1, :x, $1, ? FROM t WHERE a = ANY(:...ids)`,
  `SELECT 1`,
]
const redisCalls = [
  ['set', ['session:abc', 'tok']],
  ['set', ['session:abc', 'tok', 'EX', 3600, 'NX']],
  ['setex', ['session:abc', 60, 'tok']],
  ['get', ['user:1']],
  ['get', [{ nested: 'obj', arr: [1, 2], email: 'a@b.th' }]],
  ['hset', ['h', 'password', 'p', 'name', 'n']],
  ['hset', ['session:x', 'f', 'v']],
  ['auth', ['pw']],
  ['hello', [3, 'AUTH', 'u', 'p', 'SETNAME', 'n']],
  ['config', ['set', 'requirepass', 'x', 'maxmemory', '1gb']],
  ['acl', ['setuser', 'u', '>pw', 'on', '#hash']],
  ['migrate', ['h', '6379', 'k', '0', '5000', 'AUTH', 'pw']],
  ['migrate', ['h', '6379', '', '0', '5000', 'AUTH2', 'u', 'pw', 'KEYS', 'session:a']],
  ['eval', ['return 1', 1, 'session:x', 'arg', 'a@b.th']],
  ['evalsha', ['abc', 'x', 'k', 'v']],
  ['xadd', ['s', 'MAXLEN', '~', '1000', '*', 'token', 't', 'f', 'v']],
  ['xadd', ['s', 'NOMKSTREAM', '*', 'email', 'a@b.th']],
  ['mset', ['session:a', '1', 'b', '2', 'c', 'a@b.th']],
  ['set', ['k', 'a b', "it's", 'line\nbreak', '', 'back\\', 'tab\t"q"', '\u0001x']],
  ['set', ['k', 'x'.repeat(5000)], 64],
  ['set', ['k', 'x'.repeat(50), 'y'.repeat(50), 'z'], 80],
  ['rpush', ['list', ['a', ['b', 'c']], 7, true, null]],
  ['set', ['k', '{"email":"a@b.th","pass'.padEnd(100, 'x')], 60],
  ['get', ['ไทย ยาว'.repeat(10)], 24],
  ['publish', ['verify:ch', 'msg']],
]
const redisKeys = ['session:abc', 'user:1029', 'password_reset:xyz', 'pwreset:abc:def', 'session:[REDACTED]', 'a b:c', 'verify:x', 'nocolon', 'x:token:y:z', '']
const quoteArgs = ['', 'plain', 'a b', "it's", 'q"q', 'back\\', 'line\nbreak', 'tab\t', '\u0001\u007f', 'ไทย', "a'b\"c"]
const truncs = [['ไทย abc', 5], ['abc', 10], ['abc', 0], ['��x', 2], ['', 3]]
const words = ['passwordChangedAt', 'x-api-key', 'JWTToken', 'HTTPServer', 'a1B2', '', '__']
const urls = ['https://u:p@h/p?token=1&x=2', '/a?b=c@d.th', 'https://h/p#token=1', 'https://h/p?x=1#frag', '/p?a=b&c', 'q=a%40b.th&code=x', '']
const queries = ['token=1&x=2&email=a@b.th', 'page=2', 'a=b&c', 'q=a%40b.th&code=x', 'ticket=1&key=2&x=%ZZ', '&&', '']
const headerValues = [
  ['authorization', 'Bearer x'],
  ['cookie', 'a=1; session=2'],
  ['accept', 'text/html'],
  ['set-cookie', 'a=1; Path=/, b=2; Secure'],
  ['location', '/x?token=1'],
  ['x-url', 'https://h/p?code=1'],
  ['x-url', 'https://h/p'],
  ['x-email', 'a@b.th'],
  ['X-Api-Key', 'k'],
]
const headerJsons = [
  ['{"authorization":"Bearer x","cookie":"s=1","accept":"*/*"}', true, 65536],
  ['{"Authorization":"Bearer x","X-Email":"a@b.th"}', false, 65536],
  ['not json token=abc', true, 65536],
  ['{"a":"a@b.th","b":"c@d.th","c":"e@f.th"}', true, 40],
  ['["a@b.th"]', true, 65536],
]
const bodyTexts = [...bodies.map((b) => [b, FALLBACK_MAX_BYTES]), [BODIES[0], 40], [BODIES[3], 30], [HUGE, FALLBACK_MAX_BYTES]]
const statements = [...SQL.map((s) => [s, 'oracle', 65536]), ['get session:abc a@b.th', 'redis', 65536], ['{"find":"users","filter":{"email":"a@b.th"}}', 'mongodb', 65536], [LONG_SQL, 'oracle', 100]]
const endpoints = ['amqp://guest:guest@rabbit:5672/', 'redis://:pw@host:6379', 'host:5432', 'u:[REDACTED]@h', 'a@b.th']
const numbers = [1101700230451, 42, 812345678, 1101700230452, 1.5, -1]
const queryNames = ['code', 'key', 'ticket', 'page', 'token', 'Code', '']
const headerNames = ['authorization', 'cookie', 'x-api-key', 'accept', 'proxy-authorization', 'set-cookie', 'Authorization', '']
const stripPaths = ['/a?b=1', '/a', '/a#f', '/a?b=1#f', '']

const on = (inputs, fn) => inputs.map((input) => ({ input, output: fn(input) }))
const cases = {
  required: {
    redactValue: on(texts, (t) => c.redactValue(t)),
    redactText: on(texts, (t) => c.redactText(t)),
    isThaiNationalId: on(['1101700230451', '1101700230452', '0101700230451', '', 'abc'], (t) => c.isThaiNationalId(t)),
    stripQuery: on(stripPaths, (t) => c.stripQuery(t)),
    maskNumber: on(numbers, (n) => c.maskNumber(n)),
    maskJsonValue: on(objects, (v) => c.maskJsonValue(structuredClone(v))),
    maskJsonText: [...on(jsonTexts, (t) => c.maskJsonText(t)), ...jsonTexts.map((t) => ({ input: [t, false], output: c.maskJsonText(t, false) }))],
    maskObject: on(objects, (v) => c.maskObject(structuredClone(v))),
    truncateUtf8: on(truncs, ([t, n]) => c.truncateUtf8(t, n)),
    isSensitiveKey: on(keys, (k) => c.isSensitiveKey(k)),
    isSensitiveQueryName: on(queryNames, (k) => c.isSensitiveQueryName(k)),
    isSensitiveHeader: on(headerNames, (k) => c.isSensitiveHeader(k)),
    keyWords: on(words, (k) => c.keyWords(k)),
    maskBodyText: on(bodyTexts, ([t, n]) => c.maskBodyText(t, n)),
    maskHeaderJson: on(headerJsons, ([t, l, n]) => c.maskHeaderJson(t, l, n)),
    maskStatement: on(statements, ([s, sys, n]) => c.maskStatement(s, sys, n)),
    maskQuery: on(queries, (q) => c.maskQuery(q)),
    maskUrl: on(urls, (u) => c.maskUrl(u)),
    maskCookie: on(cookies, (v) => c.maskCookie(v)),
    maskSetCookie: on(setCookies, (v) => c.maskSetCookie(v)),
    maskHeaderValue: on(headerValues, ([n, v]) => c.maskHeaderValue(n, v)),
    maskHeaders: [...headerObjects.map((h) => ({ input: [h, true], output: c.maskHeaders(h, true) })), ...headerObjects.map((h) => ({ input: [h, false], output: c.maskHeaders(h, false) }))],
    maskMarkup: on(markup, (t) => c.maskMarkup(t)),
    maskCsv: on(csv, (t) => c.maskCsv(t)),
    maskPathByRoute: on(paths, ([p, r]) => c.maskPathByRoute(p, r)),
    maskEndpoint: on(endpoints, (t) => c.maskEndpoint(t)),
    maskRedisKey: on(redisKeys, (k) => c.maskRedisKey(k)),
    maskIdentifier: on(redisKeys, (k) => c.maskIdentifier(k)),
    isSensitiveRedisKey: on(redisKeys, (k) => c.isSensitiveRedisKey(k)),
    quoteRedisArg: on(quoteArgs, (t) => c.quoteRedisArg(t)),
    redisCommand: redisCalls.map(([n, a, max = 4096]) => ({ input: [n, a, max], output: c.redisCommand(n, a, max) })),
    maskSql: on(sqlCases, (s) => c.maskSql(s)),
    sqlPlaceholders: [...on(placeholderSql, (s) => c.sqlPlaceholders(s)).map((x) => ({ input: [x.input, null], output: x.output })), { input: [placeholderSql[4], 2], output: c.sqlPlaceholders(placeholderSql[4], 2) }],
    dbParametersJson: dbParams.map(([s, p, o]) => ({ input: [s, p, o], output: c.dbParametersJson(s ?? undefined, p.length, (i) => p[i], o) })),
  },
}
// every export of the SDK's mask module has a rule
const exported = Object.keys(require(join(dirname(require.resolve('skilllane-monitoring/contract')), 'mask', 'index.js'))).filter((k) => typeof c[k] === 'function')
const missing = exported.filter((k) => !(k in cases.required))
if (missing.length) throw new Error(`mask rules without cases: ${missing.join(', ')}`)

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
writeFileSync(join(here, 'envelopes.jsonl'), jsonl(envelopes))
writeFileSync(join(here, 'expected-logs.jsonl'), jsonl(expectedLogs))
writeFileSync(join(here, 'expected-spans.jsonl'), jsonl(expectedSpans))
writeFileSync(join(here, 'mask-cases.json'), JSON.stringify(cases, null, 1))
const n = (o) => Object.values(o).reduce((a, v) => a + v.length, 0)
console.log(`envelopes ${envelopes.length} · log rows ${expectedLogs.length} · span rows ${expectedSpans.length} · mask rules ${Object.keys(cases.required).length} cases ${n(cases.required)} (every export of the SDK)`)
