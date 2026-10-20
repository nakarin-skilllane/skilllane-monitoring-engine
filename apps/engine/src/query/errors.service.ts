import { Injectable, NotFoundException } from '@nestjs/common'
import { withRequests } from './logs.service'
import {
  type Common,
  type Level,
  type QueryString,
  optEnum,
  optInt,
  optName,
  parseCommon,
  parseFingerprint,
  parseLevels,
} from './params'
import { type Release, ReleasesService } from './releases.service'
import { type LogDb, type LogRow, LOG_SELECT, toLogRow } from './rows'
import { Reader, Where, bucketExpr, fillSeries, iso, msParam, num, scoped, seriesParams } from './sql'

export interface ErrorGroup {
  fingerprint: string
  env: string
  service: string
  /** Role of the latest occurrence. */
  role: string
  /** Every role with occurrences in the range (sorted; `role` is one of them). A group can hit api and persister. */
  roles: string[]
  /** Most severe level seen in the group (a job retry is warn, its final failure error). */
  level: string
  errorType: string
  errorCode: string
  hint: string
  hintDetail: string
  category: string
  target: string
  /** Fix sentence of the latest occurrence (it names this case's values). */
  fix: string
  originFunction: string
  originFile: string
  count: number
  users: number
  /** First occurrence in all retained data (may be before `from`). */
  firstSeen: string
  /** Last occurrence in all retained data (may be after `to`). */
  lastSeen: string
  /** `version` of the first occurrence. */
  firstSeenVersion: string
  /**
   * NEW since deploy: first seen at or after its service's current version was
   * deployed (first line of that version), and the service ran an earlier version before.
   * Never for category dependency or input (outages and bad requests are not new bugs).
   */
  isNew: boolean
  /** Occurrences per spark bucket of the range, oldest first (see `ErrorSpark`). */
  spark: number[]
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
  /** Occurrences at level error / fatal (a job group's job.failed lines), and at warn (its job.retry lines). */
  errorCount: number
  warnCount: number
  /** error / fatal occurrences per spark bucket (the rest of `spark` is warn). */
  sparkError: number[]
  /** event.module of the latest occurrence (bullmq, kafka, rabbitmq, cron) or ''. */
  eventModule: string
  /** dependency.type of the latest occurrence (redis, oracle, http …) or ''. */
  dependencyType: string
  /**
   * HTTP status the latest occurrence's request answered (its trace's `http.request` line of the same
   * service + role), else the status on the line itself when it is not an outbound call; 0 when none.
   */
  httpStatus: number
}

/**
 * Spark buckets of the error list: `buckets` counts, each exactly `stepSeconds`
 * wide (whole minutes, the range's minutes / `sparkBuckets` rounded up), laid
 * back from `to`: the last bucket is the last step before `to` (so "the last
 * minute" counts exactly that), and `from` = to − buckets × step, to the second
 * (not rounded to the minute). When the range is not a whole number of steps
 * the first bucket starts before the range and holds less; a remainder under a
 * minute joins the first bucket instead, so there are never more than
 * `sparkBuckets`. 24 h with the default 24 buckets = hourly, 1 h = 20 × 3 min.
 */
export interface ErrorSpark {
  from: string
  stepSeconds: number
  buckets: number
}

export const SPARK_BUCKETS = 24

export function sparkFor(c: Common, n = SPARK_BUCKETS): ErrorSpark & { origin: number; last: number } {
  const end = Math.ceil(c.toMs / 1000)
  const span = Math.max(1, end - Math.floor(c.fromMs / 1000))
  // Rounding the step up keeps the bucket count within n.
  const step = Math.max(60, Math.ceil(Math.floor(span / 60) / n) * 60)
  let buckets = Math.max(1, Math.ceil(span / step))
  if (buckets > 1 && span - (buckets - 1) * step < 60) buckets -= 1
  const origin = end - buckets * step
  return { from: new Date(origin * 1000).toISOString(), stepSeconds: step, buckets, origin, last: buckets - 1 }
}

/** Parameters of GROUP_SELECT's spark column. */
const sparkParams = (s: ReturnType<typeof sparkFor>) => ({ sparkOrigin: s.origin, sparkStep: s.stepSeconds, sparkLast: s.last })

const GROUP_SELECT = `
  toString(error_fingerprint) AS fingerprint,
  argMax(env, timestamp) AS group_env,
  argMax(service, timestamp) AS group_service,
  argMax(role, timestamp) AS group_role,
  arraySort(groupUniqArray(role)) AS group_roles,
  ['debug', 'info', 'warn', 'error', 'fatal'][max(multiIf(level = 'fatal', 5, level = 'error', 4, level = 'warn', 3, level = 'info', 2, 1))] AS group_level,
  sumMap([toUInt16(least(greatest(intDiv(toInt64(toUnixTimestamp(toDateTime(timestamp))) - {sparkOrigin:Int64}, {sparkStep:UInt32}), 0), {sparkLast:UInt16}))], [toUInt64(1)]) AS spark_map,
  argMax(error_type, timestamp) AS error_type,
  argMax(error_code, timestamp) AS error_code,
  argMax(error_hint, timestamp) AS hint,
  argMax(error_hint_detail, timestamp) AS hint_detail,
  argMax(error_category, timestamp) AS category,
  argMax(error_target, timestamp) AS target,
  argMax(error_fix, timestamp) AS fix,
  argMax(origin_function, timestamp) AS origin_function,
  argMax(origin_file, timestamp) AS origin_file,
  count() AS count,
  uniqExactIf(user_id, user_id != '') AS users,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen,
  groupUniqArrayIf(10)(concat(http_method, ' ', http_route), http_route != '') AS routes,
  groupUniqArrayIf(10)(usecase, usecase != '') AS usecases,
  argMaxIf(trace_id, timestamp, trace_id != '') AS sample_trace_id,
  argMax(if(error_message != '', error_message, message), timestamp) AS sample_message,
  argMax(event_code, timestamp) AS group_event_code,
  argMax(logger, timestamp) AS logger,
  argMax(failed_step, timestamp) AS failed_step,
  argMax(job_queue, timestamp) AS job_queue,
  argMax(job_type, timestamp) AS job_type,
  argMax(dependency_name, timestamp) AS dependency_name,
  countIf(level IN ('error', 'fatal')) AS error_count,
  countIf(level = 'warn') AS warn_count,
  sumMapIf([toUInt16(least(greatest(intDiv(toInt64(toUnixTimestamp(toDateTime(timestamp))) - {sparkOrigin:Int64}, {sparkStep:UInt32}), 0), {sparkLast:UInt16}))], [toUInt64(1)], level IN ('error', 'fatal')) AS spark_error_map,
  argMax(event_module, timestamp) AS event_module,
  argMax(dependency_type, timestamp) AS dependency_type,
  argMaxIf(http_status, timestamp, http_status > 0 AND url_domain = '' AND event_code != 'http.outbound_failed') AS own_status,
  max(timestamp) AS sample_at`

interface GroupDb {
  fingerprint: string
  // group_*: an alias named like a column would replace that column in WHERE.
  group_env: string
  group_service: string
  group_role: string
  group_roles: string[]
  group_level: string
  /** sumMap result: [bucket indexes, counts]. */
  spark_map: [number[], number[]] | { 1: number[]; 2: number[] }
  error_type: string
  error_code: string
  hint: string
  hint_detail: string
  category: string
  target: string
  fix: string
  origin_function: string
  origin_file: string
  count: number
  users: number
  first_seen: string
  last_seen: string
  routes: string[]
  usecases: string[]
  sample_trace_id: string
  sample_message: string
  group_event_code: string
  logger: string
  failed_step: string
  job_queue: string
  job_type: string
  dependency_name: string
  error_count: number
  warn_count: number
  spark_error_map: GroupDb['spark_map']
  event_module: string
  dependency_type: string
  own_status: number
  sample_at: string
}

/** A fingerprint over all retained data. */
interface Lifetime {
  first_seen: string
  last_seen: string
  first_version: string
}

/** Categories that are never "NEW since deploy": outages and bad requests, not new bugs. */
const NEVER_NEW = new Set(['dependency', 'input'])

function sparkArray(r: GroupDb, buckets: number, column: 'spark_map' | 'spark_error_map' = 'spark_map'): number[] {
  const out = new Array<number>(buckets).fill(0)
  const map = r[column] as unknown
  const [keys, values] = Array.isArray(map)
    ? (map as [number[], number[]])
    : [(map as { 1: number[] })[1] ?? [], (map as { 2: number[] })[2] ?? []]
  keys.forEach((k, i) => {
    if (k < buckets) out[k] += Number(values[i]) || 0
  })
  return out
}

function toGroup(r: GroupDb, life: Lifetime | undefined, releases: Map<string, Release>, buckets: number, requestStatus = 0): ErrorGroup {
  const firstSeen = iso(life?.first_seen ?? r.first_seen) ?? ''
  const release = releases.get(`${r.group_env}\u0000${r.group_service}`)
  const isNew =
    !NEVER_NEW.has(r.category) &&
    !!release?.previousVersion &&
    !!firstSeen &&
    Date.parse(firstSeen) >= Date.parse(release.deployedAt)
  return {
    fingerprint: r.fingerprint,
    env: r.group_env,
    service: r.group_service,
    role: r.group_role,
    roles: r.group_roles?.length ? r.group_roles : r.group_role ? [r.group_role] : [],
    level: r.group_level,
    errorType: r.error_type,
    errorCode: r.error_code,
    hint: r.hint,
    hintDetail: r.hint_detail,
    category: r.category,
    target: r.target,
    fix: r.fix,
    originFunction: r.origin_function,
    originFile: r.origin_file,
    count: r.count,
    users: r.users,
    firstSeen,
    lastSeen: iso(life?.last_seen ?? r.last_seen) ?? '',
    firstSeenVersion: life?.first_version ?? '',
    isNew,
    spark: sparkArray(r, buckets),
    routes: [...r.routes].sort(),
    usecases: [...r.usecases].sort(),
    sampleTraceId: r.sample_trace_id,
    sampleMessage: r.sample_message,
    eventCode: r.group_event_code,
    logger: r.logger,
    failedStep: r.failed_step,
    jobQueue: r.job_queue,
    jobType: r.job_type,
    dependencyName: r.dependency_name,
    errorCount: num(r.error_count),
    warnCount: num(r.warn_count),
    sparkError: sparkArray(r, buckets, 'spark_error_map'),
    eventModule: r.event_module,
    dependencyType: r.dependency_type,
    httpStatus: requestStatus || num(r.own_status),
  }
}

@Injectable()
export class ErrorsService {
  constructor(
    private readonly reader: Reader,
    private readonly releases: ReleasesService,
  ) {}

  /** Error groups; `level` (comma list, the group's most severe level), `sort`, `sparkBuckets`. */
  async list(q: QueryString): Promise<{ groups: ErrorGroup[]; spark: ErrorSpark }> {
    const c = parseCommon(q)
    const limit = optInt(q, 'limit', 1, 500, 100)
    const sort = optEnum(q, 'sort', ['count', 'lastseen', 'firstseen'] as const, ['count', 'lastSeen', 'firstSeen']) ?? 'count'
    const spark = sparkFor(c, optInt(q, 'sparkBuckets', 1, 120, SPARK_BUCKETS))
    const groups = await this.groups(c, { category: optName(q, 'category'), levels: parseLevels(q), sort, limit, spark })
    return { groups, spark: { from: spark.from, stepSeconds: spark.stepSeconds, buckets: spark.buckets } }
  }

  /**
   * Error groups of the range; firstSeen / lastSeen / isNew over all retained data.
   * sort count (default): most occurrences first; lastseen: latest occurrence first;
   * firstseen: newest group first (first occurrence, all retained data).
   */
  async groups(
    c: Common,
    opts: {
      category?: string
      levels?: Level[]
      sort?: 'count' | 'lastseen' | 'firstseen'
      limit: number
      spark?: ReturnType<typeof sparkFor>
    },
  ): Promise<ErrorGroup[]> {
    const sort = opts.sort ?? 'count'
    const spark = opts.spark ?? sparkFor(c)
    const w = scoped(c).add('error_fingerprint != 0')
    if (opts.category) w.add('error_category = {category:String}', { category: opts.category })
    const having = opts.levels ? 'HAVING group_level IN {levels:Array(String)}' : ''
    // Lifetime sorts need every group of the range before the limit (bounded at 500).
    const sqlLimit = sort === 'count' ? opts.limit : 500
    const rows = await this.reader.rows<GroupDb>(
      'errors',
      `SELECT ${GROUP_SELECT}
       FROM skilllane_monitoring.logs
       WHERE ${w.sql}
       GROUP BY error_fingerprint
       ${having}
       ORDER BY count DESC, last_seen DESC
       LIMIT {limit:UInt32}`,
      { ...w.params, ...sparkParams(spark), levels: opts.levels, limit: sqlLimit },
    )
    const [life, releases, statuses] = await Promise.all([
      this.lifetimes(c, rows.map((r) => r.fingerprint)),
      this.releases.serviceReleases(c.env),
      this.requestStatuses(rows),
    ])
    const groups = rows.map((r) => toGroup(r, life.get(r.fingerprint), releases, spark.buckets, statuses.get(r.fingerprint)))
    if (sort === 'lastseen') groups.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.count - a.count)
    if (sort === 'firstseen') groups.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || b.count - a.count)
    return groups.slice(0, opts.limit)
  }

  async detail(rawFingerprint: string, q: QueryString) {
    const fp = parseFingerprint(rawFingerprint)
    const c = parseCommon(q)
    // The fingerprint already includes env and service; only env and time narrow it.
    const scope: Common = { ...c, service: undefined, role: undefined }
    const w = scoped(scope).add('error_fingerprint = {fp:UInt64}', { fp })
    const spark = sparkFor(c)
    const params = { ...w.params, ...seriesParams(c), ...sparkParams(spark) }

    // Over all retained data of the fingerprint, like firstSeen / lastSeen.
    const versionsQuery = this.reader.rows<{ version: string; count: number; first_seen: string; last_seen: string }>(
      'error.versions',
      `SELECT version, count() AS count, min(timestamp) AS first_seen, max(timestamp) AS last_seen
       FROM skilllane_monitoring.logs WHERE error_fingerprint = {fp:UInt64}${c.env ? ' AND env = {env:String}' : ''}
       GROUP BY version ORDER BY first_seen`,
      { fp, env: c.env },
    )
    const [groupRows, series, routes, usecases, recent, traces] = await Promise.all([
      this.reader.rows<GroupDb>('error.group', `SELECT ${GROUP_SELECT} FROM skilllane_monitoring.logs WHERE ${w.sql} GROUP BY error_fingerprint`, params),
      this.reader.rows<{ t: number; count: number }>(
        'error.series',
        `SELECT ${bucketExpr('timestamp')} AS t, count() AS count FROM skilllane_monitoring.logs WHERE ${w.sql} GROUP BY t ORDER BY t`,
        params,
      ),
      this.reader.rows<{ route: string; count: number }>(
        'error.routes',
        `SELECT concat(http_method, ' ', http_route) AS route, count() AS count
         FROM skilllane_monitoring.logs WHERE ${w.sql} AND http_route != '' GROUP BY route ORDER BY count DESC LIMIT 20`,
        params,
      ),
      this.reader.rows<{ usecase: string; count: number }>(
        'error.usecases',
        `SELECT usecase, count() AS count
         FROM skilllane_monitoring.logs WHERE ${w.sql} AND usecase != '' GROUP BY usecase ORDER BY count DESC LIMIT 20`,
        params,
      ),
      this.reader.rows<LogDb>(
        'error.recent',
        `SELECT ${LOG_SELECT} FROM skilllane_monitoring.logs WHERE ${w.sql} ORDER BY timestamp DESC LIMIT 20`,
        params,
      ),
      this.reader.rows<{ trace_id: string }>(
        'error.traces',
        `SELECT trace_id FROM skilllane_monitoring.logs WHERE ${w.sql} AND trace_id != ''
         GROUP BY trace_id ORDER BY max(timestamp) DESC LIMIT 20`,
        params,
      ),
    ])

    let groupRow = groupRows[0]
    if (!groupRow) {
      // Not in the range: describe the group from all retained data so a saved link still opens.
      const wide: Common = { ...scope, fromMs: 0, toMs: Math.max(c.toMs, Date.now()) }
      const ww = scoped(wide).add('error_fingerprint = {fp:UInt64}', { fp })
      ;[groupRow] = await this.reader.rows<GroupDb>(
        'error.group.wide',
        `SELECT ${GROUP_SELECT} FROM skilllane_monitoring.logs WHERE ${ww.sql} GROUP BY error_fingerprint`,
        { ...ww.params, ...sparkParams(spark) },
      )
      if (!groupRow) throw new NotFoundException(`error group ${fp} has no occurrences in the retained data`)
      groupRow = { ...groupRow, count: 0, users: 0, error_count: 0, warn_count: 0, spark_map: [[], []], spark_error_map: [[], []] }
    }
    const [life, releases, versions, statuses] = await Promise.all([
      this.lifetimes(scope, [groupRow.fingerprint]),
      this.releases.serviceReleases(c.env),
      versionsQuery,
      this.requestStatuses([groupRow]),
    ])
    return {
      group: toGroup(groupRow, life.get(groupRow.fingerprint), releases, spark.buckets, statuses.get(groupRow.fingerprint)),
      spark: { from: spark.from, stepSeconds: spark.stepSeconds, buckets: spark.buckets },
      /** Occurrences per version, over all retained data (oldest version first). */
      versions: versions.map((v) => ({
        version: v.version,
        count: v.count,
        firstSeen: iso(v.first_seen) ?? '',
        lastSeen: iso(v.last_seen) ?? '',
      })),
      series: fillSeries(c, series, () => ({ count: 0 })),
      routes,
      usecases,
      recent: (await withRequests(this.reader, recent.map(toLogRow))) as LogRow[],
      traceIds: traces.map((t) => t.trace_id),
    }
  }

  /**
   * HTTP status each group's latest occurrence answered: the `http.request` line of its sample trace (the latest
   * one) for the same service + role, in one query bounded to those traces and times. Groups outside requests
   * (jobs, consumers) are not in the map.
   */
  private async requestStatuses(rows: GroupDb[]): Promise<Map<string, number>> {
    const withTrace = rows.filter((r) => r.sample_trace_id && r.sample_at)
    if (!withTrace.length) return new Map()
    const times = withTrace.map((r) => Date.parse(iso(r.sample_at) ?? '')).filter(Number.isFinite)
    if (!times.length) return new Map()
    const found = await this.reader.rows<{ trace_id: string; service: string; role: string; status: number }>(
      'errors.request_status',
      `SELECT trace_id, service, role, argMax(http_status, timestamp) AS status
       FROM skilllane_monitoring.logs
       WHERE env IN {envs:Array(String)} AND event_code = 'http.request'
         AND timestamp >= ${msParam('fromMs')} AND timestamp <= ${msParam('toMs')}
         AND trace_id IN {ids:Array(String)}
       GROUP BY trace_id, service, role`,
      {
        envs: [...new Set(withTrace.map((r) => r.group_env))],
        ids: [...new Set(withTrace.map((r) => r.sample_trace_id))],
        fromMs: Math.min(...times) - 60_000,
        toMs: Math.max(...times) + 10 * 60_000,
      },
    )
    const byKey = new Map(found.map((f) => [`${f.trace_id}\u0000${f.service}\u0000${f.role}`, num(f.status)]))
    const out = new Map<string, number>()
    for (const r of withTrace) {
      const s = byKey.get(`${r.sample_trace_id}\u0000${r.group_service}\u0000${r.group_role}`)
      if (s) out.set(r.fingerprint, s)
    }
    return out
  }

  /** First / last occurrence and first version of each fingerprint, over all retained data. */
  private async lifetimes(c: Pick<Common, 'env'>, fingerprints: string[]): Promise<Map<string, Lifetime>> {
    if (!fingerprints.length) return new Map()
    const w = new Where().add('error_fingerprint IN {fps:Array(UInt64)}', { fps: fingerprints.map((f) => BigInt(f)) })
    // The fingerprint already includes env; the env condition only prunes by primary key.
    if (c.env) w.add('env = {env:String}', { env: c.env })
    const rows = await this.reader.rows<Lifetime & { fingerprint: string }>(
      'errors.lifetime',
      `SELECT toString(error_fingerprint) AS fingerprint, min(timestamp) AS first_seen, max(timestamp) AS last_seen,
              argMin(version, timestamp) AS first_version
       FROM skilllane_monitoring.logs WHERE ${w.sql} GROUP BY error_fingerprint`,
      w.params,
    )
    return new Map(rows.map((r) => [r.fingerprint, r]))
  }
}
