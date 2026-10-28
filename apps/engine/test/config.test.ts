import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('report config', () => {
  it('has the spec defaults', () => {
    const c = loadConfig({})
    expect(c.report.envs).toEqual(['prod'])
    expect(c.report.cron).toBe('0 9 * * *')
    expect(c.report.ai).toEqual({ apiKey: undefined, model: 'anthropic/claude-sonnet-5.5', url: 'https://openrouter.ai/api/v1', onOk: false })
    expect(c.report.rules).toEqual({
      badErrorRateX: 2,
      badOutageMin: 30,
      badFeatureSuccess: 0.95,
      warnErrorRateX: 1.5,
      newLookbackDays: 14,
      increaseX: 1.5,
      increaseMin: 10,
      featureDropPt: 0.5,
      dependencyMin: 5,
      slowX: 1.2,
      spikeX: 3,
      spikeMinReq: 50,
    })
  })

  it('reads REPORT_ENVS, REPORT_CRON and decimal rules; a bad value keeps the default; empty envs = none', () => {
    const c = loadConfig({ REPORT_ENVS: 'prod, staging', REPORT_CRON: '5 9 * * *', REPORT_WARN_ERROR_RATE_X: '1.25', REPORT_SPIKE_X: 'abc' })
    expect(c.report.envs).toEqual(['prod', 'staging'])
    expect(c.report.cron).toBe('5 9 * * *')
    expect(c.report.rules.warnErrorRateX).toBe(1.25)
    expect(c.report.rules.spikeX).toBe(3)
    expect(loadConfig({ REPORT_ENVS: '' }).report.envs).toEqual([])
  })
})
