import { Global, Module } from '@nestjs/common'
import { ClickhouseService } from './clickhouse.service'
import { ColdStorageMover } from './cold-storage'

/** Global: inject ClickhouseService anywhere (writer / reader clients). */
@Global()
@Module({
  providers: [ClickhouseService, ColdStorageMover],
  exports: [ClickhouseService],
})
export class ClickhouseModule {}
