import { Module } from '@nestjs/common'
import { ErrorsService } from './errors.service'
import { LogsService } from './logs.service'
import { OpsService } from './ops.service'
import { OverviewService } from './overview.service'
import { QueryController } from './query.controller'
import { ReleasesService } from './releases.service'
import { Reader } from './sql'
import { TopologyService } from './topology.service'
import { TracesService } from './traces.service'

/**
 * Query API under /api (SPEC.md section 8), read with ClickhouseService.reader
 * (read-only user). Loaded when ENGINE_ROLE is `api` or `all`.
 */
@Module({
  controllers: [QueryController],
  providers: [Reader, ReleasesService, LogsService, TracesService, ErrorsService, OpsService, OverviewService, TopologyService],
})
export class QueryModule {}
