'use client'

import { useEffect, useState } from 'react'

/** A list page's result line after a form sent the user back: `?ok=<text>`, shown once (dropped from the URL). */
export function useFlash(): [string | null, (text: string | null) => void] {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    const url = new URL(window.location.href)
    const ok = url.searchParams.get('ok')
    if (!ok) return
    setText(ok)
    url.searchParams.delete('ok')
    window.history.replaceState(null, '', `${url.pathname}${url.search}`)
  }, [])
  return [text, setText]
}

/** Where a form goes after saving: the list, with its result line. */
export const backTo = (list: string, text: string): string => `${list}?ok=${encodeURIComponent(text)}`
