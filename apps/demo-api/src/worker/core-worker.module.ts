import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { redisConnection } from '../config'
import { FakeTypeormSchema } from '../infra/fake-schema'
import { GoogleSheetsClient } from '../infra/google-sheets'
import { OracleClient } from '../infra/oracle'
import { REPORT_QUEUE } from '../core/reports.controller'
import { ReportProcessor } from './report.processor'

/** school-core-api, role worker: processes the "report" queue. No HTTP. */
@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection() }),
    BullModule.registerQueue({ name: REPORT_QUEUE }),
  ],
  providers: [FakeTypeormSchema, OracleClient, GoogleSheetsClient, ReportProcessor],
})
export class CoreWorkerModule {}
