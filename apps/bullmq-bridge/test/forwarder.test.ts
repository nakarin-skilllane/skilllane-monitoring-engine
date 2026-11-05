import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { UnrecoverableError } from 'bullmq'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Forwarder } from '../src/forwarder'
import { IngestClient } from '../src/ingest-client'
import { BridgeStats } from '../src/stats'

interface Received {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

type Answer = { status: number; body?: string; headers?: Record<string, string> }

/** A stand-in for the ingest: records every request, answers what the test sets. */
function fakeIngest() {
  const received: Received[] = []
  let answers: Answer[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      const answer = answers.length > 1 ? (answers.shift() as Answer) : (answers[0] ?? { status: 202, body: '{"items":1}' })
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
      res.end(answer.body ?? '')
    })
  })
  return {
    server,
    received,
    /** The next answers in order; the last one repeats. */
    answer(...next: Answer[]) {
      answers = next
    },
    reset() {
      received.length = 0
      answers = []
    },
    url() {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
  }
}

const envelope = (items = 2) => ({
  v: 1,
  stream: 'logs',
  resource: { 'service.name': 'demo-api' },
  sentAt: new Date().toISOString(),
  items: Array.from({ length: items }, (_, i) => ({
    '@timestamp': new Date().toISOString(),
    'log.level': 'info',
    'event.code': 'test',
    message: `hello ${i}`,
  })),
})

describe('Forwarder', () => {
  const ingest = fakeIngest()
  let client: IngestClient
  let stats: BridgeStats
  let forwarder: Forwarder

  beforeAll(async () => {
    await new Promise<void>((resolve) => ingest.server.listen(0, '127.0.0.1', resolve))
    client = new IngestClient({ url: ingest.url(), token: 'secret-token', timeoutMs: 2000 })
  })
  afterAll(async () => {
    client.close()
    await new Promise<void>((resolve) => ingest.server.close(() => resolve()))
  })
  beforeEach(() => {
    ingest.reset()
    stats = new BridgeStats()
    forwarder = new Forwarder(client, stats)
  })

  it('202: posts the envelope to /api/ingest/<stream> with the bearer token and counts the rows', async () => {
    ingest.answer({ status: 202, body: '{"items":2}' })
    await forwarder.forward({ id: '1', queueName: 'skilllane-monitoring.logs', data: envelope(2) })

    expect(ingest.received).toHaveLength(1)
    const [req] = ingest.received
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/api/ingest/logs')
    expect(req.headers.authorization).toBe('Bearer secret-token')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(req.body.toString('utf8'))).toMatchObject({ v: 1, stream: 'logs' })
    expect(stats).toMatchObject({ jobs: 1, forwardedRows: 2, failed: 0, unrecoverable: 0 })
  })

  it('posts spans to /api/ingest/spans', async () => {
    await forwarder.forward({ id: '2', queueName: 'spans', data: { ...envelope(1), stream: 'spans' } })
    expect(ingest.received[0].url).toBe('/api/ingest/spans')
  })

  it('gzips a body above 64 KB', async () => {
    const big = envelope(1)
    big.items[0].message = 'x'.repeat(70 * 1024)
    await forwarder.forward({ id: '3', queueName: 'logs', data: big })

    const [req] = ingest.received
    expect(req.headers['content-encoding']).toBe('gzip')
    expect(req.body.length).toBeLessThan(10 * 1024)
    expect(JSON.parse(gunzipSync(req.body).toString('utf8'))).toEqual(big)
  })

  it('400: the job is unrecoverable (the ingest said it can never be written)', async () => {
    ingest.answer({ status: 400, body: '{"statusCode":400,"message":"envelope stream spans posted to /logs"}' })
    const err = await forwarder.forward({ id: '4', queueName: 'logs', data: envelope() }).catch((e) => e)
    expect(err).toBeInstanceOf(UnrecoverableError)
    expect(err.message).toContain('envelope stream spans posted to /logs')
    expect(stats).toMatchObject({ jobs: 1, forwardedRows: 0, failed: 0, unrecoverable: 1 })
  })

  it('503 + Retry-After: throws a plain error so BullMQ retries, without waiting', async () => {
    ingest.answer({ status: 503, body: '{"statusCode":503,"message":"ingest is busy, retry later"}', headers: { 'retry-after': '2' } })
    const started = Date.now()
    const err = await forwarder.forward({ id: '5', queueName: 'logs', data: envelope() }).catch((e) => e)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
    expect(err.message).toBe('ingest answered 503: ingest is busy, retry later')
    expect(stats).toMatchObject({ jobs: 1, failed: 1, unrecoverable: 0 })
  })

  it('401: throws a retryable error', async () => {
    ingest.answer({ status: 401, body: '{"statusCode":401,"message":"invalid ingest token"}' })
    const err = await forwarder.forward({ id: '6', queueName: 'logs', data: envelope() }).catch((e) => e)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
    expect(err.message).toContain('ingest rejected the token')
    expect(stats.failed).toBe(1)
  })

  it('500 with a non-JSON body: retryable, body text in the message', async () => {
    ingest.answer({ status: 500, body: 'boom' })
    const err = await forwarder.forward({ id: '7', queueName: 'logs', data: envelope() }).catch((e) => e)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
    expect(err.message).toBe('ingest answered 500: boom')
  })

  it('network error: retryable, nothing counted as forwarded', async () => {
    const closed = http.createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const lonely = new IngestClient({ url: `http://127.0.0.1:${port}`, timeoutMs: 2000 })
    try {
      const err = await new Forwarder(lonely, stats).forward({ id: '8', queueName: 'logs', data: envelope() }).catch((e) => e)
      expect(err).not.toBeInstanceOf(UnrecoverableError)
      expect(err.message).toMatch(/^ingest unreachable: /)
      expect(stats).toMatchObject({ jobs: 1, forwardedRows: 0, failed: 1 })
    } finally {
      lonely.close()
    }
  })

  it('timeout: retryable', async () => {
    const slow = http.createServer(() => undefined)
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const slowClient = new IngestClient({ url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, timeoutMs: 200 })
    try {
      const err = await new Forwarder(slowClient, stats).forward({ id: '9', queueName: 'logs', data: envelope() }).catch((e) => e)
      expect(err.message).toMatch(/did not answer within 200 ms/)
    } finally {
      slowClient.close()
      slow.closeAllConnections()
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
  })

  describe('envelope validation (no request is made)', () => {
    it.each([
      ['null', null],
      ['a string', 'not an envelope'],
      ['an object without v', { stream: 'logs', resource: { 'service.name': 'x' }, items: [] }],
      ['v 2', { ...envelope(), v: 2 }],
      ['an unknown stream', { ...envelope(), stream: 'metrics' }],
      ['items not an array', { ...envelope(), items: {} }],
      ['no resource', { ...envelope(), resource: undefined }],
      ['resource without service.name', { ...envelope(), resource: {} }],
    ])('%s is unrecoverable', async (_label, data) => {
      const err = await forwarder.forward({ id: 'x', queueName: 'skilllane-monitoring.logs', data }).catch((e) => e)
      expect(err).toBeInstanceOf(UnrecoverableError)
      expect(err.message).toMatch(/^bad envelope from bullmq skilllane-monitoring\.logs#x: /)
      expect(ingest.received).toHaveLength(0)
      expect(stats).toMatchObject({ jobs: 1, unrecoverable: 1, failed: 0 })
    })
  })
})

describe('IngestClient.healthy', () => {
  it('is true for 200 {ok:true}, false for 503 or no server', async () => {
    const ingest = fakeIngest()
    await new Promise<void>((resolve) => ingest.server.listen(0, '127.0.0.1', resolve))
    const client = new IngestClient({ url: ingest.url() })
    try {
      ingest.answer({ status: 200, body: '{"ok":true}' })
      expect(await client.healthy()).toBe(true)
      expect(ingest.received[0]).toMatchObject({ method: 'GET', url: '/api/health' })
      ingest.answer({ status: 503, body: '{"ok":false}' })
      expect(await client.healthy()).toBe(false)
    } finally {
      client.close()
      await new Promise<void>((resolve) => ingest.server.close(() => resolve()))
    }
    expect(await client.healthy(300)).toBe(false)
  })
})
