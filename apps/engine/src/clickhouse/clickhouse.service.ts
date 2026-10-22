import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common'
import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { config } from '../config'
import { readSchema } from './schema'

/** Tables whose old parts go to cold storage. */
export const COLD_TABLES = ['logs', 'spans'] as const

/**
 * Two ClickHouse clients:
 * - `writer` (CLICKHOUSE_USER): inserts and schema. Inserts use JSONEachRow;
 *   `date_time_input_format=best_effort` is set on the client.
 * - `reader` (CLICKHOUSE_READER_USER, readonly): every query API call.
 * The schema is applied on module init unless ENGINE_APPLY_SCHEMA=false.
 */
@Injectable()
export class ClickhouseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ClickHouse')
  readonly database = config.clickhouse.database

  readonly writer: ClickHouseClient = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
    database: config.clickhouse.database,
    application: 'skilllane-monitoring-engine',
    request_timeout: 60_000,
    compression: { request: true, response: true },
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
      async_insert: 0,
    },
  })

  readonly reader: ClickHouseClient = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.readerUser,
    password: config.clickhouse.readerPassword,
    database: config.clickhouse.database,
    application: 'skilllane-monitoring-engine-query',
    request_timeout: 30_000,
  })

  /** Last result of applySchema(); undefined when skipped. */
  schemaResult?: { file: string; statements: number; error?: string }

  async onModuleInit(): Promise<void> {
    await this.waitUntilReachable()
    if (!config.applySchema) {
      this.logger.log('ENGINE_APPLY_SCHEMA=false: schema not applied')
      return
    }
    try {
      await this.applySchema()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.schemaResult = { ...(this.schemaResult ?? { file: '', statements: 0 }), error: message }
      this.logger.error(`Schema apply failed: ${message}`)
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.writer.close(), this.reader.close()])
  }

  /** True when ClickHouse answers a ping as the writer. */
  async ping(): Promise<boolean> {
    try {
      const result = await this.writer.ping()
      return result.success
    } catch {
      return false
    }
  }

  /**
   * Runs every statement of clickhouse/schema.sql (idempotent DDL). Uses a
   * client without a default database so CREATE DATABASE works on an empty server.
   */
  async applySchema(): Promise<void> {
    const { file, statements } = readSchema(config.schemaFile, config.clickhouse.database)
    this.schemaResult = { file, statements: statements.length }
    const admin = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      application: 'skilllane-monitoring-engine-schema',
    })
    try {
      for (const query of statements) {
        await admin.command({ query })
      }
      this.logger.log(`Schema applied: ${statements.length} statements from ${file}`)
      await this.applyColdStorage(admin)
    } finally {
      await admin.close()
    }
  }

  /**
   * CLICKHOUSE_COLD_STORAGE_POLICY: logs and spans get the storage policy. No move TTL: with one,
   * an insert of rows already past it writes straight to S3 and fails while the bucket is
   * missing. ColdStorageMover moves the old parts instead.
   */
  private async applyColdStorage(admin: ClickHouseClient): Promise<void> {
    const cold = config.clickhouse.coldStorage
    if (!cold) return
    if (!/^\w+$/.test(cold.policy)) throw new Error('CLICKHOUSE_COLD_STORAGE_POLICY must be a plain name')
    const db = this.database
    for (const table of COLD_TABLES) {
      const result = await admin.query({
        query: 'SELECT storage_policy FROM system.tables WHERE database = {db:String} AND name = {table:String}',
        query_params: { db, table },
        format: 'JSONEachRow',
      })
      const [current] = await result.json<{ storage_policy: string }>()
      if (!current || current.storage_policy === cold.policy) continue
      await admin.command({ query: `ALTER TABLE ${db}.${table} MODIFY SETTING storage_policy = '${cold.policy}'` })
      this.logger.log(`${db}.${table}: storage policy ${current.storage_policy} → ${cold.policy}`)
    }
  }

  /** Waits up to ~30 s for ClickHouse (it may still be starting with the compose stack). */
  private async waitUntilReachable(): Promise<void> {
    for (let attempt = 1; attempt <= 15; attempt++) {
      if (await this.ping()) return
      if (attempt === 1) this.logger.warn(`ClickHouse not reachable at ${config.clickhouse.url}; retrying`)
      await new Promise((r) => setTimeout(r, 2000))
    }
    this.logger.error(`ClickHouse still not reachable at ${config.clickhouse.url}; continuing without it`)
  }
}
