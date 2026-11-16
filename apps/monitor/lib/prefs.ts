/**
 * Choices this browser remembers between visits, kept in cookies so the server renders the remembered view on the
 * first paint (no flash, no redirect from the client): the Log page's services and view, the trace page's view.
 * The URL always wins; a pref only fills what the URL leaves out.
 *
 *   server: const view = readPref(await cookies(), PREF.traceView)
 *   client: writePref(PREF.traceView, 'waterfall')
 */

export const PREF = {
  /** Log: the services last looked at (`service` param form: `svc/role,svc/role` or `all`). */
  logSources: 'sm-log-sources',
  /** Log: `timeline` | `raw`. */
  logView: 'sm-log-view',
  /** Trace detail: `timeline` | `waterfall` | `network`. */
  traceView: 'sm-trace-view',
} as const
export type PrefName = (typeof PREF)[keyof typeof PREF]

const YEAR_S = 365 * 86_400
const MAX = 2000

/** What `cookies()` from next/headers returns (only `get` is used). */
export interface CookieReader {
  get(name: string): { value: string } | undefined
}

/** The remembered value, or undefined (missing, empty or too long). */
export function readPref(jar: CookieReader, name: PrefName): string | undefined {
  const raw = jar.get(name)?.value
  if (!raw) return undefined
  let v: string
  try {
    v = decodeURIComponent(raw)
  } catch {
    return undefined
  }
  return v && v.length <= MAX ? v : undefined
}

/** Remember `value` for a year (null forgets it). Client only. */
export function writePref(name: PrefName, value: string | null): void {
  if (typeof document === 'undefined') return
  const v = value ? encodeURIComponent(value.slice(0, MAX)) : ''
  document.cookie = `${name}=${v}; path=/; max-age=${value ? YEAR_S : 0}; samesite=lax`
}
