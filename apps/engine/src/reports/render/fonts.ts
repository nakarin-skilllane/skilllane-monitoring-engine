import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Thai + Latin subsets of IBM Plex Sans Thai (the monitor's font), regular and semibold. */
const FACES = [
  { subset: 'thai', range: 'U+02D7,U+0303,U+0331,U+0E01-0E5B,U+200C-200D,U+25CC' },
  { subset: 'latin', range: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
]
const WEIGHTS = [400, 600]

let css: string | undefined

/**
 * @font-face rules with the woff2 files inlined (≈ 90 KB), so a rendered page or file carries its
 * own font: Gotenberg's Chromium and an iframe need nothing else. Read once per process.
 */
export function fontFaceCss(): string {
  if (css !== undefined) return css
  // the package exports only its CSS: find the files next to it
  const dir = join(dirname(require.resolve('@fontsource/ibm-plex-sans-thai')), 'files')
  css = WEIGHTS.flatMap((weight) =>
    FACES.map(({ subset, range }) => {
      const data = readFileSync(join(dir, `ibm-plex-sans-thai-${subset}-${weight}-normal.woff2`)).toString('base64')
      return `@font-face{font-family:'IBM Plex Sans Thai';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range}}`
    }),
  ).join('\n')
  return css
}
