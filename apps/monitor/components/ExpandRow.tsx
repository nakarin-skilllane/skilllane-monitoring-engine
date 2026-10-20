'use client'

/**
 * A table row with an expand toggle (port of app.js `[data-expand]`): first cell holds
 * `button.row-toggle`, the detail row `tr.row-detail` below opens and closes.
 *
 *   <ExpandRow label="ขยาย Value too long for column 14:18:09.226" colSpan={5} className="is-bad"
 *     cells={<><td>…</td><td>…</td></>} detail={<div className="row-detail__body">…</div>} />
 *
 * Row options: `dataKey` (data-key for <LiveTbody>), `rowId` (anchor target), `current` (aria-current),
 * `rowOpens="a.lg-title"` (a click anywhere on the row that is not on a control clicks that element, e.g. the
 * drawer link, so focus returns there), `detailClassName` / `detailSpansToggle` (the detail cell spans the
 * toggle column too, `colSpan` then counts every column), `onToggle` (lazy-load the detail on first open).
 * Without `detail` the row has an empty toggle cell and no detail row.
 */
import { type MouseEvent, type ReactNode, useId, useState } from 'react'
import { Icon } from './icons'

export function ExpandRow({
  cells,
  detail,
  colSpan,
  label,
  className,
  defaultOpen = false,
  toggleCellClassName,
  dataKey,
  rowId,
  current,
  rowOpens,
  detailClassName,
  detailSpansToggle,
  onToggle,
}: {
  /** The <td>s after the toggle cell. */
  cells: ReactNode
  /** Content of the detail row (usually a `.row-detail__body`); none = a plain row. */
  detail?: ReactNode
  /** Columns the detail spans (all but the toggle column, unless `detailSpansToggle`). */
  colSpan: number
  /** aria-label of the toggle: say which row it opens. */
  label: string
  className?: string
  defaultOpen?: boolean
  toggleCellClassName?: string
  dataKey?: string
  rowId?: string
  current?: boolean
  /** Selector of the element a click on the row clicks (whole-row opener). */
  rowOpens?: string
  detailClassName?: string
  detailSpansToggle?: boolean
  onToggle?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const has = detail !== undefined && detail !== null && detail !== false
  const cls = [className, rowOpens ? 'is-clickable' : '', open && has ? 'is-expanded' : ''].filter(Boolean).join(' ') || undefined
  const toggle = () => {
    const next = !open
    setOpen(next)
    onToggle?.(next)
  }
  const onRowClick = rowOpens
    ? (e: MouseEvent<HTMLTableRowElement>) => {
        const t = e.target as Element
        if (t.closest('a, button, input, select, summary, label, [data-tip]')) return
        if (window.getSelection()?.toString()) return
        e.currentTarget.querySelector<HTMLElement>(rowOpens)?.click()
      }
    : undefined
  return (
    <>
      <tr className={cls} id={rowId} data-key={dataKey} aria-current={current ? 'true' : undefined} onClick={onRowClick}>
        <td className={toggleCellClassName ?? 'col-tight'}>
          {has ? (
            <button className="row-toggle" type="button" aria-expanded={open} aria-controls={id} aria-label={label} onClick={toggle}>
              <Icon name="chevron-right" />
            </button>
          ) : null}
        </td>
        {cells}
      </tr>
      {has ? (
        <tr className={detailClassName ? `row-detail ${detailClassName}` : 'row-detail'} id={id} hidden={!open}>
          {detailSpansToggle ? null : <td />}
          <td colSpan={colSpan}>{detail}</td>
        </tr>
      ) : null}
    </>
  )
}
