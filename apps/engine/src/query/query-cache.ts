import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
  type OnModuleDestroy,
  type OnModuleInit,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, lastValueFrom, type Observable } from 'rxjs'
import type { AuthedRequest } from '../auth/auth.guard'
import type { Effective } from '../auth/permissions'
import { config } from '../config'

/**
 * Server-side result cache of the query API (ENGINE_QUERY_CACHE_MS, default
 * 10 s, 0 = off): many monitor tabs refreshing every 30 s ask ClickHouse once
 * per distinct request, not once per tab. The HTTP response is unchanged (no
 * Cache-Control is added; browsers never cache it).
 *
 * Key = path + query string with its params sorted + the caller's permission
 * scope (every (permission, envs) pair the principal holds), so a hit never
 * crosses a permission boundary: two users with the same grants share, any
 * difference in scope is another key. A relative range (`from=now-1h`) is
 * cached by its text: the same text within the TTL is the same answer, which is
 * the point. Concurrent identical requests share one in-flight call. Errors
 * (any thrown HttpException, 4xx or 5xx) are not kept. Bounded LRU map.
 */

const SKIP_KEY = 'skilllane-monitoring:query-cache-skip'

/** A GET of the controller that must not be cached (its answer depends on more than path + params + scope). */
export const SkipQueryCache = () => SetMetadata(SKIP_KEY, true)

export const QUERY_CACHE_MAX_ENTRIES = 500
const STATS_EVERY_MS = 5 * 60_000

interface Entry {
  value?: unknown
  /** 0 while the load is in flight. */
  expiresAt: number
  pending?: Promise<unknown>
}

export interface QueryCacheStats {
  /** Answered from a stored value. */
  hits: number
  /** Joined a load already in flight (one upstream call for all of them). */
  joined: number
  /** Loaded upstream. */
  misses: number
}

export class QueryCache {
  private readonly entries = new Map<string, Entry>()
  private stats: QueryCacheStats = { hits: 0, joined: 0, misses: 0 }

  constructor(
    readonly ttlMs: number,
    readonly maxEntries: number = QUERY_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size
  }

  /** The stored value of `key` within its TTL, else `load()` once for everyone asking meanwhile. */
  fetch<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load()
    const current = this.entries.get(key)
    if (current) {
      if (current.pending) {
        this.stats.joined++
        return current.pending as Promise<T>
      }
      if (current.expiresAt > this.now()) {
        this.stats.hits++
        // Most recently used goes to the end of the map (the front is evicted first).
        this.entries.delete(key)
        this.entries.set(key, current)
        return Promise.resolve(current.value as T)
      }
      this.entries.delete(key)
    }
    this.stats.misses++
    const entry: Entry = { expiresAt: 0 }
    // load() runs now (callers arriving meanwhile join it); a synchronous throw becomes a rejection.
    entry.pending = new Promise<T>((resolve) => resolve(load())).then(
      (value) => {
        // Still ours (not evicted meanwhile): keep the value for the TTL from now.
        if (this.entries.get(key) === entry) {
          entry.value = value
          entry.expiresAt = this.now() + this.ttlMs
          entry.pending = undefined
        }
        return value
      },
      (err: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
        throw err
      },
    )
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return entry.pending as Promise<T>
  }

  clear(): void {
    this.entries.clear()
  }

  /** The counters since the last drain, then zero. */
  drainStats(): QueryCacheStats {
    const out = this.stats
    this.stats = { hits: 0, joined: 0, misses: 0 }
    return out
  }

  peekStats(): QueryCacheStats {
    return { ...this.stats }
  }
}

/** `permission=env,env;permission=*` over every permission held, in a fixed order. */
export function scopeKey(effective: Effective): string {
  return Object.keys(effective)
    .sort()
    .map((permission) => {
      const scope = effective[permission as keyof Effective]
      if (!scope) return undefined
      return `${permission}=${scope === 'all' ? '*' : [...scope].sort().join(',')}`
    })
    .filter(Boolean)
    .join(';')
}

/** The cache key of one request: path, params sorted by name, the caller's scope. */
export function queryCacheKey(path: string, query: Record<string, unknown>, effective: Effective): string {
  const params = Object.keys(query)
    .sort()
    .map((name) => {
      const value = query[name]
      return `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`
    })
    .join('&')
  return `${path}?${params}|${scopeKey(effective)}`
}

/**
 * On QueryController: every GET (after AuthGuard, so `req.principal` is set)
 * except @SkipQueryCache(). Logs hit / join / miss counts every 5 minutes.
 */
@Injectable()
export class QueryCacheInterceptor implements NestInterceptor, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QueryCache')
  private timer?: NodeJS.Timeout

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: QueryCache,
  ) {}

  onModuleInit(): void {
    if (this.cache.ttlMs <= 0) {
      this.logger.log('Query cache off (ENGINE_QUERY_CACHE_MS=0)')
      return
    }
    this.logger.log(`Query cache ${this.cache.ttlMs} ms, ${this.cache.maxEntries} entries most`)
    this.timer = setInterval(() => this.logStats(), STATS_EVERY_MS)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private logStats(): void {
    const { hits, joined, misses } = this.cache.drainStats()
    if (hits + joined + misses === 0) return
    this.logger.log(`hits=${hits} joined=${joined} misses=${misses} entries=${this.cache.size}`)
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.cache.ttlMs <= 0) return next.handle()
    if (this.reflector.getAllAndOverride<boolean>(SKIP_KEY, [context.getHandler(), context.getClass()])) {
      return next.handle()
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>()
    if (req.method !== 'GET' || !req.principal) return next.handle()
    const key = queryCacheKey(req.path, req.query as Record<string, unknown>, req.principal.effective)
    return from(this.cache.fetch(key, () => lastValueFrom(next.handle(), { defaultValue: undefined })))
  }
}

/** The process-wide cache, sized by config; a provider of QueryModule. */
export const queryCacheProvider = {
  provide: QueryCache,
  useFactory: () => new QueryCache(config.queryCacheMs),
}
