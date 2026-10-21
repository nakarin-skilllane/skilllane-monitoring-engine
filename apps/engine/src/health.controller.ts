import { Controller, Get, Optional } from '@nestjs/common'
import { Public } from './auth/auth.guard'
import { resolveExportMode } from 'skilllane-monitoring/contract'
import { ClickhouseService } from './clickhouse/clickhouse.service'
import { config } from './config'
import { IngestService } from './ingest/ingest.service'

interface Health {
  ok: boolean
  clickhouse: boolean
  role: string
  transport: string
  /** Messages not yet in ClickHouse (0 = drained); null without ingest, when unreadable or slower than PENDING_TIMEOUT_MS. */
  pending: number | null
}

/** Health answers within 1 s even while the broker hangs (pending is then null). */
const PENDING_TIMEOUT_MS = 700
const PING_TIMEOUT_MS = 800

/** `promise`, or `fallback` after `ms`; never rejects. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/**
 * GET /api/health → { ok, clickhouse, role, transport, pending }.
 * No global prefix is set: every controller names its full `api/...` path.
 */
@Controller('api')
export class HealthController {
  // One broker read at a time: polls during an outage share the call in flight.
  private pendingCall?: Promise<number | undefined>

  constructor(
    private readonly clickhouse: ClickhouseService,
    @Optional() private readonly ingest?: IngestService,
  ) {}

  private pending(): Promise<number | undefined> {
    if (!this.ingest) return Promise.resolve(undefined)
    this.pendingCall ??= this.ingest
      .pending()
      .catch(() => undefined)
      .finally(() => {
        this.pendingCall = undefined
      })
    return this.pendingCall
  }

  @Public()
  @Get('health')
  async health(): Promise<Health> {
    const [clickhouse, pending] = await Promise.all([
      within(this.clickhouse.ping(), PING_TIMEOUT_MS, false),
      within(this.pending(), PENDING_TIMEOUT_MS, undefined),
    ])
    return {
      ok: clickhouse && !this.clickhouse.schemaResult?.error,
      clickhouse,
      role: config.role,
      transport: resolveExportMode().mode,
      pending: pending ?? null,
    }
  }
}
