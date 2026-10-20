'use client'

/**
 * useInView: true once the element is on screen (IntersectionObserver). Motion hooks
 * (count-up, chart draw-in, 3D scene start) wait for it so off-screen work never runs.
 *
 *   const [ref, inView] = useInView<HTMLDivElement>()            // once (default)
 *   const [ref, visible] = useInView<HTMLElement>({ once: false }) // tracks enter/leave
 */
import { type RefObject, useEffect, useRef, useState } from 'react'

export interface InViewOptions {
  /** Stop observing after the first time it is visible (default true). */
  once?: boolean
  rootMargin?: string
  threshold?: number
}

export function useInView<T extends Element>({ once = true, rootMargin = '0px 0px -10% 0px', threshold = 0.01 }: InViewOptions = {}): [
  RefObject<T | null>,
  boolean,
] {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        if (visible) {
          setInView(true)
          if (once) io.disconnect()
        } else if (!once) setInView(false)
      },
      { rootMargin, threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once, rootMargin, threshold])

  return [ref, inView]
}

/** prefers-reduced-motion: reduce (client only; false on the server). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * May this page animate? No when the OS asks for reduced motion or the motion switch
 * `:root[data-motion="off"]` is set (DESIGN.md §7b: ?motion=off, headless screenshots).
 */
export function motionAllowed(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.motion !== 'off' && !prefersReducedMotion()
}
