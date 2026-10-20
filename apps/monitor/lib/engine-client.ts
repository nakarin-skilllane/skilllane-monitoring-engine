/**
 * Engine calls from client components (load more, polling): same-origin /engine/*,
 * which next.config.ts rewrites to ${ENGINE_URL}/api/*. Same result shape as lib/engine.ts.
 *
 *   const res = await clientGet<LogsResponse>('/logs', { ...query, before: nextBefore })
 */
import type { EngineErrorBody } from './types'
import { type QueryInput, toSearch } from './url'

export interface ClientEngineError {
  kind: 'unreachable' | 'timeout' | 'http' | 'invalid'
  status: number | null
  message: string
  path: string
}

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: ClientEngineError }

/** `/logs` → `/engine/logs?…` (path without the /api prefix). */
export function engineClientUrl(path: string, query?: QueryInput): string {
  const p = path.replace(/^\/api(?=\/)/, '')
  return `/engine${p.startsWith('/') ? p : `/${p}`}${toSearch(query)}`
}

/**
 * The session ended while the page was open (expired, banned, reset, signed out elsewhere): go to /login and come
 * back here after signing in. Not on the sign-in pages themselves.
 */
export function toLoginOn401(status: number): void {
  if (status !== 401 || typeof window === 'undefined') return
  const here = `${window.location.pathname}${window.location.search}`
  if (here.startsWith('/login') || here.startsWith('/set-password')) return
  window.location.assign(`/login?next=${encodeURIComponent(here)}`)
}

export async function clientGet<T>(path: string, query?: QueryInput, timeoutMs = 8_000): Promise<ClientResult<T>> {
  const url = engineClientUrl(path, query)
  const fail = (kind: ClientEngineError['kind'], message: string, status: number | null = null): ClientResult<T> => ({
    ok: false,
    error: { kind, status, message, path: url },
  })
  let res: Response
  try {
    res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const err = e as Error
    return err.name === 'TimeoutError' || err.name === 'AbortError' ? fail('timeout', 'no answer in time') : fail('unreachable', err.message)
  }
  toLoginOn401(res.status)
  let body: unknown = null
  let json = true
  try {
    body = await res.json()
  } catch {
    json = false
    if (res.ok) return fail('invalid', 'answer is not JSON', res.status)
  }
  if (!res.ok) {
    // The rewrite answers 5xx without a JSON body when the engine is not reachable.
    if (!json && res.status >= 500) return fail('unreachable', `${res.status} ${res.statusText}`, res.status)
    const b = body as Partial<EngineErrorBody> | null
    const message = Array.isArray(b?.message) ? b.message.join('; ') : (b?.message ?? `${res.status} ${res.statusText}`)
    return fail('http', message, res.status)
  }
  return { ok: true, data: body as T }
}
