import { describe, expect, it, vi } from 'vitest'
import type { ReportNotifier } from '../src/reports/report-notifier'
import { ReportScheduler } from '../src/reports/report-scheduler'
import type { ReportsService } from '../src/reports/reports.service'

const offNotifier = { enabled: false } as unknown as ReportNotifier

describe('ReportScheduler.runDue', () => {
  it('builds the missing reports of the last 7 dates per env, oldest first, and goes on after a failure', async () => {
    const generate = vi.fn(async (env: string, date: string) => {
      if (env === 'staging' && date === '2026-10-16') throw new Error('boom')
      return { status: 'ok' }
    })
    const fake = {
      dates: async (env: string) => (env === 'prod' ? [{ reportDate: '2026-10-20', status: 'ok' }] : []),
      generate,
    } as unknown as ReportsService
    const built = await new ReportScheduler(fake, offNotifier).runDue(Date.UTC(2026, 9, 21, 2, 0, 5), ['prod', 'staging'])
    expect(generate.mock.calls.filter(([env]) => env === 'prod').map(([, d]) => d)).toEqual([
      '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-21',
    ])
    expect(built).toHaveLength(12)
    expect(built).not.toContain('staging 2026-10-16')
  })
})

describe('ReportScheduler.notifyLatest', () => {
  it('sends the latest report date of each env (09:00 Bangkok has passed)', async () => {
    const notify = vi.fn(async () => 'sent')
    const notifier = { enabled: true, notify } as unknown as ReportNotifier
    await new ReportScheduler({} as ReportsService, notifier).notifyLatest(Date.UTC(2026, 9, 21, 2, 0, 5), ['prod', 'staging'])
    expect(notify.mock.calls).toEqual([
      ['prod', '2026-10-21'],
      ['staging', '2026-10-21'],
    ])
  })

  it('before 09:00 the latest is yesterday; nothing when Slack is off', async () => {
    const notify = vi.fn(async () => 'sent')
    await new ReportScheduler({} as ReportsService, { enabled: true, notify } as unknown as ReportNotifier).notifyLatest(Date.UTC(2026, 9, 21, 1, 59), ['prod'])
    expect(notify.mock.calls).toEqual([['prod', '2026-10-20']])
    const off = vi.fn()
    await new ReportScheduler({} as ReportsService, { enabled: false, notify: off } as unknown as ReportNotifier).notifyLatest(Date.UTC(2026, 9, 21, 2, 0), ['prod'])
    expect(off).not.toHaveBeenCalled()
  })
})
