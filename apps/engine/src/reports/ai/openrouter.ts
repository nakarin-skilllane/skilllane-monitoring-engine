/** OpenRouter chat completions, with every failure sorted into the report's AI states. */

export type AiFailure = 'unavailable' | 'quota' | 'error'

/** A call that gave no usable answer; `status` is what the report records. */
export class AiError extends Error {
  constructor(
    readonly status: AiFailure,
    message: string,
  ) {
    super(message)
  }
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface ChatResult {
  content: string
  model: string
  tokens?: { prompt: number; completion: number }
}

export interface ChatClient {
  chat(messages: ChatMessage[], schema: object): Promise<ChatResult>
}

type Fetch = typeof fetch

/** HTTP status → state: a key problem is an error, money or rate limits are quota, the rest a retry later. */
function failure(status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError('error', `API key ใช้ไม่ได้ (${status})`)
  if (status === 402) return new AiError('quota', `เครดิต OpenRouter หมด (402)`)
  if (status === 429) return new AiError('quota', `ถูกจำกัดจำนวนครั้ง (429)`)
  if (status === 408 || status >= 500) return new AiError('unavailable', `OpenRouter ตอบ ${status}`)
  return new AiError('error', `OpenRouter ตอบ ${status}${detail ? `: ${detail}` : ''}`)
}

export class OpenRouterClient implements ChatClient {
  constructor(
    private readonly opts: { apiKey: string; model: string; url: string; timeoutMs: number },
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[], schema: object): Promise<ChatResult> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.opts.url}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'skilllane-monitoring daily report',
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages,
          temperature: 0.2,
          max_tokens: 2000,
          response_format: { type: 'json_schema', json_schema: { name: 'report_notes', strict: true, schema } },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new AiError('unavailable', timeout ? `OpenRouter ไม่ตอบใน ${this.opts.timeoutMs / 1000} วินาที` : `ต่อ OpenRouter ไม่ได้: ${err instanceof Error ? err.message : String(err)}`)
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: number | string; message?: string }
      model?: string
      choices?: Array<{ message?: { content?: string | null } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    } | null
    if (!res.ok) throw failure(res.status, body?.error?.message ?? '')
    // OpenRouter passes a provider's failure on in a 200 body
    if (body?.error) throw failure(Number(body.error.code) || 500, body.error.message ?? '')
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new AiError('error', 'คำตอบของ AI ไม่มีเนื้อหา')
    return {
      content,
      model: body?.model ?? this.opts.model,
      tokens: body?.usage ? { prompt: body.usage.prompt_tokens ?? 0, completion: body.usage.completion_tokens ?? 0 } : undefined,
    }
  }
}
