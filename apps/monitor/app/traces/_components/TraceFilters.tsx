'use client'

/**
 * The trace filter row (traces.html): service, role, route or job, status, minimum duration and the
 * trace id box. Every value lives in the URL and scopes both the scatter and the table; changing one
 * drops the row count (`show`). A full 32-hex id opens that trace; 4–31 hex filter by id prefix.
 * Without JS the id box is a plain GET form.
 */
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, type ReactNode, useTransition } from 'react'
import { Icon } from '@/components/icons'
import { buildHref, type Keep, withParams } from '@/lib/params'

export interface RouteGroup {
  label: string
  options: Array<{ value: string; label: string }>
}

const MIN_MS = [
  { value: '', label: 'ทุกความยาว' },
  { value: '100', label: 'นานกว่า 100 ms' },
  { value: '500', label: 'นานกว่า 500 ms' },
  { value: '1000', label: 'นานกว่า 1 s' },
  { value: '2000', label: 'นานกว่า 2 s (ช้า)' },
  { value: '5000', label: 'นานกว่า 5 s' },
]

const STATUS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'error', label: 'error' },
  { value: 'ok', label: 'ok' },
]

function Select({ name, label, value, onChange, children }: { name: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="select">
      <span className="sr-only">{label}</span>
      <select className="select__control" name={name} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <Icon name="chevron" className="select__chev" />
    </label>
  )
}

export function TraceFilters({
  services,
  roles,
  routeGroups,
  keep,
  clearHref,
  hasFilters,
}: {
  services: string[]
  roles: string[]
  routeGroups: RouteGroup[]
  keep: Keep
  clearHref: string
  hasFilters: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [, start] = useTransition()
  const go = (changes: Record<string, string | null>) => start(() => router.push(withParams(pathname, sp, { ...changes, show: null }), { scroll: false }))
  const cur = (k: string) => sp.get(k) ?? ''
  const minMs = cur('minMs')

  function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const v = (new FormData(e.currentTarget).get('traceId') ?? '').toString().trim().toLowerCase()
    if (/^[0-9a-f]{32}$/.test(v)) router.push(buildHref(`/traces/${v}`, keep))
    else go({ traceId: v || null })
  }

  return (
    <div className="filterbar tr-filters" role="group" aria-label="ตัวกรอง trace">
      <Select name="service" label="Service" value={cur('service')} onChange={(v) => go({ service: v || null })}>
        <option value="">ทุก service</option>
        {services.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <Select name="role" label="Role" value={cur('role')} onChange={(v) => go({ role: v || null })}>
        <option value="">ทุก role</option>
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </Select>
      <Select name="route" label="Route หรือ job" value={cur('route')} onChange={(v) => go({ route: v || null })}>
        <option value="">ทุก route และ job</option>
        {routeGroups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <div className="seg" role="group" aria-label="สถานะ trace">
        {STATUS.map((o) => (
          <button key={o.value} className="seg__btn" type="button" aria-pressed={o.value === cur('status')} onClick={() => go({ status: o.value || null })}>
            {o.label}
          </button>
        ))}
      </div>
      <Select name="minMs" label="เวลาที่ใช้ขั้นต่ำ" value={MIN_MS.some((o) => o.value === minMs) ? minMs : ''} onChange={(v) => go({ minMs: v || null })}>
        {MIN_MS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {minMs && !MIN_MS.some((o) => o.value === minMs) ? <option value={minMs}>นานกว่า {minMs} ms</option> : null}
      </Select>
      <form className="search search--sm tr-search" role="search" action={pathname} method="get" onSubmit={onSearch}>
        <Icon name="search" />
        <label className="sr-only" htmlFor="trace-q">
          เปิด trace จาก trace id
        </label>
        <input
          key={cur('traceId')}
          className="search__input"
          id="trace-q"
          type="search"
          name="traceId"
          placeholder="trace id 32 ตัวอักษร"
          autoComplete="off"
          spellCheck={false}
          pattern="[0-9a-fA-F]{4,32}"
          title="trace id 32 ตัว หรือส่วนต้นอย่างน้อย 4 ตัว (เลขฐานสิบหก)"
          defaultValue={cur('traceId')}
        />
        {/* without JS: keep the other params */}
        {Array.from(sp.entries())
          .filter(([k]) => k !== 'traceId' && k !== 'show')
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
      </form>
      {hasFilters ? (
        <Link className="btn btn--sm btn--quiet filterbar__end" href={clearHref} scroll={false}>
          ล้างตัวกรอง
        </Link>
      ) : (
        <button className="btn btn--sm btn--quiet filterbar__end" type="button" disabled>
          ล้างตัวกรอง
        </button>
      )}
    </div>
  )
}
