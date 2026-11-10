import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../src/config'
import type { ExportFile, ReportExport } from '../src/reports/report-export'
import { ReportNotifier } from '../src/reports/report-notifier'
import type { ReportStore } from '../src/reports/report-store'
import type { ReportsService } from '../src/reports/reports.service'
import type { Messenger, SlackFile } from '../src/reports/slack/slack-client'
import type { StoredReport } from '../src/reports/types'
import { sampleReport } from './report-sample'

// The engine loads the repo .env (which may hold a real token): every test sets its own values
// and injects a fake messenger, so nothing here reaches Slack.
const saved = { ...config.report.slack }
beforeEach(() => {
  Object.assign(config.report.slack, { token: 'xoxb-fake', channel: 'C1', publicUrl: 'http://m:3300', aiWaitMs: 300_000 })
})
afterEach(() => {
  Object.assign(config.report.slack, saved)
})

function setup(over: { report?: StoredReport | undefined; sent?: boolean; settled?: boolean; exportFails?: boolean; filesFail?: boolean; messagesFail?: number } = {}) {
  const report = 'report' in over ? over.report : { ...sampleReport(), aiStatus: 'ok' as const }
  const posted: Array<{ kind: 'files' | 'text'; channel: string; text: string; files?: SlackFile[] }> = []
  let messageFailures = over.messagesFail ?? 0
  const messenger: Messenger = {
    enabled: true,
    postMessage: vi.fn(async (channel: string, text: string) => {
      if (messageFailures-- > 0) throw new Error('slack down')
      posted.push({ kind: 'text', channel, text })
    }),
    postFiles: vi.fn(async (channel: string, files: SlackFile[], text: string) => {
      if (over.filesFail) throw new Error('missing_scope')
      posted.push({ kind: 'files', channel, text, files })
    }),
  }
  const reports = {
    aiSettled: vi.fn(async () => over.settled ?? true),
    get: vi.fn(async () => report),
  } as unknown as ReportsService
  const exporter = {
    file: vi.fn(async (env: string, date: string, tab: string): Promise<ExportFile> => {
      if (over.exportFails) throw new Error('ยังไม่ได้ตั้งค่า GOTENBERG_URL จึง export ไม่ได้')
      return { filename: `skilllane-report_${env}_${date}_${tab}_infographic.png`, contentType: 'image/png', body: Buffer.from(tab) }
    }),
  } as unknown as ReportExport
  const marks: string[] = []
  const store = {
    notified: vi.fn(async () => over.sent ?? false),
    markNotified: vi.fn(async (env: string, date: string, target: string) => void marks.push(`${env} ${date} ${target}`)),
  } as unknown as ReportStore
  const notifier = new ReportNotifier(reports, exporter, store, messenger)
  notifier.retryDelaysMs = [0, 0]
  return { notifier, posted, marks, reports, messenger }
}

describe('ReportNotifier', () => {
  it('waits for the AI, sends the text with the overview and detail pictures, and records it', async () => {
    const { notifier, posted, marks, reports } = setup()
    expect(await notifier.notify('prod', '2026-10-21')).toBe('sent')
    expect(reports.aiSettled).toHaveBeenCalledWith('prod', '2026-10-21', 300_000)
    expect(posted).toHaveLength(1)
    expect(posted[0].kind).toBe('files')
    expect(posted[0].channel).toBe('C1')
    expect(posted[0].files?.map((f) => [f.filename, f.title])).toEqual([
      ['skilllane-report_prod_2026-10-21_overview_infographic.png', 'ภาพรวม · prod · 2026-10-21'],
      ['skilllane-report_prod_2026-10-21_detail_infographic.png', 'รายละเอียด · prod · 2026-10-21'],
    ])
    expect(posted[0].text).toMatch(/^<http:\/\/m:3300\/reports\/daily\?env=prod&date=2026-10-21\|รายงานประจำวัน · prod · .+>$/)
    expect(marks).toEqual(['prod 2026-10-21 slack:C1'])
  })

  it('sends once: an env + date already sent is skipped', async () => {
    const { notifier, posted, reports } = setup({ sent: true })
    expect(await notifier.notify('prod', '2026-10-21')).toBe('already')
    expect(posted).toHaveLength(0)
    expect(reports.aiSettled).not.toHaveBeenCalled()
  })

  it('the AI still running after the wait: sent anyway with what is stored', async () => {
    const { notifier, posted } = setup({ settled: false, report: { ...sampleReport(), aiStatus: 'pending' } })
    expect(await notifier.notify('prod', '2026-10-21')).toBe('sent')
    expect(posted[0].kind).toBe('files')
  })

  it('no pictures (export failed): the text alone, with the reason', async () => {
    const { notifier, posted } = setup({ exportFails: true })
    expect(await notifier.notify('prod', '2026-10-21')).toBe('sent')
    expect(posted).toHaveLength(1)
    expect(posted[0].kind).toBe('text')
    expect(posted[0].text).toContain('_แนบภาพสรุปไม่ได้: ยังไม่ได้ตั้งค่า GOTENBERG_URL จึง export ไม่ได้_')
  })

  it('the upload refused: falls back to the text alone', async () => {
    const { notifier, posted } = setup({ filesFail: true })
    expect(await notifier.notify('prod', '2026-10-21')).toBe('sent')
    expect(posted.map((p) => p.kind)).toEqual(['text'])
    expect(posted[0].text).toContain('แนบภาพสรุปไม่ได้: missing_scope')
  })

  it('retries a failed send, then gives up without recording it', async () => {
    const ok = setup({ exportFails: true, messagesFail: 2 })
    expect(await ok.notifier.notify('prod', '2026-10-21')).toBe('sent')
    expect(ok.messenger.postMessage).toHaveBeenCalledTimes(3)

    const down = setup({ exportFails: true, messagesFail: 3 })
    expect(await down.notifier.notify('prod', '2026-10-21')).toBe('failed')
    expect(down.marks).toEqual([])
  })

  it('no report or no channel: nothing is sent', async () => {
    const none = setup({ report: undefined })
    expect(await none.notifier.notify('prod', '2026-10-21')).toBe('no-report')
    expect(none.posted).toHaveLength(0)

    config.report.slack.channel = undefined
    const off = setup()
    expect(off.notifier.enabled).toBe(false)
    expect(await off.notifier.notify('prod', '2026-10-21')).toBe('off')
  })
})
