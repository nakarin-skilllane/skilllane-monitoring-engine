import 'reflect-metadata'
import { Reflector } from '@nestjs/core'
import type { ExecutionContext } from '@nestjs/common'
import { lastValueFrom, of } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'
import type { Effective } from '../src/auth/permissions'
import { loadConfig } from '../src/config'
import { QueryCache, QueryCacheInterceptor, queryCacheKey, scopeKey, SkipQueryCache } from '../src/query/query-cache'

/** A cache whose clock the test moves. */
function clocked(ttlMs = 10_000, maxEntries = 500) {
  let now = 1_000_000
  const cache = new QueryCache(ttlMs, maxEntries, () => now)
  return { cache, tick: (ms: number) => (now += ms) }
}

describe('QueryCache.fetch', () => {
  it('answers from the stored value within the TTL and loads again after it', async () => {
    const { cache, tick } = clocked(10_000)
    const load = vi.fn(async () => ({ n: 1 }))
    expect(await cache.fetch('k', load)).toEqual({ n: 1 })
    tick(9_999)
    expect(await cache.fetch('k', load)).toEqual({ n: 1 })
    expect(load).toHaveBeenCalledTimes(1)
    tick(1)
    await cache.fetch('k', load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.drainStats()).toEqual({ hits: 1, joined: 0, misses: 2 })
  })

  it('keys are separate: another key loads on its own', async () => {
    const { cache } = clocked()
    const load = vi.fn(async () => 'v')
    await cache.fetch('a', load)
    await cache.fetch('b', load)
    await cache.fetch('a', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('concurrent calls for one key share one in-flight load', async () => {
    const { cache } = clocked()
    let resolve!: (value: string) => void
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const calls = [cache.fetch('k', load), cache.fetch('k', load), cache.fetch('k', load)]
    expect(load).toHaveBeenCalledTimes(1)
    resolve('shared')
    expect(await Promise.all(calls)).toEqual(['shared', 'shared', 'shared'])
    expect(cache.peekStats()).toEqual({ hits: 0, joined: 2, misses: 1 })
    // and the resolved value is now stored
    expect(await cache.fetch('k', load)).toBe('shared')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not keep a rejected load: every waiter gets the error and the next call loads again', async () => {
    const { cache } = clocked()
    let n = 0
    const load = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('boom')
      return 'ok'
    })
    const first = cache.fetch('k', load)
    const joined = cache.fetch('k', load)
    await expect(first).rejects.toThrow('boom')
    await expect(joined).rejects.toThrow('boom')
    expect(cache.size).toBe(0)
    expect(await cache.fetch('k', load)).toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('holds at most maxEntries, dropping the least recently used', async () => {
    const { cache } = clocked(10_000, 3)
    const load = vi.fn(async () => 'v')
    await cache.fetch('a', load)
    await cache.fetch('b', load)
    await cache.fetch('c', load)
    await cache.fetch('a', load) // a is now the most recently used
    await cache.fetch('d', load) // evicts b
    expect(cache.size).toBe(3)
    await cache.fetch('a', load)
    await cache.fetch('b', load)
    expect(load).toHaveBeenCalledTimes(5) // a, b, c, d, then b again
  })

  it('a TTL of 0 means off: every call loads, nothing is stored', async () => {
    const cache = new QueryCache(0)
    const load = vi.fn(async () => 'v')
    await cache.fetch('k', load)
    await cache.fetch('k', load)
    expect(load).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })
})

describe('queryCacheKey', () => {
  const all: Effective = { overview: 'all', logs: 'all' }
  const prodOnly: Effective = { overview: ['prod'], logs: ['prod'] }

  it('ignores the order of query params and keeps their text', () => {
    const a = queryCacheKey('/api/overview', { from: 'now-1h', env: 'prod' }, all)
    const b = queryCacheKey('/api/overview', { env: 'prod', from: 'now-1h' }, all)
    expect(a).toBe(b)
    expect(a).toContain('from=now-1h')
    expect(queryCacheKey('/api/overview', { env: 'prod', from: 'now-6h' }, all)).not.toBe(a)
  })

  it('differs by path', () => {
    expect(queryCacheKey('/api/logs', { env: 'prod' }, all)).not.toBe(queryCacheKey('/api/traces', { env: 'prod' }, all))
  })

  it('differs by permission scope, so principals with different grants never share', () => {
    const q = { env: 'prod' }
    expect(queryCacheKey('/api/logs', q, all)).not.toBe(queryCacheKey('/api/logs', q, prodOnly))
    expect(queryCacheKey('/api/logs', q, prodOnly)).not.toBe(queryCacheKey('/api/logs', q, { overview: ['prod'], logs: ['prod', 'dev'] }))
    expect(queryCacheKey('/api/logs', q, { logs: ['prod'] })).not.toBe(queryCacheKey('/api/logs', q, { logs: ['prod'], errors: 'all' }))
  })

  it('scopeKey is canonical: permission order and env order do not matter', () => {
    expect(scopeKey({ logs: ['dev', 'prod'], overview: 'all' })).toBe(scopeKey({ overview: 'all', logs: ['prod', 'dev'] }))
    expect(scopeKey({ logs: ['prod'], overview: 'all' })).toBe('logs=prod;overview=*')
  })
})

describe('ENGINE_QUERY_CACHE_MS', () => {
  it('defaults to 10 s; 0 turns the cache off; a bad value keeps the default', () => {
    expect(loadConfig({}).queryCacheMs).toBe(10_000)
    expect(loadConfig({ ENGINE_QUERY_CACHE_MS: '0' }).queryCacheMs).toBe(0)
    expect(loadConfig({ ENGINE_QUERY_CACHE_MS: '2500' }).queryCacheMs).toBe(2500)
    expect(loadConfig({ ENGINE_QUERY_CACHE_MS: '-1' }).queryCacheMs).toBe(10_000)
    expect(loadConfig({ ENGINE_QUERY_CACHE_MS: 'abc' }).queryCacheMs).toBe(10_000)
  })
})

describe('QueryCacheInterceptor', () => {
  class Ctl {
    cached() {}
    @SkipQueryCache()
    meta() {}
  }

  function context(handler: () => void, req: Record<string, unknown>): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => Ctl,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext
  }

  const principal = (effective: Effective, id = 'u1') => ({ id, username: id, name: id, kind: 'user', roleIds: [], effective })

  it('serves the second identical GET from the cache and loads for another scope or other params', async () => {
    const { cache } = clocked()
    const interceptor = new QueryCacheInterceptor(new Reflector(), cache)
    const handle = vi.fn(() => of({ rows: [] }))
    const call = (req: Record<string, unknown>) =>
      lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, req), { handle }))

    const base = { method: 'GET', path: '/api/logs', query: { env: 'prod', from: 'now-1h' }, principal: principal({ logs: 'all' }) }
    expect(await call(base)).toEqual({ rows: [] })
    expect(await call({ ...base, principal: principal({ logs: 'all' }, 'u2') })).toEqual({ rows: [] })
    expect(handle).toHaveBeenCalledTimes(1) // same scope, another user: shared
    await call({ ...base, principal: principal({ logs: ['prod'] }) })
    expect(handle).toHaveBeenCalledTimes(2) // narrower scope: its own entry
    await call({ ...base, query: { from: 'now-1h', env: 'prod' } })
    expect(handle).toHaveBeenCalledTimes(2) // same params, other order
    await call({ ...base, query: { env: 'prod', from: 'now-6h' } })
    expect(handle).toHaveBeenCalledTimes(3)
  })

  it('passes @SkipQueryCache() handlers, non-GET and unauthenticated requests through', async () => {
    const { cache } = clocked()
    const interceptor = new QueryCacheInterceptor(new Reflector(), cache)
    const handle = vi.fn(() => of('fresh'))
    const req = { method: 'GET', path: '/api/meta', query: {}, principal: principal({ logs: 'all' }) }
    await lastValueFrom(interceptor.intercept(context(Ctl.prototype.meta, req), { handle }))
    await lastValueFrom(interceptor.intercept(context(Ctl.prototype.meta, req), { handle }))
    await lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, { ...req, method: 'POST' }), { handle }))
    await lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, { ...req, method: 'POST' }), { handle }))
    await lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, { ...req, principal: undefined }), { handle }))
    expect(handle).toHaveBeenCalledTimes(5)
    expect(cache.size).toBe(0)
  })

  it('does not keep a handler error', async () => {
    const { cache } = clocked()
    const interceptor = new QueryCacheInterceptor(new Reflector(), cache)
    let n = 0
    const handle = vi.fn(() => {
      n += 1
      if (n === 1) throw new Error('400 bad range')
      return of('ok')
    })
    const req = { method: 'GET', path: '/api/logs', query: { from: 'x' }, principal: principal({ logs: 'all' }) }
    await expect(lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, req), { handle }))).rejects.toThrow('400 bad range')
    expect(await lastValueFrom(interceptor.intercept(context(Ctl.prototype.cached, req), { handle }))).toBe('ok')
    expect(handle).toHaveBeenCalledTimes(2)
  })
})
