'use client'

/**
 * Noise groups as checkboxes (ค้นหาขั้นสูง of /logs and /traces): ticked = shown. A change writes `param`
 * (lib/noise: all | none | list, removed when it is the page's default) and drops the paging.
 *
 *   <NoiseChecks param="noise" groups={TRACE_NOISE_GROUPS} labels={…} counts={res.data.hidden} unit="trace" shown={[]} narrowed={false} />
 */
import { useParamNav } from '@/components/ParamControls'
import { fmtCount } from '@/lib/format'
import { groupsParam } from '@/lib/noise'

export function NoiseChecks<G extends string>({
  param,
  groups,
  labels,
  counts,
  unit,
  shown,
  narrowed,
  reset,
}: {
  param: string
  groups: readonly G[]
  labels: Record<G, { label: string; hint: string }>
  /** Count per group (null while the engine answered an error). */
  counts: Record<G, number> | null
  /** `แถว`, `trace` … after each count. */
  unit: string
  shown: readonly G[]
  narrowed: boolean
  /** Other params a change resets (a screen's drawer or row count). */
  reset?: Record<string, null>
}) {
  const { go } = useParamNav(reset)
  const toggle = (g: G, on: boolean) => go({ [param]: groupsParam(groups, on ? [...shown, g] : shown.filter((x) => x !== g), narrowed) })
  return (
    <>
      {groups.map((g) => (
        <label key={g} className="adv__check">
          <input type="checkbox" checked={shown.includes(g)} onChange={(e) => toggle(g, e.target.checked)} />
          <span className="adv__label">{labels[g].label}</span>
          <span className="t-muted">{labels[g].hint}</span>
          {counts ? (
            <span className="num adv__n">
              {fmtCount(counts[g])} {unit}
            </span>
          ) : null}
        </label>
      ))}
    </>
  )
}
