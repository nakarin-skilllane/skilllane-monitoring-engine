#!/usr/bin/env node
/**
 * Load generator, one for every target. Writes one JSON result per run to --out.
 *
 *   HTTP:  node bench/load/load.mjs http --url http://localhost:5100 --profile logs|spans|mixed --env bench-load \
 *            [--steps 8,16,32,64,128] [--step-seconds 30] [--gzip] --out results/go-http-logs.json
 *          Ramps the number of concurrent connections through --steps; each step posts fixture envelopes
 *          (round-robin, 20–50 rows each) as fast as the target answers for --step-seconds. Reports per step:
 *          req/s, rows/s, p50/p95/p99 ms, error share (non-202 + timeouts). "Peak" = the highest rows/s of a
 *          step whose error share is below 0.5 %.
 *
 *   Kafka: node bench/load/load.mjs kafka --rows 500000 --profile logs --env bench-load --topic-wait 600 \
 *            --consumer-group bench-go --out results/go-kafka.json
 *          Produces --rows rows of fixture envelopes into the two topics (gzip), then waits until the consumer
 *          group's lag is 0 and reports rows/s over the drain time (start = the first commit after producing).
 *          Start the target after producing (the runner does) so the drain time is the consumer's alone.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CompressionTypes, encode, envelopes, env, fmt, kafka, pct, poster, TOPICS } from './common.mjs'

const [mode, ...rest] = process.argv.slice(2)
const args = Object.fromEntries(rest.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length))
const envName = args.env ?? 'bench-load'
const profile = args.profile ?? 'mixed'
const out = args.out

const all = await envelopes(envName)
const subset = all.filter((e) => profile === 'mixed' || e.stream === profile)
if (!subset.length) throw new Error(`no envelopes for profile ${profile}`)

function save(result) {
  if (!out) return console.log(JSON.stringify(result, null, 1))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 1))
  console.log(`saved ${out}`)
}

if (mode === 'http') {
  const url = args.url ?? 'http://localhost:5100'
  const steps = String(args.steps ?? '8,16,32,64,128').split(',').map(Number)
  const stepSeconds = Number(args['step-seconds'] ?? 30)
  const enc = encode(subset, !!args.gzip)
  if (args.gzip) for (const e of enc) e.gzip = true
  const results = []
  for (const conns of steps) {
    const post = poster(url, conns)
    const lat = []
    let req = 0
    let rows = 0
    let bytes = 0
    let errors = 0
    let next = 0
    const until = Date.now() + stepSeconds * 1000
    await Promise.all(
      Array.from({ length: conns }, async () => {
        while (Date.now() < until) {
          const e = enc[next++ % enc.length]
          const { status, ms } = await post(e)
          req++
          if (status === 202) {
            rows += e.rows
            bytes += e.bytes
            lat.push(ms)
          } else errors++
        }
      }),
    )
    lat.sort((a, b) => a - b)
    const r = {
      connections: conns,
      seconds: stepSeconds,
      requests: req,
      rows,
      reqPerS: req / stepSeconds,
      rowsPerS: rows / stepSeconds,
      mbPerS: bytes / 1e6 / stepSeconds,
      errorShare: req ? errors / req : 1,
      p50: pct(lat, 50),
      p95: pct(lat, 95),
      p99: pct(lat, 99),
    }
    results.push(r)
    console.log(`${String(conns).padStart(4)} conns · ${fmt(r.rowsPerS)} rows/s · ${fmt(r.reqPerS, 1)} req/s · ${fmt(r.mbPerS, 1)} MB/s · p50 ${fmt(r.p50, 1)} p95 ${fmt(r.p95, 1)} p99 ${fmt(r.p99, 1)} ms · errors ${(r.errorShare * 100).toFixed(2)} %`)
    // let the writer drain between steps so the next one starts clean
    await new Promise((res) => setTimeout(res, 3000))
  }
  const ok = results.filter((r) => r.errorShare < 0.005)
  const peak = ok.reduce((a, b) => (!a || b.rowsPerS > a.rowsPerS ? b : a), null)
  save({ mode, profile, url, gzip: !!args.gzip, at: new Date().toISOString(), steps: results, peak })
} else if (mode === 'kafka') {
  const targetRows = Number(args.rows ?? 500_000)
  const group = args['consumer-group']
  if (!group) throw new Error('--consumer-group is required')
  const k = kafka('bench-load')
  const admin = k.admin()
  await admin.connect()
  const existing = await admin.listTopics()
  const wanted = Object.values(TOPICS).filter((t) => !existing.includes(t))
  if (wanted.length) await admin.createTopics({ topics: wanted.map((topic) => ({ topic, numPartitions: 3 })), waitForLeaders: true })
  const producer = k.producer({ allowAutoTopicCreation: false })
  await producer.connect()
  let produced = 0
  let i = 0
  const started = Date.now()
  while (produced < targetRows) {
    const batch = []
    let n = 0
    while (n < 200 && produced < targetRows) {
      const e = subset[i++ % subset.length]
      batch.push({ topic: TOPICS[e.stream], messages: [{ key: `${e.resource['service.name']}/${e.resource['app.role']}`, value: JSON.stringify(e), headers: { 'skilllane-monitoring-stream': e.stream, 'skilllane-monitoring-v': '1' } }] })
      produced += e.items.length
      n++
    }
    await producer.sendBatch({ topicMessages: batch, compression: CompressionTypes.GZIP })
  }
  await producer.disconnect()
  console.log(`produced ${fmt(produced)} rows in ${((Date.now() - started) / 1000).toFixed(1)} s · waiting for group ${group} to drain (start the consumer now)`)

  const lagOf = async () => {
    let lag = 0
    let committed = 0
    for (const topic of Object.values(TOPICS)) {
      const ends = await admin.fetchTopicOffsets(topic)
      const offs = await admin.fetchOffsets({ groupId: group, topics: [topic] })
      for (const p of ends) {
        const c = offs[0]?.partitions.find((x) => x.partition === p.partition)
        const co = c && c.offset !== '-1' ? Number(c.offset) : 0
        committed += co
        lag += Number(p.offset) - co
      }
    }
    return { lag, committed }
  }
  const wait = Number(args['topic-wait'] ?? 600)
  const t0 = Date.now()
  let first = null
  let last = await lagOf()
  while (Date.now() - t0 < wait * 1000) {
    await new Promise((r) => setTimeout(r, 1000))
    const now = await lagOf()
    if (first === null && now.committed > last.committed) first = Date.now() - 1000
    last = now
    if (now.lag === 0 && first !== null) break
  }
  const drainS = first === null ? null : (Date.now() - first) / 1000
  await admin.disconnect()
  const r = { mode, profile, group, rows: produced, drainSeconds: drainS, rowsPerS: drainS ? produced / drainS : null, lagLeft: last.lag, at: new Date().toISOString() }
  console.log(drainS ? `drained ${fmt(produced)} rows in ${drainS.toFixed(1)} s → ${fmt(r.rowsPerS)} rows/s` : `not drained within ${wait} s (lag ${last.lag})`)
  save(r)
} else {
  console.error('usage: load.mjs http|kafka …')
  process.exit(2)
}
