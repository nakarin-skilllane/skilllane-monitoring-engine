#!/usr/bin/env node
/**
 * bench/results/*.json + *.stats.csv → bench/RESULTS.md (every run) and bench/results/summary.json (medians per
 * target and profile, for the report). Run after bench/run.sh.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fmt } from './common.mjs'

const dir = join('bench', 'results')
const files = readdirSync(dir)
const targets = [...new Set(files.map((f) => f.split('-')[0]))].filter((t) => files.some((f) => f.startsWith(`${t}-http-`)))
const median = (xs) => {
  const s = [...xs].filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
const mb = (text) => {
  const m = /([\d.]+)\s*(KiB|MiB|GiB|B)/.exec(text)
  if (!m) return null
  const v = Number(m[1])
  return m[2] === 'GiB' ? v * 1024 : m[2] === 'MiB' ? v : m[2] === 'KiB' ? v / 1024 : v / 1048576
}
/** docker stats csv → { cpuAvg (% of one core), cpuMax, rssMax (MiB) } over the samples. */
function stats(file) {
  if (!existsSync(file)) return {}
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  const cpu = rows.map((r) => Number(r.split(',')[0].replace('%', ''))).filter(Number.isFinite)
  const rss = rows.map((r) => mb(r.split(',')[1] ?? '')).filter((x) => x !== null)
  return { cpuAvg: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : null, cpuMax: cpu.length ? Math.max(...cpu) : null, rssMax: rss.length ? Math.max(...rss) : null }
}

const summary = {}
let md = `# Ingest benchmark results\n\nGenerated ${new Date().toISOString()} by bench/load/summarize.mjs. One target at a time, same CPU / memory budget (bench/docker-compose.yml).\n`
for (const t of targets) {
  const s = (summary[t] = { image: null, verify: null, http: {}, kafka: {} })
  const img = join(dir, `${t}-image-bytes.txt`)
  if (existsSync(img)) s.image = Number(readFileSync(img, 'utf8')) / 1048576
  const ver = join(dir, `${t}-verify.txt`)
  if (existsSync(ver)) s.verify = /→ OK[\s\S]*→ OK/.test(readFileSync(ver, 'utf8'))
  md += `\n## ${t}\n\nimage ${s.image ? `${fmt(s.image)} MiB` : '–'} · verify ${s.verify === null ? '–' : s.verify ? 'OK' : 'FAIL'}\n\n### HTTP\n\n| profile | run | peak rows/s | at conns | req/s | MB/s | p50 | p95 | p99 | CPU avg | CPU max | RSS max |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`
  for (const profile of ['logs', 'spans', 'mixed']) {
    const runs = files.filter((f) => f.startsWith(`${t}-http-${profile}-`) && f.endsWith('.json')).sort()
    const rows = []
    for (const f of runs) {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      const st = stats(join(dir, f.replace('.json', '.stats.csv')))
      const p = r.peak
      rows.push({ ...st, peak: p })
      md += `| ${profile} | ${f.match(/-(\d+)\.json$/)[1]} | ${p ? fmt(p.rowsPerS) : '–'} | ${p?.connections ?? '–'} | ${p ? fmt(p.reqPerS, 1) : '–'} | ${p ? fmt(p.mbPerS, 1) : '–'} | ${p ? fmt(p.p50, 1) : '–'} | ${p ? fmt(p.p95, 1) : '–'} | ${p ? fmt(p.p99, 1) : '–'} | ${st.cpuAvg ? fmt(st.cpuAvg) + '%' : '–'} | ${st.cpuMax ? fmt(st.cpuMax) + '%' : '–'} | ${st.rssMax ? fmt(st.rssMax) + ' MiB' : '–'} |\n`
    }
    if (rows.length) {
      s.http[profile] = {
        runs: rows.length,
        rowsPerS: median(rows.map((x) => x.peak?.rowsPerS)),
        reqPerS: median(rows.map((x) => x.peak?.reqPerS)),
        mbPerS: median(rows.map((x) => x.peak?.mbPerS)),
        p50: median(rows.map((x) => x.peak?.p50)),
        p95: median(rows.map((x) => x.peak?.p95)),
        p99: median(rows.map((x) => x.peak?.p99)),
        connections: median(rows.map((x) => x.peak?.connections)),
        cpuAvg: median(rows.map((x) => x.cpuAvg)),
        cpuMax: median(rows.map((x) => x.cpuMax)),
        rssMax: median(rows.map((x) => x.rssMax)),
      }
    }
  }
  md += `\n### Kafka (drain of produced rows)\n\n| run | rows | drain s | rows/s | CPU avg | CPU max | RSS max |\n|---|---|---|---|---|---|---|\n`
  const kruns = files.filter((f) => /^.+-kafka-\d+\.json$/.test(f) && f.startsWith(`${t}-kafka-`)).sort()
  const krows = []
  for (const f of kruns) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const st = stats(join(dir, f.replace('.json', '.stats.csv')))
    krows.push({ ...r, ...st })
    md += `| ${f.match(/-(\d+)\.json$/)[1]} | ${fmt(r.rows)} | ${r.drainSeconds ? fmt(r.drainSeconds, 1) : 'not drained'} | ${r.rowsPerS ? fmt(r.rowsPerS) : '–'} | ${st.cpuAvg ? fmt(st.cpuAvg) + '%' : '–'} | ${st.cpuMax ? fmt(st.cpuMax) + '%' : '–'} | ${st.rssMax ? fmt(st.rssMax) + ' MiB' : '–'} |\n`
  }
  if (krows.length) s.kafka = { runs: krows.length, rowsPerS: median(krows.map((x) => x.rowsPerS)), drainSeconds: median(krows.map((x) => x.drainSeconds)), cpuAvg: median(krows.map((x) => x.cpuAvg)), cpuMax: median(krows.map((x) => x.cpuMax)), rssMax: median(krows.map((x) => x.rssMax)) }
}
writeFileSync(join('bench', 'RESULTS.md'), md)
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1))
console.log(`targets: ${targets.join(', ')} → bench/RESULTS.md, ${join(dir, 'summary.json')}`)
