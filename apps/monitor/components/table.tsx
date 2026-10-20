/**
 * Table helpers (DESIGN.md §4–5): `.table-wrap` (+ `--scroll` for a sticky head, 480 px),
 * `table.table(--dense)(--reflow)`, sortable headers as links, number and duration cells.
 * Rows stay plain <tr>: `is-bad` / `is-slow` markers, `aria-current="true"` for the selected
 * row, <ExpandRow> for an expandable one. Below 600 px a `--reflow` table becomes small
 * grids: the screen CSS sets grid-template-areas on tr and grid-area on cells, cells get
 * `data-label`, unimportant columns `rf-hide`.
 */
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { fmtMs } from '@/lib/format'

export function TableWrap({ scroll, label, children, className }: { scroll?: boolean; label?: string; children: ReactNode; className?: string }) {
  const cls = ['table-wrap', scroll ? 'table-wrap--scroll' : '', className ?? ''].filter(Boolean).join(' ')
  // a scrolling region must be reachable by keyboard
  return (
    <div className={cls} role={label ? 'region' : undefined} aria-label={label} tabIndex={scroll || label ? 0 : undefined}>
      {children}
    </div>
  )
}

export function Table({ dense, reflow, caption, children, className }: { dense?: boolean; reflow?: boolean; caption?: ReactNode; children: ReactNode; className?: string }) {
  const cls = ['table', dense ? 'table--dense' : '', reflow ? 'table--reflow' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <table className={cls}>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      {children}
    </table>
  )
}

/** Header cell that sorts by following `href`; `dir` marks the current sort (arrow from CSS). */
export function SortTh({ label, href, dir, num, className }: { label: ReactNode; href: string; dir?: 'ascending' | 'descending'; num?: boolean; className?: string }) {
  const cls = [num ? 'num' : '', className ?? ''].filter(Boolean).join(' ') || undefined
  return (
    <th scope="col" className={cls} aria-sort={dir ?? 'none'}>
      <Link href={href} scroll={false} prefetch={false} className="link-quiet">
        {label}
      </Link>
    </th>
  )
}

/** Right-aligned tabular number; `label` = data-label shown in reflowed rows. */
export function NumCell({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <td className={className ? `num ${className}` : 'num'} data-label={label}>
      {children}
    </td>
  )
}

/** `.dur` bar: start and width in % of the column / trace; colour via `color` (CSS value) or tone. */
export function DurBar({ start = 0, width, color, tone, className }: { start?: number; width: number; color?: string; tone?: 'warn' | 'bad'; className?: string }) {
  const cls = ['dur', tone ? `dur--${tone}` : '', className ?? ''].filter(Boolean).join(' ')
  const style = { '--s': start.toFixed(2), '--w': Math.max(0, Math.min(100, width)).toFixed(2), ...(color ? { '--c': color } : {}) } as CSSProperties
  return (
    <span className={cls} aria-hidden="true">
      <i style={style} />
    </span>
  )
}

/** Duration value + 72 px bar to scale of `max` (`.dur-cell`). Exact ms like trace lists. */
export function DurCell({ ms, max, tone, label = 'เวลา' }: { ms: number; max: number; tone?: 'warn' | 'bad'; label?: string }) {
  return (
    <td className="num" data-label={label}>
      <span className="dur-cell">
        {fmtMs(ms)}
        <DurBar width={max > 0 ? (ms / max) * 100 : 0} tone={tone} />
      </span>
    </td>
  )
}
