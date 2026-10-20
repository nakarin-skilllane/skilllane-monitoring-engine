/** Query-string building shared by server and client code. */

export type QueryValue = string | number | boolean | null | undefined | readonly string[]

/**
 * Any object of QueryValue fields (typed query interfaces like LogsQuery are
 * accepted as they are: interfaces do not satisfy an index signature).
 */
export type QueryInput = object

/** `?a=1&b=x` from an object; skips undefined, null and ''; arrays become comma lists. */
export function toSearch(query?: QueryInput | URLSearchParams): string {
  if (!query) return ''
  const sp = query instanceof URLSearchParams ? new URLSearchParams(query) : new URLSearchParams()
  if (!(query instanceof URLSearchParams)) {
    for (const [key, raw] of Object.entries(query) as Array<[string, QueryValue]>) {
      if (raw === undefined || raw === null || raw === '') continue
      const value = Array.isArray(raw) ? raw.join(',') : String(raw)
      if (value !== '') sp.set(key, value)
    }
  }
  const text = sp.toString()
  return text ? `?${text}` : ''
}
