'use client'

/**
 * Filters whose state lives in the URL (the page re-renders on the server with it).
 * Changing a filter drops the paging (`before`, `cursor`, `limit`: lib/params PAGING_KEYS).
 *
 *   <ParamSegmented label="สถานะ" param="status" options={[{ value: '', label: 'ทั้งหมด' }, { value: 'error', label: 'Error' }]} />
 *   <ParamToggleChip param="level" value="error" multi label="ERR" count={228} />   level=warn,error
 *   <AppliedChip param="userId" label="user" value="u_1029" />                       fchip--applied with ×
 *   const { sp, go } = useParamNav({ drawer: null })                                  own controls; also closes the drawer
 *
 * For free text use a plain <form method="get"> with hidden env/from/to inputs (works without JS).
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { PAGING_KEYS, withParams } from '@/lib/params'
import { Icon } from './icons'

const PAGING_RESET = Object.fromEntries(PAGING_KEYS.map((k) => [k, null])) as Record<string, null>

/** Push a filter change (scroll kept), dropping the paging params and `reset` (e.g. a screen's drawer param). */
export function useParamNav(reset?: Record<string, null>) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const go = (changes: Record<string, string | null>) =>
    start(() => router.push(withParams(pathname, sp, { ...changes, ...PAGING_RESET, ...reset }), { scroll: false }))
  return { sp, go, pending }
}

/** `.seg[role=group]` single choice; '' value = param removed. */
export function ParamSegmented({ label, param, options, className }: { label: string; param: string; options: Array<{ value: string; label: string }>; className?: string }) {
  const { sp, go } = useParamNav()
  const current = sp.get(param) ?? ''
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className="seg__btn" type="button" aria-pressed={o.value === current} onClick={() => go({ [param]: o.value || null })}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * `button.fchip[aria-pressed]`; `multi` toggles `value` inside a comma list. `all` (multi only) = every value of the
 * list: no param means all of them pressed, and pressing the last missing one removes the param again.
 */
export function ParamToggleChip({
  param,
  value,
  label,
  count,
  multi,
  all,
  className,
}: {
  param: string
  value: string
  label: string
  count?: number | string
  multi?: boolean
  all?: readonly string[]
  /** Extra classes after `fchip` (`mono`, a screen's chip class). */
  className?: string
}) {
  const { sp, go } = useParamNav()
  const raw = (sp.get(param) ?? '').split(',').filter(Boolean)
  const list = all && !raw.length ? [...all] : raw
  const on = multi ? list.includes(value) : sp.get(param) === value
  let next = multi ? (on ? list.filter((v) => v !== value) : [...list, value]).join(',') : on ? '' : value
  if (multi && all) {
    const picked = all.filter((v) => next.split(',').includes(v))
    next = picked.length === all.length ? '' : picked.join(',')
  }
  return (
    <button className={className ? `fchip ${className}` : 'fchip'} type="button" aria-pressed={on} onClick={() => go({ [param]: next || null })}>
      {label}
      {count !== undefined ? <span className="fchip__n">{count}</span> : null}
    </button>
  )
}

/** Applied filter `.fchip.fchip--applied`: key, value, × removes the param. */
export function AppliedChip({ param, label, value }: { param: string; label: string; value: string }) {
  const { go } = useParamNav()
  return (
    <span className="fchip fchip--applied">
      <span className="fchip__k">{label}</span>
      <span className="fchip__v" title={value}>
        {value}
      </span>
      <button className="fchip__x" type="button" aria-label={`เอาตัวกรอง ${label} ออก`} onClick={() => go({ [param]: null })}>
        <Icon name="close" />
      </button>
    </span>
  )
}
