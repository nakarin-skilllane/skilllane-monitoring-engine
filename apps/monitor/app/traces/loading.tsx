import { Skeleton, TableSkeleton } from '@/components/states'

/** While the trace list loads: page head, filter row, the scatter and the table. */
export default function Loading() {
  return (
    <div role="status" aria-label="กำลังโหลด" aria-busy="true">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={160} height={12} />
          <Skeleton width={120} height={24} />
          <Skeleton width="min(520px, 90%)" height={14} />
        </div>
      </div>
      <div className="filterbar tr-filters">
        <Skeleton width="min(760px, 100%)" height={32} />
      </div>
      <div className="chart">
        <Skeleton variant="title" />
        <Skeleton variant="chart" height={240} />
      </div>
      <div className="panel mt-6">
        <TableSkeleton rows={8} cols={7} />
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
