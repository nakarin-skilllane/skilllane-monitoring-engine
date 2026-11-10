import { describe, expect, it } from 'vitest'
import { SlackClient, SlackError } from '../src/reports/slack/slack-client'

interface Call {
  url: string
  init: RequestInit
}

/** A fetch that answers each URL from `answers` (first matching prefix) and records the calls. */
function fakeFetch(answers: Array<[string, () => Response]>) {
  const calls: Call[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const hit = answers.find(([prefix]) => url.startsWith(prefix))
    if (!hit) throw new Error(`unexpected ${url}`)
    return hit[1]()
  }) as unknown as typeof fetch
  return { impl, calls }
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('SlackClient', () => {
  it('posts a message as JSON with the bot token', async () => {
    const { impl, calls } = fakeFetch([['https://slack.com/api/chat.postMessage', json({ ok: true, ts: '1.2' })]])
    await new SlackClient('xoxb-test', impl).postMessage('C1', 'สวัสดี')
    expect(calls).toHaveLength(1)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xoxb-test')
    expect(headers['content-type']).toContain('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ channel: 'C1', text: 'สวัสดี' })
  })

  it('a refusal becomes a SlackError with Slack\'s code and a hint', async () => {
    const { impl } = fakeFetch([['https://slack.com/api/', json({ ok: false, error: 'not_in_channel' })]])
    const err = await new SlackClient('xoxb-test', impl).postMessage('C1', 'x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SlackError)
    expect((err as SlackError).code).toBe('not_in_channel')
    expect((err as SlackError).message).toContain('/invite')
  })

  it('uploads each file to its own URL, then shares them all in one message', async () => {
    let n = 0
    const { impl, calls } = fakeFetch([
      ['https://slack.com/api/files.getUploadURLExternal', () => json({ ok: true, upload_url: `https://files.slack.com/upload/${++n}`, file_id: `F${n}` })()],
      ['https://files.slack.com/upload/', () => new Response('OK - 3')],
      ['https://slack.com/api/files.completeUploadExternal', json({ ok: true, files: [] })],
    ])
    await new SlackClient('xoxb-test', impl).postFiles(
      'C1',
      [
        { filename: 'a.png', title: 'ภาพรวม', body: Buffer.from('abc') },
        { filename: 'b.png', title: 'รายละเอียด', body: Buffer.from('defg') },
      ],
      'ข้อความ',
    )
    expect(calls.map((c) => c.url)).toEqual([
      'https://slack.com/api/files.getUploadURLExternal',
      'https://files.slack.com/upload/1',
      'https://slack.com/api/files.getUploadURLExternal',
      'https://files.slack.com/upload/2',
      'https://slack.com/api/files.completeUploadExternal',
    ])
    expect(String(calls[0].init.body)).toBe('filename=a.png&length=3')
    expect(String(calls[2].init.body)).toBe('filename=b.png&length=4')
    expect(calls[1].init.body).toBeInstanceOf(FormData)
    expect(JSON.parse(String(calls[4].init.body))).toEqual({
      files: [
        { id: 'F1', title: 'ภาพรวม' },
        { id: 'F2', title: 'รายละเอียด' },
      ],
      channel_id: 'C1',
      initial_comment: 'ข้อความ',
    })
  })

  it('a failed upload stops before the message is shared', async () => {
    const { impl, calls } = fakeFetch([
      ['https://slack.com/api/files.getUploadURLExternal', json({ ok: true, upload_url: 'https://files.slack.com/upload/1', file_id: 'F1' })],
      ['https://files.slack.com/upload/', () => new Response('nope', { status: 500 })],
    ])
    const err = await new SlackClient('xoxb-test', impl).postFiles('C1', [{ filename: 'a.png', title: 't', body: Buffer.from('a') }], 'x').catch((e: unknown) => e)
    expect((err as SlackError).code).toBe('upload_500')
    expect(calls.some((c) => c.url.includes('completeUploadExternal'))).toBe(false)
  })

  it('no token: disabled and never calls out; a network error is unreachable', async () => {
    const { impl, calls } = fakeFetch([])
    const off = new SlackClient(undefined, impl)
    expect(off.enabled).toBe(false)
    expect(((await off.postMessage('C1', 'x').catch((e: unknown) => e)) as SlackError).code).toBe('not_configured')
    expect(calls).toHaveLength(0)
    const down = new SlackClient('xoxb-test', (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(((await down.postMessage('C1', 'x').catch((e: unknown) => e)) as SlackError).code).toBe('unreachable')
  })
})
