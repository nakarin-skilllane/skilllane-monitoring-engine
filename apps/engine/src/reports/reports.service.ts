import { Injectable, Logger } from '@nestjs/common'
import { FeatureStore } from './feature-store'
import { ReportBuilder } from './report-builder'
import { ReportStore } from './report-store'
import { latestReportDate } from './rules'
import type { ReportDateItem, StoredReport } from './types'

/** Build → save; the latest date also refreshes features_auto. No AI yet: aiStatus = disabled. */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger('ReportsService')
  /** One build per env + date at a time (the scheduler and the button can meet). */
  private readonly building = new Map<string, Promise<StoredReport>>()

  constructor(
    private readonly builder: ReportBuilder,
    private readonly store: ReportStore,
    private readonly features: FeatureStore,
  ) {}

  generate(env: string, reportDate: string): Promise<StoredReport> {
    const key = `${env}\u0000${reportDate}`
    const running = this.building.get(key)
    if (running) return running
    const job = (async () => {
      const { payload, featureGroups } = await this.builder.buildWithFeatures(env, reportDate)
      if (reportDate === latestReportDate(Date.now())) {
        await this.features
          .save(env, reportDate, featureGroups, payload.features)
          .catch((err) => this.logger.warn(`features_auto ${env}: ${err instanceof Error ? err.message : String(err)}`))
      }
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
