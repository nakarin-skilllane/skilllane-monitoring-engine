import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { config } from '../config'
import { type RoleRecord, AuthStore, type UserRecord } from './auth.store'
import { hashPassword, sameSecret, sha256, type SessionClaims, signSession, verifyPassword, verifySession } from './crypto'
import { ALL_GRANTS, type Effective, effectiveGrants } from './permissions'

/** Sub of the env admin's sessions (it has no row). */
export const ENV_ADMIN_ID = 'env-admin'

/** Who is calling, resolved from the session on every request. */
export interface Principal {
  id: string
  username: string
  name: string
  /** env = SKILLLANE_MONITORING_ADMIN_USERNAME / SKILLLANE_MONITORING_ADMIN_PASSWORD. */
  kind: 'env' | 'user'
  roleIds: string[]
  effective: Effective
}

const CACHE_MS = 10_000
const FAIL_LIMIT = 5
const FAIL_WINDOW_MS = 15 * 60_000
export const MIN_PASSWORD = 12
const INVALID_LOGIN = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'

interface Attempts {
  count: number
  since: number
}

/**
 * Login, sessions, passwords. A session is an HS256 JWT (SKILLLANE_MONITORING_AUTH_SECRET)
 * carrying the user id and token_version; every request re-reads the user
 * and their roles (cached 10 s), so a ban, a reset or a role change applies
 * within 10 s, and a ban / reset ends older sessions at once on this engine.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth')
  private readonly users = new Map<string, { at: number; user?: UserRecord }>()
  private roles?: { at: number; roles: RoleRecord[] }
  private readonly failures = new Map<string, Attempts>()

  constructor(private readonly store: AuthStore) {
    if (!config.auth.secretFromEnv) {
      this.logger.log('SKILLLANE_MONITORING_AUTH_SECRET is not set: sessions are signed with a random key and end when the engine restarts')
    }
    if (!this.envAdminEnabled()) {
      this.logger.log('SKILLLANE_MONITORING_ADMIN_USERNAME / SKILLLANE_MONITORING_ADMIN_PASSWORD not set: no admin login')
    }
  }

  envAdminEnabled(): boolean {
    return !!(config.auth.adminUsername && config.auth.adminPassword)
  }

  /** Changes with the env admin's credentials: new ones end its older sessions. */
  private envAdminVersion(): string {
    return sha256(`${config.auth.adminUsername}\u0000${config.auth.adminPassword}`).slice(0, 16)
  }

  // --- login -------------------------------------------------------------------

  /**
   * Failed attempts are counted per username (5 in 15 min lock it), not per IP:
   * behind the monitor every login comes from the monitor's address.
   */
  async login(usernameRaw: string, password: string): Promise<{ token: string; maxAgeS: number; principal: Principal }> {
    const username = usernameRaw.trim().toLowerCase()
    this.checkLocked(`u:${username}`)

    let claimsFor: { sub: string; ver: string } | undefined
    if (
      this.envAdminEnabled() &&
      sameSecret(username, config.auth.adminUsername!.toLowerCase()) &&
      sameSecret(password, config.auth.adminPassword!)
    ) {
      claimsFor = { sub: ENV_ADMIN_ID, ver: this.envAdminVersion() }
    } else {
      const user = await this.store.getUserByUsername(username)
      const ok = !!user?.passwordHash && (await verifyPassword(password, user.passwordHash))
      if (ok && user!.status === 'banned') {
        throw new HttpException('บัญชีนี้ถูกระงับ', HttpStatus.FORBIDDEN)
      }
      if (ok) {
        claimsFor = { sub: user!.id, ver: String(user!.tokenVersion) }
        await this.store.saveUser({ ...user!, lastLoginAt: new Date().toISOString() })
        this.forget(user!.id)
      }
    }
    if (!claimsFor) {
      this.fail(`u:${username}`)
      throw new UnauthorizedException(INVALID_LOGIN)
    }
    this.failures.delete(`u:${username}`)
    const maxAgeS = config.auth.sessionHours * 3600
    const iat = Math.floor(Date.now() / 1000)
    const token = signSession({ ...claimsFor, iat, exp: iat + maxAgeS }, config.auth.secret)
    const principal = await this.principalFor(claimsFor.sub, claimsFor.ver)
    return { token, maxAgeS, principal: principal! }
  }

  private checkLocked(key: string): void {
    const a = this.failures.get(key)
    if (!a) return
    if (Date.now() - a.since > FAIL_WINDOW_MS) {
      this.failures.delete(key)
      return
    }
    if (a.count >= FAIL_LIMIT) {
      throw new HttpException('ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที', HttpStatus.TOO_MANY_REQUESTS)
    }
  }

  private fail(key: string): void {
    const a = this.failures.get(key)
    if (!a || Date.now() - a.since > FAIL_WINDOW_MS) this.failures.set(key, { count: 1, since: Date.now() })
    else a.count += 1
    if (this.failures.size > 10_000) this.failures.clear()
  }

  // --- sessions ------------------------------------------------------------------

  /** The caller of a session token, or undefined (expired, wrong signature, banned, deleted, reset). */
  async resolve(token: string): Promise<Principal | undefined> {
    const claims: SessionClaims | undefined = verifySession(token, config.auth.secret)
    if (!claims) return undefined
    return this.principalFor(claims.sub, claims.ver)
  }

  private async principalFor(sub: string, ver: string): Promise<Principal | undefined> {
    if (sub === ENV_ADMIN_ID) {
      if (!this.envAdminEnabled() || ver !== this.envAdminVersion()) return undefined
      return {
        id: ENV_ADMIN_ID,
        username: config.auth.adminUsername!,
        name: 'System admin',
        kind: 'env',
        roleIds: [],
        effective: effectiveGrants(ALL_GRANTS),
      }
    }
    const user = await this.cachedUser(sub)
    if (!user || user.status !== 'active' || String(user.tokenVersion) !== ver) return undefined
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      kind: 'user',
      roleIds: user.roleIds,
      effective: await this.effectiveOf(user.roleIds),
    }
  }

  async effectiveOf(roleIds: string[]): Promise<Effective> {
    const roles = await this.cachedRoles()
    return effectiveGrants(roles.filter((r) => roleIds.includes(r.id)).flatMap((r) => r.grants))
  }

  private async cachedUser(id: string): Promise<UserRecord | undefined> {
    const hit = this.users.get(id)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.user
    const user = await this.store.getUser(id)
    this.users.set(id, { at: Date.now(), user })
    if (this.users.size > 5_000) this.users.clear()
    return user
  }

  async cachedRoles(): Promise<RoleRecord[]> {
    if (this.roles && Date.now() - this.roles.at < CACHE_MS) return this.roles.roles
    const roles = await this.store.listRoles()
    this.roles = { at: Date.now(), roles }
    return roles
  }

  /** After a change on this engine: no stale read here (other engines catch up within 10 s). */
  forget(userId?: string): void {
    if (userId) this.users.delete(userId)
    else this.users.clear()
    this.roles = undefined
  }

  // --- passwords -----------------------------------------------------------------

  checkPasswordRule(password: unknown): string {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new HttpException(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`, HttpStatus.BAD_REQUEST)
    }
    if (password.length > 256) throw new HttpException('รหัสผ่านยาวเกินไป', HttpStatus.BAD_REQUEST)
    return password
  }

  /** Who a set-password link belongs to (valid and not expired), for the page to greet. */
  async inviteOwner(token: string): Promise<UserRecord | undefined> {
    const user = await this.store.getUserByInvite(sha256(token))
    if (!user || !user.inviteExpiresAt || Date.parse(user.inviteExpiresAt) < Date.now()) return undefined
    return user
  }

  /** Uses a set-password link once: sets the password, closes the link, ends older sessions. */
  async setPasswordWithInvite(token: string, password: string): Promise<UserRecord> {
    this.checkPasswordRule(password)
    const user = await this.inviteOwner(token)
    if (!user) throw new HttpException('ลิงก์นี้ใช้ไม่ได้แล้ว หรือหมดอายุ ขอลิงก์ใหม่จากผู้ดูแล', HttpStatus.GONE)
    const updated: UserRecord = {
      ...user,
      passwordHash: await hashPassword(password),
      inviteHash: '',
      invitePurpose: '',
      inviteExpiresAt: null,
      tokenVersion: user.tokenVersion + 1,
    }
    await this.store.saveUser(updated)
    this.forget(user.id)
    return updated
  }

  async changePassword(principal: Principal, current: string, next: string): Promise<{ token: string; maxAgeS: number }> {
    if (principal.kind === 'env') {
      throw new HttpException('รหัสของผู้ดูแลระบบตั้งจาก SKILLLANE_MONITORING_ADMIN_PASSWORD', HttpStatus.BAD_REQUEST)
    }
    this.checkPasswordRule(next)
    const user = await this.store.getUser(principal.id)
    if (!user?.passwordHash || !(await verifyPassword(current ?? '', user.passwordHash))) {
      throw new HttpException('รหัสผ่านปัจจุบันไม่ถูกต้อง', HttpStatus.BAD_REQUEST)
    }
    const updated = { ...user, passwordHash: await hashPassword(next), tokenVersion: user.tokenVersion + 1 }
    await this.store.saveUser(updated)
    this.forget(user.id)
    // This browser stays signed in with a fresh session; others end.
    const maxAgeS = config.auth.sessionHours * 3600
    const iat = Math.floor(Date.now() / 1000)
    return {
      token: signSession({ sub: user.id, ver: String(updated.tokenVersion), iat, exp: iat + maxAgeS }, config.auth.secret),
      maxAgeS,
    }
  }
}
