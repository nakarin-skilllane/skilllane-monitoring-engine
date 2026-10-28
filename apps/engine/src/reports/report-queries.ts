/**
 * ClickHouse reads of the daily report, all with the read-only user (Reader). Every range
 * is a UTC [fromMs, toMs) and every query filters env. A "slot" is the 24 h window index
 * counted from originMs (= window start − 6 days): 0–5 the windows before, 6 the report.
 */
import { Injectable } from '@nestjs/common'
import { msParam, Reader } from '../query/sql'
import { type FeatureSlot, RANK_DAYS, RESOURCE_RE, type UsageDay, type UsageUniq } from './features'
import type { DependencyEvent, JobDb, SpikeBucket } from './rules'

const LOGS = 'skilllane_monitoring.logs'
const STATS = 'skilllane_monitoring.route_stats_1m'
const USAGE = 'skilllane_monitoring.route_usage_1d'
/** The feature resource of a `METHOD /path` route (features.ts resourceOf). */
const RESOURCE = `extract(route, {re:String})`
/** Lines that count toward "users affected": the SDK logs a 5xx request at level error. */
const ERROR_LINE = `level IN ('error', 'fatal')`
/** Where an error happened, as route_stats_1m names HTTP routes. */
const ROUTE = `if(http_route != '', concat(http_method, ' ', http_route), if(job_type != '', concat(job_queue, ' ', job_type), ''))`
const P95 = `quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q)[2]`
const LOG_RANGE = `env = {env:String} AND timestamp >= ${msParam('fromMs')} AND timestamp < ${msParam('toMs')}`
const MINUTE_RANGE = `env = {env:String} AND minute >= ${msParam('fromMs')} AND minute < ${msParam('toMs')}`
/** Signed window index (floor, so lines older than originMs get negative slots). */
const SLOT = (column: string) => `toInt64(floor((toUnixTimestamp(${column}) - {originS:Int64}) / 86400))`

export interface ErrorDb {
  fingerprint: string
  service: string
  error_type: string
  error_hint: string
  /** Absent in older test rows. */
  logger?: string
  /** Only for groups without error_type and error_hint (their fingerprint is logger + message). */
  message?: string
  route: string
  origin_file: string
  origin_function: string
  count: number
  users: number
  first_ms: number
  trace_id: string
}

export interface RouteDb {
  route: string
  service: string
  requests: number
  p95: number
  p95_prev: number
}

type Range = { env: string; fromMs: number; toMs: number }
type Slotted = Range & { originMs: number }
const slotted = (r: Slotted) => ({ env: r.env, fromMs: r.fromMs, toMs: r.toMs, originS: Math.floor(r.originMs / 1000) })

@Injectable()
export class ReportQueries {
  constructor(private readonly reader: Reader) {}

  figureSlots(r: Slotted) {
    return this.reader.rows<{ slot: number; requests: number; errors: number; p95: number }>(
      'report.figure_slots',
      `SELECT ${SLOT('minute')} AS slot, sum(requests) AS requests, sum(errors) AS errors, ${P95} AS p95
       FROM ${STATS} WHERE ${MINUTE_RANGE} GROUP BY slot ORDER BY slot`,
      slotted(r),
    )
  }

  userSlots(r: Slotted) {
    return this.reader.rows<{ slot: number; users: number; orgs: number }>(
      'report.user_slots',
      `SELECT ${SLOT('timestamp')} AS slot,
              uniqExactIf(user_id, user_id != '') AS users, uniqExactIf(organization_id, organization_id != '') AS orgs
       FROM ${LOGS} WHERE ${LOG_RANGE} AND ${ERROR_LINE} GROUP BY slot`,
      slotted(r),
    )
  }

  /** Error groups of the window; dependency.* lines are left to the dependency card. */
  errors(r: Range) {
    return this.reader.rows<ErrorDb>(
      'report.errors',
      `SELECT toString(error_fingerprint) AS fingerprint, any(service) AS service, any(error_type) AS error_type,
              any(error_hint) AS error_hint, any(logger) AS logger,
              substring(anyIf(l.message, l.error_type = '' AND l.error_hint = ''), 1, 300) AS message,
              anyIf(${ROUTE}, ${ROUTE} != '') AS route,
              any(origin_file) AS origin_file, any(origin_function) AS origin_function,
              count() AS count, uniqExactIf(user_id, user_id != '') AS users,
              toUnixTimestamp64Milli(min(timestamp)) AS first_ms, anyIf(trace_id, trace_id != '') AS trace_id
       FROM ${LOGS} AS l WHERE ${LOG_RANGE} AND error_fingerprint != 0 AND NOT startsWith(event_code, 'dependency.')
       GROUP BY error_fingerprint ORDER BY users DESC, count DESC LIMIT 200`,
      r,
    )
  }

  /** Counts per slot of `fingerprints` in the lookback before the window (slots < 6). */
  errorHistory(r: Slotted, fingerprints: string[]) {
    if (!fingerprints.length) return Promise.resolve([])
    return this.reader.rows<{ fingerprint: string; slot: number; count: number; first_ms: number }>(
      'report.error_history',
      `SELECT toString(error_fingerprint) AS fingerprint, ${SLOT('timestamp')} AS slot, count() AS count,
              toUnixTimestamp64Milli(min(timestamp)) AS first_ms
       FROM ${LOGS} WHERE ${LOG_RANGE} AND error_fingerprint IN {fps:Array(UInt64)}
       GROUP BY error_fingerprint, slot`,
      { ...slotted(r), fps: fingerprints.map((f) => BigInt(f)) },
    )
  }

  spikeBuckets(r: Range) {
    return this.reader.rows<SpikeBucket>(
      'report.spike_buckets',
      `SELECT toUnixTimestamp(toStartOfInterval(minute, INTERVAL 5 MINUTE)) * 1000 AS t,
              sum(requests) AS requests, sum(errors) AS errors
       FROM ${STATS} WHERE ${MINUTE_RANGE} GROUP BY t ORDER BY t`,
      r,
    )
  }

  dependencyEvents(r: Range) {
    return this.reader.rows<DependencyEvent>(
      'report.dependency_events',
      `SELECT concat(service, '/', host) AS process, dependency_type AS type, dependency_name AS name,
              dependency_host AS host, dependency_port AS port, event_code AS code,
              toUnixTimestamp64Milli(timestamp) AS atMs, duration_ms AS durationMs, reason,
              if(error_message != '', error_message, message) AS message
       FROM ${LOGS} WHERE ${LOG_RANGE} AND dependency_name != ''
         AND event_code IN ('dependency.down', 'dependency.still_down', 'dependency.up')
       ORDER BY timestamp LIMIT 20000`,
      r,
    )
  }

  jobs(r: Range) {
    return this.reader.rows<JobDb>(
      'report.jobs',
      `SELECT job_type AS job, any(event_module) AS kind, any(service) AS service,
              countIf(event_code IN ('job.finished', 'job.failed')) AS total,
              countIf(event_code IN ('job.failed', 'job.stalled', 'message.dead_lettered')) AS failed,
              toUnixTimestamp64Milli(minIf(timestamp, event_code IN ('job.failed', 'job.stalled', 'message.dead_lettered'))) AS first_failed_ms,
              toUnixTimestamp64Milli(maxIf(timestamp, event_code IN ('job.failed', 'job.stalled', 'message.dead_lettered'))) AS last_failed_ms,
              toUnixTimestamp64Milli(maxIf(timestamp, event_code = 'job.finished')) AS last_ok_ms
       FROM ${LOGS} WHERE ${LOG_RANGE} AND job_type != ''
         AND (startsWith(event_code, 'job.') OR event_code = 'message.dead_lettered')
       GROUP BY job_type ORDER BY failed DESC, total DESC LIMIT 200`,
      r,
    )
  }

  /** Starts of @nestjs/schedule jobs (job type `Class.method`). */
  cronStarts(r: Range) {
    return this.reader.rows<{ type: string; starts: number[] }>(
      'report.cron_starts',
      `SELECT job_type AS type, groupArray(toUnixTimestamp64Milli(timestamp)) AS starts
       FROM ${LOGS} WHERE ${LOG_RANGE} AND event_code = 'job.started' AND event_module = 'cron'
         AND match(job_type, {cronName:String})
       GROUP BY type`,
      { ...r, cronName: '^\\w+\\.\\w+$' },
    )
  }

  /** p95 of each route in the window (fromMs) and merged over the 6 windows before it. */
  routes(r: Range & { windowFromMs: number }) {
    return this.reader.rows<RouteDb>(
      'report.routes',
      `SELECT route, any(service) AS service,
              sumIf(requests, minute >= ${msParam('windowFromMs')}) AS requests,
              quantilesTDigestMergeIf(0.5, 0.95, 0.99)(duration_q, minute >= ${msParam('windowFromMs')})[2] AS p95,
              quantilesTDigestMergeIf(0.5, 0.95, 0.99)(duration_q, minute < ${msParam('windowFromMs')})[2] AS p95_prev
       FROM ${STATS} WHERE ${MINUTE_RANGE}
       GROUP BY route HAVING requests > 0 ORDER BY requests DESC LIMIT 1000`,
      r,
    )
  }

  /** Per Bangkok day and feature group in [fromDay, toDay): sums, busy-hour share, routes. */
  usageDays(env: string, fromDay: string, toDay: string) {
    return this.reader.rows<UsageDay>(
      'report.usage_days',
      `SELECT toString(day) AS day, service, ${RESOURCE} AS resource,
              sum(requests) AS requests, sum(ok) AS ok, sum(with_user) AS withUser, sum(writes) AS writes,
              length(arrayFilter(h -> h >= 8 AND h <= 17, groupUniqArrayArray(hours))) / 10 AS peak,
              groupUniqArray(route) AS routes
       FROM ${USAGE} AS u WHERE u.env = {env:String} AND u.day >= {fromDay:Date} AND u.day < {toDay:Date}
       GROUP BY day, service, resource HAVING resource != ''`,
      { env, fromDay, toDay, re: RESOURCE_RE },
    )
  }

  /** Distinct users / orgs per group over the 30 days before each rank day d0 + k (k < RANK_DAYS). */
  usageUniq(env: string, d0: string, fromDay: string, toDay: string) {
    return this.reader.rows<UsageUniq>(
      'report.usage_uniq',
      `SELECT k, service, resource, uniqMerge(users) AS users, uniqMerge(orgs) AS orgs
       FROM (SELECT day, service, ${RESOURCE} AS resource, users, orgs FROM ${USAGE}
             WHERE env = {env:String} AND day >= {fromDay:Date} AND day < {toDay:Date})
       ARRAY JOIN range({n:UInt8}) AS k
       WHERE resource != '' AND day >= toDate({d0:Date}) + k - 30 AND day < toDate({d0:Date}) + k
       GROUP BY k, service, resource`,
      { env, d0, fromDay, toDay, n: RANK_DAYS, re: RESOURCE_RE },
    )
  }

  /** Requests / errors per slot of the features `ids` (`service:resource`) from route_stats_1m. */
  featureSlots(r: Slotted, ids: string[]) {
    if (!ids.length) return Promise.resolve([])
    return this.reader.rows<FeatureSlot>(
      'report.feature_slots',
      `SELECT concat(service, ':', ${RESOURCE}) AS featureId, ${SLOT('minute')} AS slot,
              sum(requests) AS requests, sum(errors) AS errors
       FROM ${STATS} WHERE ${MINUTE_RANGE} AND featureId IN {ids:Array(String)}
       GROUP BY featureId, slot`,
      { ...slotted(r), ids, re: RESOURCE_RE },
    )
  }

  async usersBetween(r: Range): Promise<number> {
    const rows = await this.reader.rows<{ users: number }>(
      'report.incident_users',
      `SELECT uniqExactIf(user_id, user_id != '') AS users FROM ${LOGS} WHERE ${LOG_RANGE} AND ${ERROR_LINE}`,
      r,
    )
    return rows[0]?.users ?? 0
  }
}
