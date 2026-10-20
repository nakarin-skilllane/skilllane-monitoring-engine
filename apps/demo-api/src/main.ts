import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { config } from './config'
import { CoreApiModule } from './core/core-api.module'
import { EtlApiModule } from './etl/etl-api.module'
import { CoreWorkerModule } from './worker/core-worker.module'

/**
 * No logging code here: skilllane-monitoring is loaded with
 * NODE_OPTIONS="--require skilllane-monitoring/register" and configured by env.
 */
async function bootstrap(): Promise<void> {
  if (config.service === 'etl') {
    const app = await NestFactory.create(EtlApiModule)
    await app.listen(config.port)
  } else if (config.role === 'worker') {
    // The BullMQ worker starts with the module; the context keeps it running.
    await NestFactory.createApplicationContext(CoreWorkerModule)
  } else {
    const app = await NestFactory.create<NestExpressApplication>(CoreApiModule)
    // Question-bank imports send whole sheets as JSON.
    app.useBodyParser('json', { limit: '2mb' })
    await app.listen(config.port)
  }
}

// The boot failure is already logged (app.boot_failed) and flushed.
bootstrap().catch(() => process.exit(1))
