/**
 * Engine configuration, read once from the environment (SPEC.md section 5).
 * A `.env` in the working directory or the repo root is loaded first when
 * present (ENGINE_ENV_FILE names another file); variables already set in the
 * environment win over the file.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type ExportMode,
  ENV,
  rabbitmqExchange,
  resolveExportMode,
  topicName,
} from 'skilllane-monitoring/contract'

export type EngineRole = 'ingest' | 'api' | 'all'
export type KafkaSaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512'

export interface EngineConfig {
  role: EngineRole
  port: number
  corsOrigin: string | string[] | boolean
  applySchema: boolean
  /** Explicit path of clickhouse/schema.sql (ENGINE_SCHEMA_FILE); else searched. */
  schemaFile?: string
  clickhouse: {
    url: string
    user: string
    password: string
    readerUser: string
    readerPassword: string
    database: string
    /**
     * CLICKHOUSE_COLD_STORAGE_POLICY (empty = off): logs / spans use this storage policy and move
     * to CLICKHOUSE_COLD_VOLUME (default `cold`) after CLICKHOUSE_COLD_AFTER_DAYS (default 14).
     * The policy must exist in the ClickHouse config (deploy/clickhouse-config/storage-s3.xml).
     */
    coldStorage?: { policy: string; volume: string; afterDays: number }
  }
  /** LOG_EXPORT, resolved like the SDK does (contract resolveExportMode). */
  transport: ExportMode
  /** LOG_EXPORT held a value that is not a mode; it was ignored. */
  transportInvalid?: string
  topics: { logs: string; spans: string }
  kafka: {
    brokers: string[]
    clientId: string
    ssl: boolean
    sasl?: { mechanism: KafkaSaslMechanism; username: string; password: string }
  }
  rabbitmq: { url?: string; exchange: string }
  bullmq: { redisUrl?: string; prefix: string }
  consumerGroup: string
  kafkaPartitions: number
  concurrency: number
  flushMs: number
  flushRows: number
  /** HTTP ingest (apps without a queue): POST /api/ingest/<stream>. */
  ingest: {
    /** ENGINE_INGEST_HTTP (default on): POST /api/ingest/<stream> is served. */
    enabled: boolean
    /** ENGINE_INGEST_TOKEN, comma-separated to rotate; empty = no token asked (open to whoever reaches the port). */
    tokens: string[]
    /** Largest request body after gzip is undone (ENGINE_INGEST_MAX_BYTES). */
    maxBytes: number
    /** Requests written at once; more answer 503 (ENGINE_INGEST_MAX_INFLIGHT). */
    maxInflight: number
  }
  /** Monitor users (roles api / all). */
  auth: {
    /** SKILLLANE_MONITORING_ADMIN_USERNAME / SKILLLANE_MONITORING_ADMIN_PASSWORD: the admin login, checked against env on every login; unset = no admin login. */
    adminUsername?: string
    adminPassword?: string
    /** SKILLLANE_MONITORING_AUTH_SECRET signs sessions; unset = random per process (sessions end at restart). */
    secret: string
    secretFromEnv: boolean
    /** SKILLLANE_MONITORING_SESSION_HOURS (default 8). */
    sessionHours: number
    /** Users and roles (CLICKHOUSE_CONFIG_DATABASE, default `<CLICKHOUSE_DATABASE>_config`); skilllane_monitoring_reader has no grant on it. */
    database: string
  }
}

type Env = Record<string, string | undefined>

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function int(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(str(env, name) ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = str(env, name)?.toLowerCase()
  if (value === undefined) return fallback
  return !['false', '0', 'no', 'off'].includes(value)
}

function role(env: Env): EngineRole {
  const value = str(env, 'ENGINE_ROLE')?.toLowerCase()
  return value === 'ingest' || value === 'api' ? value : 'all'
}

function corsOrigin(env: Env): EngineConfig['corsOrigin'] {
  const value = str(env, 'ENGINE_CORS_ORIGIN') ?? '*'
  if (value === '*') return true
  const list = value.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length === 1 ? list[0] : list
}

function kafkaSasl(env: Env): EngineConfig['kafka']['sasl'] {
  const mechanism = str(env, ENV.kafkaSaslMechanism)?.toLowerCase()
  if (mechanism !== 'plain' && mechanism !== 'scram-sha-256' && mechanism !== 'scram-sha-512') {
    return undefined
  }
  return {
    mechanism,
    username: str(env, ENV.kafkaSaslUsername) ?? '',
    password: str(env, ENV.kafkaSaslPassword) ?? '',
  }
}

export function loadConfig(env: Env = process.env): EngineConfig {
  const { mode, invalid } = resolveExportMode(env)
  return {
    role: role(env),
    port: int(env, 'ENGINE_PORT', 5100),
    corsOrigin: corsOrigin(env),
    applySchema: bool(env, 'ENGINE_APPLY_SCHEMA', true),
    schemaFile: str(env, 'ENGINE_SCHEMA_FILE'),
    clickhouse: {
      url: str(env, 'CLICKHOUSE_URL') ?? 'http://localhost:8123',
      user: str(env, 'CLICKHOUSE_USER') ?? 'skilllane_monitoring',
      password: str(env, 'CLICKHOUSE_PASSWORD') ?? 'skilllane_monitoring',
      readerUser: str(env, 'CLICKHOUSE_READER_USER') ?? 'skilllane_monitoring_reader',
      readerPassword: str(env, 'CLICKHOUSE_READER_PASSWORD') ?? 'skilllane_monitoring_reader',
      database: str(env, 'CLICKHOUSE_DATABASE') ?? 'skilllane_monitoring',
      coldStorage: str(env, 'CLICKHOUSE_COLD_STORAGE_POLICY')
        ? {
            policy: str(env, 'CLICKHOUSE_COLD_STORAGE_POLICY')!,
            volume: str(env, 'CLICKHOUSE_COLD_VOLUME') ?? 'cold',
            afterDays: int(env, 'CLICKHOUSE_COLD_AFTER_DAYS', 14),
          }
        : undefined,
    },
    transport: mode,
    transportInvalid: invalid,
    topics: { logs: topicName('logs', env), spans: topicName('spans', env) },
    kafka: {
      brokers: (str(env, ENV.kafkaBrokers) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      clientId: str(env, ENV.kafkaClientId) ?? 'skilllane-monitoring-engine',
      ssl: bool(env, ENV.kafkaSsl, false),
      sasl: kafkaSasl(env),
    },
    rabbitmq: { url: str(env, ENV.rabbitmqUrl), exchange: rabbitmqExchange(env) },
    bullmq: { redisUrl: str(env, ENV.bullmqRedisUrl), prefix: str(env, ENV.bullmqPrefix) ?? 'bull' },
    consumerGroup: str(env, 'ENGINE_CONSUMER_GROUP') ?? 'skilllane-monitoring-engine',
    kafkaPartitions: int(env, 'ENGINE_KAFKA_PARTITIONS', 3),
    concurrency: int(env, 'ENGINE_CONCURRENCY', 50),
    flushMs: int(env, 'ENGINE_FLUSH_MS', 1000),
    flushRows: int(env, 'ENGINE_FLUSH_ROWS', 5000),
    ingest: {
      enabled: bool(env, 'ENGINE_INGEST_HTTP', true),
      tokens: (str(env, 'ENGINE_INGEST_TOKEN') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      maxBytes: int(env, 'ENGINE_INGEST_MAX_BYTES', 2_000_000),
      maxInflight: int(env, 'ENGINE_INGEST_MAX_INFLIGHT', 64),
    },
    auth: {
      adminUsername: str(env, 'SKILLLANE_MONITORING_ADMIN_USERNAME'),
      // Taken as set, not trimmed: the password is whatever the operator wrote.
      adminPassword: env.SKILLLANE_MONITORING_ADMIN_PASSWORD || undefined,
      secret: str(env, 'SKILLLANE_MONITORING_AUTH_SECRET') ?? randomBytes(32).toString('hex'),
      secretFromEnv: str(env, 'SKILLLANE_MONITORING_AUTH_SECRET') !== undefined,
      sessionHours: int(env, 'SKILLLANE_MONITORING_SESSION_HOURS', 8),
      database: str(env, 'CLICKHOUSE_CONFIG_DATABASE') ?? `${str(env, 'CLICKHOUSE_DATABASE') ?? 'skilllane_monitoring'}_config`,
    },
  }
}

/** Nearest ancestor of `from` holding pnpm-workspace.yaml (the repo root). */
export function findRepoRoot(from: string = __dirname): string | undefined {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Loads the first .env found: ENGINE_ENV_FILE, else ./.env, else <repo root>/.env. */
export function loadDotEnv(): string | undefined {
  const explicit = process.env.ENGINE_ENV_FILE?.trim()
  const root = findRepoRoot()
  const candidates = explicit
    ? [resolve(explicit)]
    : [join(process.cwd(), '.env'), ...(root ? [join(root, '.env')] : [])]
  const file = candidates.find((path) => existsSync(path))
  if (!file) return undefined
  // Node >= 20.12; variables already set in the environment win over the file.
  process.loadEnvFile(file)
  return file
}

export const dotEnvFile = loadDotEnv()

/** The engine's configuration. Import this; do not read process.env elsewhere. */
export const config: EngineConfig = loadConfig()
