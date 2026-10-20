/**
 * Small inline markers (DESIGN.md §5): level, HTTP method/status, error category, NEW,
 * env, tag, state, service, timestamp. Markup is the mockups' markup; colour always comes
 * with a word. Usable from server and client components.
 */
import type { CSSProperties, ReactNode } from 'react'
import { fmtDateTime, fmtDateTimeMs, fmtTime, fmtTimeMs, fmtTimeSec, type TimeInput } from '@/lib/format'
import { CATEGORY_LABEL, LEVEL_SHORT } from '@/lib/readable'
import { KNOWN_SERVICES, svcClass, svcColor } from '@/lib/services'
import { Icon, type IconName } from './icons'

/** `.lvl.lvl--err` ERR … (outline → tint → solid by severity). Accepts debug|info|warn|error|fatal. */
export function LevelBadge({ level }: { level: string }) {
  const short = LEVEL_SHORT[level] ?? level.slice(0, 3).toUpperCase()
  return <span className={`lvl lvl--${short.toLowerCase()}`}>{short}</span>
}

/** `.method` GET */
export function Method({ method }: { method: string }) {
  return <span className="method">{method}</span>
}

/** `.http.http--5xx` 500 — 2xx/3xx stay neutral. */
export function HttpStatus({ status }: { status: number }) {
  if (!status) return null
  const cls = `http--${Math.floor(status / 100)}xx`
  return <span className={`http ${cls}`}>{status}</span>
}

const CATEGORY_ICON: Record<string, IconName> = {
  bug: 'cat-bug',
  input: 'cat-input',
  data: 'cat-data',
  dependency: 'cat-dependency',
  config: 'cat-config',
}

/** `.cat.cat--data` with its icon and Thai label (bug is bolder). Unknown categories show the raw value. */
export function CategoryChip({ category }: { category: string }) {
  if (!category) return null
  const icon = CATEGORY_ICON[category]
  return (
    <span className={`cat cat--${category}`} title={`category: ${category}`}>
      {icon ? <Icon name={icon} /> : null}
      {CATEGORY_LABEL[category] ?? category}
    </span>
  )
}

/** `.badge-new` NEW (+ `ตั้งแต่ <version>`): novelty, not severity. */
export function NewBadge({ since }: { since?: string }) {
  return (
    <>
      <span className="badge-new">NEW</span>
      {since ? <span className="badge-new__since">ตั้งแต่ {since}</span> : null}
    </>
  )
}

/** `.live`: "สด" with a dot for data that refreshes by itself (the dot pulses while motion is on). */
export function Live({ children = 'สด', title = 'อัปเดตอัตโนมัติ' }: { children?: ReactNode; title?: string }) {
  return (
    <span className="live" title={title}>
      {children}
    </span>
  )
}

/** `.env` tag; prod gets its own marker colour. */
export function EnvTag({ env }: { env?: string | null }) {
  if (!env) return <span className="env">ทุก env</span>
  return <span className={env === 'prod' ? 'env env--prod' : 'env'}>{env}</span>
}

/** `.tag`: version, queue system, kind, error code. */
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="tag" title={title}>
      {children}
    </span>
  )
}

/** `.state(--ok|--warn|--down)`: dot shape differs per state; always with a label. */
export function StateChip({ state, children, title }: { state: 'ok' | 'warn' | 'down' | 'unknown'; children: ReactNode; title?: string }) {
  const cls = state === 'unknown' ? 'state' : `state state--${state}`
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  )
}

/**
 * `.svc.svc-N` service tag: 8 px colour key + name + `/role`. Colour is fixed per service
 * (lib/services.ts); pass `order={serviceOrder(meta)}` so services beyond the known three keep their slot.
 */
export function ServiceChip({ service, role, order = KNOWN_SERVICES }: { service: string; role?: string; order?: readonly string[] }) {
  return (
    <span className={`svc ${svcClass(service, order)}`.trim()}>
      {service}
      {role ? <span className="svc__role">/{role}</span> : null}
    </span>
  )
}

/** `.svc-dots`: one key per service a trace touched, the count from 2 services, the names for screen readers. */
export function ServiceDots({ services, order = KNOWN_SERVICES }: { services: string[]; order?: readonly string[] }) {
  return (
    <span className="svc-dots" title={services.join(', ')}>
      {services.map((s) => (
        <i key={s} style={{ '--c': svcColor(s, order) } as CSSProperties} />
      ))}
      {services.length > 1 ? <span className="svc-dots__n">{services.length}</span> : null}
      <span className="sr-only">{services.join(', ')}</span>
    </span>
  )
}

const TS_FORMATS = {
  ms: fmtTimeMs,
  sec: fmtTimeSec,
  min: fmtTime,
  date: fmtDateTime,
  'date-ms': fmtDateTimeMs,
} as const

/**
 * `.ts` ICT timestamp in a <time> element (full ISO in dateTime + title).
 * format: ms `14:18:07.412` (default) · sec `14:20:00` · min `14:18` · date `17 ต.ค. 14:18` · date-ms.
 */
export function Ts({ value, format = 'ms', className }: { value: TimeInput; format?: keyof typeof TS_FORMATS; className?: string }) {
  const iso = typeof value === 'string' ? value : value === null || value === undefined ? '' : new Date(value).toISOString()
  return (
    <time className={className ? `ts ${className}` : 'ts'} dateTime={iso || undefined} title={iso ? `${fmtDateTimeMs(value)} ICT` : undefined}>
      {TS_FORMATS[format](value)}
    </time>
  )
}
