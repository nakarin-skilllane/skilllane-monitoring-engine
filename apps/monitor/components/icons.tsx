/**
 * Inline SVG icons from design/monitoring-ui/components.html (16 px, stroke currentColor 1.5).
 * <Icon name="search" /> renders `svg.i`; `size="sm"` (14) / `"lg"` (20); extra classes via className.
 * Reuse these paths instead of drawing new ones (DESIGN.md §5).
 */
import type { ReactNode } from 'react'

const PATHS = {
  overview: <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />,
  logs: <path d="M2.5 3.5h11M2.5 6.5h8M2.5 9.5h11M2.5 12.5h6" />,
  traces: <path d="M2 2.75h6.5v2.5H2zM4.5 6.75h8v2.5h-8zM8 10.75h6v2.5H8z" />,
  errors: (
    <>
      <path d="M8 2.2 14.3 13.3H1.7z" />
      <path d="M8 6.5v3M8 11.4v.1" />
    </>
  ),
  jobs: (
    <>
      <path d="M8 2 14 5 8 8 2 5z" />
      <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  book: (
    <>
      <path d="M3 3a1 1 0 0 1 1-1h8.5v10H4a1 1 0 0 0-1 1z" />
      <path d="M3 13a1 1 0 0 0 1 1h8.5v-2" />
    </>
  ),
  external: <path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25" />
    </>
  ),
  'search-none': (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25M5.5 5.5l3 3M8.5 5.5l-3 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  chevron: <path d="M4 6l4 4 4-4" />,
  'chevron-right': <path d="M6 4l4 4-4 4" />,
  /** The call crossed into another service (trace waterfall `.td-hop`). */
  hop: <path d="M2 8h8M7 5l3 3-3 3M13 3v10" />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" />,
  moon: <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1.25-1.25a2.65 2.65 0 0 1 3.75 3.75L10.75 8.25M9 11.5l-1.25 1.25A2.65 2.65 0 0 1 4 9l1.25-1.25" />,
  filter: <path d="M2 3.5h12L9.5 9v4l-3-1.5V9z" />,
  panel: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 5.5h12" />
    </>
  ),
  pencil: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  /** callout icons */
  'alert-octagon': (
    <>
      <path d="M5.5 1.75h5l3.75 3.75v5l-3.75 3.75h-5L1.75 10.5v-5z" />
      <path d="M8 5v3.5M8 10.9v.1" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M8 2.2 14.3 13.3H1.7z" />
      <path d="M8 6.5v3M8 11.4v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 7.25v3.5M8 5.2v.1" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.5 8.25 7.25 10l3.25-3.75" />
    </>
  ),
  /** error categories */
  'cat-bug': <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  'cat-input': <path d="M8 2v7M5 6l3 3 3-3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />,
  'cat-data': (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="1.75" />
      <path d="M3 4v8c0 .97 2.24 1.75 5 1.75s5-.78 5-1.75V4M3 8c0 .97 2.24 1.75 5 1.75S13 8.97 13 8" />
    </>
  ),
  'cat-dependency': <path d="M6.5 9.5l3-3M7 4.5l1.25-1.25a2.65 2.65 0 0 1 3.75 3.75L10.75 8.25M9 11.5l-1.25 1.25A2.65 2.65 0 0 1 4 9l1.25-1.25" />,
  'cat-config': (
    <>
      <path d="M2 4.5h6.5M11.5 4.5H14M2 11.5h2M7 11.5h7" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="5.5" cy="11.5" r="1.5" />
    </>
  ),
  /** auto refresh (same stroke style) */
  refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />,
  pause: <path d="M6 3.5v9M10 3.5v9" />,
  play: <path d="M5 3.25v9.5L12.5 8z" />,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, size, className }: { name: IconName; size?: 'sm' | 'lg'; className?: string }) {
  const cls = ['i', size ? `i--${size}` : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}

/** The product mark (sidebar + mobile top bar): ink square, two bars, amber highlight bar. */
export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 22 22" aria-hidden="true">
      <rect className="bm-bg" width="22" height="22" rx="5" />
      <rect className="bm-bar" x="5" y="5.5" width="9" height="2.2" rx="1.1" />
      <rect className="bm-hi" x="8" y="9.9" width="9" height="2.2" rx="1.1" />
      <rect className="bm-bar" x="5" y="14.3" width="6" height="2.2" rx="1.1" />
    </svg>
  )
}
