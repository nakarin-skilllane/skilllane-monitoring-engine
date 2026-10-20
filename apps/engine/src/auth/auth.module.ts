import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AccessService } from './access.service'
import { AuthController, RolesController, UsersController } from './auth.controller'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { AuthStore } from './auth.store'

/**
 * Monitor users, roles and sessions (roles api / all). AuthGuard is global:
 * every route needs a session unless @Public().
 */
@Module({
  controllers: [AuthController, UsersController, RolesController],
  providers: [AuthStore, AuthService, AccessService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
