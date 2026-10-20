/**
 * Service versions as the data shows them (no CI events): every version a
 * service wrote log lines with, its first and last line, the current version
 * and when it was deployed. Read from skilllane_monitoring.logs over all retained data.
 *
 * - current version = the version with the latest line (ties: the one first seen later);
 * - deployedAt = the first line of the current version;
 * - previousVersion = the version first seen last before deployedAt ('' when none);
 * - a deploy = a version that first appeared after another version of the same
 *   service and env (the first version in the data is not a deploy).
 */
import { Injectable } from '@nestjs/common'
import { Reader, Where, iso } from './sql'

export interface VersionSeen {
  version: string
  firstSeen: string
  lastSeen: string
}

/** Versions of one service + role (or of the whole service when role is '') in one env. */
export interface Release {
  env: string
  service: string
  /** '' = every role of the service together. */
  role: string
  currentVersion: string
  /** First line of the current version (ISO). */
  deployedAt: string
  /** Version before the current one; '' when the data shows only one. */
  previousVersion: string
  /** Oldest first. */
  versions: VersionSeen[]
}

/** A version change of a service in an env, for chart markers. */
export interface Deploy {
  service: string
  env: string
  version: string
  /** First line of `version` (ISO). */
  at: string
  previousVersion: string
}

export interface Releases {
  /** Per env + service + role. */
  byRole: Release[]
  /** Per env + service (all roles together); isNew of error groups uses these. */
  byService: Release[]
  deploys: Deploy[]
}

interface VersionDb {
  env: string
  service: string
  role: string
  version: string
  first_seen: string
  last_seen: string
}

interface Seen {
  version: string
  firstMs: number
  lastMs: number
  first: string
  last: string
}

const CACHE_MS = 10_000

function release(env: string, service: string, role: string, seen: Seen[]): Release {
  const versions = [...seen].sort((a, b) => a.firstMs - b.firstMs)
  const current = [...versions].sort((a, b) => b.lastMs - a.lastMs || b.firstMs - a.firstMs)[0]
  const before = versions.filter((v) => v.firstMs < current.firstMs)
  return {
    env,
    service,
    role,
    currentVersion: current.version,
    deployedAt: current.first,
    previousVersion: before.length ? before[before.length - 1].version : '',
    versions: versions.map((v) => ({ version: v.version, firstSeen: v.first, lastSeen: v.last })),
  }
}

function merge(list: Seen[]): Seen[] {
  const by = new Map<string, Seen>()
  for (const s of list) {
    const prev = by.get(s.version)
    if (!prev) {
      by.set(s.version, { ...s })
      continue
    }
    if (s.firstMs < prev.firstMs) Object.assign(prev, { firstMs: s.firstMs, first: s.first })
    if (s.lastMs > prev.lastMs) Object.assign(prev, { lastMs: s.lastMs, last: s.last })
  }
  return [...by.values()]
}

@Injectable()
export class ReleasesService {
  private readonly cache = new Map<string, { at: number; value: Promise<Releases> }>()

  constructor(private readonly reader: Reader) {}

  /** Versions of every service (optionally of one env / service); cached for 10 s. */
  releases(scope: { env?: string; service?: string } = {}): Promise<Releases> {
    const key = `${scope.env ?? ''}\u0000${scope.service ?? ''}`
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
    const value = this.load(scope)
    this.cache.set(key, { at: Date.now(), value })
    value.catch(() => this.cache.delete(key))
    return value
  }

  /** The service-level release of each env + service, keyed `env\0service`. */
  async serviceReleases(env?: string): Promise<Map<string, Release>> {
    const { byService } = await this.releases({ env })
    return new Map(byService.map((r) => [`${r.env}\u0000${r.service}`, r]))
  }

  private async load(scope: { env?: string; service?: string }): Promise<Releases> {
    const w = new Where().add(`service != '' AND version != ''`)
    if (scope.env) w.add('env = {env:String}', { env: scope.env })
    if (scope.service) w.add('service = {service:String}', { service: scope.service })
    const rows = await this.reader.rows<VersionDb>(
      'releases',
      `SELECT env, service, role, version, min(timestamp) AS first_seen, max(timestamp) AS last_seen
       FROM skilllane_monitoring.logs WHERE ${w.sql}
       GROUP BY env, service, role, version`,
      w.params,
    )
    const roleGroups = new Map<string, { env: string; service: string; role: string; seen: Seen[] }>()
    for (const r of rows) {
      const first = iso(r.first_seen) ?? ''
      const last = iso(r.last_seen) ?? ''
      const seen: Seen = { version: r.version, first, last, firstMs: Date.parse(first), lastMs: Date.parse(last) }
      const key = `${r.env}\u0000${r.service}\u0000${r.role}`
      const group = roleGroups.get(key) ?? { env: r.env, service: r.service, role: r.role, seen: [] }
      group.seen.push(seen)
      roleGroups.set(key, group)
    }
    const serviceGroups = new Map<string, { env: string; service: string; seen: Seen[] }>()
    for (const g of roleGroups.values()) {
      const key = `${g.env}\u0000${g.service}`
      const group = serviceGroups.get(key) ?? { env: g.env, service: g.service, seen: [] }
      group.seen.push(...g.seen)
      serviceGroups.set(key, group)
    }
    const order = (a: Release, b: Release) =>
      a.service.localeCompare(b.service) || a.role.localeCompare(b.role) || a.env.localeCompare(b.env)
    const byRole = [...roleGroups.values()].map((g) => release(g.env, g.service, g.role, g.seen)).sort(order)
    const byService = [...serviceGroups.values()].map((g) => release(g.env, g.service, '', merge(g.seen))).sort(order)
    const deploys: Deploy[] = []
    for (const r of byService) {
      r.versions.forEach((v, i) => {
        if (i === 0) return
        deploys.push({ service: r.service, env: r.env, version: v.version, at: v.firstSeen, previousVersion: r.versions[i - 1].version })
      })
    }
    deploys.sort((a, b) => a.at.localeCompare(b.at))
    return { byRole, byService, deploys }
  }
}
