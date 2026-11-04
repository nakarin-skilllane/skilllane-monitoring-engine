#!/usr/bin/env node
/**
 * The benchmark's fixture, from the engine's own mappers and the SDK's own mask rules (never hand-written):
 *
 *   envelopes.jsonl      2,000 envelopes (logs + spans; some from a sender that masked, most not) — the input
 *   expected-logs.jsonl  the rows apps/engine mapLog makes of them, in order
 *   expected-spans.jsonl the rows mapSpan makes (I/O columns left out: the prototypes do not port span I/O)
 *   mask-cases.json      every mask rule of skilllane-monitoring/contract with inputs and outputs: `required`
 *                        rules a prototype must pass, `optional` ones it may skip (counted in the report)
 *
 * Run from the repo root after `pnpm --filter @skilllane/monitoring-engine build`:
 *   node bench/fixture/generate.mjs
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

function spanItem(t, service) {
  const start = BigInt(t) * 1000000n + BigInt(int(0, 999999))
  const dur = BigInt(int(1, 900)) * 1000000n
  const isDb = rand() < 0.4
  const route = pick(ROUTES)
  return {
    traceId: hex(32),
    spanId: hex(16),
    parentSpanId: isDb ? hex(16) : '',
    name: isDb ? 'oracledb.Connection.execute:SELECT' : `GET ${route}`,
    kind: isDb ? 'CLIENT' : 'SERVER',
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + dur).toString(),
    status: { code: rand() < 0.03 ? 'ERROR' : 'UNSET', message: rand() < 0.03 ? 'token=abc rejected for a@b.th' : '' },
    scope: { name: isDb ? '@opentelemetry/instrumentation-oracledb' : '@opentelemetry/instrumentation-http' },
    attributes: isDb
      ? { 'db.system': 'oracle', 'db.statement': pick(SQL), 'server.address': 'oracle', 'server.port': 1521, 'db.user': 'app' }
      : {
          'http.request.method': 'GET',
          'http.route': route,
          'url.path': route.replace(':id', String(int(1, 5000))),
          'url.full': `https://school.ac.th${route}?token=abc`,
          'http.response.status_code': pick([200, 200, 404, 500]),
          'user_agent.original': 'Mozilla/5.0',
          'client.address': '10.0.0.5',
          'skilllane.user.email': 'a@b.th',
        },
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
  const items = Array.from({ length: n }, (_, k) => (stream === 'logs' ? logItem(t + k * 7, service, role, i * 100 + k) : spanItem(t + k * 7, service)))
  envelopes.push({ v: c.CONTRACT_VERSION, stream, resource: res, sentAt: iso(t + n * 7 + 50), items })
  t += n * 7 + 100
}

const expectedLogs = []
const expectedSpans = []
const IO_COLUMNS = new Set(['req_headers', 'res_headers', 'req_body', 'res_body', 'req_body_size', 'res_body_size', 'req_body_truncated', 'res_body_truncated', 'msg_body', 'msg_headers', 'db_params', 'url_query', 'has_query'])
for (const e of envelopes) {
  for (const item of e.items) {
    if (e.stream === 'logs') expectedLogs.push(mapLog(item, e.resource, e.sentAt))
    else {
      const row = mapSpan(item, e.resource)
      for (const k of Object.keys(row)) if (IO_COLUMNS.has(k) || /^(req|res|msg)_|_size$|_truncated$/.test(k)) delete row[k]
      expectedSpans.push(row)
    }
  }
}

// ---------- mask cases: every rule, from the SDK itself ----------
const texts = [
  ...SENSITIVE,
  'plain text with no secrets ไทย 123',
  'ids 1101700230451 and 1101700230452 (second fails checksum)',
  'nested key = "value" and other: 42, token=xyz; x',
  'email runs a@b.th,c@d.org and not-an-email@',
  'https://u:p@host/path?x=1#frag',
  '',
]
const keys = ['password', 'confirmPassword', 'token', 'secret', 'apiKey', 'x-api-key', 'authorization', 'email', 'name', 'format', 'tokenType', 'passwordChangedAt', 'user_id', 'citizen_id', 'otp', 'pin']
const paths = [
  ['/classes/118/students', '/classes/:id/students'],
  ['/users/u_1029/profile', ''],
  ['/exams/4402/submit?token=abc', '/exams/:id/submit'],
  ['/files/a%40b.th/download', '/files/:name/download'],
]
const sqlCases = SQL.concat([`SELECT 1`, `select * from t where a in (1,2,3) and b = ?`])
const cases = {
  required: {
    redactValue: texts.map((input) => ({ input, output: c.redactValue(input) })),
    redactText: texts.map((input) => ({ input, output: c.redactText(input) })),
    isSensitiveKey: keys.map((input) => ({ input, output: c.isSensitiveKey(input) })),
    maskSql: sqlCases.map((input) => ({ input, output: c.maskSql(input) })),
    maskPathByRoute: paths.map(([path, route]) => ({ input: [path, route], output: c.maskPathByRoute(path, route) })),
  },
  optional: {
    maskJsonText: ['{"email":"a@b.th","token":"x","n":1}', '[{"password":"p"}]', 'not json token=abc'].map((input) => ({ input, output: c.maskJsonText(input) })),
    maskUrl: ['https://u:p@h/p?token=1&x=2', '/a?b=c@d.th'].map((input) => ({ input, output: c.maskUrl(input) })),
    maskQuery: ['token=1&x=2&email=a@b.th', 'page=2'].map((input) => ({ input, output: c.maskQuery(input) })),
    maskHeaderJson: ['{"authorization":"Bearer x","cookie":"s=1","accept":"*/*"}'].map((input) => ({ input, output: c.maskHeaderJson(input) })),
    maskHeaderValue: [['authorization', 'Bearer x'], ['cookie', 'a=1; session=2'], ['accept', 'text/html']].map(([n, v]) => ({ input: [n, v], output: c.maskHeaderValue(n, v) })),
    isSensitiveHeader: ['authorization', 'cookie', 'x-api-key', 'accept'].map((input) => ({ input, output: c.isSensitiveHeader(input) })),
    maskStatement: SQL.map((input) => ({ input: [input, 'oracle'], output: c.maskStatement(input, 'oracle', 65536) })),
    maskIdentifier: ['session:abc', 'user:1029', 'password_reset:xyz'].map((input) => ({ input, output: c.maskIdentifier(input) })),
    isThaiNationalId: ['1101700230451', '1101700230452', '0101700230451'].map((input) => ({ input, output: c.isThaiNationalId(input) })),
    maskNumber: ['1101700230451', '42', '0812345678'].map((input) => ({ input, output: c.maskNumber(input) })),
    redisCommand: [['set', ['session:abc', 'tok']], ['get', ['user:1']], ['hset', ['h', 'password', 'p']]].map(([n, a]) => ({ input: [n, a], output: c.redisCommand(n, a, 4096) })),
  },
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
writeFileSync(join(here, 'envelopes.jsonl'), jsonl(envelopes))
writeFileSync(join(here, 'expected-logs.jsonl'), jsonl(expectedLogs))
writeFileSync(join(here, 'expected-spans.jsonl'), jsonl(expectedSpans))
writeFileSync(join(here, 'mask-cases.json'), JSON.stringify(cases, null, 1))
const n = (o) => Object.values(o).reduce((a, v) => a + v.length, 0)
console.log(`envelopes ${envelopes.length} · log rows ${expectedLogs.length} · span rows ${expectedSpans.length} · mask cases required ${n(cases.required)} optional ${n(cases.optional)}`)
