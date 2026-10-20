/**
 * What a span carried in and out, shaped for the trace Network view (DevTools-like, components/network):
 * which spans are rows and their type, name, method, status and sizes (GET /api/traces/:id alone, `io` lengths),
 * the span detail of GET /api/traces/:id/spans/:spanId read from either answer shape (summary as `span`, or flat),
 * body helpers (kind, JSON, form fields, masked values), the table's footer totals and Copy as cURL. Pure, server
 * and client.
 *
 *   const rows = netRowsOf(wf.spans)                       // every span with I/O, waterfall order
 *   const detail = normalizeSpanDetail(res.data, row.span)  // SpanDetail | null
 *   const curl = curlOf(detail.http)                        // { text, redacted, partial, files }
 */
import { REDACTED } from './sql/full-query'
import { sqlHead } from './sql/format'
import { dialectOf } from './sql/scan'
import type { DbParam, IoBody, KvPair, SpanDetail, SpanHttpIo, SpanMessageIo, SpanRow, SqlDialect } from './types'

export { REDACTED }

export type IoType = 'http-in' | 'http-out' | 'db' | 'redis' | 'queue'
export const IO_TYPES: readonly IoType[] = ['http-in', 'http-out', 'db', 'redis', 'queue']
/** Type column (DevTools calls an outgoing call `fetch`). */
export const IO_TYPE_LABEL: Record<IoType, string> = { 'http-in': 'http-in', 'http-out': 'fetch', db: 'db', redis: 'redis', queue: 'queue' }
/** Filter chips. */
export const IO_FILTER_LABEL: Record<IoType, string> = { 'http-in': 'Request เข้า', 'http-out': 'เรียกออก', db: 'Database', redis: 'Redis', queue: 'Queue' }

const attr = (s: Pick<SpanRow, 'attributes'>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = s.attributes?.[k]
    if (v) return v
  }
  return ''
}

export const dbSystemOf = (s: SpanRow): string => s.db?.system || attr(s, 'db.system.name', 'db.system')
const isRedis = (system: string) => /^(redis|ioredis|valkey|keydb)$/i.test(system)

/** Network row type of a span, null when it carried no I/O (handlers, internal steps). */
export function ioTypeOf(s: SpanRow): IoType | null {
  const sys = dbSystemOf(s)
  if (s.kind === 'PRODUCER' || s.kind === 'CONSUMER' || attr(s, 'messaging.system', 'messaging.destination.name')) return 'queue'
  if (sys) return isRedis(sys) ? 'redis' : 'db'
  const method = s.http?.method || attr(s, 'http.request.method', 'http.method')
  if (method || (s.io && (s.io.reqBytes || s.io.resBytes || s.io.reqHeaders || s.io.resHeaders || s.io.hasQuery))) {
    if (s.kind === 'SERVER') return 'http-in'
    if (s.kind === 'CLIENT' || attr(s, 'url.full', 'http.url')) return 'http-out'
  }
  return null
}

/** `sheets.googleapis.com` of `sheets.googleapis.com:443`. */
const hostOf = (peer: string) => peer.replace(/:(443|80)$/, '')

function pathOfUrl(url: string): string {
  const m = /^[a-z][\w+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)
  return m ? m[1] || '/' : url.split('?')[0]
}

/** What a waterfall row gives the Network view (WfSpan satisfies it). */
export interface NetInput {
  span: SpanRow
  /** ms from the trace start. */
  start: number
  isError: boolean
  /** Position in the waterfall (call order) and tree depth. */
  n: number
  depth: number
}

export interface NetRow<T extends NetInput = NetInput> {
  id: string
  type: IoType
  /** Path, statement head, command or queue (column ชื่อ / Name). */
  name: string
  /** Second line: host, route template, db system · peer, queue system · operation. */
  sub: string
  /** Full text for the title tooltip. */
  title: string
  /** HTTP method, SQL operation, Redis command, publish / process. */
  method: string
  /** HTTP status; 0 for DB, Redis and queue rows (statusText says OK / ERROR). */
  status: number
  statusText: string
  failed: boolean
  /** Bytes of the request / response body, message payload; null = not recorded. */
  reqBytes: number | null
  resBytes: number | null
  /** Bind values of a DB row. */
  params: number
  durationMs: number
  start: number
  input: T
}

function methodOf(type: IoType, s: SpanRow): string {
  if (type === 'http-in' || type === 'http-out') return s.http?.method || attr(s, 'http.request.method', 'http.method')
  if (type === 'queue') {
    const op = attr(s, 'messaging.operation.type', 'messaging.operation.name', 'messaging.operation')
    return op || (s.kind === 'PRODUCER' ? 'publish' : s.kind === 'CONSUMER' ? 'process' : '')
  }
  const statement = s.db?.statement || attr(s, 'db.query.text', 'db.statement')
  const first = /^\s*([A-Za-z]+)/.exec(statement)?.[1] ?? ''
  if (type === 'redis') return (first || s.name.split(' ')[0]).toUpperCase()
  return (attr(s, 'db.operation.name', 'db.operation') || first).toUpperCase()
}

/** One Network row per span with I/O, in waterfall order. */
export function netRowsOf<T extends NetInput>(list: readonly T[]): Array<NetRow<T>> {
  const out: Array<NetRow<T>> = []
  for (const input of list) {
    const s = input.span
    const type = ioTypeOf(s)
    if (!type) continue
    // io is all zeros for a span recorded before capture (or with nothing to capture): sizes unknown, not 0 B
    const io = s.io && (s.io.reqHeaders || s.io.resHeaders || s.io.reqBytes || s.io.resBytes || s.io.hasQuery || s.io.params || s.io.msgBytes) ? s.io : null
    const status = type === 'http-in' || type === 'http-out' ? s.http?.status || Number(attr(s, 'http.response.status_code', 'http.status_code')) || 0 : 0
    const failed = input.isError || s.statusCode === 'ERROR' || status >= 500
    let name = s.name
    let sub = ''
    let title = s.name
    if (type === 'http-in' || type === 'http-out') {
      const url = attr(s, 'url.full', 'http.url')
      name = s.http?.path || attr(s, 'url.path') || (url ? pathOfUrl(url) : '') || s.http?.route || s.name
      title = url || name
      if (type === 'http-out') sub = hostOf(s.peer || attr(s, 'server.address'))
      else sub = s.http?.route && s.http.route !== name ? s.http.route : ''
    } else if (type === 'db' || type === 'redis') {
      const statement = s.db?.statement || attr(s, 'db.query.text', 'db.statement')
      name = statement ? sqlHead(statement, 90) : s.name
      title = statement || s.name
      sub = [dbSystemOf(s), s.peer ? hostOf(s.peer) : ''].filter(Boolean).join(' · ')
    } else {
      const system = attr(s, 'messaging.system', 'event.module')
      const job = attr(s, 'job.id')
      const attempt = attr(s, 'job.attempt')
      const max = attr(s, 'job.max_attempts')
      sub = [system, job ? `#${job}` : '', attempt ? `attempt ${attempt}${max ? `/${max}` : ''}` : ''].filter(Boolean).join(' · ')
    }
    const http = type === 'http-in' || type === 'http-out'
    out.push({
      id: s.spanId,
      type,
      name,
      sub,
      title,
      method: methodOf(type, s),
      status,
      statusText: status ? String(status) : s.statusCode === 'ERROR' ? 'ERROR' : 'OK',
      failed,
      reqBytes: io ? (http ? io.reqBytes : type === 'queue' ? io.msgBytes : null) : null,
      resBytes: io && http ? io.resBytes : null,
      params: s.io?.params ?? 0,
      durationMs: s.durationMs,
      start: input.start,
      input,
    })
  }
  return out
}

/** `0 B`, `512 B`, `1.2 KB`, `64 KB`, `3.4 MB` (1,024-based, like DevTools); `–` for null. */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${units[u]}`
}

/** UTF-8 bytes of a string (what the cap counts). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

// ---------- masked values ----------

export const countRedacted = (text: string): number => (text ? text.split(REDACTED).length - 1 : 0)

/** `a [REDACTED] b` → [{ text: 'a ' }, { text: '[REDACTED]', masked: true }, { text: ' b' }]. */
export function splitMasked(text: string): Array<{ text: string; masked?: boolean }> {
  if (!text.includes(REDACTED)) return [{ text }]
  const out: Array<{ text: string; masked?: boolean }> = []
  text.split(REDACTED).forEach((part, i) => {
    if (i) out.push({ text: REDACTED, masked: true })
    if (part) out.push({ text: part })
  })
  return out
}

// ---------- bodies ----------

type Loose = Record<string, unknown>
const obj = (v: unknown): Loose | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : 0)

export type BodyKind = 'json' | 'form' | 'multipart' | 'text' | 'binary' | 'empty'

export function bodyKind(b: IoBody | null | undefined): BodyKind {
  if (!b || (!b.text && !b.size)) return 'empty'
  if (!b.text) return 'binary'
  const ct = b.contentType.toLowerCase()
  if (ct.includes('multipart/')) return 'multipart'
  if (ct.includes('x-www-form-urlencoded')) return 'form'
  if (ct.includes('json') || /^\s*[[{]/.test(b.text)) return parseJson(b.text).ok ? 'json' : ct.includes('json') ? 'json' : 'text'
  return 'text'
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

/** A JSON number kept as its source text (a 64-bit id beyond 2^53, `1.10`, `1e400`): JsonTree draws `raw`. */
export class RawNumber {
  constructor(readonly raw: string) {}
}

/** JSON.parse with source-text access (Chrome 114+, Safari 18.4+, Firefox 135+); older browsers parse plainly. */
type SourceReviver = (key: string, value: unknown, context?: { source?: string }) => unknown

/**
 * JSON for the tree: like parseJson, but a number whose value would not print back as written stays its source text
 * (RawNumber), so the Preview never shows 9007199254740992 for the id 9007199254740993. Key order and repeated keys
 * still follow JavaScript objects (as DevTools' Preview); the Response tab shows the text itself.
 */
export function parseJsonExact(text: string): { ok: true; value: unknown } | { ok: false } {
  const reviver: SourceReviver = (_k, v, ctx) => (typeof v === 'number' && ctx?.source !== undefined && ctx.source !== String(v) ? new RawNumber(ctx.source) : v)
  try {
    return { ok: true, value: JSON.parse(text, reviver as (k: string, v: unknown) => unknown) }
  } catch {
    return { ok: false }
  }
}

const JSON_WS = new Set([' ', '\n', '\r', '\t'])
const JSON_STOP = new Set([' ', '\n', '\r', '\t', '"', '{', '}', '[', ']', ',', ':'])

/**
 * JSON re-indented with 2 spaces without parsing it: strings, numbers and literals are copied byte for byte (a
 * 64-bit id, `1.10`), keys keep their order and repeats, and a body cut at the cap re-indents up to where it stops.
 * Text that does not start with `{` or `[` comes back as it is.
 */
export function prettyText(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text
  let out = ''
  let depth = 0
  const nl = () => `\n${'  '.repeat(depth)}`
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (JSON_WS.has(c)) i++
    else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      let j = i + 1
      while (j < text.length && JSON_WS.has(text[j])) j++
      if (text[j] === close) {
        out += c + close
        i = j + 1
      } else {
        depth++
        out += c + nl()
        i++
      }
    } else if (c === '}' || c === ']') {
      depth = Math.max(0, depth - 1)
      out += nl() + c
      i++
    } else if (c === ',') {
      out += `,${nl()}`
      i++
    } else if (c === ':') {
      out += ': '
      i++
    } else {
      // a number, true / false / null (or anything else) up to the next structural character, as written
      let j = i + 1
      while (j < text.length && !JSON_STOP.has(text[j])) j++
      out += text.slice(i, j)
      i = j
    }
  }
  return out
}

/** Fields of a form-urlencoded body or a query string, in order (`a=1&b=x` → [['a','1'], ['b','x']]). */
export function formPairs(text: string): KvPair[] {
  const out: KvPair[] = []
  for (const part of text.replace(/^\?/, '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return s
      }
    }
    out.push(i === -1 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))])
  }
  return out
}

/** content-type of a body: its own, else the header of that side. */
export function contentTypeOf(body: IoBody | null | undefined, headers: readonly KvPair[]): string {
  return body?.contentType || headerOf(headers, 'content-type')
}

export function headerOf(headers: readonly KvPair[], name: string): string {
  const n = name.toLowerCase()
  return headers.find(([k]) => k.toLowerCase() === n)?.[1] ?? ''
}

/** The SDK's summary of a multipart body: `{ fields: { name: value | value[] }, files: [{ name, filename, type, size }] }`
 *  (older seeds: `fields: [name]`, values unknown → ''). null when the text is not such a summary. */
export interface MultipartSummary {
  fields: KvPair[]
  files: Array<{ name: string; filename: string; type: string; size: number }>
}

export function multipartOf(text: string): MultipartSummary | null {
  const j = parseJson(text)
  const o = j.ok ? obj(j.value) : null
  if (!o || !('fields' in o || 'files' in o)) return null
  const fields: KvPair[] = []
  if (Array.isArray(o.fields)) for (const n of o.fields) fields.push([str(n), ''])
  else for (const [k, v] of Object.entries(obj(o.fields) ?? {})) for (const x of Array.isArray(v) ? v : [v]) fields.push([k, str(x)])
  const files = (Array.isArray(o.files) ? o.files : [])
    .map((f) => obj(f))
    .filter((f): f is Loose => !!f)
    .map((f) => ({ name: str(f.name), filename: str(f.filename), type: str(f.type), size: num(f.size) }))
  return { fields, files }
}

// ---------- GET /api/traces/:id/spans/:spanId ----------

/** Header / query pairs from [[k, v]], {k: v | v[]} or their JSON text. */
export function toPairs(v: unknown): KvPair[] {
  if (typeof v === 'string') {
    if (!v.trim()) return []
    try {
      return toPairs(JSON.parse(v))
    } catch {
      return formPairs(v)
    }
  }
  if (Array.isArray(v)) {
    return v
      .map((p): KvPair | null => (Array.isArray(p) ? [str(p[0]), str(p[1])] : obj(p) ? [str(obj(p)!.key ?? obj(p)!.name), str(obj(p)!.value)] : null))
      .filter((p): p is KvPair => !!p && p[0] !== '')
  }
  const o = obj(v)
  if (!o) return []
  const out: KvPair[] = []
  for (const [k, val] of Object.entries(o)) {
    if (Array.isArray(val)) for (const x of val) out.push([k, str(x)])
    else out.push([k, str(val)])
  }
  return out
}

function toBody(v: unknown, contentType = ''): IoBody | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v ? { text: v, size: utf8Bytes(v), truncated: false, contentType } : null
  const o = obj(v)
  if (!o) return null
  const text = str(o.text)
  const size = num(o.size) || (text ? utf8Bytes(text) : 0)
  if (!text && !size) return null
  return { text, size, truncated: o.truncated === true || o.truncated === 1 || o.truncated === '1', contentType: str(o.contentType) || contentType }
}

function toParams(v: unknown): DbParam[] {
  const list = typeof v === 'string' ? (() => {
    try {
      return JSON.parse(v) as unknown
    } catch {
      return []
    }
  })() : v
  if (!Array.isArray(list)) return []
  return list
    .map((p, i): DbParam | null => {
      const o = obj(p)
      if (!o) return { key: String(i + 1), type: p === null ? 'null' : typeof p, value: p === null ? '' : str(p) }
      const out: DbParam = { key: str(o.key) || String(i + 1), type: str(o.type) || 'string', value: o.value === null ? '' : str(o.value) }
      if (str(o.column)) out.column = str(o.column)
      if (o.truncated === true) out.truncated = true
      if (o.masked === 'unresolved') out.masked = 'unresolved'
      return out
    })
    .filter((p): p is DbParam => !!p)
}

function toHttp(o: Loose | null, s: SpanRow): SpanHttpIo | null {
  if (!o) return null
  const rich = 'url' in o || 'requestHeaders' in o || 'query' in o || 'requestBody' in o || 'responseBody' in o
  if (!rich) return null
  const requestHeaders = toPairs(o.requestHeaders)
  const responseHeaders = toPairs(o.responseHeaders)
  const url = str(o.url) || attr(s, 'url.full', 'http.url')
  const q = toPairs(o.query)
  return {
    method: str(o.method) || s.http?.method || '',
    url,
    route: str(o.route) || s.http?.route || '',
    status: num(o.status) || s.http?.status || 0,
    remoteAddress: str(o.remoteAddress),
    userAgent: str(o.userAgent) || headerOf(requestHeaders, 'user-agent') || attr(s, 'user_agent.original'),
    query: q.length ? q : url.includes('?') ? formPairs(url.slice(url.indexOf('?') + 1).split('#')[0]) : [],
    requestHeaders,
    responseHeaders,
    requestBody: toBody(o.requestBody, headerOf(requestHeaders, 'content-type')),
    responseBody: toBody(o.responseBody, headerOf(responseHeaders, 'content-type')),
  }
}

function toMessage(o: Loose | null): SpanMessageIo | null {
  if (!o) return null
  const headers = toPairs(o.headers)
  return {
    system: str(o.system),
    destination: str(o.destination),
    operation: str(o.operation),
    id: str(o.id),
    headers,
    body: toBody(o.body, headerOf(headers, 'content-type')),
  }
}

/**
 * The span detail from the engine's answer: `{ span, http, db, message, timing }`, or the summary fields flat
 * with the rich `http` / `db` in place of the summary ones. `fallback` (the span from the trace) fills what the
 * answer leaves out. null when the answer is not a span.
 */
export function normalizeSpanDetail(raw: unknown, fallback?: SpanRow | null): SpanDetail | null {
  const r = obj(raw)
  if (!r) return null
  const nested = obj(r.span)
  const summary = nested ?? r
  if (!summary.spanId && !fallback) return null
  const base = { ...(fallback ?? {}), ...(summary as Partial<SpanRow>) } as SpanRow
  const richHttp = obj(r.http)
  const richDb = obj(r.db)
  const shortHttp = richHttp ? { method: str(richHttp.method), route: str(richHttp.route), status: num(richHttp.status), path: str(richHttp.path) || pathOfUrl(str(richHttp.url)) } : null
  const shortDb = richDb ? { system: str(richDb.system), statement: str(richDb.statement) } : null
  // a flat answer puts the rich http / db where the summary has its short forms: rebuild those
  const span: SpanRow = {
    ...base,
    attributes: obj(base.attributes) ? (base.attributes as Record<string, string>) : (fallback?.attributes ?? {}),
    events: Array.isArray(base.events) ? base.events : (fallback?.events ?? []),
    http: nested ? (base.http ?? shortHttp) : (fallback?.http ?? shortHttp),
    db: nested ? (base.db ?? shortDb) : (fallback?.db ?? shortDb),
  }
  const http = toHttp(richHttp, span)
  let db: SpanDetail['db'] = null
  if (richDb || span.db) {
    const system = str(richDb?.system) || span.db?.system || dbSystemOf(span)
    const d = str(richDb?.dialect) as SqlDialect
    db = {
      system,
      name: str(richDb?.name) || attr(span, 'db.namespace', 'db.name'),
      operation: str(richDb?.operation) || attr(span, 'db.operation.name', 'db.operation'),
      table: str(richDb?.table) || attr(span, 'db.collection.name', 'db.sql.table'),
      statement: str(richDb?.statement) || span.db?.statement || attr(span, 'db.query.text', 'db.statement'),
      dialect: ['oracle', 'postgres', 'mysql', 'mssql', 'sqlite', 'other'].includes(d) ? d : dialectOf(system),
      params: toParams(richDb?.params),
    }
  }
  const t = obj(r.timing)
  return {
    span,
    http,
    db,
    message: toMessage(obj(r.message)),
    timing: {
      start: str(t?.start) || span.startTime,
      durationMs: num(t?.durationMs) || span.durationMs,
      offsetMs: num(t?.offsetMs),
    },
  }
}

/** The detail holds something the SDK captured (headers, query, a body, bind values, a message); false for a span
 *  recorded before capture was on, whose detail has only the summary. */
export function hasCapture(d: SpanDetail): boolean {
  const h = d.http
  const m = d.message
  return !!(h && (h.requestHeaders.length || h.responseHeaders.length || h.query.length || h.requestBody || h.responseBody)) || !!d.db?.params.length || !!(m && (m.headers.length || m.body))
}

/**
 * What the trace itself says about a span (no headers, bodies or binds): the panel shows it while the detail
 * loads, and when the engine has no I/O stored for the span. `offsetMs` = start − trace start.
 */
export function detailFromSpan(span: SpanRow, offsetMs: number): SpanDetail {
  const type = ioTypeOf(span)
  const http = type === 'http-in' || type === 'http-out'
  const scheme = attr(span, 'url.scheme') || 'http'
  const host = type === 'http-in' ? attr(span, 'server.address') || span.host || 'localhost' : span.peer.replace(/:\d+$/, '')
  const port = attr(span, 'server.port')
  const path = span.http?.path || attr(span, 'url.path')
  const url = attr(span, 'url.full', 'http.url') || (path ? `${scheme}://${host}${port ? `:${port}` : ''}${path}` : '')
  const statement = span.db?.statement || attr(span, 'db.query.text', 'db.statement')
  const system = dbSystemOf(span)
  return {
    span,
    http: http
      ? {
          method: span.http?.method || attr(span, 'http.request.method', 'http.method'),
          url,
          route: span.http?.route || '',
          status: span.http?.status || Number(attr(span, 'http.response.status_code')) || 0,
          remoteAddress: type === 'http-out' ? span.peer : attr(span, 'client.address', 'network.peer.address'),
          userAgent: attr(span, 'user_agent.original'),
          query: url.includes('?') ? formPairs(url.slice(url.indexOf('?') + 1).split('#')[0]) : [],
          requestHeaders: [],
          responseHeaders: [],
          requestBody: null,
          responseBody: null,
        }
      : null,
    db: system || statement ? { system, name: attr(span, 'db.namespace', 'db.name'), statement, dialect: dialectOf(system), params: [] } : null,
    message:
      type === 'queue'
        ? {
            system: attr(span, 'messaging.system', 'event.module'),
            destination: attr(span, 'messaging.destination.name', 'job.queue'),
            operation: attr(span, 'messaging.operation.type', 'messaging.operation') || (span.kind === 'PRODUCER' ? 'publish' : 'process'),
            headers: [],
            body: null,
          }
        : null,
    timing: { start: span.startTime, durationMs: span.durationMs, offsetMs },
  }
}

// ---------- Copy as cURL ----------

/**
 * Headers curl sets itself, that would break a replay, or that would put the replay into this trace (W3C trace
 * context: with `traceparent` the replay's spans become another child of the original caller span).
 */
const CURL_SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'traceparent', 'tracestate', 'baggage'])
/** curl reads [ ] { } in a URL as a glob (`ids[]=`, `filter[status]=`, a masked `token=[REDACTED]`): `bad range in URL`. */
const URL_GLOB = /[[\]{}]/
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export interface CurlCommand {
  text: string
  /** `[REDACTED]` values in the command: replace them before running it. */
  redacted: number
  /** What the stored request lacks: truncated (first 64 KB of the body), multipart (the uploaded files), binary (the body). */
  partial: Array<'truncated' | 'multipart' | 'binary'>
  /** Local files the command reads (`-F 'file=@q3.png'`, `--data-binary '@request-body.png'`): put them next to it. */
  files: string[]
}

/** File name of a body that was not stored, by its content-type (`request-body.png`, `request-body.bin`). */
function bodyFileName(contentType: string): string {
  const sub = contentType.split(';')[0].trim().toLowerCase().split('/')[1] ?? ''
  const ext: Record<string, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', pdf: 'pdf', zip: 'zip', csv: 'csv', xml: 'xml', html: 'html', plain: 'txt', 'x-www-form-urlencoded': 'txt', 'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' }
  return `request-body.${ext[sub] ?? (/json$/.test(sub) ? 'json' : 'bin')}`
}

/** The local file of an uploaded one: its base name, and the `@q3.png` / `@"a;b.png"` of -F (quotes around ; , "). */
function formFile(name: string): { base: string; arg: string } {
  const base = name.split(/[\\/]/).pop() || 'file'
  return { base, arg: /[;,"\\]/.test(base) ? `@"${base.replace(/["\\]/g, '\\$&')}"` : `@${base}` }
}

/**
 * The request of an HTTP span as a curl command (DevTools "Copy as cURL" layout): `--globoff` when the URL has
 * [ ] { }, HEAD as `-I`, a multipart body as `--form-string` per stored field and `-F name=@<filename>` per file
 * (curl writes its own boundary, so the stored content-type is left out), a body that was not stored as
 * `--data-binary @request-body.<ext>`. Masked values stay `[REDACTED]`.
 */
export function curlOf(http: SpanHttpIo): CurlCommand {
  const url = http.url || '/'
  const method = (http.method || 'GET').toUpperCase()
  const body = http.requestBody
  const kind = bodyKind(body)
  const partial: CurlCommand['partial'] = []
  const files: string[] = []
  const sendText = !!body && (kind === 'json' || kind === 'form' || kind === 'text')
  const form = body && kind === 'multipart' ? multipartOf(body.text) : null
  if (body && kind === 'multipart') partial.push('multipart')
  if (body && kind === 'binary') partial.push('binary')
  if ((sendText || form) && body?.truncated) partial.push('truncated')
  const hasBody = sendText || !!(form && (form.fields.length || form.files.length)) || kind === 'binary'
  const lines = [`curl ${URL_GLOB.test(url) ? '--globoff ' : ''}${shq(url)}`]
  // curl sends GET, or POST with a body, by itself; -X HEAD would wait for a body that never comes
  if (method === 'HEAD') lines.push('-I')
  else if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) lines.push(`-X ${method}`)
  let compressed = false
  for (const [k, v] of http.requestHeaders) {
    const name = k.toLowerCase()
    if (name.startsWith(':') || CURL_SKIP.has(name)) continue
    // the stored body is the decoded text: sent with content-encoding: gzip the server could not read it
    if (name === 'content-encoding' && (sendText || kind === 'multipart')) continue
    // -F writes its own multipart content-type with a new boundary; the old one would not match the body
    if (name === 'content-type' && kind === 'multipart') continue
    if (name === 'accept-encoding') compressed = true
    lines.push(`-H ${shq(`${k}: ${v}`)}`)
  }
  if (sendText) lines.push(`--data-raw ${shq(body!.text)}`)
  else if (form) {
    // --form-string: a value starting with @ or < (or holding ;type=) is sent as text, not read as a file
    for (const [k, v] of form.fields) lines.push(`--form-string ${shq(`${k}=${v}`)}`)
    for (const f of form.files) {
      const file = formFile(f.filename || f.name)
      files.push(file.base)
      lines.push(`-F ${shq(`${f.name}=${file.arg}${f.type ? `;type=${f.type}` : ''}`)}`)
    }
  } else if (kind === 'binary') {
    const file = bodyFileName(body!.contentType)
    files.push(file)
    lines.push(`--data-binary ${shq(`@${file}`)}`)
  }
  if (compressed) lines.push('--compressed')
  const text = lines.join(' \\\n  ')
  return { text, redacted: countRedacted(text), partial, files }
}

// ---------- footer totals ----------

export interface IoTotals {
  /** Request / response body bytes of the HTTP rows, message payload bytes of the queue rows; null = none known. */
  request: number | null
  response: number | null
  message: number | null
  http: boolean
  queue: boolean
}

/**
 * Footer totals of the Network table, each exchange counted once: an incoming request whose caller (an outgoing
 * call with sizes) is in the rows is that call seen from the other side, a consumed message whose producer is in
 * the rows is that publish, and the attempts of one job / message carry the same payload. Unknown sizes stay null.
 */
export function ioTotals(rows: readonly NetRow[]): IoTotals {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const seen = new Set<string>()
  const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b)
  const t: IoTotals = { request: null, response: null, message: null, http: false, queue: false }
  for (const r of rows) {
    const s = r.input.span
    const parent = byId.get(s.parentSpanId)
    if (r.type === 'http-in' || r.type === 'http-out') {
      t.http = true
      if (r.type === 'http-in' && parent?.type === 'http-out' && (parent.reqBytes !== null || parent.resBytes !== null)) continue
      t.request = add(t.request, r.reqBytes)
      t.response = add(t.response, r.resBytes)
    } else if (r.type === 'queue') {
      t.queue = true
      if (s.kind === 'CONSUMER' && parent?.type === 'queue' && parent.input.span.kind === 'PRODUCER') continue
      const a = s.attributes ?? {}
      const key = a['messaging.message.id'] || (a['job.id'] ? `${a['job.queue'] || a['messaging.destination.name'] || ''}#${a['job.id']}` : '')
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      t.message = add(t.message, r.reqBytes)
    }
  }
  return t
}
