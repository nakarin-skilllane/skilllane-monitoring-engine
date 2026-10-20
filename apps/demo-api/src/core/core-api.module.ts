import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { BullModule } from '@nestjs/bullmq'
import { CqrsModule } from '@nestjs/cqrs'
import { redisConnection } from '../config'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import { DemoUserMiddleware } from '../common/demo-user.middleware'
import { HealthController } from '../common/health.controller'
import { CacheService } from '../infra/cache.service'
import { FakeTypeormSchema } from '../infra/fake-schema'
import { OracleClient } from '../infra/oracle'
import { AuthController } from './auth.controller'
import { ClassesController } from './classes.controller'
import { ClassroomRepository, GetClassReportHandler } from './classes.handlers'
import { ExamsController } from './exams.controller'
import { MeController } from './me.controller'
import { QuestionBankController } from './question-bank.controller'
import { GetMyQuestionsHandler, ImportQuestionBankHandler } from './question-bank.handlers'
import { REPORT_QUEUE, ReportsController } from './reports.controller'

const controllers = [
  QuestionBankController,
  ClassesController,
  ExamsController,
  ReportsController,
  MeController,
  AuthController,
]

/** school-core-api, role api (:5101). */
@Module({
  imports: [
    CqrsModule.forRoot(),
    BullModule.forRoot({ connection: redisConnection() }),
    BullModule.registerQueue({ name: REPORT_QUEUE }),
  ],
  controllers: [HealthController, ...controllers],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    FakeTypeormSchema,
    OracleClient,
    CacheService,
    ClassroomRepository,
    GetMyQuestionsHandler,
    ImportQuestionBankHandler,
    GetClassReportHandler,
  ],
})
export class CoreApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DemoUserMiddleware).forRoutes(...controllers)
  }
}
