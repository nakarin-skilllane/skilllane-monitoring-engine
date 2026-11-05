#!/usr/bin/env node
/**
 * Correctness gate: posts every fixture envelope to a target, reads the rows back from ClickHouse and compares
 * every column with what the Node mappers produced (bench/fixture/expected-*.jsonl). A target that differs fails.
 *
 *   node bench/load/verify.mjs --url http://localhost:5100 --env bench-go
 *   CLICKHOUSE_URL=http://localhost:18123 node bench/load/verify.mjs --url … --env … --delete
 *
 * Rows are matched by (timestamp, trace_id, span_id, message) for logs and (trace_id, span_id) for spans. Columns
 * compared as JSON after normalising: numbers vs numeric strings, null vs 0 for duration, map key order.
 * Span I/O columns are not compared (the prototypes do not port span I/O). Exits 1 on any difference.
 */
import { clickhouse, encode, envelopes, fixtureFile, poster, query, readJsonl } from './common.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length))
const url = args.url ?? 'http://localhost:5100'
const envName = args.env ?? 'bench-verify'
const concurrency = Number(args.concurrency ?? 16)

const list = await envelopes(envName)
const enc = encode(list, false)
const post = poster(url, concurrency)
const statuses = new Map()
let i = 0
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (i < enc.length) {
      const { status } = await post(enc[i++], 120_000)
      statuses.set(status, (statuses.get(status) ?? 0) + 1)
    }
  }),
)
console.log(`posted ${enc.length} envelopes → ${[...statuses].map(([s, n]) => `${s}×${n}`).join(' ')}`)
if (statuses.get(202) !== enc.length) {
  console.error('FAIL: not every envelope was accepted')
  process.exit(1)
}

const ch = clickhouse()
const expectedLogs = (await readJsonl(fixtureFile('expected-logs'))).map((r) => ({ ...r, env: envName }))
// the span row keeps the whole resource map: its env was rewritten in the posted envelopes too
const expectedSpans = (await readJsonl(fixtureFile('expected-spans'))).map((r) => ({ ...r, env: envName, resource: { ...r.resource, 'deployment.environment.name': envName } }))

// wait for the last batch to land (flush 1 s + insert)
for (let tries = 0; tries < 60; tries++) {
  const [{ n }] = await query(ch, `SELECT count() AS n FROM logs WHERE env = {e:String}`, { e: envName })
  const [{ m }] = await query(ch, `SELECT count() AS m FROM spans WHERE env = {e:String}`, { e: envName })
  if (Number(n) >= expectedLogs.length && Number(m) >= expectedSpans.length) break
  await new Promise((r) => setTimeout(r, 1000))
}

const LOG_COLS = Object.keys(expectedLogs[0])
const SPAN_COLS = Object.keys(expectedSpans[0]).filter((k) => !/^(req|res|msg)_|_size$|_truncated$|^db_params$|^url_query$|^has_query$/.test(k))
const sel = (cols) => cols.map((c) => (c === 'duration_ns' ? 'toString(duration_ns) AS duration_ns' : c === 'timestamp' ? "formatDateTime(timestamp, '%Y-%m-%d %H:%i:%S.%f', 'UTC') AS timestamp" : c)).join(', ')
const gotLogs = await query(ch, `SELECT ${sel(LOG_COLS)} FROM logs WHERE env = {e:String}`, { e: envName })
const gotSpans = await query(ch, `SELECT ${sel(SPAN_COLS)} FROM spans WHERE env = {e:String}`, { e: envName })

/** A comparable value: ClickHouse returns numbers for UInt, strings for DateTime64; keep maps as sorted JSON. */
function norm(col, v, table) {
  if (v === null || v === undefined) return col === 'duration_ms' ? null : ''
  if (col === 'timestamp') {
    // logs are DateTime64(3): the expected has 3 decimals, ClickHouse %f gives 6 → cut to the table's precision
    const digits = table === 'logs' ? 3 : 6
    const s = String(v)
    return s.includes('.') ? s.slice(0, s.indexOf('.') + 1 + digits) : s
  }
  if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(Object.fromEntries(Object.entries(v).sort()))
  if (Array.isArray(v)) return JSON.stringify(v.map(String))
  if (col === 'duration_ms') return Math.round(Number(v) * 1000) / 1000
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return String(v)
}

function compare(table, cols, expected, got, keyOf) {
  const byKey = new Map(got.map((r) => [keyOf(r), r]))
  let missing = 0
  const diffs = new Map()
  const samples = []
  for (const e of expected) {
    const g = byKey.get(keyOf(e))
    if (!g) {
      missing++
      if (samples.length < 3) samples.push({ missing: keyOf(e) })
      continue
    }
    for (const col of cols) {
      const a = norm(col, e[col], table)
      const b = norm(col, g[col], table)
      if (a !== b) {
        diffs.set(col, (diffs.get(col) ?? 0) + 1)
        if (samples.length < 8) samples.push({ col, key: keyOf(e), expected: String(a).slice(0, 120), got: String(b).slice(0, 120) })
      }
    }
  }
  const extra = got.length - (expected.length - missing)
  const ok = !missing && !diffs.size && extra === 0
  console.log(`${table}: expected ${expected.length}, got ${got.length}, missing ${missing}, extra ${extra}, columns differing: ${diffs.size ? [...diffs].map(([c, n]) => `${c}(${n})`).join(' ') : 'none'} → ${ok ? 'OK' : 'FAIL'}`)
  for (const s of samples) console.log('  ', JSON.stringify(s))
  return ok
}

const okLogs = compare('logs', LOG_COLS, expectedLogs, gotLogs, (r) => `${norm('timestamp', r.timestamp, 'logs')}|${r.trace_id}|${r.span_id}|${r.message}`)
// the fixture generator's ids repeat (weak RNG): the time makes the key unique
const okSpans = compare('spans', SPAN_COLS, expectedSpans, gotSpans, (r) => `${r.trace_id}|${r.span_id}|${norm('timestamp', r.timestamp, 'spans')}`)

if (args.delete) {
  for (const t of ['logs', 'spans']) await ch.command({ query: `ALTER TABLE ${t} DELETE WHERE env = '${envName.replace(/[^a-z0-9_-]/gi, '')}'`, clickhouse_settings: { mutations_sync: '2' } })
  console.log('rows deleted')
}
await ch.close()
process.exit(okLogs && okSpans ? 0 : 1)
