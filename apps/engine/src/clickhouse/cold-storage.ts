import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { config } from '../config'
import { ClickhouseService, COLD_TABLES } from './clickhouse.service'

const FIRST_RUN_MS = 60_000
const EVERY_MS = 60 * 60_000

/**
 * CLICKHOUSE_COLD_STORAGE_POLICY: once an hour, every logs / spans part of a day older than
 * CLICKHOUSE_COLD_AFTER_DAYS that is not on CLICKHOUSE_COLD_VOLUME yet moves there (S3).
 * A move that fails (bucket missing, S3 down) leaves the part on the local disk and is tried
 * again next hour; one warning per run. Runs on the instance that applies the schema.
 */
@Injectable()
export class ColdStorageMover implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ColdStorage')
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly clickhouse: ClickhouseService) {}

  onApplicationBootstrap(): void {
    const cold = config.clickhouse.coldStorage
    if (!cold || !config.applySchema) return
    this.logger.log(`parts older than ${cold.afterDays} days move to volume ${cold.volume} (policy ${cold.policy}), hourly`)
    this.timer = setTimeout(() => this.tick(), FIRST_RUN_MS)
    this.timer.unref()
  }

  onApplicationShutdown(): void {
    clearTimeout(this.timer)
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      this.running = true
      try {
        await this.moveOldParts()
      } catch (err) {
        this.logger.warn(`cold storage run failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.running = false
      }
    }
    this.timer = setTimeout(() => this.tick(), EVERY_MS)
    this.timer.unref()
  }

  async moveOldParts(): Promise<{ moved: number; failed: number }> {
    const cold = config.clickhouse.coldStorage!
    const db = this.clickhouse.database
    const result = await this.clickhouse.writer.query({
      query: `SELECT table, name FROM system.parts
        WHERE database = {db:String} AND table IN ({tables:Array(String)}) AND active
          AND toDateOrNull(partition) < today() - {days:UInt32}
          AND disk_name NOT IN (
            SELECT arrayJoin(disks) FROM system.storage_policies
            WHERE policy_name = {policy:String} AND volume_name = {volume:String})
        ORDER BY partition`,
      query_params: { db, tables: [...COLD_TABLES], days: cold.afterDays, policy: cold.policy, volume: cold.volume },
      format: 'JSONEachRow',
    })
    const parts = await result.json<{ table: string; name: string }>()
    // ALTER ... MOVE PART takes no query parameters: names go in as literals, checked.
    if (!/^\w+$/.test(cold.volume)) throw new Error('CLICKHOUSE_COLD_VOLUME must be a plain name')
    let moved = 0
    for (const part of parts) {
      if (!/^\w+$/.test(part.name)) continue
      try {
        await this.clickhouse.writer.command({
          query: `ALTER TABLE ${db}.${part.table} MOVE PART '${part.name}' TO VOLUME '${cold.volume}'`,
        })
        moved += 1
      } catch (err) {
        // S3 down or the bucket missing fails every part alike: stop until the next run.
        const message = err instanceof Error ? err.message : String(err)
        this.logger.warn(
          `${parts.length - moved} parts not moved to volume ${cold.volume}, kept on the local disk; retry in an hour: ${message}`,
        )
        break
      }
    }
    if (moved) this.logger.log(`moved ${moved} parts to volume ${cold.volume}`)
    return { moved, failed: parts.length - moved }
  }
}
