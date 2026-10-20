'use client'

/** "Service ของกราฟและ route": the select of the trend section; changes `service` + `role` in the URL (same as clicking a health row). */
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/icons'

export function ServiceSelect({ options, value }: { options: Array<{ value: string; label: string; href: string }>; value: string }) {
  const router = useRouter()
  return (
    <label className="select">
      <span className="sr-only">Service ของกราฟและ route</span>
      <select
        className="select__control"
        name="service"
        value={value}
        onChange={(e) => {
          const o = options.find((x) => x.value === e.target.value)
          if (o) router.push(o.href, { scroll: false })
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" className="select__chev" />
    </label>
  )
}
