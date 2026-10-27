import { describe, expect, it, vi } from 'vitest'
import { ReportScheduler } from '../src/reports/report-scheduler'
import type { ReportsService } from '../src/reports/reports.service'

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
    const built = await new ReportScheduler(fake).runDue(Date.UTC(2026, 9, 21, 2, 0, 5), ['prod', 'staging'])
    expect(generate.mock.calls.filter(([env]) => env === 'prod').map(([, d]) => d)).toEqual([
      '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-21',
    ])
    expect(built).toHaveLength(12)
    expect(built).not.toContain('staging 2026-10-16')
  })
})
