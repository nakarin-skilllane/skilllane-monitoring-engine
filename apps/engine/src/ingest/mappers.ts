/**
 * Envelope items → ClickHouse rows (SPEC.md section 7).
 * Rows are plain objects for JSONEachRow. Every column gets a value of the
 * right type, so one odd item never makes a whole insert fail:
 * '' for strings, 0 for numbers, [] for arrays, null for duration_ms.
 */
import {
  type LogItem,
  type ResourceInfo,
  type SpanItem,
  durationNanos,
  isoToNanos,
  nanosToDateTime64,
} from 'skilllane-monitoring-contract'
import {
  isSensitiveKey,
  maskedBySender,
  maskEndpoint,
  maskIdentifier,
  maskJsonText,
  maskPathByRoute,
  maskSql,
  maskStatement,
  REDACTED,
  redactText,
  redactValue,
} from './mask'
import { DB_STATEMENT_MAX, FALLBACK_MAX_BYTES, maskAttributeText, splitSpanAttributes } from './span-io'

export type Row = Record<string, unknown>

/** env/service/role/version/host of a row. */
interface ResourceColumns {
  env: string
  service: string
  role: string
  version: string
  host: string
}

// ---------- small value helpers ----------

function str(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Non-negative integer clamped to `max` (UInt16 / UInt8 columns). */
function uint(value: unknown, max = 65535): number {
  const n = typeof value === 'number' ? value : Number.parseInt(str(value), 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.trunc(n), max)
}

function float(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null).map(str)
  return [str(value)]
}

/** Map(String, String): strings as is, anything else JSON-encoded. */
function stringMap(value: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value || typeof value !== 'object') return out
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue
    out[key] = str(v)
  }
  return out
}

function first<T>(...values: T[]): T | undefined {
  return values.find((v) => v !== undefined && v !== null && v !== '')
}

/** Path of a URL or of a request target; never the query string or fragment. */
function pathOf(value: unknown): string {
  const raw = str(value)
  if (!raw) return ''
  let path = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname
    } catch {
      path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    }
  }
  path = path.split(/[?#]/, 1)[0]
  return path
}

// ---------- resource ----------

function resourceColumns(resource: ResourceInfo, record?: Record<string, unknown>): ResourceColumns {
  const recordService = str(record?.['service.name'])
  const slash = recordService.indexOf('/')
  return {
    env: str(first(resource['deployment.environment.name'], record?.['service.environment'])) || 'unknown',
    service: str(first(resource['service.name'], slash >= 0 ? recordService.slice(0, slash) : recordService)),
    role: str(first(resource['app.role'], slash >= 0 ? recordService.slice(slash + 1) : undefined)),
    version: str(first(resource['service.version'], record?.['service.version'])),
    host: str(first(resource['host.name'], record?.['host.name'])),
  }
}

// ---------- logs ----------

/** Record keys that have their own column (everything else goes to `fields`). */
const LOG_COLUMN_KEYS = new Set([
  '@timestamp',
  'service.name',
  'service.version',
  'service.environment',
  'host.name',
  'log.level',
  'log.logger',
  'event.code',
  'event.module',
  'message',
  'trace.id',
  'span.id',
  'user.id',
  'user.roles',
  'organization.id',
  'http.request.method',
  'http.route',
  'url.path',
  'url.domain',
  'http.response.status_code',
  'duration_ms',
  'error.type',
  'error.code',
  'error.message',
  'error.hint',
  'error.hint_detail',
  'error.fix',
  'error.stack_trace',
  'error.cause',
  'log.origin.function',
  'log.origin.file.name',
  'db.statement',
  'dependency.type',
  'dependency.name',
  'dependency.host',
  'dependency.port',
  'job.queue',
  'job.type',
  'job.id',
  'job.attempt',
  'job.max_attempts',
  'job.final',
  'job.inflight',
  'reason',
  'labels',
])

/** Labels that become columns and are removed from `labels`. */
const LABEL_COLUMNS = ['error_category', 'error_target', 'usecase', 'failed_step'] as const

/** ISO text → DateTime64(3) text; falls back when the value does not parse. */
function logTimestamp(value: unknown, fallbackIso: string): string {
  const iso = str(value)
  const parsed = iso && Number.isFinite(Date.parse(iso)) ? iso : fallbackIso
  return nanosToDateTime64(isoToNanos(parsed), 3)
}

function jobFinal(value: unknown): number {
  return value === true || value === 1 || value === 'true' || value === '1' ? 1 : 0
}

/**
 * A log record from a sender that did not mask it (no `skilllane.monitoring.mask` in the
 * resource): the SDK's redactRecord rules, on a copy.
 */
function maskLogRecord(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r }
  const textOf = (key: string, mask: (text: string) => string) => {
    if (typeof out[key] === 'string') out[key] = mask(out[key] as string)
  }
  for (const key of ['message', 'error.message', 'error.stack_trace', 'error.hint', 'error.hint_detail', 'error.fix', 'reason']) {
    textOf(key, redactText)
  }
  textOf('db.statement', maskSql)
  textOf('user.id', redactValue)
  textOf('url.domain', redactValue)
  textOf('job.id', maskIdentifier)
  textOf('dependency.name', maskEndpoint)
  textOf('dependency.host', maskEndpoint)
  if (typeof out['url.path'] === 'string') {
    const path = (out['url.path'] as string).split('?', 1)[0]
    out['url.path'] = maskPathByRoute(redactValue(path), typeof out['http.route'] === 'string' ? out['http.route'] : undefined)
  }
  if (out['error.cause'] !== undefined) {
    const cause = out['error.cause']
    out['error.cause'] = maskJsonText(typeof cause === 'string' ? cause : JSON.stringify(cause))
  }
  return out
}

export function mapLog(item: LogItem, resource: ResourceInfo, sentAt: string): Row {
  const masked = maskedBySender(resource as unknown as Record<string, unknown>)
  const r = masked ? (item as Record<string, unknown>) : maskLogRecord(item as Record<string, unknown>)
  const labels = stringMap(r.labels as Record<string, unknown> | undefined)
  // The key rule on every label, whoever sent it; the value rule for other senders.
  for (const [key, value] of Object.entries(labels)) {
    labels[key] = isSensitiveKey(key) ? REDACTED : masked ? value : redactText(value)
  }
  const labelColumns: Record<string, string> = {}
  for (const key of LABEL_COLUMNS) {
    labelColumns[key] = labels[key] ?? ''
    delete labels[key]
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(r)) {
    if (LOG_COLUMN_KEYS.has(key) || value === undefined) continue
    fields[key] = masked ? str(value) : isSensitiveKey(key) ? REDACTED : redactValue(str(value))
  }
  const fallbackIso = Number.isFinite(Date.parse(sentAt)) ? sentAt : new Date().toISOString()
  return {
    timestamp: logTimestamp(r['@timestamp'], fallbackIso),
    ...resourceColumns(resource, r),
    level: str(r['log.level']),
    logger: str(r['log.logger']),
    event_code: str(r['event.code']),
    event_module: str(r['event.module']),
    message: str(r.message),
    trace_id: str(r['trace.id']),
    span_id: str(r['span.id']),
    correlation_id: labels.correlation_id ?? '',
    user_id: str(r['user.id']),
    user_roles: stringArray(r['user.roles']),
    organization_id: str(r['organization.id']),
    http_method: str(r['http.request.method']),
    http_route: str(r['http.route']),
    url_path: str(r['url.path']),
    url_domain: str(r['url.domain']),
    http_status: uint(r['http.response.status_code']),
    duration_ms: float(r.duration_ms),
    error_type: str(r['error.type']),
    error_code: str(r['error.code']),
    error_message: str(r['error.message']),
    error_hint: str(r['error.hint']),
    error_hint_detail: str(r['error.hint_detail']),
    error_fix: str(r['error.fix']),
    error_stack: str(r['error.stack_trace']),
    error_cause: str(r['error.cause']),
    error_category: labelColumns.error_category,
    error_target: labelColumns.error_target,
    usecase: labelColumns.usecase,
    failed_step: labelColumns.failed_step,
    origin_function: str(r['log.origin.function']),
    origin_file: str(r['log.origin.file.name']),
    db_statement: str(r['db.statement']),
    dependency_type: str(r['dependency.type']),
    dependency_name: str(r['dependency.name']),
    dependency_host: str(r['dependency.host']),
    dependency_port: uint(r['dependency.port']),
    job_queue: str(r['job.queue']),
    job_type: str(r['job.type']),
    job_id: str(r['job.id']),
    job_attempt: uint(r['job.attempt']),
    job_max_attempts: uint(r['job.max_attempts']),
    job_final: jobFinal(r['job.final']),
    job_inflight: stringArray(r['job.inflight']),
    reason: str(r.reason),
    labels,
    fields,
  }
}

// ---------- spans ----------

const NANOS = /^\d{1,30}$/

function peerOf(attrs: Record<string, unknown>): string {
  const host = str(first(attrs['server.address'], attrs['net.peer.name']))
  if (!host) return ''
  const port = str(first(attrs['server.port'], attrs['net.peer.port']))
  return port ? `${host}:${port}` : host
}

function urlPathOf(attrs: Record<string, unknown>): string {
  const direct = attrs['url.path']
  if (direct !== undefined && direct !== '') return pathOf(direct)
  const target = attrs['http.target']
  if (target !== undefined && target !== '') return pathOf(target)
  return pathOf(first(attrs['url.full'], attrs['http.url']))
}

/**
 * Throws when the item cannot become a row (missing ids or bad times). The
 * captured I/O attributes go to their own columns, not `attributes` (span-io.ts).
 */
export function mapSpan(item: SpanItem, resource: ResourceInfo): Row {
  if (!item || typeof item !== 'object') throw new Error('span item is not an object')
  if (!item.traceId || !item.spanId) throw new Error('span item without traceId/spanId')
  const start = str(item.startTimeUnixNano)
  const end = str(item.endTimeUnixNano) || start
  if (!NANOS.test(start) || !NANOS.test(end)) {
    throw new Error(`span ${item.spanId}: start/end time is not a nanosecond decimal string`)
  }
  const attrs = (item.attributes ?? {}) as Record<string, unknown>
  // skilllane-monitoring masked the item already; anything else is masked here (mask.ts).
  const masked = maskedBySender(resource as unknown as Record<string, unknown>)
  const dbSystem = str(first(attrs['db.system.name'], attrs['db.system']))
  const rawStatement = str(first(attrs['db.query.text'], attrs['db.statement']))
  const statement = masked || !rawStatement ? rawStatement : maskStatement(rawStatement, dbSystem, FALLBACK_MAX_BYTES)
  const { attributes, io } = splitSpanAttributes(attrs, statement, masked)
  const events = masked ? (item.events ?? []) : maskEvents(item.events ?? [])
  const exception = events.find((e) => e?.name === 'exception')
  const exAttrs = (exception?.attributes ?? {}) as Record<string, unknown>
  const parent = str(item.parentSpanId)
  const route = str(attrs['http.route'])
  const urlPath = urlPathOf(attrs)
  const text = (value: unknown) => (masked ? str(value) : redactValue(str(value)))
  return {
    timestamp: nanosToDateTime64(start, 6),
    duration_ns: Number(durationNanos(start, end)),
    ...resourceColumns(resource),
    trace_id: str(item.traceId),
    span_id: str(item.spanId),
    parent_span_id: parent,
    is_entry: !parent || item.parentIsRemote === true ? 1 : 0,
    name: text(item.name),
    kind: str(item.kind),
    status_code: str(item.status?.code) || 'UNSET',
    status_message: text(item.status?.message),
    scope_name: str(item.scope?.name),
    http_method: str(first(attrs['http.request.method'], attrs['http.method'])),
    http_route: route,
    http_status: uint(first(attrs['http.response.status_code'], attrs['http.status_code'])),
    url_path: masked ? urlPath : maskPathByRoute(redactValue(urlPath), route),
    db_system: dbSystem,
    db_statement: statement.slice(0, DB_STATEMENT_MAX),
    peer: peerOf(attrs),
    exception_type: str(exAttrs['exception.type']),
    exception_message: str(exAttrs['exception.message']),
    attributes,
    resource: stringMap(resource as unknown as Record<string, unknown>),
    events: JSON.stringify(events),
    ...io,
  }
}

/** Events of a sender that did not mask: every attribute by the key rule and the value rule (exception text too). */
function maskEvents(events: NonNullable<SpanItem['events']>): NonNullable<SpanItem['events']> {
  return events.map((event) => {
    if (!event?.attributes) return event
    const attributes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event.attributes)) {
      attributes[key] =
        typeof value === 'string'
          ? maskAttributeText(key, value)
          : Array.isArray(value)
            ? value.map((v) => (typeof v === 'string' ? maskAttributeText(key, v) : v))
            : isSensitiveKey(key)
              ? REDACTED
              : value
    }
    return { ...event, attributes: attributes as typeof event.attributes }
  })
}
