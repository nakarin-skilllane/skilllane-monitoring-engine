import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { config } from '../config'
import { ADMIN_ROLE_ID, AuthStore, type RoleRecord, type UserRecord, userIdFor } from './auth.store'
import { AuthService, type Principal } from './auth.service'
import { inviteToken, sha256 } from './crypto'
import { ALL_GRANTS, covers, effectiveGrants, type Effective, type Grant, parseGrants } from './permissions'

const INVITE_HOURS = 72
const USERNAME = /^[a-z0-9][a-z0-9._@+-]{1,127}$/

export interface UserView {
  id: string
  username: string
  name: string
  status: 'active' | 'banned' | 'pending'
  roleIds: string[]
  /** What the roles add up to, and which roles give each permission. */
  effective: Effective
  grantedBy: Record<string, string[]>
  lastLoginAt: string | null
  createdAt: string
  /** Pending only: until when the set-password link works (null = no open link, or expired). */
  inviteExpiresAt: string | null
  /** Set a password from a link (a banned user keeps this; status alone does not tell). */
  hasPassword: boolean
  /** The env admin (SKILLLANE_MONITORING_ADMIN_*): shown, never changed here. */
  system: boolean
}

export interface RoleView extends Omit<RoleRecord, 'deleted'> {
  userCount: number
}

/** A set-password link for the monitor to show once: the token is never stored, only its hash. */
export interface Invite {
  token: string
  expiresAt: string
}

/**
 * Users and roles, with the rules that keep the monitor safe:
 * - nobody hands out more than they hold: the roles given to a user, and the
 *   grants of a role created or changed, must be covered by the caller's own
 *   (the env admin holds everything);
 * - nobody changes their own account here (roles, ban, delete, reset);
 * - the admin role (builtin) cannot be changed or deleted.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly store: AuthStore,
    private readonly auth: AuthService,
  ) {}

  // --- users -----------------------------------------------------------------

  async listUsers(): Promise<UserView[]> {
    const [users, roles] = await Promise.all([this.store.listUsers(), this.store.listRoles()])
    const views = users.map((u) => this.userView(u, roles))
    if (this.auth.envAdminEnabled()) views.unshift(this.envAdminView())
    return views
  }

  async createUser(actor: Principal, body: { username?: unknown; name?: unknown; roleIds?: unknown }) {
    const username = this.username(body.username)
    const name = this.text(body.name, 'name', 120) || username
    const roleIds = await this.roleIds(actor, body.roleIds)
    if (await this.store.getUserByUsername(username)) throw new ConflictException(`มีผู้ใช้ ${username} อยู่แล้ว`)
    const id = userIdFor(username)
    const invite = this.newInvite(id)
    const user: UserRecord = {
      id,
      username,
      name,
      passwordHash: '',
      status: 'active',
      roleIds,
      tokenVersion: 0,
      inviteHash: sha256(invite.token),
      invitePurpose: 'set',
      inviteExpiresAt: invite.expiresAt,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      deleted: false,
    }
    await this.store.saveUser(user)
    this.auth.forget(user.id)
    return { user: this.userView(user, await this.store.listRoles()), invite }
  }

  async updateUser(actor: Principal, id: string, body: { name?: unknown; roleIds?: unknown }) {
    const user = await this.target(actor, id)
    const next = { ...user }
    if (body.name !== undefined) next.name = this.text(body.name, 'name', 120) || user.username
    if (body.roleIds !== undefined) {
      const roleIds = await this.roleIds(actor, body.roleIds)
      // Taking roles away is also limited to roles the caller could hand out.
      const removed = user.roleIds.filter((r) => !roleIds.includes(r))
      await this.assertCanHandOut(actor, removed)
      next.roleIds = roleIds
    }
    await this.store.saveUser(next)
    this.auth.forget(id)
    return this.userView(next, await this.store.listRoles())
  }

  async setBanned(actor: Principal, id: string, banned: boolean) {
    const user = await this.target(actor, id)
    const next: UserRecord = {
      ...user,
      status: banned ? 'banned' : 'active',
      tokenVersion: banned ? user.tokenVersion + 1 : user.tokenVersion,
    }
    await this.store.saveUser(next)
    this.auth.forget(id)
    return this.userView(next, await this.store.listRoles())
  }

  /** The open set-password link of a user who has not set a password yet; 404 when there is none or it expired. */
  async currentInvite(actor: Principal, id: string): Promise<{ invite: Invite }> {
    const user = await this.target(actor, id)
    const open = !user.passwordHash && user.inviteHash && user.inviteExpiresAt && Date.parse(user.inviteExpiresAt) > Date.now()
    if (!open) throw new NotFoundException('ไม่มีลิงก์ที่ยังใช้ได้ ออกลิงก์ใหม่ได้')
    const token = inviteToken(config.auth.secret, user.id, user.inviteExpiresAt!)
    // another SKILLLANE_MONITORING_AUTH_SECRET since the link was made (a restart without one): the link is gone
    if (sha256(token) !== user.inviteHash) throw new NotFoundException('ลิงก์เดิมใช้ไม่ได้แล้ว (engine เปลี่ยน SKILLLANE_MONITORING_AUTH_SECRET) ออกลิงก์ใหม่ได้')
    return { invite: { token, expiresAt: user.inviteExpiresAt! } }
  }

  /** New set-password link; the old password and every session stop working now. */
  async resetPassword(actor: Principal, id: string): Promise<{ invite: Invite }> {
    const user = await this.target(actor, id)
    const invite = this.newInvite(user.id)
    await this.store.saveUser({
      ...user,
      passwordHash: '',
      inviteHash: sha256(invite.token),
      invitePurpose: user.passwordHash ? 'reset' : 'set',
      inviteExpiresAt: invite.expiresAt,
      tokenVersion: user.tokenVersion + 1,
    })
    this.auth.forget(id)
    return { invite }
  }

  async deleteUser(actor: Principal, id: string): Promise<void> {
    const user = await this.target(actor, id)
    await this.store.saveUser({ ...user, deleted: true, inviteHash: '', tokenVersion: user.tokenVersion + 1 })
    this.auth.forget(id)
  }

  // --- roles -----------------------------------------------------------------

  async listRoles(): Promise<RoleView[]> {
    const [roles, users] = await Promise.all([this.store.listRoles(), this.store.listUsers()])
    return roles.map(({ deleted: _d, ...role }) => ({
      ...role,
      userCount: users.filter((u) => u.roleIds.includes(role.id)).length,
    }))
  }

  async createRole(actor: Principal, body: { name?: unknown; description?: unknown; grants?: unknown }) {
    const name = this.roleName(body.name)
    await this.assertRoleNameFree(name)
    const grants = this.grants(actor, body.grants)
    const role: RoleRecord = {
      id: this.store.newRoleId(),
      name,
      description: this.text(body.description, 'description', 300),
      grants,
      builtin: false,
      createdAt: new Date().toISOString(),
      deleted: false,
    }
    await this.store.saveRole(role)
    this.auth.forget()
    return { ...role, userCount: 0 }
  }

  async updateRole(actor: Principal, id: string, body: { name?: unknown; description?: unknown; grants?: unknown }) {
    const role = await this.editableRole(actor, id)
    const next = { ...role }
    if (body.name !== undefined) {
      next.name = this.roleName(body.name)
      if (next.name.toLowerCase() !== role.name.toLowerCase()) await this.assertRoleNameFree(next.name)
    }
    if (body.description !== undefined) next.description = this.text(body.description, 'description', 300)
    if (body.grants !== undefined) next.grants = this.grants(actor, body.grants)
    await this.store.saveRole(next)
    this.auth.forget()
    return next
  }

  /** In use: 409 with the users, unless `force` (then it is taken off them). */
  async deleteRole(actor: Principal, id: string, force: boolean): Promise<void> {
    const role = await this.editableRole(actor, id)
    const holders = (await this.store.listUsers()).filter((u) => u.roleIds.includes(id))
    if (holders.length && !force) {
      throw new ConflictException({
        message: `role ${role.name} ยังมีผู้ใช้ ${holders.length} คน`,
        users: holders.map((u) => u.username),
      })
    }
    for (const user of holders) {
      await this.store.saveUser({ ...user, roleIds: user.roleIds.filter((r) => r !== id) })
    }
    await this.store.saveRole({ ...role, deleted: true })
    this.auth.forget()
  }

  // --- rules -----------------------------------------------------------------

  /** A user the caller may change: exists, is not the caller, is not the env admin. */
  private async target(actor: Principal, id: string): Promise<UserRecord> {
    if (id === actor.id) throw new ForbiddenException('แก้ไขบัญชีของตัวเองจากหน้านี้ไม่ได้')
    const user = await this.store.getUser(id)
    if (!user) throw new NotFoundException('ไม่พบผู้ใช้')
    // Acting on a user who holds more than the caller would let the caller take it over.
    if (user.roleIds.length && !covers(actor.effective, await this.auth.effectiveOf(user.roleIds))) {
      throw new ForbiddenException('จัดการผู้ใช้ที่มีสิทธิ์มากกว่าคุณไม่ได้')
    }
    return user
  }

  private async editableRole(actor: Principal, id: string): Promise<RoleRecord> {
    const role = await this.store.getRole(id)
    if (!role) throw new NotFoundException('ไม่พบ role')
    if (role.builtin || role.id === ADMIN_ROLE_ID) throw new ForbiddenException('role admin แก้ไขหรือลบไม่ได้')
    if (!covers(actor.effective, effectiveGrants(role.grants))) {
      throw new ForbiddenException('role นี้มีสิทธิ์มากกว่าที่คุณมี')
    }
    return role
  }

  private async assertCanHandOut(actor: Principal, roleIds: string[]): Promise<void> {
    if (!roleIds.length) return
    const wanted = await this.auth.effectiveOf(roleIds)
    if (!covers(actor.effective, wanted)) throw new ForbiddenException('ให้หรือถอด role ที่มีสิทธิ์มากกว่าที่คุณมีไม่ได้')
  }

  private async roleIds(actor: Principal, raw: unknown): Promise<string[]> {
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string')) throw new BadRequestException('roleIds ต้องเป็นรายการ id')
    const ids = [...new Set(raw as string[])]
    const known = new Set((await this.store.listRoles()).map((r) => r.id))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length) throw new BadRequestException(`ไม่พบ role ${unknown.join(', ')}`)
    await this.assertCanHandOut(actor, ids)
    return ids
  }

  private grants(actor: Principal, raw: unknown): Grant[] {
    let grants: Grant[]
    try {
      grants = parseGrants(raw ?? [])
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err))
    }
    if (!covers(actor.effective, effectiveGrants(grants))) {
      throw new ForbiddenException('กำหนดสิทธิ์ที่คุณไม่มีให้ role ไม่ได้')
    }
    return grants
  }

  private async assertRoleNameFree(name: string): Promise<void> {
    const taken = (await this.store.listRoles()).some((r) => r.name.toLowerCase() === name.toLowerCase())
    if (taken) throw new ConflictException(`มี role ชื่อ ${name} อยู่แล้ว`)
  }

  private username(raw: unknown): string {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!USERNAME.test(value)) {
      throw new BadRequestException('username ต้องยาว 2–128 ตัว ใช้ a-z 0-9 . _ @ + - (อีเมลก็ได้)')
    }
    return value
  }

  private roleName(raw: unknown): string {
    const value = this.text(raw, 'name', 60)
    if (!value) throw new BadRequestException('ต้องตั้งชื่อ role')
    return value
  }

  private text(raw: unknown, field: string, max: number): string {
    if (raw === undefined || raw === null) return ''
    if (typeof raw !== 'string') throw new BadRequestException(`${field} ต้องเป็นข้อความ`)
    const value = raw.trim()
    if (value.length > max) throw new BadRequestException(`${field} ยาวได้ไม่เกิน ${max} ตัวอักษร`)
    return value
  }

  private newInvite(userId: string): Invite {
    const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000).toISOString()
    return { token: inviteToken(config.auth.secret, userId, expiresAt), expiresAt }
  }

  private userView(user: UserRecord, roles: RoleRecord[]): UserView {
    const mine = roles.filter((r) => user.roleIds.includes(r.id))
    const grantedBy: Record<string, string[]> = {}
    for (const role of mine) {
      for (const grant of role.grants) {
        const key = grant.envs.length ? `${grant.permission}@${grant.envs.join(',')}` : grant.permission
        ;(grantedBy[key] ??= []).push(role.name)
      }
    }
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      status: user.status === 'banned' ? 'banned' : user.passwordHash ? 'active' : 'pending',
      roleIds: user.roleIds.filter((id) => roles.some((r) => r.id === id)),
      effective: effectiveGrants(mine.flatMap((r) => r.grants)),
      grantedBy,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      inviteExpiresAt:
        !user.passwordHash && user.inviteHash && user.inviteExpiresAt && Date.parse(user.inviteExpiresAt) > Date.now()
          ? user.inviteExpiresAt
          : null,
      hasPassword: !!user.passwordHash,
      system: false,
    }
  }

  private envAdminView(): UserView {
    return {
      id: 'env-admin',
      username: config.auth.adminUsername ?? '',
      name: 'System admin (env)',
      status: 'active',
      roleIds: [ADMIN_ROLE_ID],
      effective: effectiveGrants(ALL_GRANTS),
      grantedBy: {},
      lastLoginAt: null,
      createdAt: '',
      inviteExpiresAt: null,
      hasPassword: true,
      system: true,
    }
  }
}
