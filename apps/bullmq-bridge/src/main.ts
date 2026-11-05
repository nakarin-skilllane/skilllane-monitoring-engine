import { Bridge } from './bridge'
import { loadConfig, loadDotEnv } from './config'
import { Forwarder } from './forwarder'
import { createHealthServer } from './health'
import { IngestClient } from './ingest-client'
import { Logger, errorMessage } from './log'
import { BridgeStats } from './stats'

const STATS_EVERY_MS = 30_000

/**
 * skilllane-monitoring BullMQ bridge: the engine's BullMQ consumer as its own
 * process, forwarding every job to the ingest service over HTTP. Order at
 * start: health server (so the container can be probed while Redis is still
 * coming up), then the workers. SIGTERM: workers close (active jobs finish),
 * queues close, Redis quits, exit 0.
 */
async function main(): Promise<void> {
  const logger = new Logger('BullmqBridge')
  const dotEnvFile = loadDotEnv()
  const config = loadConfig()
  if (!config.redisUrl) throw new Error('LOG_BULLMQ_REDIS_URL is empty')

  const stats = new BridgeStats()
  const client = new IngestClient({ url: config.ingestUrl, token: config.token })
  const bridge = new Bridge(config, new Forwarder(client, stats))

  const health = createHealthServer({
    redis: () => bridge.ping(),
    ingest: (timeoutMs) => client.healthy(timeoutMs),
    pending: () => bridge.pending(),
  })
  await new Promise<void>((resolve, reject) => {
    health.once('error', reject)
    health.listen(config.port, () => {
      health.off('error', reject)
      resolve()
    })
  })
  logger.log(
    `skilllane-monitoring bullmq-bridge listening on :${config.port} ingest=${config.ingestUrl}${config.token ? ' (token)' : ''}` +
      (dotEnvFile ? ` env=${dotEnvFile}` : ''),
  )

  const statsTimer = setInterval(() => void logStats(), STATS_EVERY_MS)
  statsTimer.unref()
  async function logStats(withLag = true): Promise<void> {
    const lag = withLag ? await bridge.lag().catch(() => undefined) : undefined
    logger.log(stats.line(lag))
  }

  let stopping = false
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(statsTimer)
    logger.log(`Stopping (${signal})`)
    try {
      await bridge.stop()
      await new Promise<void>((resolve) => health.close(() => resolve()))
      client.close()
      await logStats(false)
      logger.log('Stopped')
      process.exit(0)
    } catch (err) {
      logger.error(`Stop failed: ${errorMessage(err)}`)
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))

  // ping() blocks until Redis answers (maxRetriesPerRequest: null), so health already serves.
  await bridge.start()
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('skilllane-monitoring bullmq-bridge failed to start', err)
  process.exit(1)
})
