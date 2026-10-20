'use client'

/** The sidebar brand: /about (the mockups' index.html), keeping env / from / to like the nav links. */
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { buildHref, keepOf } from '@/lib/params'

export function BrandLink({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  const keep = keepOf(useSearchParams())
  return (
    <Link className={className} href={buildHref('/about', keep)} title={title} prefetch={false}>
      {children}
    </Link>
  )
}
