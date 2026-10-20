import { KpiSkeleton, Skeleton, TableSkeleton } from '@/components/states'

/** While one trace loads: page head, KPI strip and the waterfall rows. */
export default function Loading() {
  return (
    <div role="status" aria-label="กำลังโหลด" aria-busy="true">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={200} height={12} />
          <Skeleton width="min(360px, 80%)" height={24} />
          <Skeleton width="min(560px, 90%)" height={14} />
          <Skeleton width="min(480px, 80%)" height={12} />
        </div>
      </div>
      <KpiSkeleton count={4} />
      <div className="panel mt-6">
        <TableSkeleton rows={9} cols={3} />
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
