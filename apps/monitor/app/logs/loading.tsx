import { Skeleton } from '@/components/states'
// No './screen.css' import here: a <Link> prefetch renders this loading boundary, and its CSS would be preloaded on
// every page that links here ("preloaded but not used" console warning). The page imports screen.css; a hard load
// links it in <head>, so only the short client-side skeleton runs without the screen's layout rules (as /traces does).

/** /logs while its server component loads: page head, then the console (scope row, grep bar, minute strip, lines). */
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
      <div className="panel">
        <div className="panel__body">
          <Skeleton width="min(620px, 90%)" height={30} />
          <Skeleton width="100%" height={30} />
          <Skeleton variant="chart" height={40} />
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} width={`${60 + ((i * 37) % 40)}%`} height={14} />
          ))}
        </div>
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
