import { Module } from '@nestjs/common'
import { ErrorsService } from './errors.service'
import { LogsService } from './logs.service'
import { OpsService } from './ops.service'
import { OverviewService } from './overview.service'
import { queryCacheProvider } from './query-cache'
import { QueryController } from './query.controller'
import { ReleasesService } from './releases.service'
import { Reader } from './sql'
import { TopologyService } from './topology.service'
import { TracesService } from './traces.service'

/**
 * Query API under /api (SPEC.md section 8), read with ClickhouseService.reader
 * (read-only user). Loaded when ENGINE_ROLE is `api` or `all`. Results are
 * kept ENGINE_QUERY_CACHE_MS per path + params + permission scope (query-cache.ts).
 */
@Module({
  controllers: [QueryController],
  providers: [
    Reader,
    ReleasesService,
    LogsService,
    TracesService,
    ErrorsService,
    OpsService,
    OverviewService,
    TopologyService,
    // The interceptor itself is made by @UseInterceptors on the controller (listing it here too made a
    // second instance with its own stats timer).
    queryCacheProvider,
  ],
  exports: [Reader, ReleasesService],
})
export class QueryModule {}
