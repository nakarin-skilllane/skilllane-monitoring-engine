/**
 * Integration: a real Redis (the dev compose's redis-telemetry) and a fake
 * ingest. Skipped unless BULLMQ_IT=1:
 *   docker compose up -d --wait redis-telemetry     # at the repo root → redis://localhost:6390/0
 *   BULLMQ_IT=1 pnpm --filter @skilllane/monitoring-bullmq-bridge test
 * Every run uses its own queue prefix and obliterates it at the end, so a dev
 * engine on the same Redis is left alone.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Queue, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Bridge } from '../src/bridge'
import type { BridgeConfig } from '../src/config'
import { Forwarder } from '../src/forwarder'
import { IngestClient } from '../src/ingest-client'
import { BridgeStats } from '../src/stats'

const REDIS_URL = process.env.BULLMQ_IT_REDIS_URL ?? 'redis://localhost:6390/0'

describe.skipIf(process.env.BULLMQ_IT !== '1')('bullmq-bridge against Redis (BULLMQ_IT=1)', () => {
  const prefix = `bridge-it-${Date.now()}`
  const received: Array<{ url: string; body: unknown }> = []
  let answers: number[] = []
  const ingest = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      const status = answers.length > 1 ? (answers.shift() as number) : (answers[0] ?? 202)
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 503 ? { 'retry-after': '2' } : {}) })
      res.end(status === 202 ? '{"items":1}' : '{"statusCode":503,"message":"ingest is busy, retry later"}')
    })
  })

  let config: BridgeConfig
  let bridge: Bridge
  let client: IngestClient
  let stats: BridgeStats
  let logs: Queue
  let events: QueueEvents
  let eventsConnection: IORedis
  let queueConnection: IORedis

  beforeAll(async () => {
    await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve))
    config = {
      redisUrl: REDIS_URL,
      prefix,
      topics: { logs: `${prefix}.logs`, spans: `${prefix}.spans` },
      concurrency: 4,
      token: 'it-token',
      ingestUrl: `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`,
      port: 0,
    }
    stats = new BridgeStats()
    client = new IngestClient({ url: config.ingestUrl, token: config.token, timeoutMs: 5000 })
    bridge = new Bridge(config, new Forwarder(client, stats))
    await bridge.start()

    queueConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
    eventsConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
    logs = new Queue(config.topics.logs, { connection: queueConnection, prefix })
    events = new QueueEvents(config.topics.logs, { connection: eventsConnection, prefix })
    await events.waitUntilReady()
  })

  afterAll(async () => {
    await bridge.stop()
    await events.close()
    await logs.obliterate({ force: true }).catch(() => undefined)
    const spans = new Queue(config.topics.spans, { connection: queueConnection, prefix })
    await spans.obliterate({ force: true }).catch(() => undefined)
    await spans.close()
    await logs.close()
    await queueConnection.quit()
    await eventsConnection.quit()
    client.close()
    await new Promise<void>((resolve) => ingest.close(() => resolve()))
  })

  const envelope = (message: string) => ({
    v: 1,
    stream: 'logs',
    resource: { 'service.name': 'demo-api' },
    sentAt: new Date().toISOString(),
    items: [{ '@timestamp': new Date().toISOString(), 'log.level': 'info', 'event.code': 'it', message }],
  })

  it('forwards a published envelope and completes the job', async () => {
    received.length = 0
    answers = [202]
    const job = await logs.add('envelope', envelope('one'))
    await job.waitUntilFinished(events, 15_000)

    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/api/ingest/logs')
    expect(received[0].body).toMatchObject({ v: 1, stream: 'logs', items: [{ message: 'one' }] })
    expect(stats.forwardedRows).toBeGreaterThanOrEqual(1)
    expect(await bridge.pending()).toBe(0)
  })

  it('retries after a 503 (attempts 2) and then completes', async () => {
    received.length = 0
    answers = [503, 202]
    const failedBefore = stats.failed
    const job = await logs.add('envelope', envelope('two'), { attempts: 2, backoff: 200 })
    await job.waitUntilFinished(events, 15_000)

    expect(received).toHaveLength(2)
    expect(received.map((r) => (r.body as { items: Array<{ message: string }> }).items[0].message)).toEqual(['two', 'two'])
    expect(stats.failed).toBe(failedBefore + 1)
    const done = await logs.getJob(job.id as string)
    expect(done?.attemptsMade).toBe(2)
  })

  it('fails a non-envelope job as unrecoverable, without a retry or a request', async () => {
    received.length = 0
    answers = [202]
    const job = await logs.add('junk', { hello: 'world' }, { attempts: 3, backoff: 100 })
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/bad envelope from bullmq/)

    expect(received).toHaveLength(0)
    const failed = await logs.getJob(job.id as string)
    expect(await failed?.getState()).toBe('failed')
    expect(failed?.attemptsMade).toBe(1)
    expect(stats.unrecoverable).toBeGreaterThanOrEqual(1)
    expect(await bridge.lag()).toMatch(new RegExp(`${config.topics.logs}=0 wait/0 active/0 delayed/1 failed`))
  })

  it('answers ping', async () => {
    expect(await bridge.ping()).toBe(true)
  })
})
