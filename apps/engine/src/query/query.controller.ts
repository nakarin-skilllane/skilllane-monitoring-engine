import { Controller, Get, Param, Query, Req } from '@nestjs/common'
import { type AuthedRequest, RequirePermission, viewableEnvs } from '../auth/auth.guard'
import { ErrorsService } from './errors.service'
import { LogsService } from './logs.service'
import { OpsService } from './ops.service'
import { OverviewService } from './overview.service'
import type { QueryString } from './params'
import { TopologyService } from './topology.service'
import { TracesService } from './traces.service'

/**
 * Query API (SPEC.md section 8). JSON, camelCase, times ISO UTC.
 * Common params: env, from, to (ISO or now-15m|now-1h|now-6h|now-24h|now-7d), service, role,
 * step (series bucket: 900 or 1m|5m|15m|1h; buckets start at `from` rounded down to the minute).
 * errorRate values are ratios (0.0042 = 0.42 %). Bad input → 400 with a message.
 * Every route needs a session (AuthGuard); each reads with one permission, and
 * a permission limited to some envs needs `env` set to one of them.
 */
@Controller('api')
export class QueryController {
  constructor(
    private readonly overviewService: OverviewService,
    private readonly logsService: LogsService,
    private readonly tracesService: TracesService,
    private readonly errorsService: ErrorsService,
    private readonly opsService: OpsService,
    private readonly topologyService: TopologyService,
  ) {}

  /** Any signed-in user; envs the user cannot read with any permission are left out. */
  @Get('meta')
  async meta(@Query() q: QueryString, @Req() req: AuthedRequest) {
    const meta = await this.overviewService.meta(q)
    const allowed = req.principal ? viewableEnvs(req.principal.effective) : 'all'
    if (allowed === 'all') return { ...meta, envsLimited: false }
    const keep = (env: string) => allowed.includes(env)
    return {
      ...meta,
      /** The user reads only these envs, one at a time: the monitor has no "every env" for them. */
      envsLimited: true,
      envs: meta.envs.filter(keep),
      services: meta.services
        .map((s) => ({ ...s, envs: s.envs.filter(keep) }))
        .filter((s) => s.envs.length > 0),
      releases: meta.releases.filter((r) => keep(r.env)),
      deploys: meta.deploys.filter((d) => keep(d.env)),
    }
  }

  @RequirePermission('overview')
  @Get('overview')
  overview(@Query() q: QueryString) {
    return this.overviewService.overview(q)
  }

  @RequirePermission('logs')
  @Get('logs')
  logs(@Query() q: QueryString) {
    return this.logsService.search(q)
  }

  @RequirePermission('traces')
  @Get('traces')
  traces(@Query() q: QueryString) {
    return this.tracesService.list(q)
  }

  @RequirePermission('traces')
  @Get('traces/:traceId')
  trace(@Param('traceId') traceId: string, @Query() q: QueryString) {
    return this.tracesService.detail(traceId, q)
  }

  /** One span with its captured request / response, SQL and message (the trace's Network panel). */
  @RequirePermission('traces')
  @Get('traces/:traceId/spans/:spanId')
  span(@Param('traceId') traceId: string, @Param('spanId') spanId: string, @Query() q: QueryString) {
    return this.tracesService.span(traceId, spanId, q)
  }

  @RequirePermission('errors')
  @Get('errors')
  errors(@Query() q: QueryString) {
    return this.errorsService.list(q)
  }

  @RequirePermission('errors')
  @Get('errors/:fingerprint')
  error(@Param('fingerprint') fingerprint: string, @Query() q: QueryString) {
    return this.errorsService.detail(fingerprint, q)
  }

  @RequirePermission('jobs')
  @Get('jobs')
  jobs(@Query() q: QueryString) {
    return this.opsService.jobs(q)
  }

  @RequirePermission('jobs')
  @Get('dependencies')
  dependencies(@Query() q: QueryString) {
    return this.opsService.dependencies(q)
  }

  /** System map: nodes (clients, services, queues, dependencies) and edges with calls/min and error rate. */
  @RequirePermission('topology')
  @Get('topology')
  topology(@Query() q: QueryString) {
    return this.topologyService.topology(q)
  }
}
