import { describe, expect, it, vi } from 'vitest'
import { ReportExport } from '../src/reports/report-export'
import type { Renderer } from '../src/reports/render/gotenberg'
import type { ReportsService } from '../src/reports/reports.service'
import { sampleReport } from './report-sample'

function setup(enabled = true) {
  let report = sampleReport()
  const renderer = {
    enabled,
    png: vi.fn(async (_html: string, _width: number) => Buffer.from('png')),
    pdf: vi.fn(async (_html: string, _header: string, _footer: string) => Buffer.from('%PDF')),
  } satisfies Renderer
  const reports = { get: async () => report } as unknown as ReportsService
  return { exporter: new ReportExport(reports, renderer), renderer, rebuild: () => (report = { ...report, generatedAt: '2026-10-21T03:00:00.000Z' }) }
}

describe('ReportExport', () => {
  it('names the file and renders the infographic PNG at 2 × 760 px', async () => {
    const { exporter, renderer } = setup()
    const f = await exporter.file('prod', undefined, 'overview', 'infographic', 'png')
    expect(f).toMatchObject({ filename: 'skilllane-report_prod_2026-10-21_overview_infographic.png', contentType: 'image/png' })
    expect(renderer.png.mock.calls[0][1]).toBe(1520)
    expect(renderer.png.mock.calls[0][0]).toContain('<body class="png">')
  })

  it('the whole report is one PDF of 4 parts with header and footer', async () => {
    const { exporter, renderer } = setup()
    const f = await exporter.file('prod', '2026-10-21', 'all', 'data', 'pdf')
    expect(f.filename).toBe('skilllane-report_prod_2026-10-21_all_all.pdf')
    const [html, header, footer] = renderer.pdf.mock.calls[0]
    expect(html.match(/class="part"/g)).toHaveLength(4)
    expect(header).toContain('รายงานประจำวัน · prod')
    expect(footer).toContain('pageNumber')
  })

  it('caches per snapshot: the same file once, again after a rebuild', async () => {
    const { exporter, renderer, rebuild } = setup()
    await Promise.all([exporter.file('prod', undefined, 'detail', 'data', 'pdf'), exporter.file('prod', undefined, 'detail', 'data', 'pdf')])
    await exporter.file('prod', undefined, 'detail', 'data', 'pdf')
    expect(renderer.pdf).toHaveBeenCalledTimes(1)
    rebuild()
    await exporter.file('prod', undefined, 'detail', 'data', 'pdf')
    expect(renderer.pdf).toHaveBeenCalledTimes(2)
  })

  it('PNG only for one infographic; no Gotenberg = 503', async () => {
    const { exporter } = setup()
    await expect(exporter.file('prod', undefined, 'all', 'infographic', 'png')).rejects.toThrow('PNG มีเฉพาะ Infographic')
    await expect(exporter.file('prod', undefined, 'overview', 'data', 'png')).rejects.toThrow('PNG มีเฉพาะ Infographic')
    await expect(setup(false).exporter.file('prod', undefined, 'overview', 'infographic', 'pdf')).rejects.toThrow('GOTENBERG_URL')
  })
})
