/**
 * What a role can turn on, per env. A user gets the union of the grants of
 * all their roles, as (permission, env) pairs: role A `logs` on prod plus
 * role B `traces` on dev never gives `logs` on dev.
 */

/** Data a user can read: one per kind of data the query API returns. */
export const VIEW_PERMISSIONS = ['overview', 'logs', 'traces', 'errors', 'jobs', 'topology', 'reports'] as const
/** Managing the monitor itself. */
export const MANAGE_PERMISSIONS = ['users', 'roles', 'reports_manage'] as const
export const PERMISSIONS = [...VIEW_PERMISSIONS, ...MANAGE_PERMISSIONS] as const
export type Permission = (typeof PERMISSIONS)[number]

/** Catalog for the role form: grouped, Thai labels; env scope applies to view permissions only. */
export const PERMISSION_CATALOG = [
  {
    group: 'view',
    label: 'ดูข้อมูล',
    envScoped: true,
    items: [
      { id: 'overview', label: 'ภาพรวม', detail: 'KPI, route, สถานะระบบ' },
      { id: 'logs', label: 'Logs', detail: 'ค้นหา log ทุกบรรทัด' },
      { id: 'traces', label: 'Traces', detail: 'รายการ trace, waterfall, request/response ที่ capture ไว้' },
      { id: 'errors', label: 'Errors', detail: 'กลุ่ม error และรายละเอียด' },
      { id: 'jobs', label: 'Jobs', detail: 'งานเบื้องหลัง, คิว, สถานะ dependency' },
      { id: 'topology', label: 'แผนที่ระบบ', detail: 'service, DB, Redis, คิว และ host:port' },
      { id: 'reports', label: 'รายงาน', detail: 'รายงานประจำวัน' },
    ],
  },
  {
    group: 'manage',
    label: 'จัดการระบบ',
    envScoped: false,
    items: [
      { id: 'users', label: 'ผู้ใช้', detail: 'สร้าง แก้ไข ระงับ ลบ รีเซ็ตรหัสผ่าน' },
      { id: 'roles', label: 'Role', detail: 'สร้าง แก้ไข ลบ role และสิทธิ์' },
      { id: 'reports_manage', label: 'จัดการรายงาน', detail: 'สร้างรายงานใหม่ / ย้อนหลัง' },
    ],
  },
] as const

export function isPermission(value: unknown): value is Permission {
  return (PERMISSIONS as readonly unknown[]).includes(value)
}

export function isViewPermission(value: Permission): boolean {
  return (VIEW_PERMISSIONS as readonly string[]).includes(value)
}

/** One permission of a role; `envs` empty = every env (always empty for manage permissions). */
export interface Grant {
  permission: Permission
  envs: string[]
}

/** Every env, every permission. */
export const ALL_GRANTS: Grant[] = PERMISSIONS.map((permission) => ({ permission, envs: [] }))

/** Per permission: undefined = not granted, 'all' = every env, else the envs. */
export type Effective = Partial<Record<Permission, 'all' | string[]>>

/** The union of grants as (permission, env) pairs. */
export function effectiveGrants(grants: Grant[]): Effective {
  const out: Effective = {}
  for (const grant of grants) {
    const current = out[grant.permission]
    if (current === 'all') continue
    if (!grant.envs.length || !isViewPermission(grant.permission)) {
      out[grant.permission] = 'all'
      continue
    }
    out[grant.permission] = [...new Set([...(current ?? []), ...grant.envs])].sort()
  }
  return out
}

/** Whether `env` (undefined = every env at once) may be read with `permission`. */
export function allows(effective: Effective, permission: Permission, env?: string): boolean {
  const scope = effective[permission]
  if (!scope) return false
  if (scope === 'all') return true
  return env !== undefined && scope.includes(env)
}

/** True when every pair of `wanted` is also in `have` (no one hands out more than they hold). */
export function covers(have: Effective, wanted: Effective): boolean {
  return (Object.keys(wanted) as Permission[]).every((permission) => {
    const want = wanted[permission]
    const own = have[permission]
    if (!want) return true
    if (!own) return false
    if (own === 'all') return true
    if (want === 'all') return false
    return want.every((env) => own.includes(env))
  })
}

const ENV_NAME = /^[\w.:/@-]{1,128}$/

/** Validates and normalises grants from a request; throws a message for a 400. */
export function parseGrants(raw: unknown): Grant[] {
  if (!Array.isArray(raw)) throw new Error('grants must be an array of { permission, envs }')
  const byPermission = new Map<Permission, Set<string> | 'all'>()
  for (const item of raw) {
    const permission = (item as Grant | null)?.permission
    if (!isPermission(permission)) throw new Error(`unknown permission ${String(permission)}; use one of ${PERMISSIONS.join(', ')}`)
    const envs = (item as Grant).envs ?? []
    if (!Array.isArray(envs) || envs.some((e) => typeof e !== 'string' || !ENV_NAME.test(e))) {
      throw new Error(`envs of ${permission} must be a list of env names`)
    }
    const current = byPermission.get(permission)
    if (current === 'all') continue
    if (!envs.length || !isViewPermission(permission)) byPermission.set(permission, 'all')
    else byPermission.set(permission, new Set([...(current ?? []), ...envs]))
  }
  return PERMISSIONS.filter((p) => byPermission.has(p)).map((permission) => {
    const scope = byPermission.get(permission)!
    return { permission, envs: scope === 'all' ? [] : [...scope].sort() }
  })
}
