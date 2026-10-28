/**
 * Proxy (Next 16's name for middleware). Sign-in first: a page request without
 * the session cookie (skilllane_monitoring_session, set by the engine at /engine/auth/login)
 * goes to /login?next=…, except /login and /set-password; the request path is
 * passed to the layout as x-skilllane-monitoring-path (its query as x-skilllane-monitoring-search). The engine still checks every call: an
 * expired or revoked session is sent to /login by the layout.
 *
 * Unknown detail ids answer HTTP 404.
 *
 * The detail pages stream behind a loading boundary, so a notFound() in them comes after the 200 has been sent. Here
 * a page request for /errors/<fingerprint> or /traces/<traceId> is checked against the engine first (one small call,
 * 10–70 ms) and an id the engine knows nowhere in the retained data (any env, the last 90 days) is rewritten to a
 * path that matches no route, so Next renders app/not-found.tsx (Thai, h1 "ไม่พบหน้านี้", links that keep env /
 * from / to) with status 404; the browser keeps the URL. A malformed id is a 404 too. An id that lives in another env
 * or outside the selected range still opens its page, which says where it is. Not checked: client navigations and
 * prefetches (RSC requests: no status to set), other methods, and anything when the engine does not answer in time
 * (the page shows that itself).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { isFingerprint, isTraceId } from '@/lib/params'

const TIMEOUT_MS = 1500
/** Everything the engine keeps (its range limit is 90 days). */
const LOOKBACK = 'now-90d'

/** Read per request like lib/engine.ts (ENGINE_URL, default http://localhost:5100). */
const engineUrl = () => (process.env.ENGINE_URL || 'http://localhost:5100').replace(/\/+$/, '')

const SESSION_COOKIE = 'skilllane_monitoring_session'
const PUBLIC_PAGES = ['/login', '/set-password']

/** GET an engine path: its status (and JSON body when asked for and 200); null when the engine does not answer. */
async function engineGet(path: string, session: string | undefined, withBody = false): Promise<{ status: number; body: unknown } | null> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (session) headers.authorization = `Bearer ${session}`
    const res = await fetch(`${engineUrl()}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (withBody && res.ok) return { status: res.status, body: await res.json().catch(() => null) }
    await res.body?.cancel()
    return { status: res.status, body: null }
  } catch {
    return null
  }
}

/** true = the engine says the id does not exist; false = it exists, or the engine could not tell. */
async function unknownFingerprint(fp: string, session: string | undefined): Promise<boolean> {
  const res = await engineGet(`/api/errors/${encodeURIComponent(fp)}?from=${LOOKBACK}&step=1d`, session)
  return res?.status === 404
}

async function unknownTrace(id: string, session: string | undefined): Promise<boolean> {
  // the list (trace_index, one row) answers a known trace cheaply; only an empty list asks the detail, whose 404 is final
  const list = await engineGet(`/api/traces?traceId=${id}&from=${LOOKBACK}&limit=1&entries=all`, session, true)
  const rows = (list?.body as { rows?: unknown[] } | null)?.rows
  if (!list || list.status !== 200 || (rows && rows.length > 0)) return false
  const detail = await engineGet(`/api/traces/${id}`, session)
  return detail?.status === 404
}

/** The same URL one segment deeper: no route matches it, so the root not-found page renders with 404. */
function notFound(req: NextRequest, headers: Headers): NextResponse {
  const url = req.nextUrl.clone()
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/__not-found`
  return NextResponse.rewrite(url, { request: { headers } })
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token && !PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    if (pathname !== '/') url.searchParams.set('next', `${pathname}${req.nextUrl.search}`)
    return NextResponse.redirect(url)
  }
  const headers = new Headers(req.headers)
  headers.set('x-skilllane-monitoring-path', pathname)
  headers.set('x-skilllane-monitoring-search', req.nextUrl.search)
  const next = () => NextResponse.next({ request: { headers } })
  if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.has('rsc') || req.headers.has('next-router-prefetch')) return next()
  const [, screen, rawId] = req.nextUrl.pathname.split('/')
  let id: string
  try {
    id = decodeURIComponent(rawId ?? '').trim()
  } catch {
    return notFound(req, headers)
  }
  // detail pages only (/errors/<fingerprint>, /traces/<traceId>)
  if (screen === 'errors' && rawId) {
    if (!isFingerprint(id)) return notFound(req, headers)
    return (await unknownFingerprint(id, token)) ? notFound(req, headers) : next()
  }
  if (screen === 'traces' && rawId) {
    if (!isTraceId(id)) return notFound(req, headers)
    return (await unknownTrace(id.toLowerCase(), token)) ? notFound(req, headers) : next()
  }
  return next()
}

export const config = {
  // every page; not Next's assets, the /engine/* rewrite, or static files
  matcher: ['/((?!_next/|engine/|favicon\\.ico|icon\\.svg|DATA-DICTIONARY\\.md).*)'],
}
