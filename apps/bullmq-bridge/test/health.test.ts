import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { createHealthServer, probeHealth } from '../src/health'
import { BridgeStats } from '../src/stats'

const never = () => new Promise<never>(() => undefined)

describe('probeHealth', () => {
  it('ok when Redis and the ingest answer; pending from the queues', async () => {
    expect(
      await probeHealth({ redis: async () => true, ingest: async () => true, pending: async () => 7 }),
    ).toEqual({ ok: true, redis: true, ingest: true, pending: 7 })
  })

  it('not ok when one side is down; pending null when unreadable', async () => {
    expect(
      await probeHealth({ redis: async () => false, ingest: async () => true, pending: async () => undefined }),
    ).toEqual({ ok: false, redis: false, ingest: true, pending: null })
    expect(
      await probeHealth({ redis: async () => true, ingest: async () => false, pending: () => Promise.reject(new Error('x')) }),
    ).toEqual({ ok: false, redis: true, ingest: false, pending: null })
  })

  it('answers within 1 s while every probe hangs', async () => {
    const started = Date.now()
    expect(await probeHealth({ redis: never, ingest: never, pending: never })).toEqual({
      ok: false,
      redis: false,
      ingest: false,
      pending: null,
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('GET /api/health', () => {
  it('serves 200 when ok, 503 otherwise, 404 elsewhere', async () => {
    let redis = true
    const server = createHealthServer({ redis: async () => redis, ingest: async () => true, pending: async () => 0 })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      let res = await fetch(`${base}/api/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, redis: true, ingest: true, pending: 0 })
      redis = false
      res = await fetch(`${base}/api/health`)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ ok: false, redis: false })
      res = await fetch(`${base}/api/other`)
      expect(res.status).toBe(404)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('loadConfig', () => {
  it('has the engine defaults, and the bridge-specific ones', () => {
    expect(loadConfig({})).toEqual({
      redisUrl: undefined,
      prefix: 'bull',
      topics: { logs: 'skilllane-monitoring.logs', spans: 'skilllane-monitoring.spans' },
      concurrency: 50,
      token: undefined,
      ingestUrl: 'http://ingest:5100',
      port: 5110,
    })
  })

  it('reads the engine env names; the first non-empty token is sent', () => {
    const c = loadConfig({
      LOG_BULLMQ_REDIS_URL: 'redis://redis:6379/2',
      LOG_BULLMQ_PREFIX: 'telemetry',
      LOG_TOPIC_LOGS: 'my.logs',
      LOG_TOPIC_SPANS: 'my.spans',
      ENGINE_CONCURRENCY: '8',
      ENGINE_INGEST_TOKEN: ' , new-token ,old-token',
      INGEST_URL: 'http://ingest:5100/',
      BRIDGE_PORT: '6000',
    })
    expect(c).toEqual({
      redisUrl: 'redis://redis:6379/2',
      prefix: 'telemetry',
      topics: { logs: 'my.logs', spans: 'my.spans' },
      concurrency: 8,
      token: 'new-token',
      ingestUrl: 'http://ingest:5100',
      port: 6000,
    })
    expect(loadConfig({ ENGINE_CONCURRENCY: 'abc' }).concurrency).toBe(50)
  })
})

describe('BridgeStats.line', () => {
  it('prints the counters with the delta since the last line', () => {
    const stats = new BridgeStats()
    stats.jobs = 3
    stats.forwardedRows = 40
    expect(stats.line('q=1 wait/0 active/0 delayed/0 failed')).toBe(
      'bullmq: jobs 3 (+3) · forwarded rows 40 · failed 0 · unrecoverable 0 · pending q=1 wait/0 active/0 delayed/0 failed',
    )
    stats.jobs = 5
    stats.failed = 1
    expect(stats.line()).toBe('bullmq: jobs 5 (+2) · forwarded rows 40 · failed 1 · unrecoverable 0')
  })
})
