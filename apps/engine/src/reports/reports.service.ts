import { Injectable } from '@nestjs/common'
import { ReportBuilder } from './report-builder'
import { ReportStore } from './report-store'
import type { ReportDateItem, StoredReport } from './types'

/** Build → save. Stage 1 has no AI: aiStatus = disabled. */
@Injectable()
export class ReportsService {
  /** One build per env + date at a time (the scheduler and the button can meet). */
  private readonly building = new Map<string, Promise<StoredReport>>()

  constructor(
    private readonly builder: ReportBuilder,
    private readonly store: ReportStore,
  ) {}

  generate(env: string, reportDate: string): Promise<StoredReport> {
    const key = `${env}\u0000${reportDate}`
    const running = this.building.get(key)
    if (running) return running
    const job = (async () => {
      const payload = await this.builder.build(env, reportDate)
      const report: StoredReport = {
        env,
        reportDate,
        windowStartMs: payload.windowStartMs,
        windowEndMs: payload.windowEndMs,
        generatedAt: new Date().toISOString(),
        status: payload.headline.statusAuto,
        payload,
        aiStatus: 'disabled',
        aiMessage: '',
      }
      await this.store.save(report)
      return report
    })().finally(() => this.building.delete(key))
    this.building.set(key, job)
    return job
  }

  get(env: string, reportDate?: string): Promise<StoredReport | undefined> {
    return this.store.get(env, reportDate)
  }

  dates(env: string): Promise<ReportDateItem[]> {
    return this.store.dates(env)
  }
}
