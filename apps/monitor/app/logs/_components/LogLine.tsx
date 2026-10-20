/**
 * One row of the log table: `tr[data-key]` (LiveTbody marks new ones), the whole row opens the drawer (it
 * clicks the row's `a.lg-title` DrawerLink, so focus returns there), and error rows get the expand toggle
 * with their `tr.row-detail` (ต้องแก้อะไร / error จริง / trace + user). components/ExpandRow with the log table's cells.
 */
import type { ReactNode } from 'react'
import { ExpandRow } from '@/components/ExpandRow'

export function LogLine({
  rowKey,
  className,
  current,
  cells,
  detail,
  toggleLabel,
  colSpan,
}: {
  rowKey: string
  className: string
  /** The row whose drawer is open (aria-current). */
  current?: boolean
  /** The <td>s after the toggle cell. */
  cells: ReactNode
  /** `.row-detail__body` of an error row; no toggle without it. */
  detail?: ReactNode
  toggleLabel: string
  colSpan: number
}) {
  return (
    <ExpandRow
      dataKey={rowKey}
      className={className}
      current={current}
      rowOpens="a.lg-title"
      toggleCellClassName="lg-tog"
      cells={cells}
      detail={detail}
      label={toggleLabel}
      colSpan={colSpan}
    />
  )
}
