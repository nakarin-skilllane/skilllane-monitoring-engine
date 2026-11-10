import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { config } from '../config'
import type { ReportTab } from './render/infographic'
import { ReportExport } from './report-export'
import { ReportStore } from './report-store'
import { ReportsService } from './reports.service'
import { type Messenger, SlackClient, type SlackFile } from './slack/slack-client'
import { slackText } from './slack/slack-message'

/** Injection token of a Messenger other than Slack (tests). */
export const REPORT_MESSENGER = 'REPORT_MESSENGER'

const PICTURES: Array<{ tab: ReportTab; title: string }> = [
  { tab: 'overview', title: 'ภาพรวม' },
  { tab: 'detail', title: 'รายละเอียด' },
]

export type NotifyResult = 'sent' | 'already' | 'off' | 'no-report' | 'failed'

/**
 * Posts the scheduled daily report to Slack once per env + date: the overview and detail
 * infographics (PNG, through the export) with a link to the report. It waits for the AI notes
 * (they are in the pictures) up to REPORT_SLACK_AI_WAIT_S, then sends what is stored; no pictures
 * = the link alone, saying why. Sent reports are recorded
 * in report_notifications, so a restart (the catch-up) does not post them again.
 */
@Injectable()
export class ReportNotifier {
  private readonly logger = new Logger('ReportSlack')
  private readonly messenger: Messenger
  /** Waits before the 2nd and 3rd try of a send that failed. */
  retryDelaysMs = [60_000, 300_000]

  constructor(
    private readonly reports: ReportsService,
    private readonly exporter: ReportExport,
    private readonly store: ReportStore,
    @Optional() @Inject(REPORT_MESSENGER) messenger?: Messenger,
  ) {
    this.messenger = messenger ?? new SlackClient(config.report.slack.token)
  }

  get enabled(): boolean {
    return this.messenger.enabled && !!config.report.slack.channel
  }

  /** The target recorded in report_notifications. */
  private get target(): string {
    return `slack:${config.report.slack.channel ?? ''}`
  }

  async notify(env: string, reportDate: string): Promise<NotifyResult> {
    if (!this.enabled) return 'off'
    const channel = config.report.slack.channel as string
    try {
      if (await this.store.notified(env, reportDate, this.target)) return 'already'
    } catch (err) {
      this.logger.warn(`report_notifications ${env} ${reportDate}: ${message(err)}`)
      return 'failed'
    }
    const waitMs = config.report.slack.aiWaitMs
    const settled = await this.reports.aiSettled(env, reportDate, waitMs)
    if (!settled) this.logger.warn(`AI ${env} ${reportDate} not done in ${waitMs / 1000} s: sending without it`)
    const report = await this.reports.get(env, reportDate).catch(() => undefined)
    if (!report) {
      this.logger.warn(`no report ${env} ${reportDate} to send`)
      return 'no-report'
    }

    const files: SlackFile[] = []
    let noFiles: string | undefined
    try {
      for (const p of PICTURES) {
        const file = await this.exporter.file(env, reportDate, p.tab, 'infographic', 'png')
        files.push({ filename: file.filename, title: `${p.title} · ${env} · ${reportDate}`, body: file.body })
      }
    } catch (err) {
      noFiles = message(err)
      files.length = 0
      this.logger.warn(`pictures ${env} ${reportDate}: ${noFiles}`)
    }

    const opts = { publicUrl: config.report.slack.publicUrl }
    for (let attempt = 0; ; attempt++) {
      try {
        if (files.length) {
          try {
            await this.messenger.postFiles(channel, files, slackText(report, opts))
          } catch (err) {
            // the text alone is still worth sending
            this.logger.warn(`upload ${env} ${reportDate}: ${message(err)}; sending the text only`)
            await this.messenger.postMessage(channel, slackText(report, { ...opts, noFiles: message(err) }))
          }
        } else {
          await this.messenger.postMessage(channel, slackText(report, { ...opts, noFiles }))
        }
        break
      } catch (err) {
        const delay = this.retryDelaysMs[attempt]
        if (delay === undefined) {
          this.logger.warn(`send ${env} ${reportDate} failed: ${message(err)}`)
          return 'failed'
        }
        this.logger.warn(`send ${env} ${reportDate} failed (${message(err)}), again in ${delay / 1000} s`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    await this.store
      .markNotified(env, reportDate, this.target)
      .catch((err) => this.logger.warn(`report_notifications ${env} ${reportDate} not recorded: ${message(err)}`))
    this.logger.log(`sent ${env} ${reportDate} (${report.status}, AI ${report.aiStatus}, ${files.length} pictures)`)
    return 'sent'
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
