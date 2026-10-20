/**
 * Background work and dependencies, both read from log lines:
 * job.* lines → JobStat; dependency.* (+ http.outbound_failed) → Dependency.
 */
import { Injectable } from '@nestjs/common'
import { type Common, type QueryString, parseCommon } from './params'
import { type LogDb, type LogRow, LOG_SELECT, toLogRow } from './rows'
import { Reader, Where, iso, msParam, num, scopeOnly, scoped } from './sql'

export interface JobStat {
  /** event.module: bullmq, kafka, rabbitmq, cron, task. */
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
  /** p95 of attempt durations (finished, retried and failed attempts). */
  p95Ms: number
  lastRunAt: string | null
  lastFailedAt: string | null
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
   * 'degraded' when it is not down but the range has http.outbound_failed lines for it
   * and no dependency.down|still_down line (calls fail, e.g. ThaID 401, without an outage).
   */
  state: 'down' | 'degraded' | 'up'
  /** Start of the current outage when down; when degraded, the first http.outbound_failed of the range; when up, the latest dependency.up (back up, or first connect: reason connected); null without state lines. */
  since: string | null
  lastEventAt: string | null
  /** Failure lines in the range: dependency.down, dependency.still_down, http.outbound_failed. */
  attempts: number
  /** http.outbound_failed lines in the range (part of attempts). */
  outboundFailures: number
  /**
   * The last finished outage of this target as every process that reported it saw it
   * (recovery lines of the same env + type + name + host:port whose down windows overlap
   * this row's latest one): `lastRecoveredAt` = the last of their dependency.up lines
   * (reason not `connected`), `lastOutageFrom` = the earliest start (up − duration_ms),
   * `lastOutageMs` = the union of their windows. The same values on every row of that
   * outage; null when the 7-day lookback has no recovery of this row.
   */
  lastRecoveredAt: string | null
  lastOutageFrom: string | null
  lastOutageMs: number | null
  /** Features that stop working while it is down (dependency.affects). */
  affects: string[]
}

const FAILED = `('job.failed', 'job.stalled', 'message.dead_lettered')`
const ENDED = `('job.finished', 'job.retry', 'job.failed')`
const STATE_EVENTS = `('dependency.down', 'dependency.still_down', 'dependency.up')`
const FAILURE_EVENTS = `('dependency.down', 'dependency.still_down', 'http.outbound_failed')`
const DEPENDENCY_LOOKBACK_MS = 7 * 86_400_000

interface Recovery {
  env: string
  service: string
  role: string
  type: string
  name: string
  host: string
  port: number
  up_ms: number
  ms: number
}

/** Down windows closer than this are one outage (processes notice a drop a little apart). */
const SAME_OUTAGE_MS = 1000

/**
 * The last finished outage of a row: its own latest recovery line, merged with
 * every recovery of the same env + target whose window overlaps (transitively);
 * `ms` = the union of the windows. `recoveries` is newest first.
 */
function lastOutage(
  recoveries: Recovery[],
  row: { service: string; role: string; type: string; name: string; host: string; port: number },
): { fromMs: number; toMs: number; ms: number } | null {
  const sameTarget = (r: Recovery) => r.type === row.type && r.name === row.name && r.host === row.host && r.port === row.port
  const own = recoveries.find((r) => sameTarget(r) && r.service === row.service && r.role === row.role)
  if (!own) return null
  const windows = recoveries
    .filter((r) => r.env === own.env && sameTarget(r))
    .map((r) => ({ from: r.up_ms - r.ms, to: r.up_ms }))
  let from = own.up_ms - own.ms
  let to = own.up_ms
  const picked = new Set<number>()
  for (let grown = true; grown; ) {
    grown = false
    windows.forEach((win, i) => {
      if (picked.has(i) || win.from > to + SAME_OUTAGE_MS || win.to < from - SAME_OUTAGE_MS) return
      picked.add(i)
      from = Math.min(from, win.from)
      to = Math.max(to, win.to)
      grown = true
    })
  }
  // Union length: merge the picked windows in start order.
  let ms = 0
  let end = -Infinity
  for (const win of [...picked].map((i) => windows[i]).sort((a, b) => a.from - b.from)) {
    if (win.to <= end) continue
    ms += win.to - Math.max(win.from, end)
    end = win.to
  }
  return { fromMs: from, toMs: to, ms }
}

function parseList(text: string): string[] {
  if (!text) return []
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) ? value.map(String) : [String(value)]
  } catch {
    return [text]
  }
}

@Injectable()
export class OpsService {
  constructor(private readonly reader: Reader) {}

  async jobs(q: QueryString): Promise<{ stats: JobStat[]; recentFailures: LogRow[]; consumerEvents: LogRow[] }> {
    const c = parseCommon(q)
    const failures = scoped(c).add(`event_code IN ('job.failed', 'job.stalled', 'job.retry', 'message.dead_lettered')`)
    const consumer = scoped(c).add(`startsWith(event_code, 'consumer.')`)
    const [stats, recent, consumerEvents] = await Promise.all([
      this.jobStats(c),
      this.reader.rows<LogDb>(
        'jobs.failures',
        `SELECT ${LOG_SELECT} FROM skilllane_monitoring.logs WHERE ${failures.sql} ORDER BY timestamp DESC LIMIT 50`,
        failures.params,
      ),
      this.reader.rows<LogDb>(
        'jobs.consumer',
        `SELECT ${LOG_SELECT} FROM skilllane_monitoring.logs WHERE ${consumer.sql} ORDER BY timestamp DESC LIMIT 20`,
        consumer.params,
      ),
    ])
    return { stats, recentFailures: recent.map(toLogRow), consumerEvents: consumerEvents.map(toLogRow) }
  }

  async jobStats(c: Common): Promise<JobStat[]> {
    const w = scoped(c).add(`(startsWith(event_code, 'job.') OR event_code = 'message.dead_lettered')`)
    const rows = await this.reader.rows<{
      module: string
      queue: string
      type: string
      job_service: string
      job_role: string
      started: number
      finished: number
      retried: number
      failed: number
      p95_ms: number
      last_run_at: string
      last_failed_at: string
    }>(
      'jobs.stats',
      `SELECT event_module AS module, job_queue AS queue, job_type AS type,
              argMax(service, timestamp) AS job_service, argMax(role, timestamp) AS job_role,
              countIf(event_code = 'job.started') AS started,
              countIf(event_code = 'job.finished') AS finished,
              countIf(event_code IN ('job.retry', 'job.redelivered')) AS retried,
              countIf(event_code IN ${FAILED}) AS failed,
              quantileIf(0.95)(assumeNotNull(duration_ms), event_code IN ${ENDED} AND duration_ms IS NOT NULL) AS p95_ms,
              max(timestamp) AS last_run_at,
              maxIf(timestamp, event_code IN ${FAILED}) AS last_failed_at
       FROM skilllane_monitoring.logs
       WHERE ${w.sql}
       GROUP BY module, queue, type
       ORDER BY started DESC, queue, type`,
      w.params,
    )
    return rows.map((r) => ({
      module: r.module,
      queue: r.queue,
      type: r.type,
      service: r.job_service,
      role: r.job_role,
      started: r.started,
      finished: r.finished,
      retried: r.retried,
      failed: r.failed,
      p95Ms: num(r.p95_ms, 1),
      lastRunAt: iso(r.last_run_at),
      lastFailedAt: r.failed > 0 ? iso(r.last_failed_at) : null,
    }))
  }

  async dependencies(q: QueryString): Promise<{ dependencies: Dependency[]; events: LogRow[] }> {
    const c = parseCommon(q)
    const w = scoped(c).add(`(startsWith(event_code, 'dependency.') OR event_code = 'http.outbound_failed')`)
    const [dependencies, events] = await Promise.all([
      this.dependencyStates(c),
      this.reader.rows<LogDb>(
        'dependencies.events',
        `SELECT ${LOG_SELECT} FROM skilllane_monitoring.logs WHERE ${w.sql} ORDER BY timestamp DESC LIMIT 200`,
        w.params,
      ),
    ])
    return { dependencies, events: events.map(toLogRow) }
  }

  /**
   * Every dependency target (service + role + type + name + host:port) named in the
   * 7 days before `to`, with its state as of `to`. A process that moved to another
   * host gets one row per host, each with that host's own lines.
   */
  async dependencyStates(c: Common): Promise<Dependency[]> {
    const w = new Where().add(
      `dependency_name != '' AND timestamp >= ${msParam('lookMs')} AND timestamp <= ${msParam('toMs')}`,
      { lookMs: c.toMs - DEPENDENCY_LOOKBACK_MS, toMs: c.toMs, fromMs: c.fromMs },
    )
    scopeOnly(c, w)
    const [rows, recoveries] = await Promise.all([
      this.reader.rows<{
        service: string
        role: string
        dep_type: string
        dep_name: string
        dep_host: string
        dep_port: number
        state_event: string
        last_down_at: string
        last_up_at: string
        last_event_at: string
        failures: number
        outbound_failures: number
        outage_lines: number
        first_outbound_at: string
        affects: string
      }>(
        'dependencies.state',
        `SELECT service, role, dependency_type AS dep_type, dependency_name AS dep_name,
                dependency_host AS dep_host, dependency_port AS dep_port,
                argMaxIf(event_code, timestamp, event_code IN ${STATE_EVENTS}) AS state_event,
                maxIf(timestamp, event_code = 'dependency.down') AS last_down_at,
                maxIf(timestamp, event_code = 'dependency.up') AS last_up_at,
                max(timestamp) AS last_event_at,
                countIf(timestamp >= ${msParam('fromMs')} AND event_code IN ${FAILURE_EVENTS}) AS failures,
                countIf(timestamp >= ${msParam('fromMs')} AND event_code = 'http.outbound_failed') AS outbound_failures,
                countIf(timestamp >= ${msParam('fromMs')} AND event_code IN ('dependency.down', 'dependency.still_down')) AS outage_lines,
                minIf(timestamp, timestamp >= ${msParam('fromMs')} AND event_code = 'http.outbound_failed') AS first_outbound_at,
                argMaxIf(fields['dependency.affects'], timestamp, fields['dependency.affects'] != '') AS affects
         FROM skilllane_monitoring.logs
         WHERE ${w.sql}
         GROUP BY service, role, dep_type, dep_name, dep_host, dep_port
         ORDER BY state_event IN ('dependency.down', 'dependency.still_down') DESC, outbound_failures > 0 AND outage_lines = 0 DESC,
                  failures DESC, service, role, dep_name, dep_host, dep_port`,
        w.params,
      ),
      this.recoveries(c),
    ])
    return rows.map((r) => {
      const down = r.state_event === 'dependency.down' || r.state_event === 'dependency.still_down'
      const degraded = !down && r.outbound_failures > 0 && r.outage_lines === 0
      const target = { type: r.dep_type, name: r.dep_name, host: r.dep_host, port: r.dep_port }
      const outage = lastOutage(recoveries, { service: r.service, role: r.role, ...target })
      return {
        service: r.service,
        role: r.role,
        ...target,
        state: down ? 'down' : degraded ? 'degraded' : 'up',
        since: down
          ? iso(r.last_down_at)
          : degraded
            ? iso(r.first_outbound_at)
            : r.state_event
              ? iso(r.last_up_at)
              : null,
        lastEventAt: iso(r.last_event_at),
        attempts: r.failures,
        outboundFailures: r.outbound_failures,
        lastRecoveredAt: outage ? new Date(outage.toMs).toISOString() : null,
        lastOutageFrom: outage ? new Date(outage.fromMs).toISOString() : null,
        lastOutageMs: outage ? num(outage.ms, 1) : null,
        affects: parseList(r.affects),
      }
    })
  }

  /**
   * Recovery lines (dependency.up with a duration, reason not `connected`) of the
   * 7 days before `to`, newest first: env only, so an outage is merged over every
   * process that reported it whatever the service / role filter.
   */
  private recoveries(c: Common): Promise<Recovery[]> {
    const w = new Where().add(
      `event_code = 'dependency.up' AND reason != 'connected' AND duration_ms > 0 AND dependency_name != ''
       AND timestamp >= ${msParam('lookMs')} AND timestamp <= ${msParam('toMs')}`,
      { lookMs: c.toMs - DEPENDENCY_LOOKBACK_MS, toMs: c.toMs },
    )
    scopeOnly({ env: c.env }, w)
    return this.reader.rows<Recovery>(
      'dependencies.recoveries',
      `SELECT env, service, role, dependency_type AS type, dependency_name AS name,
              dependency_host AS host, dependency_port AS port,
              toUnixTimestamp64Milli(timestamp) AS up_ms, assumeNotNull(duration_ms) AS ms
       FROM skilllane_monitoring.logs
       WHERE ${w.sql}
       ORDER BY timestamp DESC
       LIMIT 10000`,
      w.params,
    )
  }
}
