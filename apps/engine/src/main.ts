import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
// config first: it loads .env before any module reads it.
import { config, dotEnvFile } from './config'
import { AppModule } from './app.module'

/**
 * The engine logs to stdout only (Nest's logger). It never sends its own
 * telemetry to the queue: that would loop back into ingest.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Engine')
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false })
  // HTTP ingest bodies are whole envelopes; gzip is undone before the limit applies.
  app.useBodyParser('json', { limit: config.ingest.maxBytes })
  // No global prefix: controllers declare `api/...` themselves.
  app.enableCors({ origin: config.corsOrigin })
  app.enableShutdownHooks()
  await app.listen(config.port)
  logger.log(
    `skilllane-monitoring engine listening on :${config.port} role=${config.role} transport=${config.transport}` +
      (config.transportInvalid ? ` (ignored LOG_EXPORT=${config.transportInvalid})` : '') +
      (config.ingest.enabled && config.role !== 'api'
        ? ` http-ingest=on${config.ingest.tokens.length ? ' (token)' : ''}`
        : '') +
      (dotEnvFile ? ` env=${dotEnvFile}` : ''),
  )
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('skilllane-monitoring engine failed to start', err)
  process.exit(1)
})
