import { Logger } from '@nestjs/common'
import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { config } from '../config'
import { between, sleep } from '../common/util'
import { GoogleSheetsClient } from '../infra/google-sheets'
import { OracleClient } from '../infra/oracle'
import { REPORT_JOB, REPORT_QUEUE } from '../core/reports.controller'

interface ReportJob {
  reportId: string
  schoolId?: string
  requestedBy?: string
  term?: string
  classIds?: number[]
  recipients?: string[]
}

/**
 * school-core-api role worker. skilllane-monitoring wraps every attempt:
 * job.started → job.finished, or job.retry until the last attempt → job.failed.
 */
@Processor(REPORT_QUEUE, { concurrency: 5 })
export class ReportProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportProcessor.name)

  constructor(
    private readonly oracle: OracleClient,
    private readonly sheets: GoogleSheetsClient,
  ) {
    super()
  }

  async process(job: Job<ReportJob>): Promise<{ rows: number }> {
    if (job.name !== REPORT_JOB) return { rows: 0 }
    const rows = await this.oracle.run(
      'SELECT',
      'EXAM_SCORE',
      'SELECT "STUDENT_ID", "EXAM_ID", "SCORE" FROM "APP"."EXAM_SCORE" WHERE "SCHOOL_ID" = :1 AND "REPORT_ID" = :2 AND "TERM" = :3',
      async () => {
        await sleep(between(50, 200))
        return between(30, 400)
      },
      [job.data.schoolId ?? null, Number(job.data.reportId), job.data.term ?? '2569/1'],
    )
    await this.sheets.appendReport(job.data.reportId, config.reportFailRate, {
      rows: Math.min(rows, 8),
      term: job.data.term ?? '2569/1',
    })
    this.logger.log(`Report ${job.data.reportId} exported (${rows} rows)`)
    return { rows }
  }
}
