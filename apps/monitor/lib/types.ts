/**
 * Response and query types of the skilllane-monitoring engine query API (SPEC.md §8), copied from
 * apps/engine/src/query/*.ts and apps/engine/src/health.controller.ts.
 * Conventions: times are ISO UTC strings; absent strings are '' and absent numbers 0;
 * nested objects (http, error, job …) are null when empty; errorRate values are ratios
 * (0.0042 = 0.42 %). When the engine adds fields, add them here (additive only).
 */

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error', 'fatal']

export type ErrorCategory = 'bug' | 'input' | 'data' | 'dependency' | 'config'

// ---------- GET /api/health ----------

export interface Health {
  ok: boolean
  clickhouse: boolean
  /** ENGINE_ROLE: all | ingest | query. */
  role: string
  /** Queue the engine reads: kafka | rabbitmq | bullmq. */
  transport: string
  /** Messages not yet in ClickHouse (0 = drained); null when unknown. */
  pending: number | null
}

// ---------- GET /api/meta ----------

export interface VersionSeen {
  version: string
  firstSeen: string
  lastSeen: string
}

export interface RoleRelease {
  role: string
  currentVersion: string
  /** First line of the current version (ISO). */
  deployedAt: string
  /** '' when the data shows only one version. */
  previousVersion: string
  /** Oldest first. */
  versions: VersionSeen[]
}

export interface ServiceRelease extends Omit<RoleRelease, 'role'> {
  env: string
  service: string
  roles: RoleRelease[]
}

/** A version change of a service in an env (chart markers). */
export interface Deploy {
  service: string
  env: string
  version: string
  at: string
  previousVersion: string
}

export interface MetaService {
  service: string
  roles: string[]
  envs: string[]
}

export interface Meta {
  /** Envs seen in the last 7 days, sorted. */
  envs: string[]
  /** Sorted by service name. */
  services: MetaService[]
  releases: ServiceRelease[]
  deploys: Deploy[]
  /** Engine clock (ISO). */
  now: string
  /** The signed-in user may read only `envs`, one at a time (no "every env"). */
  envsLimited?: boolean
}

// ---------- users ----------

export type PermissionId = 'overview' | 'logs' | 'traces' | 'errors' | 'jobs' | 'topology' | 'users' | 'roles'
/** Per permission: 'all' = every env, else the envs; absent = not granted. */
export type Effective = Partial<Record<PermissionId, 'all' | string[]>>

export interface Me {
  id: string
  username: string
  name: string
  /** env = the admin from SKILLLANE_MONITORING_ADMIN_USERNAME / SKILLLANE_MONITORING_ADMIN_PASSWORD. */
  kind: 'env' | 'user'
  roleIds: string[]
  permissions: Effective
  envs: 'all' | string[]
}

// ---------- shared ----------

/** Query params every endpoint accepts. from/to: ISO or now-<n>s|m|h|d|w (default now-1h..now, max 90 d). */
export interface CommonQuery {
  env?: string
  from?: string
  to?: string
  service?: string
  role?: string
  /**
   * Series bucket: seconds (900) or 1m | 5m | 15m | 1h | 1d; whole minutes, ≥ 60 s, ≤ 2000 buckets.
   * Default by range: ≤ 1 h → 60, ≤ 6 h → 300, ≤ 24 h → 900, ≤ 30 d → 3600, else 21600.
   */
  step?: string | number
}

/**
 * Series buckets (`t` = bucket start) begin at `from` rounded down to the minute (not epoch-aligned).
 * Above 1 m a leftover under a minute joins the last bucket (now-24h → 96 × 15 m, 24 × 1 h with step=1h);
 * at 1 m the current partial minute is its own last bucket (now-1h → 61). Series sums equal the totals.
 */
export interface RangeInfo {
  from: string
  to: string
  /** The `step` param, else ≤ 1 h → 60, ≤ 6 h → 300, ≤ 24 h → 900, ≤ 30 d → 3600, else 21600 (always accepted back as `step`). */
  stepSeconds: number
}

/**
 * Buckets of ErrorGroup.spark: `spark[i]` counts [from + i·step, from + (i+1)·step), every bucket exactly one
 * step. The grid is laid back from `to`: the last bucket is the last step before `to` (so "the last minute"
 * counts exactly that), and `from` = to − buckets·step, to the second (not rounded to the minute: label buckets
 * with seconds, or round knowing they are up to 59 s off). When the range is not a whole number of steps the
 * first bucket starts before the range and holds less (a remainder under a minute joins the first bucket).
 * 15 min → 15 × 60 s, 1 h → 20 × 180 s, 24 h → 24 × 3600 s, 7 d → 24 × 25200 s.
 */
export interface ErrorSpark {
  from: string
  stepSeconds: number
  buckets: number
}

export interface ErrorGroup {
  /** UInt64 as a decimal string. */
  fingerprint: string
  env: string
  service: string
  /** Role of the latest occurrence. */
  role: string
  /** Every role with occurrences in the range, sorted (`role` is one of them): a Redis outage can hit api and persister. */
  roles: string[]
  /** Most severe level of the group (a job retry is warn, its final failure error). */
  level: Level | string
  errorType: string
  errorCode: string
  hint: string
  hintDetail: string
  category: ErrorCategory | string
  target: string
  /** Fix sentence of the latest occurrence. */
  fix: string
  originFunction: string
  originFile: string
  count: number
  users: number
  /** Over all retained data (may be before `from`). */
  firstSeen: string
  lastSeen: string
  firstSeenVersion: string
  /**
   * NEW since deploy: first seen at or after its service's current version was deployed, and the service ran an
   * earlier version before. Never for category dependency or input (outages and bad requests are not new bugs).
   */
  isNew: boolean
  /** Occurrences per ErrorSpark bucket of the range, oldest first (sums to `count`). */
  spark: number[]
  /** `METHOD /path`. */
  routes: string[]
  usecases: string[]
  sampleTraceId: string
  sampleMessage: string
  eventCode: string
  logger: string
  failedStep: string
  jobQueue: string
  jobType: string
  dependencyName: string
  /** Occurrences at error + fatal (a job group's job.failed lines) and at warn (its job.retry lines); sum = count. */
  errorCount: number
  warnCount: number
  /** error + fatal occurrences per spark bucket (`spark` minus these = warn). */
  sparkError: number[]
  /** event.module of the latest occurrence (bullmq, kafka, rabbitmq, cron) or ''. */
  eventModule: string
  /** dependency.type of the latest occurrence (redis, oracle, http …) or ''. */
  dependencyType: string
  /** Status the latest occurrence's request answered (its trace's http.request line), else the line's own; 0 = none. */
  httpStatus: number
}

export interface Dependency {
  service: string
  role: string
  type: string
  name: string
  host: string
  port: number
  /**
   * From the latest dependency.down|still_down|up line up to `to` (7-day lookback); 'up' when none.
   * degraded = not down, the range has http.outbound_failed lines for it and no dependency.down|still_down line
   * (calls fail, e.g. ThaID 401, without an outage).
   */
  state: 'down' | 'degraded' | 'up'
  /** down: start of the outage; degraded: first http.outbound_failed of the range; up: latest dependency.up (back up or first connect); null without state lines. */
  since: string | null
  lastEventAt: string | null
  /** Failure lines in the range: dependency.down, dependency.still_down, http.outbound_failed. */
  attempts: number
  /** http.outbound_failed lines in the range (part of attempts). */
  outboundFailures: number
  /** Length of the last finished outage; null when none (first-connect `dependency.up` lines have no duration). */
  lastOutageMs: number | null
  affects: string[]
}

export interface JobStat {
  /** bullmq, kafka, rabbitmq, cron, task. */
  module: string
  queue: string
  type: string
  service: string
  role: string
  started: number
  finished: number
  /** job.retry + job.redelivered. */
  retried: number
  /** job.failed + job.stalled + message.dead_lettered. */
  failed: number
  p95Ms: number
  lastRunAt: string | null
  lastFailedAt: string | null
}

export interface LogRow {
  timestamp: string
  env: string
  service: string
  role: string
  version: string
  host: string
  level: Level | string
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
  /** `route` is the bare template (/classes/:id); `domain` is set on outbound calls. */
  http: { method: string; route: string; path: string; status: number; domain: string } | null
  durationMs: number | null
  /**
   * Status the service answered for the HTTP request this line was written in: an `http.request` line's own
   * status; on an error line (fingerprint set) in /api/logs and /api/errors/:fp recent[], the `http.request` line
   * of the same trace + service + role (http.status when 0 and durationMs when null are filled from it too, except
   * outbound lines, which keep their own). null for jobs or when no request is found; /api/traces/:id does no join.
   */
  httpStatus: number | null
  /** Duration of that request (same source as httpStatus). */
  requestDurationMs: number | null
  error: {
    type: string
    code: string
    message: string
    hint: string
    hintDetail: string
    fix: string
    category: ErrorCategory | string
    target: string
    stack: string
    originFunction: string
    originFile: string
    cause: string
  } | null
  /** Error group of the line, null when it is not an error line. */
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
  /** SERVER | CLIENT | INTERNAL | PRODUCER | CONSUMER. */
  kind: string
  /** ISO with microseconds. */
  startTime: string
  durationMs: number
  /** OK | ERROR | UNSET. */
  statusCode: string
  statusMessage: string
  scope: string
  http: { method: string; route: string; status: number; path: string } | null
  db: { system: string; statement: string } | null
  peer: string
  exception: { type: string; message: string } | null
  attributes: Record<string, string>
  events: unknown[]
  /** What the span carried in and out (lengths only, `GET /api/traces/:traceId`); absent from older engines. */
  io?: SpanIo | null
}

// ---------- GET /api/overview ----------

export interface OverviewService {
  service: string
  role: string
  kind: string
  requests: number
  errors: number
  errorRate: number
  p95Ms: number
  /** Requests per minute over the range. */
  rpm: number
  /** Requests per bucket (range.stepSeconds), oldest first. */
  spark: number[]
}

export interface OverviewSeriesPoint {
  t: string
  requests: number
  errors: number
  p95Ms: number
}

export interface OverviewRoute {
  service: string
  role: string
  kind: string
  /** `METHOD /path` for HTTP (`GET /me`), else the job key / entry span name (`report report:generate`). */
  route: string
  /** `GET`; '' for jobs. */
  method: string
  /** `/me`; '' for jobs. */
  path: string
  requests: number
  errors: number
  errorRate: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  /** 4xx responses (SERVER 4xx spans are never ERROR, so not counted in errors). */
  clientErrors: number
  clientErrorRate: number
}

export interface Overview {
  range: RangeInfo
  services: OverviewService[]
  /** Aligned buckets of range.stepSeconds (see RangeInfo). */
  series: OverviewSeriesPoint[]
  /** Top 20 by requests. */
  routes: OverviewRoute[]
  /** Top 8 by count, with spark. */
  errorGroups: ErrorGroup[]
  /** Buckets of errorGroups[].spark. */
  errorGroupsSpark: ErrorSpark
  dependencies: Dependency[]
  jobs: JobStat[]
}

// ---------- GET /api/logs ----------

export interface LogsQuery extends CommonQuery {
  /** Comma list, e.g. warn,error. */
  level?: string
  /** Text in message, error message, fix, hint, target or code (case-insensitive). */
  q?: string
  /** Event code, prefix or comma list of codes: job.failed, job.*, job.retry,job.failed */
  event?: string
  traceId?: string
  userId?: string
  /** job_id (any queue): every attempt of one job. */
  jobId?: string
  /** `GET /classes/:id` (the form responses use), a bare `/classes/:id`, or a job key `report report:generate` (job_queue + job_type). */
  route?: string
  category?: string
  /** Error group (decimal UInt64): its lines. */
  fingerprint?: string
  /** 1–500, default 100. */
  limit?: number
  /** Cursor: `nextBefore` of the previous page. */
  before?: string
}

export interface LogsHistogramBucket {
  t: string
  debug: number
  info: number
  warn: number
  error: number
  fatal: number
}

/** Lines per level over the whole range with every filter except `level`; requestError = error lines that are http.request lines. */
export interface LogsLevelCounts {
  debug: number
  info: number
  warn: number
  error: number
  fatal: number
  requestError: number
}

export interface LogsResponse {
  rows: LogRow[]
  histogram: LogsHistogramBucket[]
  levelCounts: LogsLevelCounts
  /** Pass as `before` for the next (older) page; null on the last page. */
  nextBefore: string | null
}

// ---------- GET /api/traces, /api/traces/:traceId ----------

/** Parts of `sample`, in the order they take from the `limit` budget. */
export type SamplePart = 'errors' | 'slow' | 'spread'
export const SAMPLE_PARTS: readonly SamplePart[] = ['errors', 'slow', 'spread']

/**
 * Every filter applies to rows and to every total.
 * sample: `spread` alone = errors,slow,spread. errors take at most ceil(limit/2) when other parts follow (spread
 * over time when there are more), slow = the slowest non-errors ceil(limit/5), HTTP entries first (long jobs never
 * push slow requests out; jobs fill what is left), the remainder without spread,
 * spread = the rest evenly over time buckets; when errors hit their cap and rows are still short of `limit`,
 * more errors fill it (sample 'errors'). Rows come back ordered by `sort`.
 */
export interface TracesQuery extends CommonQuery {
  /** `GET /me` (bare `/me` works too) or a job key `report report:generate` (the entry span name). */
  route?: string
  status?: 'error' | 'ok'
  minMs?: number
  /** Entry span kind: server, consumer … */
  kind?: string
  /** 32 hex = exact; 4–31 hex = prefix, within the range. */
  traceId?: string
  /** timestamp (default, newest first) | durationMs (slowest first). */
  sort?: 'timestamp' | 'durationMs'
  /** `spread`, or a comma list of errors,slow,spread. */
  sample?: string
  /**
   * `top` (default): no downstream HTTP entries (a service called by another service, e.g. POST /etl/parse-excel
   * inside an import): they are hops of their caller's trace. With service / role / route they are listed anyway
   * (that service's own requests). `all`: every entry span.
   */
  entries?: 'top' | 'all'
  /** Threshold of `totalSlow` in ms (default 2000, the monitor's slow rule). */
  slowMs?: number
  /** 1–500, default 200. */
  limit?: number
}

/** Job / message of a non-HTTP entry span (span attributes, else the job.* lines of that span). */
export interface TraceJob {
  queue: string
  type: string
  /** job.id / message id; '' when unknown (cron, tasks). */
  id: string
  /** 1-based attempt (each retry is its own span); 0 when unknown (Kafka, RabbitMQ, cron). */
  attempt: number
  /** 0 when unknown. */
  maxAttempts: number
  /** Queue system (bullmq, kafka, rabbitmq, cron) from the span's event.module / messaging.system or its job lines; '' when unknown. */
  module: string
}

export interface TraceListRow {
  traceId: string
  /** The entry span (a trace can have several rows: the request and each job attempt it queued). */
  spanId: string
  timestamp: string
  service: string
  role: string
  name: string
  kind: string
  method: string
  /** `GET /me` for HTTP entries, else the span name `report report:generate` (= overview routes[].route). */
  route: string
  /** The bare http.route template (`/me`); '' when not HTTP. */
  httpRoute: string
  /** HTTP status of the entry span; 0 when not HTTP (jobs, consumers). */
  status: number
  statusCode: string
  /** ERROR status or HTTP ≥ 500. */
  isError: boolean
  /** An HTTP entry called by another service (a hop inside its caller's trace); only with entries=all or a service / role / route filter. */
  downstream: boolean
  durationMs: number
  spanCount: number
  errorCount: number
  services: string[]
  /** null for HTTP entries, or when nothing names the job. */
  job: TraceJob | null
  /** Which `sample` part picked the row; null without `sample`. */
  sample: SamplePart | null
}

export interface TracesResponse {
  rows: TraceListRow[]
  /** Entry spans in the range matching every filter (not only the returned rows): requests + job / message attempts. */
  total: number
  /** Of those, isError. */
  totalErrors: number
  /** Distinct traces of those entry spans (a request and the job attempts it queued are one trace). */
  totalTraces: number
  /** Distinct traces with an isError entry span. */
  totalErrorTraces: number
  /** HTTP entries (kind SERVER) that are not isError and took ≥ `slowMs`: the real number of slow requests. */
  totalSlow: number
  /** Threshold of totalSlow (the `slowMs` param, default 2000). */
  slowMs: number
  /** The sample parts used (`spread` alone = all three); null without `sample`. */
  sample: SamplePart[] | null
}

export interface TraceDetail {
  traceId: string
  env: string
  start: string
  durationMs: number
  spanCount: number
  errorCount: number
  services: string[]
  spans: SpanRow[]
  logs: LogRow[]
}

// ---------- GET /api/errors, /api/errors/:fingerprint ----------

export interface ErrorsQuery extends CommonQuery {
  category?: string
  /** Comma list, matched against the group's most severe level. */
  level?: string
  /** count (default) | lastSeen (latest first) | firstSeen (newest group first, over all retained data). */
  sort?: 'count' | 'lastSeen' | 'firstSeen'
  /** 1–120, default 24 (ErrorSpark). */
  sparkBuckets?: number
  /** 1–500, default 100. */
  limit?: number
}

export interface ErrorsResponse {
  groups: ErrorGroup[]
  /** Buckets of groups[].spark (spark sums equal count). */
  spark: ErrorSpark
}

export interface ErrorDetail {
  group: ErrorGroup
  /** Buckets of group.spark. */
  spark: ErrorSpark
  /** Occurrences per version over all retained data, oldest first. */
  versions: Array<{ version: string; count: number; firstSeen: string; lastSeen: string }>
  /** Aligned to `from` (common `step`; step=1h → 24 hourly buckets for 24 h). */
  series: Array<{ t: string; count: number }>
  /** route = `METHOD /path`. */
  routes: Array<{ route: string; count: number }>
  usecases: Array<{ usecase: string; count: number }>
  /** Latest 20 lines of the group, with httpStatus / requestDurationMs from their request. */
  recent: LogRow[]
  /** Latest 20 traces. */
  traceIds: string[]
}

// ---------- GET /api/jobs, /api/dependencies ----------

export interface JobsResponse {
  stats: JobStat[]
  /** job.failed, job.stalled, job.retry, message.dead_lettered (latest 50). */
  recentFailures: LogRow[]
  /** consumer.* lines (latest 20). */
  consumerEvents: LogRow[]
}

export interface DependenciesResponse {
  dependencies: Dependency[]
  /** dependency.* and http.outbound_failed lines (latest 200). */
  events: LogRow[]
}

// ---------- GET /api/topology (3D system map) ----------

export type TopologyNodeKind = 'clients' | 'service' | 'queue' | 'dependency'
export type TopologyEdgeKind = 'http' | 'db' | 'rpc' | 'produce' | 'consume' | 'call'

export interface TopologyNode {
  /** `clients` · `service:<service>/<role>` · `queue:<name>` · `dependency:<type>:<name>` (one node per type + name, whatever host). */
  id: string
  kind: TopologyNodeKind
  /** dependency: readable (Oracle, Redis queue, AWS S3, Google Sheets, ThaID); service: `<service>/<role>`; queue: its name. */
  label: string
  /** service: SERVER | CONSUMER; queue: bullmq | kafka | rabbitmq | cron | task | ''; dependency: oracle | redis | http | aws-api …; clients: ''. */
  type: string
  service: string
  role: string
  /** dependency: every host:port it was seen on, most calls first, joined with `, `; '' otherwise. */
  host: string
  /** Names the SDK's dependency.* lines use (cache, queue, ThaID); [] when none. */
  names: string[]
  /** service: entry spans (route_stats_1m); dependency: calls of its incoming edges; queue: messages consumed (every attempt); clients: requests sent. */
  requests: number
  errors: number
  errorRate: number
  callsPerMin: number
  /** service: p95 of entry spans; other nodes: p95 over every span of the edges counted in requests (0 when none). */
  p95Ms: number
  /** dependency watched by the SDK: worst Dependency.state of its names; else null. */
  state: Dependency['state'] | null
}

export interface TopologyEdge {
  /** `<source>-><target>`. */
  id: string
  source: string
  target: string
  /** clients → service http; service → service http; db / rpc / call to dependencies; produce (service → queue) and consume (queue → service). */
  kind: TopologyEdgeKind
  /** produce edges count distinct parent spans (a retried job once); consume edges count every attempt. 0 = watched dependency without spans. */
  calls: number
  errors: number
  /** HTTP 4xx. Not in `errors` on clients → service edges; on CLIENT-span edges an outbound 4xx is ERROR, so it is in `errors` too (never add the two). */
  clientErrors: number
  callsPerMin: number
  errorRate: number
  /** 0 for produce edges and watched dependencies without spans. */
  avgMs: number
  /** p95 over every span of the edge (all hosts / peers merged); 0 like avgMs. */
  p95Ms: number
}

/** With `service` / `role` only the edges touching that service are kept, plus their nodes. */
export interface Topology {
  range: { from: string; to: string; minutes: number }
  nodes: TopologyNode[]
  edges: TopologyEdge[]
}

/** Body of a 4xx/5xx answer (NestJS). */
export interface EngineErrorBody {
  message: string | string[]
  error?: string
  statusCode: number
}

// ---------- span I/O: GET /api/traces/:traceId spans[].io, GET /api/traces/:traceId/spans/:spanId ----------
// The SDK stores what each request, outgoing call, query and message carried (masked: key names with password,
// token, secret, authorization, cookie, session and the authorization / cookie headers are `[REDACTED]`, and so are
// JWT, Bearer / Basic credentials, secret key=value pairs, e-mail and Thai national ids in any value), capped at
// LOG_BODY_MAX_BYTES (64 KB) per body. The trace monitor's Network view reads it (components/network, lib/io.ts).

/** Lengths only, on every span of the trace (cheap): the Network table's size column and which spans have I/O. */
export interface SpanIo {
  /** url.query is set. */
  hasQuery: boolean
  /** Header count of the request / response. */
  reqHeaders: number
  resHeaders: number
  /** Original body sizes in bytes (before the cap). */
  reqBytes: number
  resBytes: number
  /** The stored body was cut at the cap. */
  reqTruncated: boolean
  resTruncated: boolean
  /** Bind values of a DB span. */
  params: number
  /** Message / job payload size in bytes. */
  msgBytes: number
}

/** A header or query pair, in the order the request had it; a header with several values comes once per value. */
export type KvPair = [string, string]

export interface IoBody {
  /** As stored: JSON re-serialised compact after masking, text as text, form fields masked per key, multipart as a
   *  JSON summary (field names + files {name, filename, type, size}), '' for binary (size only). */
  text: string
  /** Original size in bytes. */
  size: number
  /** text is the first LOG_BODY_MAX_BYTES of the body. */
  truncated: boolean
  /** content-type of that side, '' when unknown. */
  contentType: string
}

export type SqlDialect = 'oracle' | 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'other'
export type DbParamType = 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'date' | 'buffer' | 'object'

/** One bind value in bind order: key = the name of a `:name` bind, else `1`, `2` …; value = its string form
 *  (date ISO-8601, buffer hex, object JSON). */
export interface DbParam {
  key: string
  type: DbParamType | string
  value: string
  /** The column the placeholder binds to, when the SDK could tell from the statement. */
  column?: string
  /** The value was cut by the SDK. A last `{ key: '…', value: '<n> more', truncated: true }` = the list was cut. */
  truncated?: boolean
  /** 'unresolved': masked because the statement names a secret (password, token…) and the SDK could not tell this
   * placeholder's column, so it closed the value to be safe. */
  masked?: 'unresolved'
}

export interface SpanHttpIo {
  method: string
  /** scheme://host:port/path?query */
  url: string
  /** Route template of an incoming request, '' for an outgoing call. */
  route: string
  status: number
  /** Peer address: the client of an incoming request, the server of an outgoing one. */
  remoteAddress: string
  userAgent: string
  query: KvPair[]
  requestHeaders: KvPair[]
  responseHeaders: KvPair[]
  requestBody: IoBody | null
  responseBody: IoBody | null
}

export interface SpanDbIo {
  /** db.system (oracle, postgresql, redis …). */
  system: string
  /** Database / namespace name, '' when unknown. */
  name: string
  /** db.operation.name (SELECT) and db.collection.name (SCORE); '' when unknown. */
  operation?: string
  table?: string
  /** The whole statement (SpanRow.db.statement stops at 2,000 characters). */
  statement: string
  dialect: SqlDialect
  params: DbParam[]
}

export interface SpanMessageIo {
  /** kafka | rabbitmq | bullmq … */
  system: string
  /** Topic, queue or exchange. */
  destination: string
  /** publish | process | receive … */
  operation: string
  /** messaging.message.id / job.id; '' when unknown. */
  id?: string
  headers: KvPair[]
  body: IoBody | null
}

export interface SpanTiming {
  start: string
  durationMs: number
  /** ms from the trace start. */
  offsetMs: number
}

/**
 * One span with everything it carried, as lib/io.ts normalizeSpanDetail() returns it from the engine's answer to
 * `GET /api/traces/:traceId/spans/:spanId` (SPEC §8: `SpanRow & { http, db, message, timing }`, flat; 404 for an
 * unknown id). The summary is `span` here; `http.requestBody` / `responseBody` are null when nothing was captured.
 */
export interface SpanDetail {
  span: SpanRow
  http: SpanHttpIo | null
  db: SpanDbIo | null
  message: SpanMessageIo | null
  timing: SpanTiming
}

// ---------- GET /api/dependencies: fields the engine adds (one row per service / role / name / host:port) ----------

/** Merged into Dependency above; optional until every engine sends it (the monitor works without). */
export interface Dependency {
  /**
   * Time of the latest dependency.up line that ended an outage of this host:port (reason recovered, it carries the
   * outage length `lastOutageMs`): that outage ran from lastRecoveredAt − lastOutageMs to lastRecoveredAt. null when none.
   */
  lastRecoveredAt?: string | null
}
