import { describe, expect, it, vi } from 'vitest'
import { buildEvidence } from '../src/reports/ai/evidence'
import { guardNotes } from '../src/reports/ai/guard'
import { AiError, type ChatClient, OpenRouterClient } from '../src/reports/ai/openrouter'
import { ReportAi } from '../src/reports/ai/report-ai'
import { NOTES_SCHEMA } from '../src/reports/ai/prompt'
import { sampleReport } from './report-sample'

const r = sampleReport({
  featureGroups: [{ featureId: 'core:zzz', service: 'core', resource: 'zzz', routes: ['GET /zzz/:id'], requests: 0, score: 1, rank: 1 }],
  featureSlots: [{ featureId: 'core:zzz', slot: 6, requests: 100, errors: 0 }],
})
const pack = buildEvidence(r, { 'core:zzz': ['GET /zzz/:id'] })

describe('buildEvidence', () => {
  it('a target for each summary, error, incident and unnamed feature, each about one item', () => {
    expect(pack.targets.map((t) => t.id)).toEqual([
      'summaryOverview', 'summaryDetail', '111', 'dependency:redis:cache@r:6379:0', 'job:SendMail', 'featureName:core:zzz',
    ])
    const ids = new Set(pack.items.map((i) => i.id))
    for (const t of pack.targets) expect(ids.has(t.about)).toBe(true)
  })
  it('numbers as the page shows them, the deploy behind a new error, no user ids', () => {
    expect(pack.items.find((i) => i.id === 'fig:users')?.facts).toMatchObject({ value: '1,240', affected: '13 (1.0%)' })
    expect(pack.items.find((i) => i.id === 'err:111')?.facts).toMatchObject({ count: '30', firstSeen: '19:00', afterDeploy: 'core 1.0.0 → 1.1.0 เวลา 18:00' })
    expect(pack.items.find((i) => i.id === 'feat:core:zzz')?.facts.routes).toBe('GET /zzz/:id')
    expect(JSON.stringify(pack)).not.toMatch(/user_id|organization_id|@[a-z-]+\.[a-z]{2,}/i)
  })
})

describe('guardNotes', () => {
  const note = (target: string, text: string, evidence: unknown = ['err:111']) => ({ target, text, evidence })
  it('keeps notes that cite real evidence and only its numbers', () => {
    const g = guardNotes(
      {
        notes: [
          note('111', 'Null read เริ่ม 19:00 หลัง deploy 1.1.0 ราว 1 ชม. น่าจะมาจาก release นี้', ['err:111', 'deploy:core@1.1.0']),
          note('summaryOverview', 'ผู้ใช้ 13 จาก 1,240 คนเจอปัญหา ส่วนใหญ่ช่วง redis cache ล่ม 40 นาที', ['fig:users', 'dep:redis:cache@r:6379']),
          note('featureName:core:zzz', 'ดูรายละเอียด', ['feat:core:zzz']),
        ],
      },
      pack,
    )
    expect(g.notes.map((n) => n.target)).toEqual(['111', 'summaryOverview'])
    expect(g.names).toEqual({ 'core:zzz': 'ดูรายละเอียด' })
    expect(g.dropped).toEqual([])
  })
  it('drops what it cannot trust', () => {
    const g = guardNotes(
      {
        notes: [
          note('999', 'ไม่ได้ขอ'),
          note('111', 'ไม่มีหลักฐาน', []),
          note('summaryDetail', 'อ้างของที่ไม่มี', ['err:nope']),
          note('dependency:redis:cache@r:6379:0', 'ล่ม 55 นาที กระทบ 300 คน', ['dep:redis:cache@r:6379']),
          note('job:SendMail', 'ติดต่อ ops@example.com', ['job:SendMail']),
          note('summaryOverview', '   ', ['status']),
        ],
      },
      pack,
    )
    expect(g.notes).toEqual([])
    expect(g.dropped.map((d) => d.why)).toEqual([
      'target ที่ไม่ได้ขอ', 'ไม่อ้างหลักฐาน', 'อ้างหลักฐานที่ไม่มี', 'ตัวเลขที่ไม่อยู่ในหลักฐาน: 55, 300', 'มีอีเมล', 'ข้อความว่าง',
    ])
  })
  it('one note per target, long text cut, a malformed answer gives nothing', () => {
    const long = 'ก'.repeat(200)
    const g = guardNotes({ notes: [note('111', long), note('111', 'ซ้ำ')] }, pack)
    expect(g.notes[0].text).toHaveLength(140)
    expect(g.dropped).toEqual([{ target: '111', why: 'ซ้ำ' }])
    expect(guardNotes('not json', pack)).toEqual({ notes: [], names: {}, dropped: [] })
  })
})

describe('OpenRouterClient', () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const client = (f: () => Promise<Response>) => new OpenRouterClient({ apiKey: 'k', model: 'm', url: 'https://x/api/v1', timeoutMs: 50 }, f as unknown as typeof fetch)
  const msgs = [{ role: 'user' as const, content: 'hi' }]

  it('returns the content, model and tokens; sends the key, model and strict schema', async () => {
    let sent: { url: string; init: RequestInit } | undefined
    const f = async (url: string, init: RequestInit) => {
      sent = { url, init }
      return new Response(JSON.stringify({ model: 'anthropic/x', choices: [{ message: { content: '{"notes":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 })
    }
    const res = await new OpenRouterClient({ apiKey: 'k', model: 'm', url: 'https://x/api/v1', timeoutMs: 1000 }, f as unknown as typeof fetch).chat(msgs, NOTES_SCHEMA)
    expect(res).toEqual({ content: '{"notes":[]}', model: 'anthropic/x', tokens: { prompt: 10, completion: 3 } })
    expect(sent?.url).toBe('https://x/api/v1/chat/completions')
    expect((sent?.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    const body = JSON.parse(String(sent?.init.body))
    expect(body).toMatchObject({ model: 'm', response_format: { type: 'json_schema', json_schema: { strict: true } } })
  })

  it('sorts failures: key → error, money / rate → quota, server / network / timeout → unavailable', async () => {
    const statusOf = (c: OpenRouterClient) => c.chat(msgs, NOTES_SCHEMA).then(() => 'ok', (e: AiError) => `${e.status}: ${e.message}`)
    expect(await statusOf(client(reply(401, { error: { message: 'bad key' } })))).toBe('error: API key ใช้ไม่ได้ (401)')
    expect(await statusOf(client(reply(402, {})))).toBe('quota: เครดิต OpenRouter หมด (402)')
    expect(await statusOf(client(reply(429, {})))).toBe('quota: ถูกจำกัดจำนวนครั้ง (429)')
    expect(await statusOf(client(reply(502, {})))).toBe('unavailable: OpenRouter ตอบ 502')
    expect(await statusOf(client(reply(200, { error: { code: 429, message: 'upstream' } })))).toBe('quota: ถูกจำกัดจำนวนครั้ง (429)')
    expect(await statusOf(client(reply(200, { choices: [{ message: { content: '' } }] })))).toBe('error: คำตอบของ AI ไม่มีเนื้อหา')
    expect(await statusOf(client(async () => { throw new TypeError('fetch failed') }))).toBe('unavailable: ต่อ OpenRouter ไม่ได้: fetch failed')
    const slow = client(() => new Promise<Response>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 10)))
    expect(await statusOf(slow)).toBe('unavailable: OpenRouter ไม่ตอบใน 0.05 วินาที')
  })
})

describe('ReportAi', () => {
  const ok = (content: string) => ({ chat: vi.fn(async () => ({ content, model: 'm', tokens: { prompt: 100, completion: 20 } })) })
  const ai = (client: ChatClient) => {
    const a = new ReportAi(client)
    a.retryDelaysMs = [1, 1]
    return a
  }
  const goodAnswer = JSON.stringify({
    notes: [
      { target: '111', text: 'Null read เริ่ม 19:00 หลัง deploy 1.1.0 น่าจะมาจาก release นี้', evidence: ['err:111', 'deploy:core@1.1.0'] },
      { target: 'summaryDetail', text: 'ระบบมี error ใหม่ 999 ครั้ง', evidence: ['status'] },
    ],
  })

  it('keeps the trusted notes and says what it used', async () => {
    const out = await ai(ok(goodAnswer)).analyze(r)
    expect(out.aiStatus).toBe('ok')
    expect(out.aiNotes.map((n) => n.target)).toEqual(['111'])
    expect(out.aiMessage).toBe('m · 120 token · ตัดทิ้ง 1 ข้อความที่อ้างหลักฐานไม่ได้')
  })

  it('a normal day is not analysed; a report of a bad day is', async () => {
    const quiet = sampleReport({ dependencyEvents: [], jobs: [], errors: [], routes: [] })
    expect(quiet.payload.headline.statusAuto).toBe('ok')
    const client = ok(goodAnswer)
    expect(await ai(client).analyze(quiet)).toMatchObject({ aiStatus: 'disabled', aiMessage: 'สถานะปกติ จึงไม่ได้เรียก AI' })
    expect(client.chat).not.toHaveBeenCalled()
  })

  it('tries an unavailable call twice more; quota and errors are not tried again; bad JSON is an error', async () => {
    let calls = 0
    const flaky = { chat: vi.fn(async () => { if (++calls < 3) throw new AiError('unavailable', 'OpenRouter ตอบ 502'); return { content: goodAnswer, model: 'm' } }) }
    expect((await ai(flaky).analyze(r)).aiStatus).toBe('ok')
    expect(flaky.chat).toHaveBeenCalledTimes(3)
    const down = { chat: vi.fn(async () => { throw new AiError('unavailable', 'ต่อ OpenRouter ไม่ได้') }) }
    expect(await ai(down).analyze(r)).toMatchObject({ aiStatus: 'unavailable', aiMessage: 'ต่อ OpenRouter ไม่ได้', aiNotes: [] })
    expect(down.chat).toHaveBeenCalledTimes(3)
    const broke = { chat: vi.fn(async () => { throw new AiError('quota', 'เครดิต OpenRouter หมด (402)') }) }
    expect(await ai(broke).analyze(r)).toMatchObject({ aiStatus: 'quota', aiMessage: 'เครดิต OpenRouter หมด (402)' })
    expect(broke.chat).toHaveBeenCalledTimes(1)
    expect((await ai(ok('not json')).analyze(r)).aiStatus).toBe('error')
  })
})
