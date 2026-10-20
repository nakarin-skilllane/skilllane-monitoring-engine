import type { Metadata } from 'next'
import { Suspense } from 'react'
import { NotFoundPageBody, NotFoundPageFallback } from '@/components/NotFoundLinks'

/** Unknown URL (404): h1 "ไม่พบหน้านี้" and links back that keep env / from / to (same NotFoundState as the detail screens). */
export const metadata: Metadata = { title: 'ไม่พบหน้านี้' }

export default function NotFound() {
  return (
    <Suspense fallback={<NotFoundPageFallback />}>
      <NotFoundPageBody />
    </Suspense>
  )
}
