import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ClickhouseService } from '../clickhouse/clickhouse.service'
import { config } from '../config'
import { sha256 } from './crypto'
import { ALL_GRANTS, type Grant, VIEW_PERMISSIONS } from './permissions'

export type UserStatus = 'active' | 'banned'
export type InvitePurpose = 'set' | 'reset'

export interface UserRecord {
  id: string
  /** Login name, lower case (an email works too). */
  username: string
  name: string
  /** '' until the user has set a password through the link. */
  passwordHash: string
  status: UserStatus
  roleIds: string[]
  /** Bumped on ban, password change / reset and delete: older sessions stop working. */
  tokenVersion: number
  /** sha256 of the one open set-password link; '' when none. */
  inviteHash: string
  invitePurpose: InvitePurpose | ''
  inviteExpiresAt: string | null
  lastLoginAt: string | null
  createdAt: string
  deleted: boolean
}

export interface RoleRecord {
  id: string
  name: string
  description: string
  grants: Grant[]
  /** The admin role: every permission, cannot be changed or deleted. */
  builtin: boolean
  createdAt: string
  deleted: boolean
}

export const ADMIN_ROLE_ID = 'admin'
const VIEWER_ROLE_ID = 'viewer'

/** Same username, same id: a second create of one name lands on the same row. */
export const userIdFor = (username: string): string => sha256(`user:${username.toLowerCase()}`).slice(0, 32)

const ZERO_TIME = '1970-01-01 00:00:00.000'
const toIso = (value: string | null | undefined): string | null =>
  !value || value.startsWith('1970-01-01') ? null : `${value.replace(' ', 'T')}Z`
const toCh = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ').replace('Z', '') : ZERO_TIME)

interface UserRow {
  id: string
  username: string
  name: string
  password_hash: string
  status: string
  role_ids: string[]
  token_version: number
  invite_hash: string
  invite_purpose: string
  invite_expires_at: string
  last_login_at: string
  deleted: number
  created_at: string
}

interface RoleRow {
  id: string
  name: string
  description: string
  grants: string
  builtin: number
  deleted: number
  created_at: string
}

const fromUserRow = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  name: r.name,
  passwordHash: r.password_hash,
  status: r.status === 'banned' ? 'banned' : 'active',
  roleIds: r.role_ids,
  tokenVersion: Number(r.token_version),
  inviteHash: r.invite_hash,
  invitePurpose: r.invite_purpose === 'set' || r.invite_purpose === 'reset' ? r.invite_purpose : '',
  inviteExpiresAt: toIso(r.invite_expires_at),
  lastLoginAt: toIso(r.last_login_at),
  createdAt: toIso(r.created_at) ?? '',
  deleted: Number(r.deleted) === 1,
})

const fromRoleRow = (r: RoleRow): RoleRecord => {
  let grants: Grant[] = []
  try {
    grants = JSON.parse(r.grants)
  } catch {
    grants = []
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    grants,
    builtin: Number(r.builtin) === 1,
    createdAt: toIso(r.created_at) ?? '',
    deleted: Number(r.deleted) === 1,
  }
}

/**
 * Users and roles in ClickHouse database CLICKHOUSE_CONFIG_DATABASE
 * (skilllane_monitoring_config), written and read with the writer user: skilllane_monitoring_reader (query
 * API, AI) has no grant on it. ReplacingMergeTree(updated_at): every change
 * inserts the whole row again; reads use FINAL. Deletes are rows with
 * deleted = 1.
 */
@Injectable()
export class AuthStore implements OnModuleInit {
  private readonly logger = new Logger('AuthStore')
  private readonly db = config.auth.database
  private lastWrite = 0

  constructor(private readonly clickhouse: ClickhouseService) {}

  async onModuleInit(): Promise<void> {
    if (config.applySchema) {
      try {
        await this.applySchema()
      } catch (err) {
        this.logger.error(`Auth schema apply failed: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    await this.seedRoles().catch((err) =>
      this.logger.error(`Default roles not created: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  private async applySchema(): Promise<void> {
    const statements = [
      `CREATE DATABASE IF NOT EXISTS ${this.db}`,
      `CREATE TABLE IF NOT EXISTS ${this.db}.users (
        id String,
        username String,
        name String,
        password_hash String,
        status LowCardinality(String),
        role_ids Array(String),
        token_version UInt32,
        invite_hash String,
        invite_purpose LowCardinality(String),
        invite_expires_at DateTime64(3, 'UTC'),
        last_login_at DateTime64(3, 'UTC'),
        deleted UInt8,
        created_at DateTime64(3, 'UTC'),
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${this.db}.roles (
        id String,
        name String,
        description String,
        grants String,
        builtin UInt8,
        deleted UInt8,
        created_at DateTime64(3, 'UTC'),
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
    ]
    for (const query of statements) await this.clickhouse.writer.command({ query })
  }

  /** admin (builtin, every permission) and viewer (every view permission, every env), once. */
  private async seedRoles(): Promise<void> {
    const roles = await this.listRoles(true)
    const now = new Date().toISOString()
    const admin = roles.find((r) => r.id === ADMIN_ROLE_ID)
    if (!admin) {
      await this.saveRole({
        id: ADMIN_ROLE_ID,
        name: 'admin',
        description: 'ทุกสิทธิ์ ทุก env',
        grants: ALL_GRANTS,
        builtin: true,
        createdAt: now,
        deleted: false,
      })
    } else if (ALL_GRANTS.some((g) => !admin.grants.some((a) => a.permission === g.permission))) {
      // a permission added after the role was seeded (reports, reports_manage): admin always holds every one
      await this.saveRole({ ...admin, grants: ALL_GRANTS })
    }
    if (!roles.some((r) => r.id === VIEWER_ROLE_ID)) {
      await this.saveRole({
        id: VIEWER_ROLE_ID,
        name: 'viewer',
        description: 'ดูข้อมูลทุกหน้า ทุก env',
        grants: VIEW_PERMISSIONS.map((permission) => ({ permission, envs: [] })),
        builtin: false,
        createdAt: now,
        deleted: false,
      })
    }
  }

  /** Strictly increasing version for ReplacingMergeTree, even within one millisecond. */
  private version(): string {
    this.lastWrite = Math.max(Date.now(), this.lastWrite + 1)
    return new Date(this.lastWrite).toISOString()
  }

  private async rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const result = await this.clickhouse.writer.query({ query, query_params: params, format: 'JSONEachRow' })
    return result.json<T>()
  }

  // --- users -----------------------------------------------------------------

  private static readonly USER_COLUMNS =
    'id, username, name, password_hash, status, role_ids, token_version, invite_hash, invite_purpose, ' +
    'toString(invite_expires_at) AS invite_expires_at, toString(last_login_at) AS last_login_at, deleted, ' +
    'toString(created_at) AS created_at'

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.rows<UserRow>(
      `SELECT ${AuthStore.USER_COLUMNS} FROM ${this.db}.users FINAL WHERE deleted = 0 ORDER BY username`,
    )
    return rows.map(fromUserRow)
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const rows = await this.rows<UserRow>(
      `SELECT ${AuthStore.USER_COLUMNS} FROM ${this.db}.users FINAL WHERE id = {id:String} AND deleted = 0`,
      { id },
    )
    return rows[0] ? fromUserRow(rows[0]) : undefined
  }

  async getUserByUsername(username: string): Promise<UserRecord | undefined> {
    return this.getUser(userIdFor(username))
  }

  async getUserByInvite(inviteHash: string): Promise<UserRecord | undefined> {
    const rows = await this.rows<UserRow>(
      `SELECT ${AuthStore.USER_COLUMNS} FROM ${this.db}.users FINAL
       WHERE invite_hash = {inviteHash:String} AND invite_hash != '' AND deleted = 0`,
      { inviteHash },
    )
    return rows[0] ? fromUserRow(rows[0]) : undefined
  }

  async saveUser(user: UserRecord): Promise<void> {
    await this.clickhouse.writer.insert({
      table: `${this.db}.users`,
      format: 'JSONEachRow',
      values: [
        {
          id: user.id,
          username: user.username,
          name: user.name,
          password_hash: user.passwordHash,
          status: user.status,
          role_ids: user.roleIds,
          token_version: user.tokenVersion,
          invite_hash: user.inviteHash,
          invite_purpose: user.invitePurpose,
          invite_expires_at: toCh(user.inviteExpiresAt),
          last_login_at: toCh(user.lastLoginAt),
          deleted: user.deleted ? 1 : 0,
          created_at: toCh(user.createdAt),
          updated_at: toCh(this.version()),
        },
      ],
    })
  }

  // --- roles -----------------------------------------------------------------

  async listRoles(withDeleted = false): Promise<RoleRecord[]> {
    const rows = await this.rows<RoleRow>(
      `SELECT id, name, description, grants, builtin, deleted, toString(created_at) AS created_at
       FROM ${this.db}.roles FINAL ${withDeleted ? '' : 'WHERE deleted = 0'} ORDER BY builtin DESC, name`,
    )
    return rows.map(fromRoleRow)
  }

  async getRole(id: string): Promise<RoleRecord | undefined> {
    return (await this.listRoles()).find((r) => r.id === id)
  }

  async saveRole(role: RoleRecord): Promise<void> {
    await this.clickhouse.writer.insert({
      table: `${this.db}.roles`,
      format: 'JSONEachRow',
      values: [
        {
          id: role.id,
          name: role.name,
          description: role.description,
          grants: JSON.stringify(role.grants),
          builtin: role.builtin ? 1 : 0,
          deleted: role.deleted ? 1 : 0,
          created_at: toCh(role.createdAt),
          updated_at: toCh(this.version()),
        },
      ],
    })
  }

  newRoleId(): string {
    return randomUUID()
  }
}
