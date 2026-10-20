/**
 * error_stack for reading and for Copy for AI (DESIGN.md §6b): frames with the shared absolute prefix and the
 * pnpm store path removed (no home directory leaves the page), app frames told apart from library frames
 * (node_modules, node: internals, the skilllane-monitoring SDK). Pure: server and client.
 *
 *   const s = parseStack(row.error.stack)   // { head, frames: [{ fn, async, loc, app }], libs, nodeInternal }
 *   aiStack(s)                              // ['at ImportQuestionBankHandler.saveQuestions (apps/demo-api/dist/src/…:88:7)', …]
 */

export interface StackFrame {
  /** Function (`ImportQuestionBankHandler.execute`), '' for a location-only frame. */
  fn: string
  async: boolean
  /** Location with the shared absolute prefix and the pnpm store path removed. */
  loc: string
  app: boolean
}

export interface ParsedStack {
  head: string
  frames: StackFrame[]
  /** Library packages of the non-app frames (`typeorm`, `@nestjs`), in order of appearance. */
  libs: string[]
  nodeInternal: boolean
}

const FRAME = /^at\s+(async\s+)?(?:(.+?)\s+\((.+)\)|(.+))$/

function commonDir(paths: string[]): string {
  if (paths.length < 2) return ''
  let prefix = paths[0].slice(0, paths[0].lastIndexOf('/') + 1)
  for (const p of paths.slice(1)) {
    while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1)
  }
  return prefix.length > 1 ? prefix : ''
}

/** Frames of an error_stack: app frames are the ones outside node_modules, node: and the SDK (packages/monitoring). */
export function parseStack(stack: string): ParsedStack {
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean)
  const firstFrame = lines.findIndex((l) => l.startsWith('at '))
  const head = (firstFrame < 0 ? lines : lines.slice(0, firstFrame)).join(' ')
  const raw = firstFrame < 0 ? [] : lines.slice(firstFrame).filter((l) => l.startsWith('at '))
  const parsed = raw.map((l) => {
    const m = FRAME.exec(l)
    return { async: !!m?.[1], fn: m?.[2] ?? '', loc: m?.[3] ?? m?.[4] ?? l.slice(3) }
  })
  const abs = parsed.map((f) => f.loc).filter((l) => l.startsWith('/'))
  const prefix = commonDir(abs)
  const libs: string[] = []
  let nodeInternal = false
  const frames = parsed.map((f) => {
    let loc = prefix && f.loc.startsWith(prefix) ? f.loc.slice(prefix.length) : f.loc
    // A lone absolute path (no shared prefix): keep it from the first project-looking folder (no home directory).
    if (loc.startsWith('/')) loc = loc.replace(/^.*?\/((?:apps|packages|src|dist|lib|node_modules)\/)/, '$1')
    loc = loc.replace(/(^|\/)node_modules\/\.pnpm\/[^/]+\/node_modules\//, '$1node_modules/')
    const isNode = loc.startsWith('node:')
    const sdk = /(^|\/)packages\/monitoring\//.test(loc)
    const lib = loc.includes('node_modules/') || isNode || sdk
    if (isNode) nodeInternal = true
    else if (sdk) {
      if (!libs.includes('skilllane-monitoring')) libs.push('skilllane-monitoring')
    } else if (lib) {
      const rest = loc.slice(loc.lastIndexOf('node_modules/') + 'node_modules/'.length)
      const pkg = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0]
      const scope = pkg.split('/')[0]
      if (scope && !libs.includes(scope)) libs.push(scope)
    }
    return { fn: f.fn, async: f.async, loc, app: !lib }
  })
  return { head, frames, libs, nodeInternal }
}

/** `    at async Fn (loc)` as in the stack. */
export function frameText(f: StackFrame): string {
  return `    at ${f.async ? 'async ' : ''}${f.fn ? `${f.fn} (${f.loc})` : f.loc}`
}

/** At most `max` frames for Copy for AI, app frames first, without `async`: `at Fn (loc)`. */
export function aiStack(s: ParsedStack | string, max = 3): string[] {
  const p = typeof s === 'string' ? parseStack(s) : s
  return [...p.frames.filter((f) => f.app), ...p.frames.filter((f) => !f.app)].slice(0, max).map((f) => (f.fn ? `at ${f.fn} (${f.loc})` : `at ${f.loc}`))
}

/** Line number of the first app frame (`…handler.ts:88:7` → 88). */
export function firstAppLine(s: ParsedStack): number | null {
  const f = s.frames.find((x) => x.app)
  const m = f ? /:(\d+):\d+$/.exec(f.loc) : null
  return m ? Number(m[1]) : null
}
