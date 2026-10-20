'use client'

/**
 * Follows the bucket links of the charts inside it (TimeBars / TimeLine `bucketHrefs` → `.c-hit[data-href]`):
 * a click on a hover column opens that bucket (e.g. Log of that minute) through the router.
 *
 *   <BucketLinks className="panel ov-charts"><ChartFrame …><TimeLine bucketHrefs={hrefs} … /></ChartFrame></BucketLinks>
 */
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

export function BucketLinks({ className, children }: { className?: string; children: ReactNode }) {
  const router = useRouter()
  return (
    <div
      className={className}
      onClick={(e) => {
        const href = (e.target as Element).closest('.c-hit')?.getAttribute('data-href')
        if (!href) return
        if (e.metaKey || e.ctrlKey || e.shiftKey) window.open(href, '_blank')
        else router.push(href)
      }}
    >
      {children}
    </div>
  )
}
