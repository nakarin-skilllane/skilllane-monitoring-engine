import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { config } from '../config'

/**
 * Cache on the app's own Redis (6391). Fails fast while Redis is down
 * (no offline queue): the request falls back to Oracle. skilllane-monitoring
 * watches this connection and writes dependency.down / still_down / up.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name)
  private readonly redis = new Redis(config.redisUrl, {
    connectionName: 'demo-cache',
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  })

  async getJson<T>(key: string): Promise<T | undefined> {
    try {
      const value = await this.redis.get(key)
      return value ? (JSON.parse(value) as T) : undefined
    } catch (error) {
      this.logger.warn('Cache read failed; reading from Oracle', error)
      return undefined
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    } catch {
      // the read already reported the outage
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect()
  }
}
