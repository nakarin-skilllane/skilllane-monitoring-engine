import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { QueryModule } from '../query/query.module'
import { FeatureStore } from './feature-store'
import { ReportBuilder } from './report-builder'
import { ReportQueries } from './report-queries'
import { ReportScheduler } from './report-scheduler'
import { ReportStore } from './report-store'
import { ReportsController } from './reports.controller'
import { ReportsService } from './reports.service'
import { UsageBackfill } from './usage-backfill'

/** Daily report (roles api / all): snapshots, the 09:00 @Cron, /api/reports/daily*. */
@Module({
  imports: [ScheduleModule.forRoot(), QueryModule],
  controllers: [ReportsController],
  providers: [ReportQueries, ReportBuilder, ReportStore, FeatureStore, ReportsService, ReportScheduler, UsageBackfill],
})
export class ReportsModule {}
