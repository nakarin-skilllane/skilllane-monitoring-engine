import http from 'node:http'
import { within } from './log'

export interface Health {
  ok: boolean
  /** Redis answered PING. */
  redis: boolean
  /** The ingest's GET /api/health answered ok. */
  ingest: boolean
  /** Jobs not yet accepted by the ingest (wait + active + prioritized + delayed); null when Redis is unreadable or slow. */
  pending: number | null
}

export interface HealthProbes {
  redis(): Promise<boolean>
  ingest(timeoutMs: number): Promise<boolean>
  pending(): Promise<number | undefined>
}

/** Health answers within 1 s even while Redis or the ingest hangs (pending is then null). */
const PENDING_TIMEOUT_MS = 700
const PING_TIMEOUT_MS = 800

export async function probeHealth(probes: HealthProbes): Promise<Health> {
  const [redis, ingest, pending] = await Promise.all([
    within(probes.redis(), PING_TIMEOUT_MS, false),
    within(probes.ingest(PING_TIMEOUT_MS), PING_TIMEOUT_MS, false),
    within(probes.pending(), PENDING_TIMEOUT_MS, undefined),
  ])
  return { ok: redis && ingest, redis, ingest, pending: pending ?? null }
}

/**
 * GET /api/health → { ok, redis, ingest, pending }; 200 when ok, 503 otherwise
 * (so the container HEALTHCHECK reflects it). Anything else is 404.
 */
export function createHealthServer(probes: HealthProbes): http.Server {
  // One probe at a time: polls during an outage share the call in flight.
  let inflight: Promise<Health> | undefined
  return http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'GET' || path !== '/api/health') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"statusCode":404,"message":"not found"}')
      return
    }
    inflight ??= probeHealth(probes).finally(() => {
      inflight = undefined
    })
    inflight.then(
      (health) => {
        res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' })
        res.end(JSON.stringify(health))
      },
      () => {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, redis: false, ingest: false, pending: null }))
      },
    )
  })
}
