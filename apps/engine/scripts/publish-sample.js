#!/usr/bin/env node
/**
 * Publishes realistic sample envelopes (the skilllane-monitoring/contract wire format) to the
 * queue the engine consumes, the same way skilllane-monitoring does:
 *   logs : an error line with hint/fix/labels, http.request lines, job lines,
 *          a dependency line, app.shutdown with job.inflight
 *   spans: a SERVER root with CLIENT children (old and new semconv), a remote
 *          child in a second service, and a plain read trace
 *
 * Usage (from apps/engine):
 *   LOG_EXPORT=kafka node scripts/publish-sample.js --env ingest-test-kafka
 *   node scripts/publish-sample.js --transport rabbitmq --env dev --repeat 20 --bad
 * Options:
 *   --env <name>        deployment.environment.name of every envelope (default ingest-test)
 *   --transport <name>  kafka | rabbitmq | bullmq (default: LOG_EXPORT, resolved like the SDK)
 *   --repeat <n>        sample sets to send, each with new trace ids (default 1)
 *   --bad               also send two invalid messages and one invalid span item
 * Reads the same env vars as the SDK and engine (LOG_KAFKA_BROKERS, LOG_RABBITMQ_URL,
 * LOG_BULLMQ_REDIS_URL, LOG_TOPIC_*, ...); a repo-root .env is loaded when present.
 */
'use strict'
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { randomBytes } = require('node:crypto')

const rootEnv = join(__dirname, '..', '..', '..', '.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const contract = require('skilllane-monitoring/contract')

// ---------- args ----------
function parseArgs(argv) {
  const args = { env: 'ingest-test', transport: undefined, repeat: 1, bad: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--env') args.env = next()
    else if (a.startsWith('--env=')) args.env = a.slice(6)
    else if (a === '--transport') args.transport = next()
    else if (a.startsWith('--transport=')) args.transport = a.slice(12)
    else if (a === '--repeat') args.repeat = Number(next())
    else if (a.startsWith('--repeat=')) args.repeat = Number(a.slice(9))
    else if (a === '--bad') args.bad = true
    else if (a === '-h' || a === '--help') {
      console.log('node scripts/publish-sample.js [--env name] [--transport kafka|rabbitmq|bullmq] [--repeat n] [--bad]')
      process.exit(0)
    } else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isInteger(args.repeat) || args.repeat < 1) args.repeat = 1
  return args
}

// ---------- sample data ----------
const hex = (bytes) => randomBytes(bytes).toString('hex')
const nanos = (ms, extraNs = 0) => (BigInt(Math.round(ms * 1000)) * 1000n + BigInt(extraNs)).toString()
const iso = (ms) => new Date(ms).toISOString()

function resource(env, service, role, extra = {}) {
  return {
    'service.name': service,
    'service.version': service === 'school-etl-api' ? '0.9.1' : '1.4.2',
    'deployment.environment.name': env,
    'host.name': service === 'school-etl-api' ? 'ip-10-0-4-22' : 'ip-10-0-3-17',
    'app.role': role,
    'telemetry.sdk.name': 'skilllane-monitoring',
    'telemetry.sdk.version': '0.2.0',
    ...extra,
  }
}

function envelope(stream, res, items) {
  return { v: contract.CONTRACT_VERSION, stream, resource: res, sentAt: new Date().toISOString(), items }
}

const ORA_MESSAGE =
  'ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)'
const INSERT_SQL = 'INSERT INTO "QUESTION_BANK"("ID", "TITLE", "SCHOOL_ID", "CREATED_AT") VALUES (:1, :2, :3, :4)'

/** One sample set: returns { envelopes: [{stream, resource, items}], traceIds }. */
function sampleSet(env) {
  const t0 = Date.now() - 500
  const importTrace = hex(16)
  const readTrace = hex(16)
  const ids = {
    importRoot: hex(8),
    importCmd: hex(8),
    etlClient: hex(8),
    etlServer: hex(8),
    oracleInsert: hex(8),
    readRoot: hex(8),
    redisGet: hex(8),
    oracleSelect: hex(8),
  }
  const user = { 'user.id': 'u_1029', 'user.roles': ['teacher'], 'organization.id': 's_118' }
  const coreApi = resource(env, 'school-core-api', 'api')
  const etlApi = resource(env, 'school-etl-api', 'api')
  // Worker resource without env and role: the engine falls back to the record fields.
  const coreWorker = resource(env, 'school-core-api', 'worker')
  delete coreWorker['deployment.environment.name']
  delete coreWorker['app.role']

  const apiLogs = [
    {
      '@timestamp': iso(t0 + 180),
      'log.level': 'error',
      'log.logger': 'ImportQuestionBankHandler',
      'service.name': 'school-core-api/api',
      'event.code': 'app.log',
      message: 'Failed to import question bank',
      'trace.id': importTrace,
      'span.id': ids.importCmd,
      ...user,
      'http.request.method': 'POST',
      'http.route': '/question-bank/import',
      'url.path': '/question-bank/import',
      'error.type': 'QueryFailedError',
      'error.code': 'ORA-12899',
      'error.message': ORA_MESSAGE,
      'error.hint': 'Value too long for column',
      'error.hint_detail': 'A text value exceeds the column size. Common in Excel imports; validate length before saving.',
      'error.fix': 'QuestionBankEntity.title got 312 (max 255). Validate the length of title before saving, or widen the column.',
      'error.stack_trace':
        'QueryFailedError: ' + ORA_MESSAGE + '\n    at OracleQueryRunner.query (node_modules/typeorm/driver/oracle/OracleQueryRunner.js:187:19)\n    at ImportQuestionBankHandler.execute (dist/src/domain/question-bank/commands/import-question-bank.handler.js:41:9)',
      'error.cause': { type: 'Error', message: ORA_MESSAGE, code: 'ORA-12899', errorNum: 12899 },
      'log.origin.function': 'ImportQuestionBankHandler.execute',
      'log.origin.file.name': 'src/domain/question-bank/commands/import-question-bank.handler.ts',
      'db.statement': INSERT_SQL,
      labels: {
        usecase: 'ImportQuestionBankCommand',
        failed_step: 'oracle INSERT QUESTION_BANK',
        error_category: 'data',
        error_target: 'QuestionBankEntity.title',
        correlation_id: 'imp-' + hex(4),
        excel_sheet: 'Sheet1',
      },
    },
    {
      '@timestamp': iso(t0 + 184),
      'log.level': 'error',
      'log.logger': 'HTTP',
      'service.name': 'school-core-api/api',
      'event.code': 'http.request',
      message: 'POST /question-bank/import 500',
      'trace.id': importTrace,
      'span.id': ids.importRoot,
      ...user,
      'http.request.method': 'POST',
      'http.route': '/question-bank/import',
      'url.path': '/question-bank/import',
      'url.domain': 'school-core-api.local',
      'http.response.status_code': 500,
      'http.request.id': importTrace,
      duration_ms: 184.237,
      'error.type': 'QueryFailedError',
      'error.code': 'ORA-12899',
      labels: { usecase: 'ImportQuestionBankCommand' },
    },
    {
      '@timestamp': iso(t0 + 60),
      'log.level': 'info',
      'log.logger': 'HTTP',
      'service.name': 'school-core-api/api',
      'event.code': 'http.request',
      message: 'GET /question-bank/my 200',
      'trace.id': readTrace,
      'span.id': ids.readRoot,
      ...user,
      'http.request.method': 'GET',
      'http.route': '/question-bank/my',
      'url.path': '/question-bank/my',
      'url.domain': 'school-core-api.local',
      'http.response.status_code': 200,
      duration_ms: 42.7,
    },
    {
      '@timestamp': iso(t0 + 90),
      'log.level': 'warn',
      'log.logger': 'DependencyMonitor',
      'service.name': 'school-core-api/api',
      'event.code': 'dependency.down',
      'event.module': 'bullmq',
      message: 'redis "cache" is down',
      'dependency.type': 'redis',
      'dependency.name': 'cache',
      'dependency.host': 'localhost',
      'dependency.port': 6391,
      'dependency.attempt': 3,
      'dependency.affects': ['GET /question-bank/my', 'report:generate'],
      'error.type': 'Error',
      'error.code': 'ECONNREFUSED',
      'error.message': 'connect ECONNREFUSED 127.0.0.1:6391',
      'error.hint': 'Redis is not reachable',
      labels: { error_category: 'dependency', error_target: 'localhost:6391' },
    },
  ]

  const workerLogs = [
    {
      '@timestamp': iso(t0 + 300),
      'log.level': 'warn',
      'log.logger': 'ReportProcessor',
      'service.name': 'school-core-api/worker',
      'service.environment': env,
      'event.code': 'job.retry',
      'event.module': 'bullmq',
      message: 'Job report:generate failed; retrying',
      'trace.id': hex(16),
      'job.queue': 'reports',
      'job.type': 'report:generate',
      'job.id': '1834',
      'job.attempt': 2,
      'job.max_attempts': 3,
      'job.started_at': iso(t0 - 512),
      duration_ms: 812.4,
      'error.type': 'GaxiosError',
      'error.code': 'rateLimitExceeded',
      'error.message': 'Rate Limit Exceeded',
      'error.hint': 'Google API rate limit exceeded',
      'error.fix': 'Back off and retry; ask for a higher quota for the Sheets API project.',
      labels: { error_category: 'dependency', usecase: 'GenerateReport' },
    },
    {
      '@timestamp': iso(t0 + 340),
      'log.level': 'error',
      'log.logger': 'ReportProcessor',
      'service.name': 'school-core-api/worker',
      'service.environment': env,
      'event.code': 'job.failed',
      'event.module': 'bullmq',
      message: 'Job report:generate failed after 3 attempts',
      'job.queue': 'reports',
      'job.type': 'report:generate',
      'job.id': '1834',
      'job.attempt': 3,
      'job.max_attempts': 3,
      'job.final': true,
      duration_ms: 790,
      'error.type': 'GaxiosError',
      'error.code': 'rateLimitExceeded',
      'error.message': 'Rate Limit Exceeded',
      'error.hint': 'Google API rate limit exceeded',
      dlq: false,
      labels: { error_category: 'dependency', usecase: 'GenerateReport' },
    },
    {
      '@timestamp': iso(t0 + 400),
      'log.level': 'info',
      'log.logger': 'App',
      'service.name': 'school-core-api/worker',
      'service.environment': env,
      'event.code': 'app.shutdown',
      message: 'Shutting down',
      signal: 'SIGTERM',
      'job.inflight': ['job:report:generate#1835', 'task:cache:rebuild_school_list'],
    },
  ]

  const etlLogs = [
    {
      '@timestamp': iso(t0 + 120),
      'log.level': 'info',
      'log.logger': 'HTTP',
      'service.name': 'school-etl-api/api',
      'event.code': 'http.request',
      message: 'POST /etl/parse-excel 200',
      'trace.id': importTrace,
      'span.id': ids.etlServer,
      ...user,
      'http.request.method': 'POST',
      'http.route': '/etl/parse-excel',
      'url.path': '/etl/parse-excel',
      'http.response.status_code': 200,
      duration_ms: 95.5,
    },
  ]

  const exceptionEvent = (ms, type, message) => ({
    name: 'exception',
    timeUnixNano: nanos(ms),
    attributes: { 'exception.type': type, 'exception.message': message, 'exception.stacktrace': `${type}: ${message}` },
  })

  const coreSpans = [
    {
      traceId: importTrace,
      spanId: ids.importRoot,
      name: 'POST /question-bank/import',
      kind: 'SERVER',
      startTimeUnixNano: nanos(t0, 123),
      endTimeUnixNano: nanos(t0 + 184.237, 456),
      status: { code: 'ERROR', message: ORA_MESSAGE },
      attributes: {
        'http.request.method': 'POST',
        'http.route': '/question-bank/import',
        'url.path': '/question-bank/import',
        'url.scheme': 'http',
        'http.response.status_code': 500,
        'server.address': 'localhost',
        'server.port': 5101,
        'user_agent.original': 'skilllane-monitoring-traffic/1.0',
        'enduser.id': 'u_1029',
      },
      events: [exceptionEvent(t0 + 183, 'QueryFailedError', ORA_MESSAGE)],
      scope: { name: '@opentelemetry/instrumentation-http', version: '0.57.2' },
    },
    {
      traceId: importTrace,
      spanId: ids.importCmd,
      parentSpanId: ids.importRoot,
      name: 'ImportQuestionBankCommand',
      kind: 'INTERNAL',
      startTimeUnixNano: nanos(t0 + 2),
      endTimeUnixNano: nanos(t0 + 182),
      status: { code: 'ERROR', message: ORA_MESSAGE },
      attributes: { 'cqrs.type': 'command', 'cqrs.name': 'ImportQuestionBankCommand' },
      scope: { name: 'skilllane-monitoring' },
    },
    {
      // Old semconv (instrumentation-http < 0.5x): http.method, http.url, net.peer.*
      traceId: importTrace,
      spanId: ids.etlClient,
      parentSpanId: ids.importCmd,
      name: 'POST',
      kind: 'CLIENT',
      startTimeUnixNano: nanos(t0 + 5),
      endTimeUnixNano: nanos(t0 + 110),
      status: { code: 'UNSET' },
      attributes: {
        'http.method': 'POST',
        'http.url': 'http://localhost:5102/etl/parse-excel?sheet=1&token=secret',
        'http.status_code': 200,
        'net.peer.name': 'localhost',
        'net.peer.port': 5102,
        'http.flavor': '1.1',
      },
      scope: { name: '@opentelemetry/instrumentation-http', version: '0.57.2' },
    },
    {
      // New semconv: db.system.name, db.query.text, server.address/port
      traceId: importTrace,
      spanId: ids.oracleInsert,
      parentSpanId: ids.importCmd,
      name: 'oracle INSERT QUESTION_BANK',
      kind: 'CLIENT',
      startTimeUnixNano: nanos(t0 + 120),
      endTimeUnixNano: nanos(t0 + 178.5),
      status: { code: 'ERROR', message: ORA_MESSAGE },
      attributes: {
        'db.system.name': 'oracle',
        'db.query.text': INSERT_SQL,
        'db.operation.name': 'INSERT',
        'db.collection.name': 'QUESTION_BANK',
        'server.address': 'oracle-db.internal',
        'server.port': 1521,
        'oracle.rows': 0,
        'oracle.batch': true,
      },
      events: [exceptionEvent(t0 + 178, 'Error', ORA_MESSAGE)],
      scope: { name: 'school-core-api' },
    },
    {
      traceId: readTrace,
      spanId: ids.readRoot,
      name: 'GET /question-bank/my',
      kind: 'SERVER',
      startTimeUnixNano: nanos(t0 + 17.3),
      endTimeUnixNano: nanos(t0 + 60),
      status: { code: 'UNSET' },
      attributes: {
        'http.request.method': 'GET',
        'http.route': '/question-bank/my',
        'url.path': '/question-bank/my',
        'url.query': 'page=2',
        'http.response.status_code': 200,
      },
      scope: { name: '@opentelemetry/instrumentation-http', version: '0.57.2' },
    },
    {
      // Old semconv for Redis: db.system, db.statement, net.peer.*
      traceId: readTrace,
      spanId: ids.redisGet,
      parentSpanId: ids.readRoot,
      name: 'get',
      kind: 'CLIENT',
      startTimeUnixNano: nanos(t0 + 18),
      endTimeUnixNano: nanos(t0 + 19.2),
      status: { code: 'UNSET' },
      attributes: {
        'db.system': 'redis',
        'db.statement': 'get question-bank:u_1029',
        'net.peer.name': 'localhost',
        'net.peer.port': 6391,
      },
      scope: { name: '@opentelemetry/instrumentation-ioredis', version: '0.47.0' },
    },
    {
      traceId: readTrace,
      spanId: ids.oracleSelect,
      parentSpanId: ids.readRoot,
      name: 'oracle SELECT QUESTION_BANK',
      kind: 'CLIENT',
      startTimeUnixNano: nanos(t0 + 20),
      endTimeUnixNano: nanos(t0 + 58),
      status: { code: 'OK' },
      attributes: {
        'db.system': 'oracle',
        // Longer than 2000 chars: the engine keeps the first 2000 in db_statement.
        'db.statement': 'SELECT "QB"."ID", "QB"."TITLE" FROM "QUESTION_BANK" "QB" WHERE "QB"."SCHOOL_ID" = :1 ' + 'AND 1=1 '.repeat(300),
        'server.address': 'oracle-db.internal',
      },
      scope: { name: 'school-core-api' },
    },
  ]

  const etlSpans = [
    {
      // Remote parent (traceparent from the core API): is_entry = 1.
      traceId: importTrace,
      spanId: ids.etlServer,
      parentSpanId: ids.etlClient,
      parentIsRemote: true,
      name: 'POST /etl/parse-excel',
      kind: 'SERVER',
      startTimeUnixNano: nanos(t0 + 9),
      endTimeUnixNano: nanos(t0 + 104.5),
      status: { code: 'UNSET' },
      attributes: {
        'http.method': 'POST',
        'http.target': '/etl/parse-excel?sheet=1',
        'http.route': '/etl/parse-excel',
        'http.status_code': 200,
        'net.host.name': 'localhost',
      },
      scope: { name: '@opentelemetry/instrumentation-http', version: '0.57.2' },
    },
  ]

  return {
    traceIds: { import: importTrace, read: readTrace },
    envelopes: [
      envelope('logs', coreApi, apiLogs),
      envelope('logs', coreWorker, workerLogs),
      envelope('logs', etlApi, etlLogs),
      envelope('spans', coreApi, coreSpans),
      envelope('spans', etlApi, etlSpans),
    ],
  }
}

/** Invalid input the engine must count and skip without stopping. */
function badMessages(env) {
  const badSpan = {
    traceId: hex(16),
    spanId: hex(8),
    name: 'broken span',
    kind: 'INTERNAL',
    startTimeUnixNano: 'not-a-number',
    endTimeUnixNano: '1',
    status: { code: 'UNSET' },
    attributes: {},
  }
  return [
    { stream: 'logs', raw: 'this is not json' },
    { stream: 'spans', raw: JSON.stringify({ hello: 'world' }) },
    { stream: 'spans', envelope: envelope('spans', resource(env, 'school-core-api', 'api'), [badSpan]) },
  ]
}

// ---------- transports ----------
function keyOf(res) {
  return `${res['service.name']}/${res['app.role'] ?? ''}`
}

async function kafkaPublisher() {
  const { Kafka, CompressionTypes, logLevel } = require('kafkajs')
  const brokers = (process.env.LOG_KAFKA_BROKERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (brokers.length === 0) throw new Error('LOG_KAFKA_BROKERS is empty')
  const kafka = new Kafka({ clientId: 'skilllane-monitoring-publish-sample', brokers, logLevel: logLevel.WARN })
  const { Partitioners } = require('kafkajs')
  const producer = kafka.producer({ allowAutoTopicCreation: true, createPartitioner: Partitioners.DefaultPartitioner })
  await producer.connect()
  return {
    async send(stream, body, key) {
      await producer.send({
        topic: contract.topicName(stream),
        compression: CompressionTypes.GZIP,
        messages: [
          {
            key,
            value: body,
            headers: { [contract.HEADER_STREAM]: stream, [contract.HEADER_VERSION]: String(contract.CONTRACT_VERSION) },
          },
        ],
      })
    },
    close: () => producer.disconnect(),
  }
}

async function rabbitmqPublisher() {
  const amqp = require('amqplib')
  const url = process.env.LOG_RABBITMQ_URL
  if (!url) throw new Error('LOG_RABBITMQ_URL is empty')
  const connection = await amqp.connect(url)
  const channel = await connection.createConfirmChannel()
  const exchange = contract.rabbitmqExchange()
  await channel.assertExchange(exchange, 'direct', { durable: true })
  for (const stream of contract.STREAMS) {
    const queue = contract.topicName(stream)
    await channel.assertQueue(queue, { durable: true })
    await channel.bindQueue(queue, exchange, queue)
  }
  return {
    async send(stream, body) {
      channel.publish(exchange, contract.topicName(stream), body, {
        persistent: true,
        contentType: 'application/json',
        headers: { [contract.HEADER_STREAM]: stream, [contract.HEADER_VERSION]: contract.CONTRACT_VERSION },
      })
    },
    async close() {
      await channel.waitForConfirms()
      await channel.close()
      await connection.close()
    },
  }
}

async function bullmqPublisher() {
  const { Queue } = require('bullmq')
  const IORedis = require('ioredis')
  const url = process.env.LOG_BULLMQ_REDIS_URL
  if (!url) throw new Error('LOG_BULLMQ_REDIS_URL is empty')
  const connection = new IORedis(url, { maxRetriesPerRequest: null })
  const prefix = process.env.LOG_BULLMQ_PREFIX || 'bull'
  const queues = Object.fromEntries(
    contract.STREAMS.map((stream) => [stream, new Queue(contract.topicName(stream), { connection, prefix })]),
  )
  return {
    async send(stream, body) {
      // job.data is the envelope object (or, for --bad, whatever was given).
      const data = typeof body === 'string' || Buffer.isBuffer(body) ? safeParse(body) : body
      await queues[stream].add(stream, data, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      })
    },
    async close() {
      await Promise.all(Object.values(queues).map((q) => q.close()))
      await connection.quit()
    },
  }
}

function safeParse(body) {
  try {
    return JSON.parse(body.toString())
  } catch {
    return { raw: body.toString() }
  }
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const transport = (args.transport || contract.resolveExportMode().mode).toLowerCase()
  if (!contract.isQueueTransport(transport)) {
    throw new Error(`transport "${transport}" is not a queue; set LOG_EXPORT or --transport kafka|rabbitmq|bullmq`)
  }
  const publisher =
    transport === 'kafka' ? await kafkaPublisher() : transport === 'rabbitmq' ? await rabbitmqPublisher() : await bullmqPublisher()

  const counts = { logs: 0, spans: 0, items: { logs: 0, spans: 0 }, bad: 0 }
  const traces = []
  try {
    for (let i = 0; i < args.repeat; i++) {
      const set = sampleSet(args.env)
      traces.push(set.traceIds)
      for (const env of set.envelopes) {
        const body = transport === 'bullmq' ? env : contract.encodeEnvelope(env)
        await publisher.send(env.stream, body, keyOf(env.resource))
        counts[env.stream] += 1
        counts.items[env.stream] += env.items.length
      }
    }
    if (args.bad) {
      for (const bad of badMessages(args.env)) {
        const body = bad.envelope
          ? transport === 'bullmq'
            ? bad.envelope
            : contract.encodeEnvelope(bad.envelope)
          : Buffer.from(bad.raw, 'utf8')
        await publisher.send(bad.stream, body, 'bad/sample')
        counts.bad += 1
      }
    }
  } finally {
    await publisher.close()
  }
  console.log(
    JSON.stringify(
      {
        transport,
        env: args.env,
        topics: { logs: contract.topicName('logs'), spans: contract.topicName('spans') },
        envelopes: { logs: counts.logs, spans: counts.spans },
        items: counts.items,
        badMessages: counts.bad,
        traces: traces.length <= 3 ? traces : `${traces.length} sets`,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error('publish-sample failed:', err && err.message ? err.message : err)
  process.exit(1)
})
