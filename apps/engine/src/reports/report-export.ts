import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common'
import { config } from '../config'
import { CARD_WIDTH, pdfFooter, pdfHeader, type ReportPart, reportDocument, type ReportView } from './render/document'
import { GotenbergClient, type Renderer } from './render/gotenberg'
import type { ReportTab } from './render/infographic'
import { ReportsService } from './reports.service'

export type ExportTab = ReportTab | 'all'
export type ExportFormat = 'png' | 'pdf'

export interface ExportFile {
  filename: string
  contentType: string
  body: Buffer
}

/** Files kept in memory; a snapshot never changes, so a key (with its generatedAt) is good until rebuilt. */
const CACHE_SIZE = 64
/** Injection token of a Renderer other than Gotenberg (tests). */
export const REPORT_RENDERER = 'REPORT_RENDERER'
/** Print scales tried when a part runs over its page; below 75 % the tables get hard to read. */
const FIT_SCALES = [0.9, 0.8, 0.75]

/** Pages of a PDF as Chromium writes it: one `/Type /Page` object each (`/Pages` is the tree). */
export function pdfPages(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0
}
/** The whole report: overview (picture, data), then detail (picture, data). */
const ALL: ReportPart[] = [
  { tab: 'overview', view: 'infographic' },
  { tab: 'overview', view: 'data' },
  { tab: 'detail', view: 'infographic' },
  { tab: 'detail', view: 'data' },
]

/**
 * PNG / PDF of a stored report through Gotenberg, from the same HTML as /render. A future Slack
 * job calls file() too. Same key while rendering = one render.
 */
@Injectable()
export class ReportExport {
  private readonly cache = new Map<string, ExportFile>()
  private readonly rendering = new Map<string, Promise<ExportFile>>()
  private readonly renderer: Renderer

  constructor(
    private readonly reports: ReportsService,
    @Optional() @Inject(REPORT_RENDERER) renderer?: Renderer,
  ) {
    this.renderer = renderer ?? new GotenbergClient(config.report.gotenbergUrl)
  }

  async file(env: string, date: string | undefined, tab: ExportTab, view: ReportView, format: ExportFormat): Promise<ExportFile> {
    if (format === 'png' && (tab === 'all' || view !== 'infographic')) throw new BadRequestException('PNG มีเฉพาะ Infographic ของ tab เดียว')
    if (!this.renderer.enabled) throw new ServiceUnavailableException('ยังไม่ได้ตั้งค่า GOTENBERG_URL จึง export ไม่ได้')
    const report = await this.reports.get(env, date)
    if (!report) throw new NotFoundException(date ? `ยังไม่มีรายงานของวันที่ ${date}` : 'ยังไม่มีรายงาน')
    const viewName = tab === 'all' ? 'all' : view
    const key = [env, report.reportDate, tab, viewName, format, report.generatedAt].join('|')
    const hit = this.cache.get(key)
    if (hit) {
      // most recently used last
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const running = this.rendering.get(key)
    if (running) return running
    const job = (async (): Promise<ExportFile> => {
      const parts = tab === 'all' ? ALL : [{ tab, view }]
      const html = reportDocument(report, parts, format)
      const body = format === 'png' ? await this.renderer.png(html, CARD_WIDTH * 2) : await this.fitPdf(html, pdfHeader(report), pdfFooter(report), parts.length)
      const file = {
        filename: `skilllane-report_${env}_${report.reportDate}_${tab}_${viewName}.${format}`,
        contentType: format === 'png' ? 'image/png' : 'application/pdf',
        body,
      }
      this.cache.set(key, file)
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
      return file
    })().finally(() => this.rendering.delete(key))
    this.rendering.set(key, job)
    return job
  }

  /**
   * One page per part when it can: a part a little over a page is printed smaller, a step at a time,
   * down to FIT_SCALES' last; longer than that, the full-size file over more pages (still readable).
   */
  private async fitPdf(html: string, header: string, footer: string, parts: number): Promise<Buffer> {
    const full = await this.renderer.pdf(html, header, footer)
    if (pdfPages(full) <= parts) return full
    for (const scale of FIT_SCALES) {
      const pdf = await this.renderer.pdf(html, header, footer, scale)
      if (pdfPages(pdf) <= parts) return pdf
    }
    return full
  }
}
