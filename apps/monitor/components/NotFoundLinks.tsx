'use client'

/**
 * The 404 page body (app/not-found.tsx): NotFoundState as the page's h1, with links that keep env / from / to
 * of the URL that was not found (not-found.tsx gets no searchParams).
 */
import { useSearchParams } from 'next/navigation'
import { buildHref, keepOf } from '@/lib/params'
import { NotFoundState } from './states'

const links = (keep: ReturnType<typeof keepOf>) => [
  { href: buildHref('/overview', keep), label: 'ไปที่ภาพรวม' },
  { href: buildHref('/logs', keep), label: 'ค้นใน Log' },
]

export function NotFoundPageBody() {
  return <NotFoundState heading text="ลิงก์อาจพิมพ์ผิด หรือหน้านี้ถูกย้าย · เลือกหน้าจอจากเมนูทางซ้าย หรือกลับไปที่ภาพรวม" links={links(keepOf(useSearchParams()))} />
}

/** Before search params are known (prerender): the same, without kept params. */
export function NotFoundPageFallback() {
  return <NotFoundState heading text="ลิงก์อาจพิมพ์ผิด หรือหน้านี้ถูกย้าย · เลือกหน้าจอจากเมนูทางซ้าย หรือกลับไปที่ภาพรวม" links={links({})} />
}
