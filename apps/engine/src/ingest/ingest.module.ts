import { Module } from '@nestjs/common'
import { ClickhouseWriter } from './clickhouse-writer'
import { EnvelopeHandler } from './envelope-handler'
import { HttpIngestController } from './http-ingest.controller'
import { IngestService } from './ingest.service'
import { IngestStats } from './ingest.stats'

/**
 * Ingest: subscribe to the queue picked by LOG_EXPORT and write ClickHouse
 * (SPEC.md section 8); apps without a queue POST to /api/ingest/<stream>
 * instead (ENGINE_INGEST_TOKEN). Loaded when ENGINE_ROLE is `ingest` or `all`.
 * Consumers start in onApplicationBootstrap, after ClickhouseModule applied
 * the schema in onModuleInit.
 */
@Module({
  controllers: [HttpIngestController],
  providers: [IngestStats, ClickhouseWriter, EnvelopeHandler, IngestService],
  exports: [IngestService],
})
export class IngestModule {}
