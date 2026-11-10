/**
 * Slack Web API with a bot token: a text message (chat.postMessage) or files with a comment
 * (files.getUploadURLExternal → POST the bytes → files.completeUploadExternal; files.upload is retired).
 */

type Fetch = typeof fetch

/** A call Slack refused (`code` is Slack's error, e.g. not_in_channel) or that did not reach it. */
export class SlackError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface SlackFile {
  filename: string
  title: string
  body: Buffer
}

export interface Messenger {
  readonly enabled: boolean
  postMessage(channel: string, text: string): Promise<void>
  postFiles(channel: string, files: SlackFile[], comment: string): Promise<void>
}

const API = 'https://slack.com/api'
const TIMEOUT_MS = 30_000

/** What a refusal means for whoever reads the log. */
const HINTS: Record<string, string> = {
  invalid_auth: 'SLACK_BOT_TOKEN ใช้ไม่ได้',
  not_authed: 'SLACK_BOT_TOKEN ใช้ไม่ได้',
  token_revoked: 'SLACK_BOT_TOKEN ถูกยกเลิกแล้ว',
  account_inactive: 'SLACK_BOT_TOKEN ถูกยกเลิกแล้ว',
  not_in_channel: 'bot ยังไม่อยู่ใน channel: /invite bot เข้า channel ก่อน',
  channel_not_found: 'ไม่พบ channel: SLACK_REPORT_CHANNEL ต้องเป็น channel ID (C…) และ bot อยู่ใน channel',
  missing_scope: 'token ขาด scope: ต้องมี chat:write และ files:write แล้ว reinstall app',
  ratelimited: 'Slack จำกัดจำนวนครั้ง',
}

export class SlackClient implements Messenger {
  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.token
  }

  async postMessage(channel: string, text: string): Promise<void> {
    await this.call('chat.postMessage', { channel, text, unfurl_links: false, unfurl_media: false })
  }

  async postFiles(channel: string, files: SlackFile[], comment: string): Promise<void> {
    const uploaded: Array<{ id: string; title: string }> = []
    for (const f of files) {
      const target = await this.call('files.getUploadURLExternal', { filename: f.filename, length: String(f.body.length) }, 'form')
      const uploadUrl = typeof target.upload_url === 'string' ? target.upload_url : ''
      const fileId = typeof target.file_id === 'string' ? target.file_id : ''
      if (!uploadUrl || !fileId) throw new SlackError('bad_response', 'files.getUploadURLExternal ไม่ส่ง upload_url / file_id กลับมา')
      const form = new FormData()
      form.append('filename', new Blob([new Uint8Array(f.body)]), f.filename)
      const res = await this.send(uploadUrl, { method: 'POST', body: form })
      if (!res.ok) throw new SlackError(`upload_${res.status}`, `อัปโหลด ${f.filename} ไม่สำเร็จ (${res.status})`)
      uploaded.push({ id: fileId, title: f.title })
    }
    await this.call('files.completeUploadExternal', { files: uploaded, channel_id: channel, initial_comment: comment })
  }

  /** One Web API method; `{ ok: false }` and transport failures become a SlackError. */
  private async call(method: string, args: Record<string, unknown>, encoding: 'json' | 'form' = 'json'): Promise<Record<string, unknown>> {
    const body = encoding === 'json' ? JSON.stringify(args) : new URLSearchParams(args as Record<string, string>)
    const res = await this.send(`${API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token ?? ''}`,
        'content-type': encoding === 'json' ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
      },
      body,
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) throw new SlackError(`http_${res.status}`, `${method}: Slack ตอบ ${res.status} ที่ไม่ใช่ JSON`)
    if (json.ok !== true) {
      const code = typeof json.error === 'string' ? json.error : `http_${res.status}`
      throw new SlackError(code, `${method}: ${code}${HINTS[code] ? ` (${HINTS[code]})` : ''}`)
    }
    return json
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    if (!this.token) throw new SlackError('not_configured', 'ยังไม่ได้ตั้ง SLACK_BOT_TOKEN')
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new SlackError('unreachable', timeout ? `Slack ไม่ตอบใน ${TIMEOUT_MS / 1000} วินาที` : `ต่อ Slack ไม่ได้: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
