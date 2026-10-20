import { type DynamicModule, Module, type Type } from '@nestjs/common'
import { AuthModule } from './auth/auth.module'
import { ClickhouseModule } from './clickhouse/clickhouse.module'
import { config } from './config'
import { HealthController } from './health.controller'
import { IngestModule } from './ingest/ingest.module'
import { QueryModule } from './query/query.module'

/** ENGINE_ROLE: ingest → IngestModule, api → QueryModule + AuthModule (sessions on every route), all → both. */
const roleModules: Array<Type | DynamicModule> = [
  ...(config.role === 'ingest' || config.role === 'all' ? [IngestModule] : []),
  ...(config.role === 'api' || config.role === 'all' ? [AuthModule, QueryModule] : []),
]

@Module({
  imports: [ClickhouseModule, ...roleModules],
  controllers: [HealthController],
})
export class AppModule {}
