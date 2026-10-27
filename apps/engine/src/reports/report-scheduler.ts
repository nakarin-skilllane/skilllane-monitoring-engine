import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { config } from '../config'
import { ReportsService } from './reports.service'
import { dueDates } from './rules'

/** After boot, wait for ClickHouse and the other modules before catching up. */
const CATCH_UP_DELAY_MS = 30_000
/** How far back a missing report is built automatically. */
const CATCH_UP_DAYS = 7

/**
 * REPORT_ENVS at REPORT_CRON (default 09:00 Asia/Bangkok): the report of the window that just
 * ended is built for each env, and any of the last 7 that is missing (engine down at 09:00).
 * The same catch-up runs 30 s after boot. @nestjs/schedule keeps no state and fires on every
 * instance, so it runs only on the instance that applies the schema, as ColdStorageMover.
 */
@Injectable()
export class ReportScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('DailyReport')
  private boot?: NodeJS.Timeout
  private running = false

  constructor(private readonly reports: ReportsService) {}

  private get enabled(): boolean {
    return config.applySchema && config.report.envs.length > 0
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return
    this.logger.log(`daily report of ${config.report.envs.join(', ')} at "${config.report.cron}" Asia/Bangkok`)
    this.boot = setTimeout(() => void this.tick(), CATCH_UP_DELAY_MS)
    this.boot.unref()
  }

  onApplicationShutdown(): void {
    clearTimeout(this.boot)
  }

  @Cron(config.report.cron, { name: 'daily-report', timeZone: 'Asia/Bangkok' })
  async onSchedule(): Promise<void> {
    if (this.enabled) await this.tick()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.runDue(Date.now())
    } finally {
      this.running = false
    }
  }

  /** Builds the missing reports of the last CATCH_UP_DAYS dates; returns `env date` of each one built. */
  async runDue(nowMs: number, envs: string[] = config.report.envs): Promise<string[]> {
    const built: string[] = []
    for (const env of envs) {
      let existing: Set<string>
      try {
        existing = new Set((await this.reports.dates(env)).map((d) => d.reportDate))
      } catch (err) {
        this.logger.warn(`report dates of ${env} failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      for (const date of dueDates(nowMs, existing, CATCH_UP_DAYS)) {
        try {
          const started = Date.now()
          const report = await this.reports.generate(env, date)
          this.logger.log(`report ${env} ${date}: ${report.status} in ${Date.now() - started} ms`)
          built.push(`${env} ${date}`)
        } catch (err) {
          this.logger.warn(`report ${env} ${date} failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    return built
  }
}
