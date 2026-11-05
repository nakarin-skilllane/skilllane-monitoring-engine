import http from 'node:http'
import https from 'node:https'
import { gzipSync } from 'node:zlib'
import { INGEST_PATH, type TelemetryStream } from 'skilllane-monitoring/contract'

/** Bodies above this many bytes go out gzipped (the ingest undoes it). */
export const GZIP_OVER_BYTES = 64 * 1024
export const REQUEST_TIMEOUT_MS = 30_000

/** The ingest's answer to a POST; a network error or timeout rejects instead. */
export interface IngestAnswer {
  status: number
  /** `message` of a JSON error body, else the (trimmed) text, else ''. */
  message: string
  /** Retry-After in seconds when the ingest sent one (informational; the bridge does not wait). */
  retryAfter?: number
}

export interface IngestClientOptions {
  /** http://ingest:5100, no trailing slash. */
  url: string
  /** Sent as `Authorization: Bearer <token>` when set. */
  token?: string
  timeoutMs?: number
  gzipOverBytes?: number
}

/**
 * POST ${url}/api/ingest/<stream> with one envelope per request, over a
 * keep-alive agent, 30 s per request. Resolves with the status for every HTTP
 * answer (the forwarder decides what 202 / 400 / 401 / 503 mean); rejects when
 * the ingest cannot be reached or does not answer in time.
 */
export class IngestClient {
  private readonly url: URL
  private readonly agent: http.Agent
  private readonly request: typeof http.request
  private readonly timeoutMs: number
  private readonly gzipOverBytes: number
  private readonly token?: string

  constructor(options: IngestClientOptions) {
    this.url = new URL(options.url.replace(/\/+$/, ''))
    const secure = this.url.protocol === 'https:'
    this.agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true })
    this.request = secure ? https.request : http.request
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.gzipOverBytes = options.gzipOverBytes ?? GZIP_OVER_BYTES
    this.token = options.token
  }

  async post(stream: TelemetryStream, envelope: object): Promise<IngestAnswer> {
    let body = Buffer.from(JSON.stringify(envelope), 'utf8')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (body.length > this.gzipOverBytes) {
      body = gzipSync(body)
      headers['content-encoding'] = 'gzip'
    }
    headers['content-length'] = String(body.length)
    if (this.token) headers.authorization = `Bearer ${this.token}`

    const { status, headers: answerHeaders, text } = await this.send(
      'POST',
      `${this.url.pathname.replace(/\/+$/, '')}${INGEST_PATH}/${stream}`,
      headers,
      body,
    )
    const retryAfter = Number.parseInt(answerHeaders['retry-after'] ?? '', 10)
    return {
      status,
      message: messageOf(text),
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    }
  }

  /** GET /api/health answers 2xx with `ok` not false. */
  async healthy(timeoutMs = 800): Promise<boolean> {
    try {
      const { status, text } = await this.send('GET', `${this.url.pathname.replace(/\/+$/, '')}/api/health`, {}, undefined, timeoutMs)
      if (status < 200 || status >= 300) return false
      try {
        return (JSON.parse(text) as { ok?: unknown }).ok !== false
      } catch {
        return true
      }
    } catch {
      return false
    }
  }

  /** Closes the keep-alive sockets. */
  close(): void {
    this.agent.destroy()
  }

  private send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
    return new Promise((resolve, reject) => {
      const req = this.request(
        {
          agent: this.agent,
          method,
          host: this.url.hostname,
          port: this.url.port || undefined,
          path,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
          )
        },
      )
      req.on('timeout', () => req.destroy(new Error(`ingest did not answer within ${timeoutMs} ms`)))
      req.on('error', reject)
      req.end(body)
    })
  }
}

/** `message` of a Nest/axum-style JSON error body, else the text itself, cut short. */
function messageOf(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown }
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') return parsed.message
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.message)) return parsed.message.join('; ')
  } catch {
    // not JSON
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}
