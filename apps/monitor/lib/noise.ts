/**
 * Noise groups in a URL param (pure), shared by /logs (`show`) and /traces (`noise`):
 *
 *   all | none | probe,cache   groups shown; absent = none, or all while the page is narrowed to one thing
 *
 * Narrowed = a page asking for one thing (a trace, a job, a route …): every line or entry of it is wanted.
 */
export function shownGroups<G extends string>(groups: readonly G[], raw: string | undefined, narrowed: boolean): G[] {
  if (raw === undefined) return narrowed ? [...groups] : []
  if (raw === 'all') return [...groups]
  const list = raw.split(',').map((s) => s.trim())
  return groups.filter((g) => list.includes(g))
}

/** The param for these shown groups; null = the page's default. */
export function groupsParam<G extends string>(groups: readonly G[], shown: readonly G[], narrowed: boolean): string | null {
  const all = shown.length === groups.length
  if (narrowed ? all : !shown.length) return null
  return all ? 'all' : shown.length ? groups.filter((g) => shown.includes(g)).join(',') : 'none'
}
