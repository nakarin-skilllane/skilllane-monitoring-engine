import { Body, Controller, Headers, HttpCode, Logger, Post, Query } from '@nestjs/common'
import { questionTitle } from '../common/school-data'
import { between, sleep } from '../common/util'

interface ParseBody {
  fileName?: string
  schoolId?: string
  sheetName?: string
  requestedBy?: string
  columns?: string[]
}

/** school-etl-api: parses the uploaded Excel file for school-core-api. */
@Controller('etl')
export class EtlController {
  private readonly logger = new Logger(EtlController.name)

  @Post('parse-excel')
  @HttpCode(200)
  async parseExcel(
    @Body() body: ParseBody,
    @Query('dryRun') dryRun?: string,
    @Headers('x-school-id') schoolId?: string,
  ) {
    await sleep(between(60, 220))
    const rows = between(20, 300)
    this.logger.log(`Parsed ${rows} rows from ${body?.fileName ?? 'upload.xlsx'}`)
    const seed = between(1, 9_999)
    return {
      rows,
      sheet: body?.sheetName ?? 'Questions',
      schoolId: body?.schoolId ?? schoolId,
      dryRun: dryRun === 'true',
      preview: Array.from({ length: 3 }, (_, i) => ({
        row: i + 2,
        code: `Q-${seed + i}`,
        title: questionTitle(seed + i),
        answer: ['A', 'B', 'C', 'D'][(seed + i) % 4],
      })),
      warnings: rows > 250 ? [`แถวที่ ${rows - 3}: ไม่มีเฉลย (answer ว่าง)`] : [],
    }
  }
}
