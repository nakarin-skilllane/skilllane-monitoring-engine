import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { HealthController } from '../common/health.controller'
import { EtlController } from './etl.controller'

/** school-etl-api, role api (:5102). */
@Module({
  controllers: [HealthController, EtlController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class EtlApiModule {}
