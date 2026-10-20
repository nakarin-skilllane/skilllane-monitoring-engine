/**
 * Chart frame (DESIGN.md §5, §7): `figure.chart` > head (title, sub, legend) + plot +
 * foot with the table view (`details.chart__table`; a tooltip never holds the only copy
 * of a value). `timeAxis` = the plot scrolls inside itself on phones, starting at the newest bucket.
 *
 *   <ChartFrame titleId="ov-c-req-t" title="Request ต่อนาที" sub="รวม 70,800 · เฉลี่ย 1,180 ต่อนาที" bare timeAxis
 *     legend={[{ label: 'request', className: 'svc-1', shape: 'line' }]}
 *     table={{ caption: 'ค่าต่อนาที', columns: ['นาที', 'Request'], rows: series.map(s => [fmtTime(s.t), fmtCount(s.requests)]) }}>
 *     <TimeLine labelledBy="ov-c-req-t" … />
 *   </ChartFrame>
 * Bucket links (`bucketHrefs` on the chart) are mouse / touch only: pass the same hrefs as `table.rowHrefs`
 * (in the table's row order) so keyboard users open a bucket from the table's time cell.
 */
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'
import { TimeAxisPlot } from '../ScrollToEnd'

export interface LegendItem {
  label: ReactNode
  /** Class that sets --c (`svc-1`, `c-lvl-err`) or a CSS colour. */
  className?: string
  color?: string
  /** box (default) · line · dot · bar (row marker). */
  shape?: 'box' | 'line' | 'dot' | 'bar'
}

export interface ChartTableData {
  caption: string
  columns: string[]
  /** Cell texts; columns after the first are right-aligned numbers unless `textColumns` says so. */
  rows: Array<Array<ReactNode>>
  textColumns?: number[]
  /** Link of each row (same order as `rows`): the first cell becomes a link, e.g. Log of that minute. */
  rowHrefs?: Array<string | undefined>
  /** `title` of row i's link (e.g. `เปิด Log 12:19–12:20`); without it the link reads as the cell text. */
  rowLinkLabel?: (row: number) => string
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (!items.length) return null
  return (
    <ul className="legend">
      {items.map((it, i) => (
        <li className="legend__item" key={i}>
          <span
            className={[it.shape && it.shape !== 'box' ? `legend__key legend__key--${it.shape}` : 'legend__key', it.className ?? ''].filter(Boolean).join(' ')}
            style={it.color ? ({ '--c': it.color } as CSSProperties) : undefined}
            aria-hidden="true"
          />
          {it.label}
        </li>
      ))}
    </ul>
  )
}

export function ChartTable({ data }: { data: ChartTableData }) {
  return (
    <details className="chart__table">
      <summary className="summary-line">ดูเป็นตาราง</summary>
      <div className="table-wrap">
        <table className="table table--dense">
          <caption className="sr-only">{data.caption}</caption>
          <thead>
            <tr>
              {data.columns.map((c, i) => (
                <th key={i} scope="col" className={i > 0 && !data.textColumns?.includes(i) ? 'num' : undefined}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => {
              const href = data.rowHrefs?.[i]
              return (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j} className={j === 0 ? 'ts' : data.textColumns?.includes(j) ? undefined : 'num'}>
                      {j === 0 && href ? (
                        // a table of 60 rows: no prefetch per link
                        <Link href={href} prefetch={false} title={data.rowLinkLabel?.(i)}>
                          {cell}
                        </Link>
                      ) : (
                        cell
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export function ChartFrame({
  title,
  titleId,
  sub,
  legend,
  bare,
  timeAxis = true,
  foot,
  table,
  children,
  className,
}: {
  title: ReactNode
  /** id of the h3; pass the same to the chart's `labelledBy`. */
  titleId: string
  sub?: ReactNode
  legend?: LegendItem[]
  /** No own border / padding (inside a panel). */
  bare?: boolean
  /** Plot scrolls sideways on phones, starting at the right (default true). */
  timeAxis?: boolean
  foot?: ReactNode
  table?: ChartTableData
  children: ReactNode
  className?: string
}) {
  const cls = ['chart', bare ? 'chart--bare' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <figure className={cls}>
      <div className="chart__head">
        <h3 className="chart__title" id={titleId}>
          {title}
        </h3>
        {sub ? <span className="chart__sub">{sub}</span> : null}
        {legend ? <Legend items={legend} /> : null}
      </div>
      {timeAxis ? <TimeAxisPlot>{children}</TimeAxisPlot> : <div className="chart__plot">{children}</div>}
      {foot || table ? (
        <div className="chart__foot">
          {foot ? <span>{foot}</span> : null}
          {table ? <ChartTable data={table} /> : null}
        </div>
      ) : null}
    </figure>
  )
}
