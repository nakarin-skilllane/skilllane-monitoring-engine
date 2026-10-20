'use client'

/**
 * /errors filters kept in the URL (the server re-renders with them): service select, error / warn chips
 * (no `level` = both on; `level=none` = both off; a click while both are on keeps only that one, as on /logs)
 * and the sort segmented control (engine `sort`).
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { Icon } from '@/components/icons'
import { withParams } from '@/lib/params'

function useNav() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [, start] = useTransition()
  return (changes: Record<string, string | null>) => start(() => router.push(withParams(pathname, sp, changes), { scroll: false }))
}

export function ServiceSelect({ services, value }: { services: string[]; value?: string }) {
  const go = useNav()
  return (
    <label className="select">
      <span className="sr-only">Service</span>
      <select className="select__control" name="service" value={value ?? ''} onChange={(e) => go({ service: e.target.value || null, role: null })}>
        <option value="">ทุก service</option>
        {services.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Icon name="chevron" className="select__chev" />
    </label>
  )
}

export type LevelKey = 'error' | 'warn'

export function LevelChips({ selected, counts }: { selected: LevelKey[]; counts: Record<LevelKey, number> }) {
  const go = useNav()
  const all = selected.length === 2
  function toggle(k: LevelKey) {
    // both on: the first click means "only this one"; after that a click adds or removes one
    const next = all ? [k] : selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]
    go({ level: next.length === 2 ? null : next.length ? next.join(',') : 'none' })
  }
  return (
    <div className="chips" role="group" aria-labelledby="eg-level-label">
      <span className="filter-label" id="eg-level-label">
        ระดับ
      </span>
      {(['error', 'warn'] as const).map((k) => (
        <button
          key={k}
          className="fchip"
          type="button"
          aria-pressed={selected.includes(k)}
          title={`${counts[k]} group · ${all ? `กดเพื่อดูเฉพาะ ${k}` : selected.includes(k) ? `กดเพื่อซ่อน ${k}` : `กดเพื่อแสดง ${k}`}`}
          onClick={() => toggle(k)}
        >
          {k} <span className="fchip__n">{counts[k]}</span>
        </button>
      ))}
    </div>
  )
}

const SORTS = [
  { value: 'count', label: 'จำนวน', title: 'จำนวนครั้งมากก่อน' },
  { value: 'lastSeen', label: 'ล่าสุด', title: 'เกิดล่าสุดก่อน' },
  { value: 'firstSeen', label: 'ใหม่', title: 'เห็นครั้งแรกล่าสุดก่อน (group ใหม่ขึ้นบน)' },
] as const

export function SortSeg({ value }: { value: string }) {
  const go = useNav()
  return (
    <>
      <span className="filter-label" id="eg-sort-label">
        เรียงตาม
      </span>
      <div className="seg" role="group" aria-labelledby="eg-sort-label">
        {SORTS.map((s) => (
          <button key={s.value} className="seg__btn" type="button" aria-pressed={s.value === value} title={s.title} onClick={() => go({ sort: s.value === 'count' ? null : s.value })}>
            {s.label}
          </button>
        ))}
      </div>
    </>
  )
}
