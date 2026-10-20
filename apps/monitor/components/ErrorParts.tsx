/**
 * Pieces of the readable error line (DESIGN.md §6, data from lib/readable.ts):
 * key=value chips, "ต้องแก้อะไร", "error จริง", and id chips with copy.
 *
 *   <KvList items={logKvs(row)} />
 *   <ErrorDetailText text={logDetail(row)} />
 *   <ActualError text={actualError(row.error)} />
 *   <IdChip label="trace" value={row.traceId} href={buildHref(`/traces/${row.traceId}`, keep)} />
 */
import Link from 'next/link'
import type { Kv } from '@/lib/readable'
import { CopyButton } from './CopyButton'

export function KvList({ items, label = 'บริบท', className }: { items: Kv[]; label?: string; className?: string }) {
  if (!items.length) return null
  return (
    <ul className={className ? `kv-list ${className}` : 'kv-list'} aria-label={label}>
      {items.map((kv, i) => (
        <li key={`${kv.k}-${i}`} className={kv.tone ? `kv kv--${kv.tone}` : 'kv'}>
          <span className="kv__k">{kv.k}</span>
          <span className="kv__v">{kv.v}</span>
        </li>
      ))}
    </ul>
  )
}

/** `p.err-row__detail` with the label ต้องแก้อะไร (or your label). */
export function ErrorDetailText({ text, label = 'ต้องแก้อะไร' }: { text: string; label?: string }) {
  if (!text) return null
  return (
    <p className="err-row__detail">
      <span className="err-row__detail-label">{label}</span>
      {text}
    </p>
  )
}

/** `p.err-row__actual` with the label error จริง: `Type [CODE] message` in mono danger. */
export function ActualError({ text, label = 'error จริง' }: { text: string; label?: string }) {
  if (!text) return null
  return (
    <p className="err-row__actual">
      <span className="err-row__actual-label">{label}</span>
      {text}
    </p>
  )
}

/** `.idchip`: muted key, the id (link when href), copy button; full id in title. */
export function IdChip({ label, value, href, copy = true, display }: { label: string; value: string; href?: string; copy?: boolean; display?: string }) {
  if (!value) return null
  return (
    <span className="idchip">
      <span className="idchip__k">{label}</span>
      {href ? (
        <Link href={href} title={value} prefetch={false}>
          {display ?? value}
        </Link>
      ) : (
        <span className="idchip__v" title={value}>
          {display ?? value}
        </span>
      )}
      {copy ? <CopyButton text={value} variant="icon" ariaLabel={`คัดลอก ${label} id`} /> : null}
    </span>
  )
}
