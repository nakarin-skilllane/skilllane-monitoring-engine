/**
 * Response shapes of the query API (SPEC.md section 8) and the mapping from
 * ClickHouse rows. Conventions: times are ISO UTC strings; absent strings are
 * '' (as stored), absent numbers 0, `durationMs` null when unknown; a nested
 * object (http, error, dependency, job, db, exception) is null when empty.
 * Extra fields beyond the SPEC shapes are additive.
 */
import { iso, num } from './sql'

export const LOG_SELECT = `
  timestamp, env, service, role, version, host, level, logger, event_code, event_module, message,
  trace_id, span_id, correlation_id, user_id, user_roles, organization_id,
  http_method, http_route, url_path, url_domain, http_status, duration_ms,
  error_type, error_code, error_message, error_hint, error_detail, error_how_to_fix, error_stack, error_cause,
  error_category, error_target, origin_function, origin_file, usecase, failed_step, db_statement,
  dependency_type, dependency_name, dependency_host, dependency_port,
  job_queue, job_type, job_id, job_attempt, job_max_attempts, job_final, job_inflight,
  reason, labels, fields, toString(error_fingerprint) AS fingerprint`

export interface LogDb {
  timestamp: string
  env: string
  service: string
  role: string
  version: string
  host: string
  level: string
  logger: string
  event_code: string
  event_module: string
  message: string
  trace_id: string
  span_id: string
  correlation_id: string
  user_id: string
  user_roles: string[]
  organization_id: string
  http_method: string
  http_route: string
  url_path: string
  url_domain: string
  http_status: number
  duration_ms: number | null
  error_type: string
  error_code: string
  error_message: string
  error_hint: string
  error_detail: string
  error_how_to_fix: string
  error_stack: string
  error_cause: string
  error_category: string
  error_target: string
  origin_function: string
  origin_file: string
  usecase: string
  failed_step: string
  db_statement: string
  dependency_type: string
  dependency_name: string
  dependency_host: string
  dependency_port: number
  job_queue: string
  job_type: string
  job_id: string
  job_attempt: number
  job_max_attempts: number
  job_final: number
  job_inflight: string[]
  reason: string
  labels: Record<string, string>
  fields: Record<string, string>
  fingerprint: string
}

export interface LogRow {
  timestamp: string
  env: string
  service: string
  role: string
  version: string
  host: string
  level: string
  logger: string
  eventCode: string
  eventModule: string
  message: string
  traceId: string
  spanId: string
  correlationId: string
  userId: string
  userRoles: string[]
  organizationId: string
  http: { method: string; route: string; path: string; status: number; domain: string } | null
  durationMs: number | null
  /**
   * Status the service answered for the HTTP request this line was written in:
   * an `http.request` line's own status; for an error line (fingerprint set),
   * the `http.request` line of the same trace + service + role (/api/logs and
   * /api/errors/:fingerprint recent[] only). null when unknown or not in a request.
   */
  httpStatus: number | null
  /** Duration of that request (same source as httpStatus). */
  requestDurationMs: number | null
  error: {
    type: string
    code: string
    message: string
    hint: string
    detail: string
    howToFix: string
    category: string
    target: string
    stack: string
    originFunction: string
    originFile: string
    cause: string
  } | null
  /** Error group of the line (decimal string), null when it is not an error line. */
  fingerprint: string | null
  usecase: string
  failedStep: string
  dbStatement: string
  dependency: { type: string; name: string; host: string; port: number } | null
  job: {
    queue: string
    type: string
    id: string
    attempt: number
    maxAttempts: number
    final: boolean
    inflight: string[]
  } | null
  reason: string
  labels: Record<string, string>
  fields: Record<string, string>
}

export function toLogRow(r: LogDb): LogRow {
  const hasHttp = r.http_method || r.http_route || r.url_path || r.http_status || r.url_domain
  const hasError = r.error_type || r.error_code || r.error_hint || r.error_message
  const durationMs = r.duration_ms === null || r.duration_ms === undefined ? null : num(r.duration_ms)
  const isRequest = r.event_code === 'http.request'
  return {
    timestamp: iso(r.timestamp) ?? '',
    env: r.env,
    service: r.service,
    role: r.role,
    version: r.version,
    host: r.host,
    level: r.level,
    logger: r.logger,
    eventCode: r.event_code,
    eventModule: r.event_module,
    message: r.message,
    traceId: r.trace_id,
    spanId: r.span_id,
    correlationId: r.correlation_id,
    userId: r.user_id,
    userRoles: r.user_roles ?? [],
    organizationId: r.organization_id,
    http: hasHttp
      ? { method: r.http_method, route: r.http_route, path: r.url_path, status: r.http_status, domain: r.url_domain }
      : null,
    durationMs,
    httpStatus: isRequest && r.http_status ? r.http_status : null,
    requestDurationMs: isRequest ? durationMs : null,
    error: hasError
      ? {
          type: r.error_type,
          code: r.error_code,
          message: r.error_message,
          hint: r.error_hint,
          detail: r.error_detail,
          howToFix: r.error_how_to_fix,
          category: r.error_category,
          target: r.error_target,
          stack: r.error_stack,
          originFunction: r.origin_function,
          originFile: r.origin_file,
          cause: r.error_cause,
        }
      : null,
    fingerprint: r.fingerprint && r.fingerprint !== '0' ? r.fingerprint : null,
    usecase: r.usecase,
    failedStep: r.failed_step,
    dbStatement: r.db_statement,
    dependency:
      r.dependency_type || r.dependency_name
        ? { type: r.dependency_type, name: r.dependency_name, host: r.dependency_host, port: r.dependency_port }
        : null,
    job:
      r.job_queue || r.job_id
        ? {
            queue: r.job_queue,
            type: r.job_type,
            id: r.job_id,
            attempt: r.job_attempt,
            maxAttempts: r.job_max_attempts,
            final: r.job_final === 1,
            inflight: r.job_inflight ?? [],
          }
        : null,
    reason: r.reason,
    labels: r.labels ?? {},
    fields: r.fields ?? {},
  }
}

export const SPAN_SELECT = `
  trace_id, span_id, parent_span_id, env, service, role, version, host, is_entry, name, kind,
  timestamp, duration_ns / 1e6 AS duration_ms, status_code, status_message, scope_name,
  http_method, http_route, http_status, url_path, db_system, db_statement, peer,
  exception_type, exception_message, attributes, events`

/**
 * Sizes of a span's captured I/O (trace detail): lengths only, from the size and
 * count columns the ingest fills, never the headers / params JSON or the bodies.
 */
export const SPAN_IO_SELECT = `
  url_query != '' AS io_has_query, req_header_count AS io_req_headers, res_header_count AS io_res_headers,
  req_body_size AS io_req_bytes, res_body_size AS io_res_bytes,
  req_body_truncated AS io_req_truncated, res_body_truncated AS io_res_truncated,
  db_param_count AS io_params, msg_body_size AS io_msg_bytes`

export interface SpanIoDb {
  io_has_query: number
  io_req_headers: number
  io_res_headers: number
  io_req_bytes: number
  io_res_bytes: number
  io_req_truncated: number
  io_res_truncated: number
  io_params: number
  io_msg_bytes: number
}

/** What a span captured (the Network view's rows and Size column); zeros when nothing. */
export interface SpanIo {
  hasQuery: boolean
  /** Header names (a repeated header counts once). */
  reqHeaders: number
  resHeaders: number
  /** Original body sizes in bytes (before masking and the SDK's cap). */
  reqBytes: number
  resBytes: number
  reqTruncated: boolean
  resTruncated: boolean
  /** SQL bind values. */
  params: number
  /** Queue message body, original bytes. */
  msgBytes: number
}

export interface SpanDb {
  trace_id: string
  span_id: string
  parent_span_id: string
  env: string
  service: string
  role: string
  version: string
  host: string
  is_entry: number
  name: string
  kind: string
  timestamp: string
  duration_ms: number
  status_code: string
  status_message: string
  scope_name: string
  http_method: string
  http_route: string
  http_status: number
  url_path: string
  db_system: string
  db_statement: string
  peer: string
  exception_type: string
  exception_message: string
  attributes: Record<string, string>
  events: string
}

export interface SpanRow {
  traceId: string
  spanId: string
  parentSpanId: string
  service: string
  role: string
  version: string
  host: string
  isEntry: boolean
  name: string
  kind: string
  /** ISO with microseconds. */
  startTime: string
  durationMs: number
  statusCode: string
  statusMessage: string
  scope: string
  http: { method: string; route: string; status: number; path: string } | null
  db: { system: string; statement: string } | null
  peer: string
  exception: { type: string; message: string } | null
  attributes: Record<string, string>
  events: unknown[]
  /** Captured I/O sizes; zeros when the row was read without SPAN_IO_SELECT. */
  io: SpanIo
}

function parseEvents(text: string): unknown[] {
  try {
    const value = JSON.parse(text || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function toSpanIo(r: Partial<SpanIoDb>): SpanIo {
  return {
    hasQuery: r.io_has_query === 1,
    reqHeaders: r.io_req_headers ?? 0,
    resHeaders: r.io_res_headers ?? 0,
    reqBytes: r.io_req_bytes ?? 0,
    resBytes: r.io_res_bytes ?? 0,
    reqTruncated: r.io_req_truncated === 1,
    resTruncated: r.io_res_truncated === 1,
    params: r.io_params ?? 0,
    msgBytes: r.io_msg_bytes ?? 0,
  }
}

export function toSpanRow(r: SpanDb & Partial<SpanIoDb>): SpanRow {
  return {
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    service: r.service,
    role: r.role,
    version: r.version,
    host: r.host,
    isEntry: r.is_entry === 1,
    name: r.name,
    kind: r.kind,
    startTime: iso(r.timestamp) ?? '',
    durationMs: num(r.duration_ms),
    statusCode: r.status_code,
    statusMessage: r.status_message,
    scope: r.scope_name,
    http:
      r.http_method || r.http_route || r.http_status || r.url_path
        ? { method: r.http_method, route: r.http_route, status: r.http_status, path: r.url_path }
        : null,
    db: r.db_system || r.db_statement ? { system: r.db_system, statement: r.db_statement } : null,
    peer: r.peer,
    exception: r.exception_type || r.exception_message ? { type: r.exception_type, message: r.exception_message } : null,
    attributes: r.attributes ?? {},
    events: parseEvents(r.events),
    io: toSpanIo(r),
  }
}
