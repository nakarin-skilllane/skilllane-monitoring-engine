#!/usr/bin/env node
/**
 * bench/results/summary.json → an HTML fragment for the report tab (the numbers part: tiles, bars, tables). The
 * narrative around it is written by hand. Prints to stdout; the classes are the report artifact's own (tiles, panel,
 * bar, track, fill, table-wrap …).
 *
 *   node bench/load/report.mjs > /tmp/ingest-tab.html
 */
import { readFileSync } from 'node:fs'
import { fmt } from './common.mjs'

const summary = JSON.parse(readFileSync('bench/results/summary.json', 'utf8'))
const FACTS = {
  node: { label: 'Node (engine ปัจจุบัน)', color: 'var(--nest)', loc: '1,362 (ingest) + SDK mask', mask: 'ครบ (SDK เอง)' },
  go: { label: 'Go', color: 'var(--sdk)', loc: '4,843', mask: '5/5 · 27/31' },
  rust: { label: 'Rust', color: 'var(--kafka)', loc: '4,012', mask: '5/5 · 28/31' },
  dotnet: { label: 'C# / .NET 10', color: 'var(--ok)', loc: '3,283', mask: '5/5 · 10/11*' },
}
const order = ['node', 'go', 'rust', 'dotnet'].filter((t) => summary[t])
const h = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const n = (v, d = 0) => (v === null || v === undefined ? '–' : fmt(v, d))

function bars(title, unit, valueOf, scaleMax, note) {
  const max = scaleMax ?? Math.max(...order.map((t) => valueOf(t) ?? 0))
  return `<div class="panel">
  <h3>${h(title)}</h3>
  ${order
    .map((t) => {
      const v = valueOf(t)
      const w = v === null || v === undefined ? 0 : Math.min(100, (v / max) * 100)
      return `<div class="bar"><span style="min-width:150px;font-size:15px">${h(FACTS[t].label)}</span><div class="track"><div class="fill" style="width:${w.toFixed(1)}%;background:${FACTS[t].color}"></div></div><span class="num">${n(v)}${unit}</span></div>`
    })
    .join('\n  ')}
  ${note ? `<p class="scale">${h(note)}</p>` : ''}
</div>`
}

const best = (valueOf, lower = false) => order.reduce((a, t) => (valueOf(t) === null ? a : !a || (lower ? valueOf(t) < valueOf(a) : valueOf(t) > valueOf(a)) ? t : a), null)
const http = (t, p) => summary[t].http?.[p] ?? {}
const kafka = (t) => summary[t].kafka ?? {}

let out = ''
out += `<div class="tiles">
  <div class="tile"><span class="label">Kafka: ภาษาที่ drain เร็วสุด</span><span class="value">${h(FACTS[best((t) => kafka(t).rowsPerS)]?.label ?? '–')}</span><span class="note">${n(kafka(best((t) => kafka(t).rowsPerS)).rowsPerS)} แถว/วิ · Node ${n(kafka('node').rowsPerS)}</span></div>
  <div class="tile"><span class="label">HTTP: p50 ต่ำสุดที่ 64 connection</span><span class="value">${h(FACTS[best((t) => http(t, 'mixed').p50, true)]?.label ?? '–')}</span><span class="note">${n(http(best((t) => http(t, 'mixed').p50, true), 'mixed').p50, 1)} ms · Node ${n(http('node', 'mixed').p50, 1)} ms</span></div>
  <div class="tile"><span class="label">CPU น้อยสุดที่โหลดเท่ากัน (HTTP mixed)</span><span class="value">${h(FACTS[best((t) => http(t, 'mixed').cpuAvg, true)]?.label ?? '–')}</span><span class="note">${n(http(best((t) => http(t, 'mixed').cpuAvg, true), 'mixed').cpuAvg)} % ของ 1 core · Node ${n(http('node', 'mixed').cpuAvg)} %</span></div>
  <div class="tile"><span class="label">RAM สูงสุดน้อยสุด</span><span class="value">${h(FACTS[best((t) => http(t, 'mixed').rssMax, true)]?.label ?? '–')}</span><span class="note">${n(http(best((t) => http(t, 'mixed').rssMax, true), 'mixed').rssMax)} MiB · Node ${n(http('node', 'mixed').rssMax)} MiB</span></div>
</div>\n`

out += `<section>\n<h2>Kafka: drain 500,000 แถว</h2>\n<p>ตัวเลขที่บอกความเร็วจริงของ ingest เพราะไม่มีเพดาน request: produce 500k แถวลง topic ก่อน แล้ว start consumer จับเวลาจน lag เป็น 0 (ค่ากลางจาก 3 รอบ)</p>\n`
out += bars('แถวต่อวินาที (สูง = ดี)', ' แถว/วิ', (t) => kafka(t).rowsPerS) + '\n'
out += `<div class="table-wrap"><table>
<tr><th>ภาษา</th><th>drain (วิ)</th><th>แถว/วิ</th><th>CPU เฉลี่ย</th><th>CPU สูงสุด</th><th>RSS สูงสุด</th></tr>
${order.map((t) => `<tr><td>${h(FACTS[t].label)}</td><td class="num">${n(kafka(t).drainSeconds, 1)}</td><td class="num">${n(kafka(t).rowsPerS)}</td><td class="num">${n(kafka(t).cpuAvg)} %</td><td class="num">${n(kafka(t).cpuMax)} %</td><td class="num">${n(kafka(t).rssMax)} MiB</td></tr>`).join('\n')}
</table></div>\n</section>\n`

for (const p of ['logs', 'spans', 'mixed']) {
  out += `<section>\n<h2>HTTP · ${p}</h2>\n`
  out += bars('แถวต่อวินาทีสูงสุดโดย error < 0.5 % (สูง = ดี)', ' แถว/วิ', (t) => http(t, p).rowsPerS) + '\n'
  out += bars('p50 ที่จุดสูงสุด (ต่ำ = ดี)', ' ms', (t) => http(t, p).p50) + '\n'
  out += `<div class="table-wrap"><table>
<tr><th>ภาษา</th><th>connection</th><th>req/วิ</th><th>แถว/วิ</th><th>MB/วิ</th><th>p50</th><th>p95</th><th>p99</th><th>CPU เฉลี่ย</th><th>RSS สูงสุด</th></tr>
${order.map((t) => { const r = http(t, p); return `<tr><td>${h(FACTS[t].label)}</td><td class="num">${n(r.connections)}</td><td class="num">${n(r.reqPerS, 1)}</td><td class="num">${n(r.rowsPerS)}</td><td class="num">${n(r.mbPerS, 1)}</td><td class="num">${n(r.p50, 1)}</td><td class="num">${n(r.p95, 1)}</td><td class="num">${n(r.p99, 1)}</td><td class="num">${n(r.cpuAvg)} %</td><td class="num">${n(r.rssMax)} MiB</td></tr>` }).join('\n')}
</table></div>\n</section>\n`
}

out += `<section>\n<h2>ขนาดของงาน</h2>\n<div class="table-wrap"><table>
<tr><th>ภาษา</th><th>image</th><th>บรรทัดโค้ด</th><th>mask (required · optional)</th><th>verify กับ Node</th></tr>
${order.map((t) => `<tr><td>${h(FACTS[t].label)}</td><td class="num">${n(summary[t].image)} MiB</td><td class="num">${h(FACTS[t].loc)}</td><td>${h(FACTS[t].mask)}</td><td>${summary[t].verify ? '<span class="okmark">ตรงทุกคอลัมน์</span>' : '<span class="badmark">ไม่ผ่าน</span>'}</td></tr>`).join('\n')}
</table></div>\n<p>* C# port กฎ optional ชุดย่อย 11 ข้อ (ครอบ mapper ครบเท่ากัน) · verify = ส่ง 2,000 envelope (57,078 log + 8,651 span) แล้วเทียบทุกคอลัมน์ใน ClickHouse กับแถวที่ engine ปัจจุบันสร้าง</p>\n</section>\n`
process.stdout.write(out)
