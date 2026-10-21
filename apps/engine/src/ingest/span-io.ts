/**
 * Captured I/O of a span (SPEC.md section 7): request / response headers and
 * bodies, query string, SQL bind values and queue messages, moved out of
 * `attributes` into their own columns, so queries that read the attributes map
 * (topology, trace lists) never read bodies; the statement too (it is in
 * `db_statement` / `db_statement_full`). One pass over the attributes. Items
 * of a sender that masked them with the current rules (`skilllane.monitoring.mask` in the
 * envelope resource: skilllane-monitoring) are stored as they are; anything else is
 * masked here with the same rules (mask.ts): I/O values, URLs, every other
 * attribute. Other instrumentations' bind and header names (fallbacks) are
 * always masked.
 */
import { type DbParameter, dbParametersJson } from 'skilllane-monitoring/contract'
import {
  isSensitiveKey,
  maskBodyText,
  maskHeaderJson,
  maskHeaderValue,
  maskIdentifier,
  maskPathByRoute,
  maskQuery,
  maskUrl,
  REDACTED,
  redactValue,
} from './mask'

/** `db_statement` keeps this many characters; a longer statement also goes to `db_statement_full`. */
export const DB_STATEMENT_MAX = 2000
/** What the engine masks of one value from a sender that did not (and keeps: the rest is cut). */
export const FALLBACK_MAX_BYTES = 262_144
const FALLBACK_PARAMS = { maxBytes: FALLBACK_MAX_BYTES, valueMax: FALLBACK_MAX_BYTES / 4 }

/** Attribute names that become columns (the SDK's, and school-core-api's same-named ones). */
const IO_KEYS = new Set([
  'url.query',
  'http.request.headers',
  'http.response.headers',
  'http.request.body',
  'http.response.body',
  'http.request.body.size',
  'http.response.body.size',
  'http.request.body.truncated',
  'http.response.body.truncated',
  'skilllane.monitoring.db.parameters',
  // opentelemetry-instrumentation-typeorm collectParameters: JSON of the query builder's parameters
  'db.statement.parameters',
  // @opentelemetry/instrumentation-pg enhancedDatabaseReporting: string[] of $1, $2 …
  'db.postgresql.values',
  'messaging.message.body',
  'messaging.message.body.size',
  'messaging.message.body.truncated',
  'messaging.message.headers',
])
// Semconv per-key forms (0-based index for positional binds); oracledb writes db.operation.parameter.*.
const QUERY_PARAMETER = 'db.query.parameter.'
const OPERATION_PARAMETER = 'db.operation.parameter.'
const REQUEST_HEADER = 'http.request.header.'
const RESPONSE_HEADER = 'http.response.header.'

export type DbParamType = 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'date' | 'buffer' | 'object'

/** One bind value of `db_params`: key = name of a :name bind, or "1", "2" … in bind order. */
export interface DbParam {
  key: string
  type: DbParamType
  value: string
  /** The column the placeholder binds to, when the statement says. */
  column?: string
  /** The value was cut (a last `{ key: '…', value: '<n> more' }` entry: the list was cut). */
  truncated?: boolean
  /** Masked because the statement names a secret and this bind's column could not be read from it. */
  masked?: 'unresolved'
}

export interface SpanIoColumns {
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
  req_header_count: number
  res_header_count: number
  db_param_count: number
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value)
}

/** Non-negative integer (UInt64 columns; JS numbers are exact far beyond any body size). */
function size(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(text(value))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), Number.MAX_SAFE_INTEGER) : 0
}

function flag(value: unknown): number {
  return value === true || value === 1 || value === 'true' || value === '1' ? 1 : 0
}

/** Keys of a JSON object / items of a JSON array (UInt16); 0 when not JSON. */
function countOf(json: string): number {
  if (!json) return 0
  try {
    const value: unknown = JSON.parse(json)
    const n = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0
    return Math.min(n, 65535)
  } catch {
    return 0
  }
}

/** Binds in skilllane.monitoring.db.parameters, leaving out the SDK's last `{ key: '…', value: '<n> more' }` cut marker. */
function paramCountOf(json: string): number {
  if (!json) return 0
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) return 0
    const binds = value.filter((p) => !(p && typeof p === 'object' && (p as { key?: unknown }).key === '…'))
    return Math.min(binds.length, 65535)
  } catch {
    return 0
  }
}

function isJson(body: string): boolean {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/** A JSON-encoded Node Buffer: { type: 'Buffer', data: number[] }. */
function isBufferJson(value: object): value is { type: 'Buffer'; data: number[] } {
  const v = value as { type?: unknown; data?: unknown }
  return v.type === 'Buffer' && Array.isArray(v.data)
}

/** One fallback bind value, typed from its JS value (dbParametersJson masks it). */
function param(key: string, value: unknown): DbParameter {
  if (value === null || value === undefined) return { key, type: 'null', value: '' }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return { key, type: typeof value as DbParamType, value: String(value) }
  }
  if (typeof value === 'string') return { key, type: ISO_DATE.test(value) ? 'date' : 'string', value }
  if (typeof value === 'object' && isBufferJson(value)) {
    return { key, type: 'buffer', value: Buffer.from(value.data.slice(0, 2048)).toString('hex') }
  }
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  return { key, type: 'object', value: json ?? String(value) }
}

/** Bind values from another instrumentation's attributes, as the `db_params` JSON ('' when none). */
function fallbackParams(perKey: Array<[string, unknown]> | undefined, io: Record<string, unknown>, statement: string): string {
  let params: DbParameter[] | undefined
  if (perKey?.length) {
    // Positional keys from a 0-based index become "1", "2" …; names stay. Sorted by position.
    params = perKey.map(([key, value]) => param(/^\d+$/.test(key) ? String(Number(key) + 1) : key, value))
    if (params.every((p) => /^\d+$/.test(p.key))) params.sort((a, b) => Number(a.key) - Number(b.key))
  } else if (io['db.statement.parameters'] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text(io['db.statement.parameters']))
      if (Array.isArray(parsed)) params = parsed.map((v, i) => param(String(i + 1), v))
      else if (parsed && typeof parsed === 'object') params = Object.entries(parsed).map(([k, v]) => param(k, v))
    } catch {
      // not JSON: nothing to show
    }
  } else if (Array.isArray(io['db.postgresql.values'])) {
    // the pg instrumentation writes 'null' for SQL NULL
    params = (io['db.postgresql.values'] as unknown[]).map((v, i) => param(String(i + 1), v === 'null' ? null : v))
  }
  return paramsOf(statement, params)
}

/** The shared rules (columns from the statement, key / fail-closed / value rule, caps) on a list of binds. */
function paramsOf(statement: string, params: DbParameter[] | undefined): string {
  if (!params?.length) return ''
  return dbParametersJson(statement || undefined, params.length, (i) => params[i], FALLBACK_PARAMS)
}

/** `skilllane.monitoring.db.parameters` from a sender that did not mask it: parsed and masked again. */
function remaskParams(json: string, statement: string): string {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return ''
    const params = parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p): DbParameter => {
        const out: DbParameter = {
          key: String(p.key ?? ''),
          type: (typeof p.type === 'string' ? p.type : 'string') as DbParamType,
          value: typeof p.value === 'string' ? p.value : JSON.stringify(p.value ?? ''),
        }
        if (typeof p.column === 'string' && p.column) out.column = p.column
        if (p.truncated === true) out.truncated = true
        return out
      })
    return paramsOf(statement, params)
  } catch {
    return ''
  }
}

/** Semconv per-header attributes (`http.request.header.content_type`) → the headers JSON object, masked. */
function headersJson(collected: Record<string, unknown> | undefined): string {
  if (!collected) return ''
  const out: Record<string, string | string[]> = {}
  for (const [suffix, value] of Object.entries(collected)) {
    const name = suffix.toLowerCase().replace(/_/g, '-')
    out[name] = Array.isArray(value) ? value.map((v) => maskHeaderValue(name, text(v))) : maskHeaderValue(name, text(value))
  }
  return JSON.stringify(out)
}

const URL_ATTRIBUTES = new Set(['url.full', 'http.url', 'http.target'])
const ID_ATTRIBUTES = new Set(['job.id', 'messaging.message.id', 'messaging.message.conversation_id', 'messaging.kafka.message.key'])

/** One attribute of a sender that did not mask: URLs by their query, ids by their segments, the rest by key and value. */
export function maskAttributeText(key: string, value: string, route?: string): string {
  if (URL_ATTRIBUTES.has(key)) return key === 'http.target' ? maskPathByRoute(maskUrl(value), route) : maskUrl(value)
  if (key === 'url.path') return maskPathByRoute(redactValue(value), route)
  if (isSensitiveKey(key)) return REDACTED
  if (ID_ATTRIBUTES.has(key)) return maskIdentifier(value)
  return redactValue(value)
}

/** A body (or message payload) from a sender that did not mask it, and whether masking cut it. */
function maskedBody(body: string): { text: string; cut: boolean } {
  if (!body) return { text: body, cut: false }
  const masked = maskBodyText(body, FALLBACK_MAX_BYTES)
  return { text: masked, cut: Buffer.byteLength(body) > FALLBACK_MAX_BYTES }
}

/** school-core-api's own hook cuts a body at 1000 characters and appends '...' (it sends no size or flag). */
function cutAt1000(body: string, sizeAttr: unknown, flagAttr: unknown): number {
  return sizeAttr === undefined && flagAttr === undefined && body.length === 1003 && body.endsWith('...') ? 1 : 0
}

/**
 * Splits span attributes into the `attributes` map (strings, non-strings
 * JSON-encoded) and the I/O columns. The statement (`db.query.text` /
 * `db.statement`) always leaves `attributes`: it is the `db_statement` column,
 * and whole in `db_statement_full` when longer than DB_STATEMENT_MAX.
 * `masked`: the sender masked everything already (else it is masked here);
 * `statement`: already masked when the sender did not.
 */
export function splitSpanAttributes(
  attrs: Record<string, unknown>,
  statement: string,
  masked = true,
): { attributes: Record<string, string>; io: SpanIoColumns } {
  const longStatement = statement.length > DB_STATEMENT_MAX
  const route = typeof attrs['http.route'] === 'string' ? attrs['http.route'] : undefined
  const attributes: Record<string, string> = {}
  const io: Record<string, unknown> = {}
  let queryParams: Array<[string, unknown]> | undefined
  let operationParams: Array<[string, unknown]> | undefined
  let reqHeaders: Record<string, unknown> | undefined
  let resHeaders: Record<string, unknown> | undefined
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    if (value === undefined) continue
    if (IO_KEYS.has(key)) {
      io[key] = value
      continue
    }
    if (key.startsWith('db.')) {
      if (key.startsWith(QUERY_PARAMETER)) {
        ;(queryParams ??= []).push([key.slice(QUERY_PARAMETER.length), value])
        continue
      }
      if (key.startsWith(OPERATION_PARAMETER)) {
        ;(operationParams ??= []).push([key.slice(OPERATION_PARAMETER.length), value])
        continue
      }
      if (key === 'db.query.text' || key === 'db.statement') continue
    } else if (key.startsWith('http.')) {
      if (key.startsWith(REQUEST_HEADER)) {
        ;(reqHeaders ??= {})[key.slice(REQUEST_HEADER.length)] = value
        continue
      }
      if (key.startsWith(RESPONSE_HEADER)) {
        ;(resHeaders ??= {})[key.slice(RESPONSE_HEADER.length)] = value
        continue
      }
    }
    attributes[key] = masked ? text(value) : maskAttributeText(key, text(value), route)
  }

  const rawReq = text(io['http.request.body'])
  const rawRes = text(io['http.response.body'])
  const rawMsg = text(io['messaging.message.body'])
  const req = masked ? { text: rawReq, cut: false } : maskedBody(rawReq)
  const res = masked ? { text: rawRes, cut: false } : maskedBody(rawRes)
  const msg = masked ? { text: rawMsg, cut: false } : maskedBody(rawMsg)
  const reqBody = req.text
  const resBody = res.text
  const msgBody = msg.text
  // Sizes of what the sender sent, before any masking here.
  const msgSize = size(io['messaging.message.body.size']) || (rawMsg ? Buffer.byteLength(rawMsg) : 0)
  const msgFlag = io['messaging.message.body.truncated']
  const headerText = (key: string, lowerCase: boolean): string => {
    const value = text(io[key])
    return masked || !value ? value : maskHeaderJson(value, lowerCase, FALLBACK_MAX_BYTES)
  }
  const reqHeadersJson = headerText('http.request.headers', true) || headersJson(reqHeaders)
  const resHeadersJson = headerText('http.response.headers', true) || headersJson(resHeaders)
  const sdkParams = text(io['skilllane.monitoring.db.parameters'])
  const dbParams = sdkParams
    ? masked
      ? sdkParams
      : remaskParams(sdkParams, statement)
    : fallbackParams(queryParams ?? operationParams, io, statement)
  const query = text(io['url.query']).replace(/^\?/, '')
  return {
    attributes,
    io: {
      url_query: masked ? query : maskQuery(query),
      req_headers: reqHeadersJson,
      res_headers: resHeadersJson,
      req_body: reqBody,
      res_body: resBody,
      req_body_size: size(io['http.request.body.size']) || (rawReq ? Buffer.byteLength(rawReq) : 0),
      res_body_size: size(io['http.response.body.size']) || (rawRes ? Buffer.byteLength(rawRes) : 0),
      req_body_truncated:
        flag(io['http.request.body.truncated']) ||
        (req.cut ? 1 : 0) ||
        cutAt1000(rawReq, io['http.request.body.size'], io['http.request.body.truncated']),
      res_body_truncated:
        flag(io['http.response.body.truncated']) ||
        (res.cut ? 1 : 0) ||
        cutAt1000(rawRes, io['http.response.body.size'], io['http.response.body.truncated']),
      db_params: dbParams,
      db_statement_full: longStatement ? statement : '',
      msg_body: msgBody,
      msg_headers: headerText('messaging.message.headers', false),
      msg_body_size: msgSize,
      // Without the flag: cut when the original was bigger and the text is no longer whole JSON.
      msg_body_truncated:
        msgFlag !== undefined
          ? flag(msgFlag) || (msg.cut ? 1 : 0)
          : msg.cut || (rawMsg && msgSize > Buffer.byteLength(rawMsg) && !isJson(rawMsg))
            ? 1
            : 0,
      req_header_count: countOf(reqHeadersJson),
      res_header_count: countOf(resHeadersJson),
      db_param_count: paramCountOf(dbParams),
    },
  }
}
