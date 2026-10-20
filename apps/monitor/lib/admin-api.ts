/**
 * Calls to the engine's /api/auth, /api/users and /api/roles from client
 * components, through the same-origin /engine/* rewrite (the session cookie
 * goes along). Never throws: `{ ok, status, data }` or `{ ok: false, message }`.
 */
import { toLoginOn401 } from './engine-client'
import type { Effective, PermissionId } from './types'

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; message: string; body?: unknown }

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(`/engine${path}`, {
      method,
      cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    return { ok: false, status: 0, message: `ติดต่อ engine ไม่ได้ (${(e as Error).message})` }
  }
  // a wrong password at /login is also 401: toLoginOn401 leaves the sign-in pages alone
  toLoginOn401(res.status)
  const text = await res.text().catch(() => '')
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T }
  const m = (data as { message?: unknown } | null)?.message
  const message = Array.isArray(m) ? m.join('; ') : typeof m === 'string' && m ? m : `${res.status} ${res.statusText}`
  return { ok: false, status: res.status, message, body: data }
}

export interface Grant {
  permission: PermissionId
  /** [] = every env. */
  envs: string[]
}

export interface Role {
  id: string
  name: string
  description: string
  grants: Grant[]
  builtin: boolean
  createdAt: string
  userCount: number
}

export interface UserRow {
  id: string
  username: string
  name: string
  /** pending = has not set a password from the link yet. */
  status: 'active' | 'banned' | 'pending'
  roleIds: string[]
  effective: Effective
  grantedBy: Record<string, string[]>
  lastLoginAt: string | null
  createdAt: string
  /** Pending only: until when the set-password link works; null = none open (expired). */
  inviteExpiresAt: string | null
  /** Has set a password (a banned user too). */
  hasPassword: boolean
  /** The env admin (SKILLLANE_MONITORING_ADMIN_*): read only. */
  system: boolean
}

export interface Invite {
  token: string
  expiresAt: string
}

export interface CatalogItem {
  id: PermissionId
  label: string
  detail: string
}

export interface CatalogGroup {
  group: 'view' | 'manage'
  label: string
  /** View permissions take an env scope; manage permissions are always every env. */
  envScoped: boolean
  items: CatalogItem[]
}

/** The set-password link of an invite, on this monitor's origin. */
export const inviteLink = (invite: Invite): string => `${window.location.origin}/set-password?token=${encodeURIComponent(invite.token)}`

/** Union of the roles' grants as (permission, env) pairs, with the roles each pair comes from. */
export function effectiveOf(roles: Role[]): Array<{ permission: PermissionId; envs: 'all' | string[]; from: string[] }> {
  const by = new Map<PermissionId, { envs: 'all' | Set<string>; from: Set<string> }>()
  for (const role of roles) {
    for (const g of role.grants) {
      const cur = by.get(g.permission) ?? { envs: new Set<string>(), from: new Set<string>() }
      cur.from.add(role.name)
      if (cur.envs !== 'all') {
        if (!g.envs.length) cur.envs = 'all'
        else for (const e of g.envs) cur.envs.add(e)
      }
      by.set(g.permission, cur)
    }
  }
  return [...by.entries()].map(([permission, v]) => ({
    permission,
    envs: v.envs === 'all' ? 'all' : [...v.envs].sort(),
    from: [...v.from],
  }))
}

export const envText = (envs: 'all' | string[]): string => (envs === 'all' || !envs.length ? 'ทุก env' : envs.join(', '))
