import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { AccessService } from './access.service'
import { type AuthedRequest, Public, RequirePermission, SESSION_COOKIE, viewableEnvs } from './auth.guard'
import { AuthService, type Principal } from './auth.service'
import { PERMISSION_CATALOG } from './permissions'

type Json = Record<string, unknown>

/** httpOnly session cookie; Secure when the monitor is served over https (x-forwarded-proto). */
function setSession(req: AuthedRequest, res: Response, token: string, maxAgeS: number): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: maxAgeS * 1000, secure })
}

function me(p: Principal) {
  return {
    id: p.id,
    username: p.username,
    name: p.name,
    kind: p.kind,
    roleIds: p.roleIds,
    permissions: p.effective,
    /** Envs any view permission reaches; 'all' or a list (the monitor's env picker). */
    envs: viewableEnvs(p.effective),
  }
}

const principal = (req: AuthedRequest): Principal => req.principal!

/**
 * /api/auth: login (sets the httpOnly cookie skilllane_monitoring_session), logout, me,
 * change password, set password from a link. The monitor calls these through
 * its /engine/* rewrite, so the cookie belongs to the monitor's origin.
 */
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: Json, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const { token, maxAgeS, principal: p } = await this.auth.login(username, password)
    setSession(req, res, token, maxAgeS)
    return me(p)
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' })
  }

  @Get('me')
  whoami(@Req() req: AuthedRequest) {
    return me(principal(req))
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: Json, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const { token, maxAgeS } = await this.auth.changePassword(
      principal(req),
      typeof body?.currentPassword === 'string' ? body.currentPassword : '',
      body?.newPassword as string,
    )
    setSession(req, res, token, maxAgeS)
    return { ok: true }
  }

  /** Who the link is for (the page shows it); 410 when used or expired. */
  @Public()
  @Get('invite/:token')
  async invite(@Param('token') token: string) {
    const user = await this.auth.inviteOwner(token)
    if (!user) return { valid: false }
    return { valid: true, username: user.username, name: user.name, purpose: user.invitePurpose }
  }

  @Public()
  @Post('set-password')
  @HttpCode(200)
  async setPassword(@Body() body: Json) {
    const user = await this.auth.setPasswordWithInvite(String(body?.token ?? ''), body?.password as string)
    return { ok: true, username: user.username }
  }

  /** The permissions a role can turn on, grouped for the form. */
  @Get('permissions')
  permissions() {
    return { groups: PERMISSION_CATALOG }
  }
}

@Controller('api/users')
export class UsersController {
  constructor(private readonly access: AccessService) {}

  @RequirePermission('users')
  @Get()
  list() {
    return this.access.listUsers().then((users) => ({ users }))
  }

  @RequirePermission('users')
  @Post()
  create(@Body() body: Json, @Req() req: AuthedRequest) {
    return this.access.createUser(principal(req), body ?? {})
  }

  @RequirePermission('users')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Json, @Req() req: AuthedRequest) {
    return this.access.updateUser(principal(req), id, body ?? {})
  }

  @RequirePermission('users')
  @Post(':id/ban')
  @HttpCode(200)
  ban(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.access.setBanned(principal(req), id, true)
  }

  @RequirePermission('users')
  @Post(':id/unban')
  @HttpCode(200)
  unban(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.access.setBanned(principal(req), id, false)
  }

  /** The open set-password link of a pending user (shown again on the edit form). */
  @RequirePermission('users')
  @Get(':id/invite')
  invite(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.access.currentInvite(principal(req), id)
  }

  @RequirePermission('users')
  @Post(':id/reset-password')
  @HttpCode(200)
  reset(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.access.resetPassword(principal(req), id)
  }

  @RequirePermission('users')
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.access.deleteUser(principal(req), id)
  }
}

@Controller('api/roles')
export class RolesController {
  constructor(private readonly access: AccessService) {}

  /** Listed for `users` too: the user form picks roles. */
  @Get()
  list(@Req() req: AuthedRequest) {
    const p = principal(req)
    if (!p.effective.users && !p.effective.roles) return { roles: [] }
    return this.access.listRoles().then((roles) => ({ roles }))
  }

  @RequirePermission('roles')
  @Post()
  create(@Body() body: Json, @Req() req: AuthedRequest) {
    return this.access.createRole(principal(req), body ?? {})
  }

  @RequirePermission('roles')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Json, @Req() req: AuthedRequest) {
    return this.access.updateRole(principal(req), id, body ?? {})
  }

  @RequirePermission('roles')
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string, @Query('force') force: string | undefined, @Req() req: AuthedRequest) {
    return this.access.deleteRole(principal(req), id, force === 'true')
  }
}
