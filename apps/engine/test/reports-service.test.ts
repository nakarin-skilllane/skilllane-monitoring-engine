import { describe, expect, it, vi } from 'vitest'
import type { AiOutcome, ReportAi } from '../src/reports/ai/report-ai'
import type { FeatureStore } from '../src/reports/feature-store'
import type { ReportBuilder } from '../src/reports/report-builder'
import type { ReportStore } from '../src/reports/report-store'
import { ReportsService } from '../src/reports/reports.service'
import type { StoredReport } from '../src/reports/types'
import { sampleReport } from './report-sample'

function setup(skip?: string) {
  const sample = sampleReport()
  const saved: StoredReport[] = []
  const pendingAi: Array<(o: AiOutcome) => void> = []
  const builder = { buildWithFeatures: vi.fn(async () => ({ payload: structuredClone(sample.payload), featureGroups: [] })) } as unknown as ReportBuilder
  const store = { save: vi.fn(async (r: StoredReport) => void saved.push(r)), get: async () => saved.at(-1) } as unknown as ReportStore
  const features = { aiNames: async () => ({ 'core:classes': 'ห้องเรียนออนไลน์' }), save: async () => undefined, setNames: vi.fn(async () => undefined) } as unknown as FeatureStore
  const ai = {
    skipReason: () => skip,
    analyze: vi.fn(() => new Promise<AiOutcome>((resolve) => pendingAi.push(resolve))),
  } as unknown as ReportAi
  return { service: new ReportsService(builder, store, features, ai), saved, pendingAi, features }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ReportsService with the AI', () => {
  it('saves the numbers at once as pending, then the AI notes', async () => {
    const { service, saved, pendingAi, features } = setup()
    const first = await service.generate('prod', '2026-10-21')
    expect(first.aiStatus).toBe('pending')
    expect(first.payload.features[0].name).toBe('ห้องเรียนออนไลน์')
    await flush()
    pendingAi[0]({ aiStatus: 'ok', aiMessage: 'm', aiNotes: [{ target: '111', text: 'น่าจะมาจาก deploy' }], featureNames: { 'core:classes': 'ห้องเรียน' } })
    await flush()
    expect(saved.map((r) => r.aiStatus)).toEqual(['pending', 'ok'])
    expect(saved[1].payload.aiNotes).toEqual([{ target: '111', text: 'น่าจะมาจาก deploy' }])
    expect(saved[1].payload.figures).toEqual(first.payload.figures)
    expect(features.setNames).toHaveBeenCalledWith('prod', { 'core:classes': 'ห้องเรียน' })
  })

  it('no key or a normal day: saved once as disabled with the reason', async () => {
    const { service, saved } = setup('ยังไม่ได้ตั้ง OPENROUTER_API_KEY')
    const r = await service.generate('prod', '2026-10-21')
    expect(r).toMatchObject({ aiStatus: 'disabled', aiMessage: 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY' })
    await flush()
    expect(saved).toHaveLength(1)
  })

  it('an older AI run does not overwrite a newer build', async () => {
    const { service, saved, pendingAi } = setup()
    await service.generate('prod', '2026-10-21')
    await new Promise((r) => setTimeout(r, 2))
    await service.generate('prod', '2026-10-21')
    await flush()
    pendingAi[0]({ aiStatus: 'ok', aiMessage: 'old', aiNotes: [], featureNames: {} })
    await flush()
    expect(saved.map((r) => r.aiStatus)).toEqual(['pending', 'pending'])
    pendingAi[1]({ aiStatus: 'ok', aiMessage: 'new', aiNotes: [], featureNames: {} })
    await flush()
    expect(saved.at(-1)?.aiMessage).toBe('new')
  })
})
