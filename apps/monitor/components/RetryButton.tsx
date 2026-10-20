'use client'

/**
 * "ลองใหม่": re-runs the page's server components (router.refresh), or `onRetry` for a block that fetched on
 * the client (a refresh never re-runs a client fetch: pass the function that fetches again).
 *
 *   <EngineErrorState error={load.error} onRetry={() => load.retry()} />
 */
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

export function RetryButton({ label = 'ลองใหม่', onRetry }: { label?: string; onRetry?: () => void | Promise<void> }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      className="btn btn--sm"
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (onRetry) await onRetry()
          else router.refresh()
        })
      }
    >
      {pending ? 'กำลังโหลด…' : label}
    </button>
  )
}
