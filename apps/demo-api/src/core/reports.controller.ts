import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import type { Queue } from 'bullmq'
import { config } from '../config'
import type { DemoUser } from '../common/demo-user.middleware'

export const REPORT_QUEUE = 'report'
export const REPORT_JOB = 'report:generate'

export interface ReportRequest {
  format?: 'xlsx' | 'csv' | 'sheet'
  term?: string
  classIds?: number[]
  recipients?: string[]
  notify?: boolean
}

@Controller('reports')
export class ReportsController {
  constructor(@InjectQueue(REPORT_QUEUE) private readonly queue: Queue) {}

  /** Enqueues the business job; the worker role exports it to Google Sheets. */
  @Post(':id/generate')
  @HttpCode(202)
  async generate(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: { user?: DemoUser },
    @Body() body: ReportRequest = {},
  ) {
    const add = this.queue.add(
      REPORT_JOB,
      {
        reportId: String(id),
        schoolId: req.user?.schoolId,
        requestedBy: req.user?.id,
        format: body.format ?? 'sheet',
        term: body.term ?? '2569/1',
        classIds: body.classIds ?? [],
        recipients: body.recipients ?? [],
        notify: body.notify ?? false,
      },
      {
        attempts: config.reportAttempts,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      },
    )
    // While the app Redis is down BullMQ would wait for it; answer 503 instead.
    const job = await Promise.race([
      add,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ServiceUnavailableException('Report queue is unavailable')),
          2_000,
        ).unref(),
      ),
    ])
    return { reportId: id, jobId: job.id, status: 'queued', queuedAt: new Date().toISOString() }
  }
}
