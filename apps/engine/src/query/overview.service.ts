/**
 * Overview (RED from route_stats_1m + top errors, dependencies, jobs) and meta.
 * Errors in RED = entry spans with status ERROR or HTTP >= 500 (4xx are not errors).
 */
import { Injectable } from '@nestjs/common'
import { ErrorsService, type ErrorGroup, sparkFor } from './errors.service'
import { type Dependency, type JobStat, OpsService } from './ops.service'
import { type QueryString, optName, parseCommon } from './params'
import { type Deploy, type Release, ReleasesService } from './releases.service'
import { Reader, bucketExpr, buckets, fillSeries, num, ratio, scoped, scopedMinutes, seriesParams } from './sql'

const QUANTILES = `quantilesTDigestMerge(0.5, 0.95, 0.99)(duration_q)`
const HTTP_ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S.*)$/

/** route_stats_1m route key → method + path ('' for non-HTTP entries such as jobs). */
export function splitRoute(route: string): { method: string; path: string } {
  const m = HTTP_ROUTE.exec(route)
  return m ? { method: m[1], path: m[2] } : { method: '', path: '' }
}

interface RedDb {
  requests: number
  errors: number
  q: number[]
}

@Injectable()
export class OverviewService {
  constructor(
    private readonly reader: Reader,
    private readonly errors: ErrorsService,
    private readonly ops: OpsService,
    private readonly releasesService: ReleasesService,
  ) {}

  /**
   * envs and services of the last 7 days, plus versions from all retained data:
   * `releases` per env + service (with its roles), `deploys` = version changes
   * for chart markers. Optional `env` / `service` narrow releases and deploys.
   */
  async meta(q: QueryString = {}) {
    const scope = { env: optName(q, 'env'), service: optName(q, 'service') }
    const releasesPromise = this.releasesService.releases(scope)
    const rows = await this.reader.rows<{ env: string; service: string; role: string }>(
      'meta',
      `SELECT env, service, role FROM (
         SELECT env, service, role FROM skilllane_monitoring.route_stats_1m WHERE minute >= now() - INTERVAL 7 DAY GROUP BY env, service, role
         UNION ALL
         SELECT env, service, role FROM skilllane_monitoring.logs WHERE timestamp >= now() - INTERVAL 7 DAY GROUP BY env, service, role
       )
       WHERE service != ''
       GROUP BY env, service, role
       ORDER BY service, role, env`,
    )
    const services = new Map<string, { service: string; roles: Set<string>; envs: Set<string> }>()
    for (const r of rows) {
      const entry = services.get(r.service) ?? { service: r.service, roles: new Set(), envs: new Set() }
      if (r.role) entry.roles.add(r.role)
      entry.envs.add(r.env)
      services.set(r.service, entry)
    }
    const { byRole, byService, deploys } = await releasesPromise
    const roleOf = (r: Release) => ({
      role: r.role,
      currentVersion: r.currentVersion,
      deployedAt: r.deployedAt,
      previousVersion: r.previousVersion,
      versions: r.versions,
    })
    return {
      envs: [...new Set(rows.map((r) => r.env))].sort(),
      services: [...services.values()].map((s) => ({ service: s.service, roles: [...s.roles].sort(), envs: [...s.envs].sort() })),
      releases: byService.map((s) => ({
        env: s.env,
        service: s.service,
        currentVersion: s.currentVersion,
        deployedAt: s.deployedAt,
        previousVersion: s.previousVersion,
        versions: s.versions,
        roles: byRole.filter((r) => r.env === s.env && r.service === s.service).map(roleOf),
      })),
      deploys: deploys as Deploy[],
      now: new Date().toISOString(),
    }
  }

  async overview(q: QueryString) {
    const c = parseCommon(q)
    const w = scopedMinutes(c)
    const p = { ...w.params, ...seriesParams(c) }
    const errorSpark = sparkFor(c)
    const minutes = Math.max(1, (c.toMs - c.fromMs) / 60_000)

    // 4xx per route from http.request lines (route_stats_1m counts only 5xx / ERROR).
    const http4xx = scoped(c).add(`event_code = 'http.request' AND http_status >= 400 AND http_status < 500`)

    const [services, spark, series, routes, clientErrors, errorGroups, dependencies, jobs] = await Promise.all([
      this.reader.rows<RedDb & { service: string; role: string; kind: string }>(
        'overview.services',
        `SELECT service, role, sum(requests) AS requests, sum(errors) AS errors, ${QUANTILES} AS q,
                anyHeavy(kind) AS kind
         FROM skilllane_monitoring.route_stats_1m WHERE ${w.sql}
         GROUP BY service, role ORDER BY requests DESC`,
        p,
      ),
      this.reader.rows<{ service: string; role: string; t: number; requests: number }>(
        'overview.spark',
        `SELECT service, role, ${bucketExpr('minute')} AS t, sum(requests) AS requests
         FROM skilllane_monitoring.route_stats_1m WHERE ${w.sql}
         GROUP BY service, role, t`,
        p,
      ),
      this.reader.rows<RedDb & { t: number }>(
        'overview.series',
        `SELECT ${bucketExpr('minute')} AS t, sum(requests) AS requests, sum(errors) AS errors, ${QUANTILES} AS q
         FROM skilllane_monitoring.route_stats_1m WHERE ${w.sql}
         GROUP BY t ORDER BY t`,
        p,
      ),
      this.reader.rows<RedDb & { service: string; role: string; kind: string; route: string; duration_sum_ms: number }>(
        'overview.routes',
        `SELECT service, role, kind, route, sum(requests) AS requests, sum(errors) AS errors,
                sum(duration_sum_ms) AS duration_sum_ms, ${QUANTILES} AS q
         FROM skilllane_monitoring.route_stats_1m WHERE ${w.sql}
         GROUP BY service, role, kind, route ORDER BY requests DESC LIMIT 20`,
        p,
      ),
      this.reader.rows<{ service: string; role: string; route: string; count: number }>(
        'overview.4xx',
        `SELECT service, role, concat(http_method, ' ', http_route) AS route, count() AS count
         FROM skilllane_monitoring.logs WHERE ${http4xx.sql}
         GROUP BY service, role, route`,
        http4xx.params,
      ),
      this.errors.groups(c, { limit: 8, spark: errorSpark }),
      this.ops.dependencyStates(c),
      this.ops.jobStats(c),
    ])

    const clientBy = new Map(clientErrors.map((r) => [`${r.service}\u0000${r.role}\u0000${r.route}`, r.count]))
    const bucketList = buckets(c)
    const sparkBy = new Map<string, Map<number, number>>()
    for (const s of spark) {
      const key = `${s.service}\u0000${s.role}`
      const m = sparkBy.get(key) ?? new Map<number, number>()
      m.set(Number(s.t), s.requests)
      sparkBy.set(key, m)
    }

    return {
      range: { from: new Date(c.fromMs).toISOString(), to: new Date(c.toMs).toISOString(), stepSeconds: c.stepSeconds },
      services: services.map((s) => {
        const m = sparkBy.get(`${s.service}\u0000${s.role}`)
        return {
          service: s.service,
          role: s.role,
          kind: s.kind,
          requests: s.requests,
          errors: s.errors,
          errorRate: ratio(s.errors, s.requests),
          p95Ms: num(s.q[1], 1),
          rpm: num(s.requests / minutes, 2),
          spark: bucketList.map((t) => m?.get(t) ?? 0),
        }
      }),
      series: fillSeries(
        c,
        series.map((s) => ({ t: s.t, requests: s.requests, errors: s.errors, p95Ms: num(s.q[1], 1) })),
        () => ({ requests: 0, errors: 0, p95Ms: 0 }),
      ),
      routes: routes.map((r) => {
        const client = clientBy.get(`${r.service}\u0000${r.role}\u0000${r.route}`) ?? 0
        return {
          service: r.service,
          role: r.role,
          kind: r.kind,
          /** `METHOD /path` for HTTP, the span name (`report report:generate`) otherwise. */
          route: r.route,
          ...splitRoute(r.route),
          requests: r.requests,
          errors: r.errors,
          errorRate: ratio(r.errors, r.requests),
          avgMs: r.requests ? num(r.duration_sum_ms / r.requests, 1) : 0,
          p50Ms: num(r.q[0], 1),
          p95Ms: num(r.q[1], 1),
          p99Ms: num(r.q[2], 1),
          /** 4xx responses (from http.request log lines); not counted in errors. */
          clientErrors: client,
          clientErrorRate: ratio(client, r.requests),
        }
      }),
      errorGroups: errorGroups as ErrorGroup[],
      /** Buckets of errorGroups[].spark. */
      errorGroupsSpark: { from: errorSpark.from, stepSeconds: errorSpark.stepSeconds, buckets: errorSpark.buckets },
      dependencies: dependencies as Dependency[],
      jobs: jobs as JobStat[],
    }
  }
}
