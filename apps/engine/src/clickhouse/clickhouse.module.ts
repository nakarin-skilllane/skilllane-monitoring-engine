import { Global, Module } from '@nestjs/common'
import { ClickhouseService } from './clickhouse.service'

/** Global: inject ClickhouseService anywhere (writer / reader clients). */
@Global()
@Module({
  providers: [ClickhouseService],
  exports: [ClickhouseService],
})
export class ClickhouseModule {}
