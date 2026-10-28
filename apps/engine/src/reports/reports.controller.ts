import { Body, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Post, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { type AuthedRequest, RequirePermission } from '../auth/auth.guard'
import { allows } from '../auth/permissions'
import { bad, optEnum, optName, optString, type QueryString } from '../query/params'
import { reportDocument } from './render/document'
import { ReportExport } from './report-export'
import { ReportsService } from './reports.service'
import { latestReportDate, reportDateProblem } from './rules'

const DATE = /^\d{4}-\d{2}-\d{2}$/

function envOf(q: QueryString): string {
  return optName(q, 'env') ?? bad('env is required')
}

/** `date` to read: any YYYY-MM-DD (a snapshot outlives the raw data); unset = the latest. */
function readDateOf(q: QueryString): string | undefined {
  const date = optString(q, 'date', 10)
  if (date !== undefined && !DATE.test(date)) bad('date ต้องเป็น YYYY-MM-DD')
  return date
}

/** `date` to build: within the raw data's 90 days; unset = the latest window that has ended. */
function buildDateOf(q: QueryString): string {
  const now = Date.now()
  const date = optString(q, 'date', 10) ?? latestReportDate(now)
  const problem = reportDateProblem(date, now)
  if (problem) bad(problem)
  return date
}

/** Daily report API. Reading needs `reports` on the env; building needs `reports_manage` and `reports` on that env. */
@Controller('api/reports/daily')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exporter: ReportExport,
  ) {}

  @RequirePermission('reports')
  @Get()
  async daily(@Query() q: QueryString, @Req() req: AuthedRequest) {
    const env = envOf(q)
    const date = readDateOf(q)
    const report = await this.reports.get(env, date)
    if (report) return report
    throw new NotFoundException({
      statusCode: 404,
      message: date ? `ยังไม่มีรายงานของวันที่ ${date}` : 'ยังไม่มีรายงาน',
      reportDate: date ?? null,
      canGenerate: !!req.principal && allows(req.principal.effective, 'reports_manage'),
    })
  }

  /** The infographic (default) or the data view of a tab as a whole HTML page: the monitor's iframe. */
  @RequirePermission('reports')
  @Get('render')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async render(@Query() q: QueryString) {
    const env = envOf(q)
    const date = readDateOf(q)
    const tab = optEnum(q, 'tab', ['overview', 'detail'] as const) ?? 'overview'
    const view = optEnum(q, 'view', ['infographic', 'data'] as const) ?? 'infographic'
    const report = await this.reports.get(env, date)
    if (!report) throw new NotFoundException(date ? `ยังไม่มีรายงานของวันที่ ${date}` : 'ยังไม่มีรายงาน')
    return reportDocument(report, [{ tab, view }], 'screen')
  }

  /** PNG (infographic of one tab) or PDF (one tab, or tab=all: both tabs, picture + data) as a download. */
  @RequirePermission('reports')
  @Get('export')
  async export(@Query() q: QueryString, @Res() res: Response) {
    const env = envOf(q)
    const date = readDateOf(q)
    const tab = optEnum(q, 'tab', ['overview', 'detail', 'all'] as const) ?? 'overview'
    const view = optEnum(q, 'view', ['infographic', 'data'] as const) ?? 'infographic'
    const format = optEnum(q, 'format', ['png', 'pdf'] as const) ?? 'pdf'
    const file = await this.exporter.file(env, date, tab, view, format)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.send(file.body)
  }

  @RequirePermission('reports')
  @Get('dates')
  async dates(@Query() q: QueryString) {
    const env = envOf(q)
    return { env, dates: await this.reports.dates(env) }
  }

  /** Runs the AI again on a stored report (numbers unchanged); answers at once with aiStatus pending. */
  @RequirePermission('reports_manage')
  @Post('analyze')
  @HttpCode(200)
  analyze(@Body() body: QueryString, @Req() req: AuthedRequest) {
    const env = envOf(body ?? {})
    const date = readDateOf(body ?? {})
    if (!req.principal || !allows(req.principal.effective, 'reports', env)) throw new ForbiddenException(`ไม่มีสิทธิ์ reports ใน env ${env}`)
    return this.reports.analyze(env, date)
  }

  @RequirePermission('reports_manage')
  @Post('generate')
  @HttpCode(200)
  generate(@Body() body: QueryString, @Req() req: AuthedRequest) {
    const env = envOf(body ?? {})
    const date = buildDateOf(body ?? {})
    if (!req.principal || !allows(req.principal.effective, 'reports', env)) throw new ForbiddenException(`ไม่มีสิทธิ์ reports ใน env ${env}`)
    return this.reports.generate(env, date)
  }
}
