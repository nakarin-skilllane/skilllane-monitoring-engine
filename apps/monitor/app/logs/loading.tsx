import { Skeleton, TableSkeleton } from '@/components/states'
// No './screen.css' import here: a <Link> prefetch renders this loading boundary, and its CSS would be preloaded on
// every page that links here ("preloaded but not used" console warning). The page imports screen.css; a hard load
// links it in <head>, so only the short client-side skeleton runs without the screen's layout rules (as /traces does).

/** /logs while its server component loads: page head, query bar, filters, histogram, table (the shell stays). */
export default function Loading() {
  return (
    <div className="ui-page-skel" role="status" aria-label="กำลังโหลด">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={160} height={12} />
          <Skeleton width={120} height={24} />
          <Skeleton width="min(560px, 90%)" height={14} />
        </div>
      </div>
      <div className="lg-query">
        <Skeleton width="100%" height={36} />
      </div>
      <div className="lg-filters">
        <Skeleton width="min(520px, 80%)" height={28} />
        <Skeleton width="min(760px, 95%)" height={28} />
      </div>
      <div className="chart lg-hist">
        <Skeleton width={220} height={14} />
        <Skeleton variant="chart" height={230} />
      </div>
      <div className="panel lg-results">
        <TableSkeleton rows={10} cols={5} />
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
