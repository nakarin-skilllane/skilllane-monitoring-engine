import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import { config } from '../config'
import { featureName } from './feature-names'
import type { RankedGroup } from './features'
import type { ReportFeature } from './types'

interface FeatureRow {
  feature_id: string
  name: string
  name_source: string
  since: string
  active: number
}

/**
 * CLICKHOUSE_CONFIG_DATABASE.features_auto: the main features of each env as of its latest report
 * (writer user, ReplacingMergeTree, FINAL). The report payload does not read it; it keeps when a
 * feature joined and its routes for the AI layer, which writes names back here (name_source = ai).
 */
@Injectable()
export class FeatureStore implements OnModuleInit {
  private readonly logger = new Logger('FeatureStore')
  private readonly db = config.auth.database

  constructor(private readonly clickhouse: ClickhouseService) {}

  async onModuleInit(): Promise<void> {
    if (!config.applySchema) return
    try {
      await this.clickhouse.writer.command({ query: `CREATE DATABASE IF NOT EXISTS ${this.db}` })
      await this.clickhouse.writer.command({
        query: `CREATE TABLE IF NOT EXISTS ${this.db}.features_auto (
          env         LowCardinality(String),
          feature_id  String,
          name        String,
          name_source LowCardinality(String),
          routes      Array(String),
          score       Float64,
          since       Date,
          reason      String,
          active      UInt8,
          updated_at  DateTime64(3, 'UTC')
        ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (env, feature_id)`,
      })
    } catch (err) {
      this.logger.error(`features_auto schema apply failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The list of the latest report: members keep their `since`; those that left get active = 0. */
  async save(env: string, reportDate: string, groups: RankedGroup[], features: ReportFeature[]): Promise<void> {
    const result = await this.clickhouse.writer.query({
      query: `SELECT feature_id, name, name_source, toString(since) AS since, active FROM ${this.db}.features_auto FINAL WHERE env = {env:String}`,
      query_params: { env },
      format: 'JSONEachRow',
    })
    const before = new Map((await result.json<FeatureRow>()).map((r) => [r.feature_id, r]))
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
    const names = new Map(features.map((f) => [f.featureId, f.name]))
    const rows = groups.map((g) => {
      const old = before.get(g.featureId)
      const dict = featureName(g.resource)
      // the dictionary wins; else a name the AI gave earlier stays
      const keepAi = dict.source !== 'dict' && old?.name_source === 'ai'
      return {
        env,
        feature_id: g.featureId,
        name: keepAi ? old.name : dict.source === 'dict' ? (names.get(g.featureId) ?? dict.name) : dict.name,
        name_source: keepAi ? 'ai' : dict.source,
        routes: g.routes,
        score: g.score,
        since: old && Number(old.active) ? old.since : reportDate,
        reason: `อันดับ ${Number.isFinite(g.rank) ? g.rank : '–'} · คะแนน ${g.score} (${reportDate})`,
        active: 1,
        updated_at: now,
      }
    })
    const left = [...before.values()]
      .filter((r) => Number(r.active) && !groups.some((g) => g.featureId === r.feature_id))
      .map((r) => ({ env, feature_id: r.feature_id, active: 0, reason: `หลุดรายการ (${reportDate})`, since: r.since, updated_at: now }))
    if (!rows.length && !left.length) return
    // a left row keeps its other columns only through this insert: read them back with the row
    const keep = left.length
      ? await (
          await this.clickhouse.writer.query({
            query: `SELECT feature_id, name, name_source, routes, score FROM ${this.db}.features_auto FINAL
                    WHERE env = {env:String} AND feature_id IN {ids:Array(String)}`,
            query_params: { env, ids: left.map((r) => r.feature_id) },
            format: 'JSONEachRow',
          })
        ).json<{ feature_id: string; name: string; name_source: string; routes: string[]; score: number }>()
      : []
    const keepBy = new Map(keep.map((k) => [k.feature_id, k]))
    await this.clickhouse.writer.insert({
      table: `${this.db}.features_auto`,
      format: 'JSONEachRow',
      values: [...rows, ...left.map((r) => ({ ...keepBy.get(r.feature_id), ...r }))],
    })
  }

  /** Names the AI gave (name_source = ai), featureId → name. */
  async aiNames(env: string): Promise<Record<string, string>> {
    const result = await this.clickhouse.writer.query({
      query: `SELECT feature_id, name FROM ${this.db}.features_auto FINAL WHERE env = {env:String} AND name_source = 'ai'`,
      query_params: { env },
      format: 'JSONEachRow',
    })
    return Object.fromEntries((await result.json<{ feature_id: string; name: string }>()).map((r) => [r.feature_id, r.name]))
  }

  /** Keeps the AI's names of features (only rows that exist). */
  async setNames(env: string, names: Record<string, string>): Promise<void> {
    const ids = Object.keys(names)
    if (!ids.length) return
    const result = await this.clickhouse.writer.query({
      query: `SELECT env, feature_id, routes, score, toString(since) AS since, reason, active FROM ${this.db}.features_auto FINAL
              WHERE env = {env:String} AND feature_id IN {ids:Array(String)}`,
      query_params: { env, ids },
      format: 'JSONEachRow',
    })
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '')
    const rows = (await result.json<Record<string, unknown> & { feature_id: string }>()).map((r) => ({ ...r, name: names[r.feature_id], name_source: 'ai', updated_at: now }))
    if (rows.length) await this.clickhouse.writer.insert({ table: `${this.db}.features_auto`, format: 'JSONEachRow', values: rows })
  }
}
