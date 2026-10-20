'use client'

/**
 * /logs filter controls whose state lives in the URL (the page re-renders on the server with it). A change
 * drops the paging (`before`, `limit`) and the drawer.
 *
 *   <LevelChips counts={{ debug: 0, info: 101979, … }} />   pressed = shown; no `level` param = all pressed; a click
 *                                                           while all are shown keeps only that level (ERR → errors only),
 *                                                           later clicks add or remove one; hiding the last one shows all
 *   <EventChips />                                          one of http.request · job.* · dependency.*
 *   <FilterSelect param="route" label="Route" allLabel="ทุก route" options={[…]} />
 *   <UserIdSearch />                                        Enter = userId=…
 */
import { Icon } from '@/components/icons'
import { useParamNav } from '@/components/ParamControls'
import { fmtCount } from '@/lib/format'
import { LEVEL_SHORT } from '@/lib/readable'
import { type Level, LEVELS } from '@/lib/types'

const DRAWER_RESET = { drawer: null }
const useNav = () => useParamNav(DRAWER_RESET)

export function LevelChips({ counts }: { counts: Record<Level, number> }) {
  const { sp, go } = useNav()
  const raw = (sp.get('level') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  const list = LEVELS.filter((l) => raw.includes(l))
  const all = !list.length || list.length === LEVELS.length
  const on = (l: Level) => all || list.includes(l)
  const toggle = (l: Level) => {
    // all shown: the first click during an incident means "only this level" (it used to hide it)
    const next = all ? [l] : list.includes(l) ? list.filter((x) => x !== l) : LEVELS.filter((x) => x === l || list.includes(x))
    go({ level: next.length && next.length < LEVELS.length ? next.join(',') : null })
  }
  return (
    <div className="chips">
      {LEVELS.map((l) => (
        <button
          key={l}
          className="fchip lg-fchip-lvl"
          type="button"
          aria-pressed={on(l)}
          title={all ? `กดเพื่อดูเฉพาะ ${LEVEL_SHORT[l]}` : on(l) ? `กดเพื่อซ่อน ${LEVEL_SHORT[l]}` : `กดเพื่อแสดง ${LEVEL_SHORT[l]} ด้วย`}
          onClick={() => toggle(l)}
        >
          {LEVEL_SHORT[l]} <span className="fchip__n">{fmtCount(counts[l] ?? 0)}</span>
        </button>
      ))}
    </div>
  )
}

const EVENTS = ['http.request', 'job.*', 'dependency.*']

export function EventChips() {
  const { sp, go } = useNav()
  const current = sp.get('event') ?? ''
  return (
    <div className="chips">
      {EVENTS.map((e) => (
        <button key={e} className="fchip mono" type="button" aria-pressed={current === e} onClick={() => go({ event: current === e ? null : e })}>
          {e}
        </button>
      ))}
    </div>
  )
}

export function FilterSelect({
  param,
  label,
  allLabel,
  options,
}: {
  param: string
  /** sr-only label. */
  label: string
  allLabel: string
  /** `group` puts the option in an <optgroup> of that label (HTTP routes vs job keys). */
  options: Array<{ value: string; label: string; group?: string }>
}) {
  const { sp, go } = useNav()
  const value = sp.get(param) ?? ''
  const list = value && !options.some((o) => o.value === value) ? [{ value, label: value }, ...options] : options
  const option = (o: { value: string; label: string }) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  )
  const groups = Array.from(new Set(list.map((o) => o.group ?? '')))
  return (
    <label className="select">
      <span className="sr-only">{label}</span>
      <select className="select__control" name={param} value={value} onChange={(e) => go({ [param]: e.target.value || null })}>
        <option value="">{allLabel}</option>
        {groups.length > 1
          ? groups.map((gr) =>
              gr ? (
                <optgroup key={gr} label={gr}>
                  {list.filter((o) => o.group === gr).map(option)}
                </optgroup>
              ) : (
                list.filter((o) => !o.group).map(option)
              ),
            )
          : list.map(option)}
      </select>
      <Icon name="chevron" className="select__chev" />
    </label>
  )
}

export function UserIdSearch() {
  const { sp, go } = useNav()
  const current = sp.get('userId') ?? ''
  return (
    <form
      className="search search--sm lg-user"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const v = String(new FormData(e.currentTarget).get('userId') ?? '').trim()
        go({ userId: v || null })
      }}
    >
      <Icon name="search" />
      <label className="sr-only" htmlFor="lg-user">
        User id
      </label>
      <input key={current} className="search__input" id="lg-user" type="search" name="userId" defaultValue={current} placeholder="user id เช่น u_1029" autoComplete="off" spellCheck={false} />
    </form>
  )
}

/** "ขยาย error ทั้งหมด": opens every collapsed error row of the table (like the mockup's script). */
export function ExpandAllButton() {
  return (
    <button
      className="btn btn--sm btn--quiet"
      type="button"
      onClick={() => {
        document.querySelectorAll<HTMLButtonElement>('.lg-table .row-toggle[aria-expanded="false"]').forEach((b) => b.click())
      }}
    >
      <Icon name="chevron" size="sm" />
      ขยาย error ทั้งหมด
    </button>
  )
}
