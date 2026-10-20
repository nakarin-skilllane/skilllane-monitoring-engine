/**
 * One span with everything it captured (GET /api/traces/:traceId/spans/:spanId,
 * SPEC.md section 8): the monitor's Network panel (Headers, Payload, Preview,
 * Response, Query, Message, Timing). The values were masked by the SDK.
 */
import type { DbParam } from '../ingest/span-io'
import { type SpanDb, type SpanIoDb, type SpanRow, SPAN_IO_SELECT, SPAN_SELECT, toSpanRow } from './rows'
import { micros, num } from './sql'

export const SPAN_DETAIL_SELECT = `${SPAN_SELECT}, ${SPAN_IO_SELECT},
  url_query, req_headers, res_headers, req_body, res_body, req_body_size, res_body_size,
  req_body_truncated, res_body_truncated, db_params, db_statement_full,
  msg_body, msg_headers, msg_body_size, msg_body_truncated`

export interface SpanDetailDb extends SpanDb, SpanIoDb {
  url_query: string
  req_headers: string
  res_headers: string
  req_body: string
  res_body: string
  req_body_size: number
  res_body_size: number
  req_body_truncated: number
  res_body_truncated: number
  db_params: string
  db_statement_full: string
  msg_body: string
  msg_headers: string
  msg_body_size: number
  msg_body_truncated: number
}

/** Header / query pairs in the order sent; a repeated header (set-cookie) gives one pair per value. */
export type Pairs = Array<[string, string]>

export interface Body {
  /** Masked text: JSON compact, text as text, a multipart summary as JSON; '' for binary or none. */
  text: string
  /** Original size in bytes. */
  size: number
  /** The SDK kept only the first LOG_BODY_MAX_BYTES. */
  truncated: boolean
  /** content-type of its headers; '' when unknown. */
  contentType: string
}

export type Dialect = 'oracle' | 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'other'

export interface SpanDetail extends SpanRow {
  http: {
    method: string
    route: string
    status: number
    path: string
    /** scheme://host[:port]/path?query (default ports left out); path?query alone when the host is unknown. */
    url: string
    /** The other end of the connection: the caller of an incoming request, the server of an outgoing call. */
    remoteAddress: string
    userAgent: string
    query: Pairs
    requestHeaders: Pairs
    responseHeaders: Pairs
    requestBody: Body
    responseBody: Body
  } | null
  db: {
    system: string
    /** db.namespace / db.name. */
    name: string
    operation: string
    table: string
    /** The whole statement (not cut at 2000 characters like SpanRow.db.statement). */
    statement: string
    dialect: Dialect
    /** Bind values in bind order. */
    params: DbParam[]
  } | null
  message: {
    system: string
    destination: string
    operation: string
    /** messaging.message.id / job.id; '' when unknown. */
    id: string
    headers: Pairs
    body: Body
  } | null
  timing: {
    start: string
    durationMs: number
    /** Start relative to the start of the trace. */
    offsetMs: number
  }
}

const DIALECTS: Record<string, Dialect> = {
  oracle: 'oracle',
  'oracle.db': 'oracle',
  postgresql: 'postgres',
  postgres: 'postgres',
  pg: 'postgres',
  cockroachdb: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mssql: 'mssql',
  'microsoft.sql_server': 'mssql',
  sqlserver: 'mssql',
  sqlite: 'sqlite',
  'better-sqlite3': 'sqlite',
}

export function dialectOf(system: string): Dialect {
  return DIALECTS[system.toLowerCase()] ?? 'other'
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Headers JSON object ({ name: value | value[] }) → pairs. */
function headerPairs(text: string): Pairs {
  const value = parseJson(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const out: Pairs = []
  for (const [name, v] of Object.entries(value)) {
    if (Array.isArray(v)) for (const item of v) out.push([name, String(item)])
    else if (v !== undefined && v !== null) out.push([name, typeof v === 'string' ? v : JSON.stringify(v)])
  }
  return out
}

const header = (pairs: Pairs, name: string): string => pairs.find(([k]) => k.toLowerCase() === name)?.[1] ?? ''

function body(text: string, size: number, truncated: number, contentType: string): Body {
  return { text, size: size || (text ? Buffer.byteLength(text) : 0), truncated: truncated === 1, contentType }
}

function params(text: string): DbParam[] {
  const value = parseJson(text)
  if (!Array.isArray(value)) return []
  return value
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => {
      const out: DbParam = {
        key: String(p.key ?? ''),
        type: (typeof p.type === 'string' ? p.type : 'string') as DbParam['type'],
        value: p.value === undefined || p.value === null ? '' : typeof p.value === 'string' ? p.value : JSON.stringify(p.value),
      }
      if (typeof p.column === 'string' && p.column) out.column = p.column
      if (p.truncated === true) out.truncated = true
      if (p.masked === 'unresolved') out.masked = 'unresolved'
      return out
    })
}

/** An IPv6 address in brackets, as in a URL or DevTools' Remote Address: [::1]:5102. */
const bracketed = (host: string): string => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)

const address = (host: string | undefined, port: string | undefined): string =>
  host ? (port ? `${bracketed(host)}:${port}` : bracketed(host)) : ''

/** `host[:port]` → [host, port]. */
function splitHost(value: string): [string, string] {
  const colon = value.lastIndexOf(':')
  return colon > 0 && !value.endsWith(']') ? [value.slice(0, colon), value.slice(colon + 1)] : [value, '']
}

/**
 * scheme://host[:port]/path?query. An outgoing call: url.full. An incoming
 * request: as the client addressed it (Host header, x-forwarded-proto), else
 * server.address / server.port. The query is the masked url_query.
 */
function urlOf(r: SpanDetailDb, a: Record<string, string>, requestHeaders: Pairs): { url: string; query: string } {
  const full = a['url.full'] || a['http.url'] || ''
  const hostHeader = header(requestHeaders, 'host')
  let scheme = header(requestHeaders, 'x-forwarded-proto').split(',')[0].trim() || a['url.scheme'] || a['http.scheme'] || ''
  let [host, port] = r.kind === 'SERVER' && hostHeader ? splitHost(hostHeader) : ['', '']
  if (!host) {
    host = a['server.address'] || a['net.host.name'] || ''
    port = a['server.port'] || a['net.host.port'] || ''
  }
  let path = r.url_path
  let fullQuery = ''
  if (full && r.kind !== 'SERVER') {
    try {
      const u = new URL(full)
      scheme = u.protocol.replace(/:$/, '')
      host = u.hostname
      port = u.port
      path = path || u.pathname
      fullQuery = u.search.slice(1)
    } catch {
      // not a URL: keep the attributes
    }
  }
  if (!host && hostHeader) [host, port] = splitHost(hostHeader)
  if (!scheme && host) scheme = port === '443' ? 'https' : 'http'
  const target = a['http.target'] ?? ''
  const query = r.url_query || fullQuery || (target.includes('?') ? target.slice(target.indexOf('?') + 1) : '')
  const defaultPort = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443')
  const origin = host ? `${scheme}://${bracketed(host)}${port && !defaultPort ? `:${port}` : ''}` : ''
  return { url: `${origin}${path}${query ? `?${query}` : ''}`, query }
}

function queryPairs(query: string): Pairs {
  if (!query) return []
  try {
    return [...new URLSearchParams(query)]
  } catch {
    return []
  }
}

export function toSpanDetail(r: SpanDetailDb, traceStartUs: number): SpanDetail {
  const row = toSpanRow(r)
  const a = r.attributes ?? {}
  const requestHeaders = headerPairs(r.req_headers)
  const responseHeaders = headerPairs(r.res_headers)

  const isHttp = !!(row.http || a['url.full'] || a['http.url'] || r.req_headers || r.res_headers || r.req_body || r.res_body)
  let http: SpanDetail['http'] = null
  if (isHttp) {
    const { url, query } = urlOf(r, a, requestHeaders)
    const remoteAddress =
      r.kind === 'SERVER'
        ? address(a['client.address'] || a['network.peer.address'] || a['net.peer.ip'], a['client.address'] ? a['client.port'] : a['network.peer.port'] || a['net.peer.port'])
        : address(a['network.peer.address'], a['network.peer.port']) || r.peer
    http = {
      // The columns, else the attributes (an S3 / rpc span records its HTTP exchange there).
      method: r.http_method || a['http.request.method'] || a['http.method'] || '',
      route: r.http_route,
      status: r.http_status || Number(a['http.response.status_code'] || a['http.status_code']) || 0,
      path: r.url_path,
      url,
      remoteAddress,
      userAgent: a['user_agent.original'] || a['http.user_agent'] || header(requestHeaders, 'user-agent'),
      query: queryPairs(query),
      requestHeaders,
      responseHeaders,
      requestBody: body(r.req_body, r.req_body_size, r.req_body_truncated, header(requestHeaders, 'content-type')),
      responseBody: body(r.res_body, r.res_body_size, r.res_body_truncated, header(responseHeaders, 'content-type')),
    }
  }

  const statement = r.db_statement_full || r.db_statement
  const db: SpanDetail['db'] =
    r.db_system || statement || r.db_params
      ? {
          system: r.db_system,
          name: a['db.namespace'] || a['db.name'] || '',
          operation: a['db.operation.name'] || a['db.operation'] || '',
          table: a['db.collection.name'] || a['db.sql.table'] || '',
          statement,
          dialect: dialectOf(r.db_system),
          params: params(r.db_params),
        }
      : null

  const isMessage =
    r.kind === 'CONSUMER' || r.kind === 'PRODUCER' || !!a['messaging.system'] || !!r.msg_body || !!r.msg_headers || r.msg_body_size > 0
  let message: SpanDetail['message'] = null
  if (isMessage) {
    const headers = headerPairs(r.msg_headers)
    const looksJson = /^\s*[{[]/.test(r.msg_body)
    message = {
      system: a['messaging.system'] || a['event.module'] || '',
      destination: a['messaging.destination.name'] || a['job.queue'] || '',
      operation:
        a['messaging.operation.type'] ||
        a['messaging.operation'] ||
        (r.kind === 'PRODUCER' ? 'send' : r.kind === 'CONSUMER' ? 'process' : ''),
      id: a['messaging.message.id'] || a['job.id'] || '',
      headers,
      body: body(
        r.msg_body,
        r.msg_body_size,
        r.msg_body_truncated,
        header(headers, 'content-type') || a['messaging.rabbitmq.content_type'] || (looksJson ? 'application/json' : ''),
      ),
    }
  }

  return {
    ...row,
    http,
    db,
    message,
    timing: { start: row.startTime, durationMs: row.durationMs, offsetMs: num((micros(r.timestamp) - traceStartUs) / 1000) },
  }
}
