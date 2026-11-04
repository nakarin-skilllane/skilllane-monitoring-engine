/**
 * Shared by verify.mjs and load.mjs: the fixture, an HTTP poster with keep-alive, a ClickHouse query, Kafka.
 * Dependencies come from apps/engine (kafkajs, @clickhouse/client): run from the repo root.
 */
import { createReadStream, existsSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { gzipSync } from 'node:zlib'
import http from 'node:http'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(here, '..', '..')
// in the loadgen image: /app/fixture next to /app/load; in the repo: bench/fixture
export const FIXTURE = existsSync(join(here, '..', 'fixture', 'envelopes.jsonl.gz')) ? join(here, '..', 'fixture') : join(ROOT, 'bench', 'fixture')
// deps: the loadgen image's own node_modules, else the engine's (kafkajs, @clickhouse/client are its dependencies)
const ownRequire = createRequire(import.meta.url)
let require = ownRequire
try {
  ownRequire.resolve('kafkajs')
} catch {
  require = createRequire(join(ROOT, 'apps', 'engine', 'package.json'))
}
export const { Kafka, CompressionTypes, logLevel } = require('kafkajs')
export const { createClient } = require('@clickhouse/client')

export const env = (name, fallback) => process.env[name] ?? fallback

/** Every line of a .jsonl (or .jsonl.gz) as parsed objects. */
export async function readJsonl(file) {
  const out = []
  const stream = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file)
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line) out.push(JSON.parse(line))
  return out
}

/** The fixture envelopes with `deployment.environment.name` set to `envName`. */
/** `<name>.jsonl` of the fixture, or its committed `.gz` (the plain files are regenerated, not committed). */
export const fixtureFile = (name) => (existsSync(join(FIXTURE, `${name}.jsonl`)) ? join(FIXTURE, `${name}.jsonl`) : join(FIXTURE, `${name}.jsonl.gz`))

export async function envelopes(envName) {
  const list = await readJsonl(fixtureFile('envelopes'))
  for (const e of list) e.resource['deployment.environment.name'] = envName
  return list
}

/** Pre-encoded bodies: JSON bytes and gzip bytes per envelope (built once, posted many times). */
export function encode(list, gzip) {
  return list.map((e) => {
    const json = Buffer.from(JSON.stringify(e))
    return { stream: e.stream, body: gzip ? gzipSync(json) : json, rows: e.items.length, bytes: json.length }
  })
}

export const clickhouse = () =>
  createClient({
    url: env('CLICKHOUSE_URL', 'http://localhost:8123'),
    username: env('CLICKHOUSE_USER', 'skilllane_monitoring'),
    password: env('CLICKHOUSE_PASSWORD', 'skilllane_monitoring'),
    database: env('CLICKHOUSE_DATABASE', 'skilllane_monitoring'),
    request_timeout: 120_000,
  })

export async function query(ch, sql, params = {}) {
  const r = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow', clickhouse_settings: { output_format_json_quote_64bit_integers: 0 } })
  return r.json()
}

/** One keep-alive agent per target so connections are reused across the run. */
export function poster(baseUrl, maxSockets) {
  const url = new URL(baseUrl)
  const agent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets })
  /** Resolves { status, ms }; never rejects (a socket error counts as status 0). */
  return (enc, timeoutMs = 30_000) =>
    new Promise((resolve) => {
      const started = process.hrtime.bigint()
      const done = (status) => resolve({ status, ms: Number(process.hrtime.bigint() - started) / 1e6 })
      const req = http.request(
        {
          agent,
          host: url.hostname,
          port: url.port,
          method: 'POST',
          path: `/api/ingest/${enc.stream}`,
          headers: { 'content-type': 'application/json', 'content-length': enc.body.length, ...(enc.gzip ? { 'content-encoding': 'gzip' } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume()
          res.on('end', () => done(res.statusCode ?? 0))
        },
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', () => done(0))
      req.end(enc.body)
    })
}

export const kafka = (clientId) =>
  new Kafka({ clientId, brokers: env('LOG_KAFKA_BROKERS', 'localhost:29092').split(','), logLevel: logLevel.NOTHING })

export const TOPICS = { logs: 'skilllane-monitoring.logs', spans: 'skilllane-monitoring.spans' }

export const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0)
export const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d })
