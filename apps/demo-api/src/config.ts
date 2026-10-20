/**
 * Demo settings. One codebase runs as three processes:
 *   DEMO_SERVICE=core APP_ROLE=api     school-core-api, HTTP :5101
 *   DEMO_SERVICE=core APP_ROLE=worker  school-core-api, BullMQ worker (no HTTP)
 *   DEMO_SERVICE=etl  APP_ROLE=api     school-etl-api, HTTP :5102
 * Logging is configured by skilllane-monitoring from env alone (NODE_OPTIONS).
 */

function text(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value ? value : fallback
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return process.env[name]?.trim() && Number.isFinite(value) ? value : fallback
}

const service = text('DEMO_SERVICE', 'core') === 'etl' ? 'etl' : 'core'
const role = text('APP_ROLE', 'api') === 'worker' ? 'worker' : 'api'

export const config = {
  service: service as 'core' | 'etl',
  role: role as 'api' | 'worker',
  port: num('DEMO_PORT', service === 'etl' ? 5102 : 5101),
  /** school-etl-api, called by the import command. */
  etlUrl: text('DEMO_ETL_URL', 'http://localhost:5102'),
  /** The app's own Redis: cache + business queue "report" (not telemetry). */
  redisUrl: text('DEMO_REDIS_URL', 'redis://localhost:6391'),
  /** Share of imports that fail with ORA-12899 (SPEC: 25%). */
  importFailRate: num('DEMO_IMPORT_FAIL_RATE', 0.25),
  /** Share of report attempts that fail with a Google 429 (SPEC: 30%). */
  reportFailRate: num('DEMO_REPORT_FAIL_RATE', 0.3),
  reportAttempts: 3,
}

export function redisConnection(): { host: string; port: number; db: number } {
  const url = new URL(config.redisUrl)
  return {
    host: url.hostname || 'localhost',
    port: Number(url.port || 6379),
    db: Number(url.pathname.replace('/', '') || 0),
  }
}
