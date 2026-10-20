import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AuthService, type Principal } from './auth.service'
import { type Effective, isViewPermission, type Permission } from './permissions'

const PUBLIC_KEY = 'skilllane-monitoring:public'
const PERMISSION_KEY = 'skilllane-monitoring:permission'

/** No session needed (health, ingest, login, set-password). */
export const Public = () => SetMetadata(PUBLIC_KEY, true)

/** The permission a route reads with; view permissions are also checked against `?env=`. */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission)

export const SESSION_COOKIE = 'skilllane_monitoring_session'

export type AuthedRequest = Request & { principal?: Principal }

/** Bearer token, else the session cookie (the monitor's /engine/* rewrite forwards it). */
export function sessionToken(req: Request): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization?.trim() ?? '')
  if (bearer) return bearer[1]
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** Envs the principal can read with any view permission; 'all' when one of them covers every env. */
export function viewableEnvs(effective: Effective): 'all' | string[] {
  const envs = new Set<string>()
  for (const [permission, scope] of Object.entries(effective)) {
    if (!scope || !isViewPermission(permission as Permission)) continue
    if (scope === 'all') return 'all'
    for (const env of scope) envs.add(env)
  }
  return [...envs].sort()
}

/**
 * Global guard (APP_GUARD, roles api / all): every route needs a session
 * unless @Public(). @RequirePermission(p) also needs p; for a view
 * permission limited to some envs, `env` must be one of them, so a limited
 * user reads one allowed env at a time (every query filters on `env`) and
 * never "all envs".
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true

    const req = context.switchToHttp().getRequest<AuthedRequest>()
    const token = sessionToken(req)
    const principal = token ? await this.auth.resolve(token) : undefined
    if (!principal) throw new UnauthorizedException('กรุณาเข้าสู่ระบบ')
    req.principal = principal

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, targets)
    if (!permission) return true
    const scope = principal.effective[permission]
    if (!scope) throw new ForbiddenException(`ไม่มีสิทธิ์ ${permission}`)
    if (scope === 'all' || !isViewPermission(permission)) return true

    const env = typeof req.query.env === 'string' ? req.query.env.trim() : ''
    if (!env) throw new ForbiddenException(`สิทธิ์ ${permission} ดูได้เฉพาะ env ${scope.join(', ')}: เลือก env ก่อน`)
    if (!scope.includes(env)) throw new ForbiddenException(`ไม่มีสิทธิ์ ${permission} ใน env ${env}`)
    return true
  }
}
