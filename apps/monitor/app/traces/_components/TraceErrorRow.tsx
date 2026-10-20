'use client'

/**
 * An error row of the trace list with its expand toggle (DESIGN.md §5 row-toggle + tr.row-detail).
 * The readable error loads on first open from GET /api/traces/:traceId (through /engine); the row
 * that starts open gets its trace from the server. The page's other cells come in as `cells`.
 */
import { type ReactNode, useRef, useState } from 'react'
import { ExpandRow } from '@/components/ExpandRow'
import { EngineErrorState, Skeleton } from '@/components/states'
import { type ClientEngineError, clientGet } from '@/lib/engine-client'
import type { TraceDetail } from '@/lib/types'
import { type ErrorBlockContext, TraceErrorBlock } from './TraceErrorBlock'

type Load = { status: 'idle' | 'loading' } | { status: 'ok'; data: TraceDetail } | { status: 'error'; error: ClientEngineError }

export function TraceErrorRow({
  traceId,
  rowKey,
  env,
  cells,
  className,
  label,
  colSpan,
  defaultOpen = false,
  initial,
  ctx,
}: {
  traceId: string
  /** data-key of the row (unique per entry span). */
  rowKey: string
  env?: string
  /** The <td>s after the toggle cell. */
  cells: ReactNode
  className?: string
  /** aria-label of the toggle. */
  label: string
  /** All columns, toggle included. */
  colSpan: number
  defaultOpen?: boolean
  initial?: TraceDetail | null
  ctx: ErrorBlockContext
}) {
  const [load, setLoad] = useState<Load>(initial ? { status: 'ok', data: initial } : { status: 'idle' })
  const started = useRef(!!initial)

  const fetchDetail = async () => {
    started.current = true
    setLoad({ status: 'loading' })
    const res = await clientGet<TraceDetail>(`/traces/${traceId}`, { env })
    setLoad(res.ok ? { status: 'ok', data: res.data } : { status: 'error', error: res.error })
  }

  // first open fetches; re-opening after a failed fetch tries again (a router refresh never re-runs this fetch)
  const onToggle = (open: boolean) => {
    if (!open || (started.current && load.status !== 'error')) return
    void fetchDetail()
  }

  return (
    <ExpandRow
      dataKey={rowKey}
      className={className}
      toggleCellClassName="col-tight tr-c-tog"
      cells={cells}
      label={label}
      colSpan={colSpan}
      defaultOpen={defaultOpen}
      detailClassName="tr-detail-row"
      detailSpansToggle
      onToggle={onToggle}
      detail={
        <div className="row-detail__body">
          {load.status === 'ok' ? (
            <TraceErrorBlock detail={load.data} ctx={ctx} />
          ) : load.status === 'error' ? (
            <EngineErrorState error={load.error} inPanel={false} onRetry={fetchDetail} />
          ) : (
            <div className="tr-detail-skel" aria-busy="true">
              <span className="sr-only">กำลังโหลด…</span>
              <Skeleton variant="title" />
              <Skeleton variant="text" />
              <Skeleton variant="short" />
            </div>
          )}
        </div>
      }
    />
  )
}
