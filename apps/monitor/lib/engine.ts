/**
 * Typed server-side calls to the skilllane-monitoring engine query API. Server components only
 * (it reads ENGINE_URL at request time); client components use lib/engine-client.ts.
 *
 * Every call resolves, never throws (but a 401 redirects to /login): `{ ok: true, data }` or `{ ok: false, error }`
 * with a readable EngineError, so a page can render <EngineErrorState error={…} />
 * (Thai panel naming the engine URL) instead of a Next error page.
 *
 *   const res = await engine.overview(scopeQuery(scope))
 *   if (!res.ok) return <EngineErrorState error={res.error} />
 *   res.data.services …
 */
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { type QueryInput, toSearch } from './url'
import type {
  CommonQuery,
  DailyReport,
  Me,
  DependenciesResponse,
  EngineErrorBody,
  ErrorDetail,
  ErrorsQuery,
  ErrorsResponse,
  Health,
  JobsResponse,
  LogsQuery,
  LogsResponse,
  Meta,
  Overview,
  ReportDateItem,
  Topology,
  TraceDetail,
  TracesQuery,
  TracesResponse,
} from './types'

export const ENGINE_TIMEOUT_MS = 8_000

/** Base URL of the engine as server code sees it (no trailing slash). */
export function engineUrl(): string {
  return (process.env.ENGINE_URL || 'http://localhost:5100').replace(/\/+$/, '')
}

export interface EngineError {
  /** unreachable = connection refused / DNS; timeout = no answer in 8 s; http = 4xx/5xx; invalid = not JSON. */
  kind: 'unreachable' | 'timeout' | 'http' | 'invalid'
  /** HTTP status for kind http, else null. */
  status: number | null
  /** The engine's message (400s name the bad parameter) or the network error. */
  message: string
  /** Path with query, e.g. /api/logs?env=prod. */
  path: string
  /** Engine base URL that was called. */
  engineUrl: string
}

export type EngineResult<T> = { ok: true; data: T; ms: number } | { ok: false; error: EngineError }

function bodyMessage(body: unknown, fallback: string): string {
  const b = body as Partial<EngineErrorBody> | null
  if (b && Array.isArray(b.message)) return b.message.join('; ')
  if (b && typeof b.message === 'string' && b.message) return b.message
  return fallback
}

/** The signed-in user's session (cookie skilllane_monitoring_session, set by the engine through /engine/auth/login) for the engine. */
async function sessionHeader(): Promise<Record<string, string>> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value
    return token ? { authorization: `Bearer ${token}` } : {}
  } catch {
    // outside a request (build): no session
    return {}
  }
}

export const SESSION_COOKIE = 'skilllane_monitoring_session'
const AUTH_PAGES = ['/login', '/set-password']

/**
 * The session ended (expired, banned, reset, a new engine key): to /login and back here after. Every page, also
 * on a client navigation, where the root layout's own check does not run again and the page would read the 401 as
 * "no permission". Not on the sign-in pages, which ask /me to see whether someone is signed in.
 */
async function toLoginOn401(): Promise<void> {
  let path: string
  let search: string
  try {
    const h = await headers()
    path = h.get('x-skilllane-monitoring-path') ?? '/'
    search = h.get('x-skilllane-monitoring-search') ?? ''
  } catch {
    // outside a request (build)
    return
  }
  if (AUTH_PAGES.some((p) => path === p || path.startsWith(`${p}/`))) return
  redirect(`/login?next=${encodeURIComponent(`${path}${search}`)}`)
}

/** GET <ENGINE_URL><path>?<query> with no-store and an 8 s timeout, as the signed-in user. */
export async function engineGet<T>(path: string, query?: QueryInput): Promise<EngineResult<T>> {
  const base = engineUrl()
  const full = `${path}${toSearch(query)}`
  const started = Date.now()
  const fail = (kind: EngineError['kind'], message: string, status: number | null = null): EngineResult<T> => ({
    ok: false,
    error: { kind, status, message, path: full, engineUrl: base },
  })
  let res: Response
  try {
    res = await fetch(`${base}${full}`, {
      cache: 'no-store',
      headers: { accept: 'application/json', ...(await sessionHeader()) },
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    })
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return fail('timeout', `no answer within ${ENGINE_TIMEOUT_MS / 1000} s`)
    }
    return fail('unreachable', err.cause?.code ?? err.cause?.message ?? err.message)
  }
  if (res.status === 401) await toLoginOn401()
  const text = await res.text().catch(() => '')
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    if (res.ok) return fail('invalid', `answer is not JSON (${text.slice(0, 80)})`, res.status)
  }
  if (!res.ok) return fail('http', bodyMessage(body, `${res.status} ${res.statusText}`), res.status)
  return { ok: true, data: body as T, ms: Date.now() - started }
}

/** One function per endpoint (SPEC.md §8). Path segments are URL-encoded here. */
export const engine = {
  health: () => engineGet<Health>('/api/health'),
  meta: (q: Pick<CommonQuery, 'env' | 'service'> = {}) => engineGet<Meta>('/api/meta', q),
  overview: (q: CommonQuery) => engineGet<Overview>('/api/overview', q),
  logs: (q: LogsQuery) => engineGet<LogsResponse>('/api/logs', q),
  traces: (q: TracesQuery) => engineGet<TracesResponse>('/api/traces', q),
  trace: (traceId: string, q: Pick<CommonQuery, 'env'> = {}) =>
    engineGet<TraceDetail>(`/api/traces/${encodeURIComponent(traceId)}`, q),
  /** One span with its request / response, query + binds or message (raw: read it with normalizeSpanDetail() of lib/io.ts). */
  span: (traceId: string, spanId: string, q: Pick<CommonQuery, 'env'> = {}) =>
    engineGet<unknown>(`/api/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(spanId)}`, q),
  errors: (q: ErrorsQuery) => engineGet<ErrorsResponse>('/api/errors', q),
  error: (fingerprint: string, q: CommonQuery) =>
    engineGet<ErrorDetail>(`/api/errors/${encodeURIComponent(fingerprint)}`, q),
  jobs: (q: CommonQuery) => engineGet<JobsResponse>('/api/jobs', q),
  dependencies: (q: CommonQuery) => engineGet<DependenciesResponse>('/api/dependencies', q),
  /** 3D system map: nodes + edges with calls/min (lib/topology.ts → <SystemMap3D>). */
  topology: (q: CommonQuery) => engineGet<Topology>('/api/topology', q),
  /** Daily report snapshot; no date = the latest one of the env. */
  dailyReport: (q: { env: string; date?: string }) => engineGet<DailyReport>('/api/reports/daily', q),
  reportDates: (q: { env: string }) => engineGet<{ env: string; dates: ReportDateItem[] }>('/api/reports/daily/dates', q),
  /** The signed-in user: permissions per permission ('all' or envs) and the envs they reach. */
  me: () => engineGet<Me>('/api/auth/me'),
}

/** /api/auth/me once per request. */
export const getMe = cache(() => engine.me())

/** /api/meta (all envs) once per request: the layout and the page share it. */
export const getMeta = cache(() => engine.meta())

/** /api/health once per request. */
export const getHealth = cache(() => engine.health())
