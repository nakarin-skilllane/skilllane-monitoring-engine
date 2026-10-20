'use client'

/**
 * Trace list clicks (port of the mockup's page script): a click anywhere on a `tr.is-clickable` row opens
 * that trace (its `a.tr-name`); links, buttons and copy keep their own action. Scatter points (`svg a` in
 * `.tr-hits`) navigate with the router instead of a full page load. Renders nothing.
 */
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export function RowNav() {
  const router = useRouter()
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const t = e.target as Element | null
      const point = t?.closest?.('.tr-hits a')
      if (point) {
        const href = point.getAttribute('href')
        if (href) {
          e.preventDefault()
          router.push(href)
        }
        return
      }
      const row = t?.closest?.('.tr-table tr.is-clickable')
      if (!row || t?.closest('a, button, input, select, summary, label')) return
      // a text selection is not a click
      if (window.getSelection()?.toString()) return
      const a = row.querySelector('a.tr-name')
      const href = a?.getAttribute('href')
      if (href) router.push(href)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [router])
  return null
}
