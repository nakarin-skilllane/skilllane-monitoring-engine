import { Skeleton, TableSkeleton } from '@/components/states'
// No './screen.css' import here: a <Link> prefetch renders this loading boundary, and its CSS would be preloaded on
// every page that links here ("preloaded but not used" console warning). The page imports screen.css; a hard load
// links it in <head>, so only the short client-side skeleton runs without the screen's layout rules (as /traces does).

/** Overview while its engine calls run: the same blocks as the page (callouts + map, health table, charts, side panels). */
export default function OverviewLoading() {
  return (
    <div role="status" aria-label="กำลังโหลดภาพรวม" aria-busy="true">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={160} height={12} />
          <Skeleton width={140} height={24} />
          <Skeleton width="min(520px, 90%)" height={14} />
        </div>
      </div>
      <div className="ov-top">
        <section className="section ov-attn">
          <div className="section__head">
            <Skeleton variant="title" width={140} />
          </div>
          <div className="callouts">
            {[0, 1, 2].map((i) => (
              <div className="panel panel__body" key={i}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="90%" height={12} className="mt-2" />
              </div>
            ))}
          </div>
        </section>
        <section className="section ov-health-sec">
          <div className="section__head">
            <Skeleton variant="title" width={160} />
          </div>
          <div className="panel">
            <TableSkeleton rows={5} cols={7} />
          </div>
        </section>
        <section className="section ov-map">
          <div className="section__head">
            <Skeleton variant="title" width={120} />
          </div>
          <div className="panel ov-map__panel">
            <div className="ov-map__box">
              <Skeleton width="100%" height="var(--ov-map-h)" className="ov-map__skel" />
            </div>
          </div>
        </section>
      </div>
      <div className="grid grid--main-side ov-body">
        <div className="ov-main">
          <div className="panel panel__body">
            <Skeleton variant="chart" width="100%" />
          </div>
        </div>
        <div className="stack ov-side__stack">
          <div className="panel">
            <TableSkeleton rows={5} cols={2} />
          </div>
        </div>
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
