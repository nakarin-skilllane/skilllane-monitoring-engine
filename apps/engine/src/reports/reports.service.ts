import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ReportAi } from './ai/report-ai'
import { FeatureStore } from './feature-store'
import type { RankedGroup } from './features'
import { ReportBuilder } from './report-builder'
import { ReportStore } from './report-store'
import { latestReportDate } from './rules'
import type { ReportDateItem, StoredReport } from './types'

/** A snapshot still `pending` after this long lost its AI run (engine restarted): shown as an error. */
const PENDING_STALE_MS = 15 * 60_000

/**
 * Build → save (numbers complete, aiStatus pending or disabled) → AI in the background → save again.
 * The latest date also refreshes features_auto; names the AI gave features are used in every build.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger('ReportsService')
  /** One build per env + date at a time (the scheduler and the button can meet). */
  private readonly building = new Map<string, Promise<StoredReport>>()
  /** generatedAt of the newest snapshot per env + date: an older AI run must not overwrite a rebuild. */
  private readonly newest = new Map<string, string>()

  constructor(
    private readonly builder: ReportBuilder,
    private readonly store: ReportStore,
    private readonly features: FeatureStore,
    private readonly ai: ReportAi,
  ) {}

  generate(env: string, reportDate: string): Promise<StoredReport> {
    const key = `${env}\u0000${reportDate}`
    const running = this.building.get(key)
    if (running) return running
    const job = (async () => {
      const { payload, featureGroups } = await this.builder.buildWithFeatures(env, reportDate)
      const aiNames = await this.features.aiNames(env).catch(() => ({}) as Record<string, string>)
      payload.features = payload.features.map((f) => (aiNames[f.featureId] ? { ...f, name: aiNames[f.featureId] } : f))
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
        aiStatus: 'pending',
        aiMessage: '',
      }
      return this.saveAndAnalyze(report, featureGroups)
    })().finally(() => this.building.delete(key))
    this.building.set(key, job)
    return job
  }

  /** Runs the AI again on a stored snapshot (numbers unchanged). */
  async analyze(env: string, reportDate?: string): Promise<StoredReport> {
    const report = await this.store.get(env, reportDate)
    if (!report) throw new NotFoundException(reportDate ? `ยังไม่มีรายงานของวันที่ ${reportDate}` : 'ยังไม่มีรายงาน')
    return this.saveAndAnalyze({ ...report, generatedAt: new Date().toISOString(), payload: { ...report.payload, aiNotes: [] } }, [])
  }

  async get(env: string, reportDate?: string): Promise<StoredReport | undefined> {
    const report = await this.store.get(env, reportDate)
    if (report?.aiStatus === 'pending' && Date.now() - Date.parse(report.generatedAt) > PENDING_STALE_MS && !this.newest.has(`${env}\u0000${report.reportDate}`)) {
      return { ...report, aiStatus: 'error', aiMessage: 'การวิเคราะห์ไม่จบ (engine เริ่มใหม่ระหว่างวิเคราะห์) กด "วิเคราะห์ใหม่"' }
    }
    return report
  }

  dates(env: string): Promise<ReportDateItem[]> {
    return this.store.dates(env)
  }

  /** Saves the numbers now; the AI notes follow when (and if) they come. */
  private async saveAndAnalyze(report: StoredReport, groups: RankedGroup[]): Promise<StoredReport> {
    const skip = this.ai.skipReason(report)
    const first: StoredReport = { ...report, aiStatus: skip ? 'disabled' : 'pending', aiMessage: skip ?? '' }
    await this.store.save(first)
    if (skip) return first
    const key = `${report.env}\u0000${report.reportDate}`
    this.newest.set(key, first.generatedAt)
    void this.finishAi(first, groups, key)
    return first
  }

  private async finishAi(report: StoredReport, groups: RankedGroup[], key: string): Promise<void> {
    try {
      const routes = Object.fromEntries(groups.map((g) => [g.featureId, g.routes]))
      const out = await this.ai.analyze(report, routes)
      if (this.newest.get(key) !== report.generatedAt) return
      const features = report.payload.features.map((f) => (out.featureNames[f.featureId] ? { ...f, name: out.featureNames[f.featureId] } : f))
      await this.store.save({ ...report, payload: { ...report.payload, aiNotes: out.aiNotes, features }, aiStatus: out.aiStatus, aiMessage: out.aiMessage })
      await this.features.setNames(report.env, out.featureNames)
      this.logger.log(`AI ${report.env} ${report.reportDate}: ${out.aiStatus} · ${out.aiNotes.length} notes${out.aiMessage ? ` · ${out.aiMessage}` : ''}`)
    } catch (err) {
      this.logger.warn(`AI ${report.env} ${report.reportDate} failed: ${err instanceof Error ? err.message : String(err)}`)
      if (this.newest.get(key) === report.generatedAt) {
        await this.store.save({ ...report, aiStatus: 'error', aiMessage: err instanceof Error ? err.message : String(err) }).catch(() => undefined)
      }
    } finally {
      if (this.newest.get(key) === report.generatedAt) this.newest.delete(key)
    }
  }
}
