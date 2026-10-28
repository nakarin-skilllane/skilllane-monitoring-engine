import { describe, expect, it } from 'vitest'
import { dataView } from '../src/reports/render/data-view'
import { pdfFooter, reportDocument } from '../src/reports/render/document'
import { infographic } from '../src/reports/render/infographic'
import { sampleReport } from './report-sample'

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('infographic', () => {
  const r = sampleReport()
  it('overview: band, figures, features, timeline, follow-ups', () => {
    const t = text(infographic(r, 'overview'))
    expect(t).toContain('สรุปรายวัน · prod · ภาพรวม')
    expect(t).toContain('พ. 21 ต.ค. 2569')
    expect(t).toContain('มีปัญหา')
    expect(t).toContain('13 คน')
    expect(t).toContain('ห้องเรียน 99.8%')
    expect(t).toContain('11:00–11:40 redis cache ล่ม 40 นาที')
    expect(t).toContain('ปัญหาใหม่ Null read ที่ GET /classes/:id/result กระทบผู้ใช้ 8 คน')
    expect(t).toContain('ยังไม่ได้เปิดใช้ AI · รายงานวันนี้มีเฉพาะส่วนที่คำนวณจากกฎ')
  })
  it('detail: error rate, systems, slow route, errors', () => {
    const t = text(infographic(r, 'detail'))
    expect(t).toContain('สรุปรายวัน · prod · รายละเอียด')
    expect(t).toContain('1.00%')
    expect(t).toContain('redis cache ล่ม 40 นาที')
    expect(t).toContain('SendMail ล้มเหลว 3')
    expect(t).toContain('deploy core 1.0.0 → 1.1.0 · 18:00')
    expect(t).toContain('200 ms → 300 ms')
    expect(t).toContain('ใหม่ Null read')
  })
  it('an empty window says so; AI state is shown', () => {
    const quiet = sampleReport({ dependencyEvents: [], jobs: [], errors: [], routes: [], deploys: [] }, { aiStatus: 'quota', aiMessage: '429' })
    const t = text(infographic(quiet, 'detail'))
    expect(t).toContain('ไม่มีรายการในช่วงนี้')
    expect(t).toContain('AI โควตาหมด (429)')
  })
  it('an error without type or hint shows its logger and message', () => {
    const plain = sampleReport({
      errors: [{ fingerprint: '7', service: 'core', error_type: '', error_hint: '', logger: 'RabbitMQService', message: 'Disconnected from RMQ. Trying to reconnect.', route: '', origin_file: '', origin_function: '', count: 3, users: 0, first_ms: 0, trace_id: '' }],
    })
    expect(text(infographic(plain, 'detail'))).toContain('Disconnected from RMQ. Trying to reconnect.')
    expect(text(dataView(plain, 'detail'))).toContain('RabbitMQService Disconnected from RMQ. Trying to reconnect.')
  })

  it('payload text is escaped', () => {
    const evil = sampleReport({
      errors: [{ fingerprint: '9', service: 'core', error_type: 'X', error_hint: '<script>alert(1)</script>', route: '', origin_file: '', origin_function: '', count: 1, users: 1, first_ms: 0, trace_id: '' }],
    })
    const html = infographic(evil, 'detail')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('data view and document', () => {
  const r = sampleReport()
  it('the detail tab as tables', () => {
    const t = text(dataView(r, 'detail'))
    expect(t).toContain('ปัญหาใหม่ / เพิ่มขึ้น')
    expect(t).toContain('src/a.ts › A.b')
    expect(t).toContain('redis cache (r:6379)')
    expect(text(dataView(sampleReport({ dependencyEvents: [] }), 'detail'))).toContain('ไม่มีรายการในช่วงนี้')
  })
  it('a whole document: fonts inlined, one part per section, no user ids', () => {
    const html = reportDocument(r, [{ tab: 'overview', view: 'infographic' }, { tab: 'overview', view: 'data' }, { tab: 'detail', view: 'infographic' }, { tab: 'detail', view: 'data' }], 'pdf')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain("src:url(data:font/woff2;base64,")
    expect(html).toContain('<body class="pdf">')
    expect(html.match(/class="part"/g)).toHaveLength(4)
    expect(html).not.toMatch(/user_id|organization_id/)
  })
  it('the PDF footer has the window and page numbers', () => {
    expect(text(pdfFooter(r))).toContain('ช่วงข้อมูล 20 ต.ค. 09:01 ถึง 21 ต.ค. 09:00 · สร้างเมื่อ 21 ต.ค. 09:00')
    expect(pdfFooter(r)).toContain('class="pageNumber"')
  })
})
