import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { config } from '../../config'
import type { AiNote, AiStatus, StoredReport } from '../types'
import { buildEvidence } from './evidence'
import { guardNotes } from './guard'
import { AiError, type ChatClient, OpenRouterClient } from './openrouter'
import { NOTES_SCHEMA, promptMessages } from './prompt'

/** Injection token of a ChatClient other than OpenRouter (tests). */
export const REPORT_AI_CLIENT = 'REPORT_AI_CLIENT'
/** The spec's limit for one call. */
const TIMEOUT_MS = 60_000

export interface AiOutcome {
  aiStatus: AiStatus
  aiMessage: string
  aiNotes: AiNote[]
  /** featureId → Thai name, for features still shown by their route. */
  featureNames: Record<string, string>
}

/**
 * The AI layer of the daily report: once per snapshot, it words what the numbers already say.
 * Never blocks the report: every failure becomes an aiStatus and the numbers stand without it.
 */
@Injectable()
export class ReportAi {
  private readonly logger = new Logger('ReportAi')
  private readonly client?: ChatClient
  /** Waits before the 2nd and 3rd try; only an unavailable answer is tried again. */
  retryDelaysMs = [5_000, 15_000]

  constructor(@Optional() @Inject(REPORT_AI_CLIENT) client?: ChatClient) {
    const ai = config.report.ai
    this.client = client ?? (ai.apiKey ? new OpenRouterClient({ apiKey: ai.apiKey, model: ai.model, url: ai.url, timeoutMs: TIMEOUT_MS }) : undefined)
  }

  /** Why the AI will not run for this report (disabled + reason), or undefined when it will. */
  skipReason(r: StoredReport): string | undefined {
    if (!this.client) return 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY'
    if (r.payload.headline.statusAuto === 'ok' && !config.report.ai.onOk) return 'สถานะปกติ จึงไม่ได้เรียก AI'
    return undefined
  }

  async analyze(r: StoredReport, featureRoutes: Record<string, string[]> = {}): Promise<AiOutcome> {
    const none = (aiStatus: AiStatus, aiMessage: string): AiOutcome => ({ aiStatus, aiMessage, aiNotes: [], featureNames: {} })
    const skip = this.skipReason(r)
    if (skip || !this.client) return none('disabled', skip ?? '')
    const pack = buildEvidence(r, featureRoutes)
    const messages = promptMessages(pack)
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.chat(messages, NOTES_SCHEMA)
        let raw: unknown
        try {
          raw = JSON.parse(res.content)
        } catch {
          return none('error', 'AI ตอบไม่เป็น JSON')
        }
        const g = guardNotes(raw, pack)
        for (const d of g.dropped) this.logger.warn(`${r.env} ${r.reportDate}: dropped note ${d.target || '?'}: ${d.why}`)
        const tokens = res.tokens ? ` · ${res.tokens.prompt + res.tokens.completion} token` : ''
        const dropped = g.dropped.length ? ` · ตัดทิ้ง ${g.dropped.length} ข้อความที่อ้างหลักฐานไม่ได้` : ''
        return { aiStatus: 'ok', aiMessage: `${res.model}${tokens}${dropped}`, aiNotes: g.notes, featureNames: g.names }
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError('error', err instanceof Error ? err.message : String(err))
        if (e.status !== 'unavailable' || attempt >= this.retryDelaysMs.length) {
          this.logger.warn(`${r.env} ${r.reportDate}: AI ${e.status}: ${e.message}`)
          return none(e.status, e.message)
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt]))
      }
    }
  }
}
