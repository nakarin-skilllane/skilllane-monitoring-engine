/**
 * Bridge configuration, read once from the environment. The names are the
 * engine's (apps/engine/src/config.ts) so a compose file can hand both the same
 * env; INGEST_URL and BRIDGE_PORT are the bridge's own. A `.env` in the working
 * directory or the repo root is loaded first when present (ENGINE_ENV_FILE
 * names another file); variables already set in the environment win.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ENV, topicName } from 'skilllane-monitoring/contract'

export interface BridgeConfig {
  /** LOG_BULLMQ_REDIS_URL (required). */
  redisUrl?: string
  /** LOG_BULLMQ_PREFIX (default bull). */
  prefix: string
  /** LOG_TOPIC_LOGS / LOG_TOPIC_SPANS: the queue names. */
  topics: { logs: string; spans: string }
  /** ENGINE_CONCURRENCY (default 50): jobs in flight per queue. */
  concurrency: number
  /** First non-empty entry of ENGINE_INGEST_TOKEN, sent as `Authorization: Bearer`. */
  token?: string
  /** INGEST_URL (default http://ingest:5100), no trailing slash. */
  ingestUrl: string
  /** BRIDGE_PORT (default 5110): GET /api/health. */
  port: number
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

export function loadConfig(env: Env = process.env): BridgeConfig {
  const tokens = (str(env, 'ENGINE_INGEST_TOKEN') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    redisUrl: str(env, ENV.bullmqRedisUrl),
    prefix: str(env, ENV.bullmqPrefix) ?? 'bull',
    topics: { logs: topicName('logs', env), spans: topicName('spans', env) },
    concurrency: int(env, 'ENGINE_CONCURRENCY', 50),
    token: tokens[0],
    ingestUrl: (str(env, 'INGEST_URL') ?? 'http://ingest:5100').replace(/\/+$/, ''),
    port: int(env, 'BRIDGE_PORT', 5110),
  }
}

/** Nearest ancestor of `from` holding pnpm-workspace.yaml (the repo root). */
function findRepoRoot(from: string = __dirname): string | undefined {
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
