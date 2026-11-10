/** The Slack text (mrkdwn) next to the infographics: only a link to the report, named by env and date. */
import { thaiDate } from '../render/html'
import type { StoredReport } from '../types'

/** Slack mrkdwn needs only these three escaped; everything from the payload goes through it. */
export const mrkdwn = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The page of this report on the monitor. */
export function reportLink(publicUrl: string, r: Pick<StoredReport, 'env' | 'reportDate'>): string {
  return `${publicUrl}/reports/daily?env=${encodeURIComponent(r.env)}&date=${r.reportDate}`
}

export interface MessageOptions {
  publicUrl?: string
  /** Why the pictures are missing, when they are. */
  noFiles?: string
}

/** `<link|รายงานประจำวัน · prod · ศ. 6 พ.ย. 2569>`; plain text without MONITOR_PUBLIC_URL; plus why the pictures are missing. */
export function slackText(r: Pick<StoredReport, 'env' | 'reportDate'>, opts: MessageOptions): string {
  const title = mrkdwn(`รายงานประจำวัน · ${r.env} · ${thaiDate(r.reportDate)}`)
  const head = opts.publicUrl ? `<${reportLink(opts.publicUrl, r)}|${title}>` : title
  return opts.noFiles ? `${head}\n_แนบภาพสรุปไม่ได้: ${mrkdwn(opts.noFiles)}_` : head
}
