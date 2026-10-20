import { KpiSkeleton, Skeleton, TableSkeleton } from '@/components/states'
// No './screen.css' import here: a <Link> prefetch renders this loading boundary, and its CSS would be preloaded on
// every page that links here ("preloaded but not used" console warning). The page imports screen.css; a hard load
// links it in <head>, so only the short client-side skeleton runs without the screen's layout rules (as /traces does).

/** /jobs while the engine answers: page head, the five KPIs, the queue table and the dependency table. */
export default function JobsLoading() {
  return (
    <div className="ui-page-skel" role="status" aria-label="กำลังโหลด">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={160} height={12} />
          <Skeleton width={180} height={24} />
          <Skeleton width="min(620px, 90%)" height={14} />
        </div>
      </div>
      <div className="jb-kpis">
        <KpiSkeleton count={5} />
      </div>
      <section className="section">
        <div className="section__head">
          <Skeleton width={200} height={18} />
        </div>
        <div className="panel">
          <TableSkeleton rows={8} cols={8} />
        </div>
      </section>
      <section className="section">
        <div className="section__head">
          <Skeleton width={240} height={18} />
        </div>
        <div className="panel">
          <TableSkeleton rows={4} cols={5} />
        </div>
      </section>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
