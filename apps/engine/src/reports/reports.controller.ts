import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Post, Query, Req } from '@nestjs/common'
import { type AuthedRequest, RequirePermission } from '../auth/auth.guard'
import { allows } from '../auth/permissions'
import { bad, optName, optString, type QueryString } from '../query/params'
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
  constructor(private readonly reports: ReportsService) {}

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

  @RequirePermission('reports')
  @Get('dates')
  async dates(@Query() q: QueryString) {
    const env = envOf(q)
    return { env, dates: await this.reports.dates(env) }
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
