import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common'
import { DemoAuthGuard } from '../common/demo-auth.guard'
import type { DemoUser } from '../common/demo-user.middleware'
import { passwordHash } from '../common/school-data'
import { between, sleep } from '../common/util'
import { OracleClient } from '../infra/oracle'
import { ClassroomRepository } from './classes.handlers'

interface ProfileBody {
  displayName?: string
  email?: string
  phone?: string
  nationalId?: string
  birthDate?: string
  guardian?: { name?: string; phone?: string; nationalId?: string }
  security?: { currentPassword?: string; newPassword?: string; confirmPassword?: string }
}

@Controller('me')
export class MeController {
  constructor(
    private readonly oracle: OracleClient,
    private readonly classrooms: ClassroomRepository,
  ) {}

  @Get()
  @UseGuards(DemoAuthGuard)
  me(@Req() req: { user?: DemoUser }) {
    return req.user
  }

  /** The profile screen: personal data and, optionally, a new password. */
  @Put('profile')
  @UseGuards(DemoAuthGuard)
  async profile(@Req() req: { user?: DemoUser }, @Body() body: ProfileBody) {
    const userId = req.user?.id ?? 'anonymous'
    const studentId = Number(userId.replace(/\D/g, '')) * 10 || 1
    const passwordChanged = !!body.security?.newPassword
    if (passwordChanged) {
      await this.oracle.run(
        'UPDATE',
        'APP_USER',
        'UPDATE "APP"."APP_USER" SET "PASSWORD_HASH" = :1, "PASSWORD_CHANGED_AT" = :2 WHERE "ID" = :3',
        () => sleep(between(10, 40)),
        [passwordHash(body.security!.newPassword!), new Date(), userId],
      )
    }
    await this.classrooms.updateProfile(studentId, {
      displayName: body.displayName ?? userId,
      email: body.email ?? `${userId}@school.demo`,
      birthDate: body.birthDate,
    })
    return {
      id: userId,
      studentId,
      displayName: body.displayName,
      email: body.email,
      phone: body.phone,
      passwordChanged,
      updatedAt: new Date().toISOString(),
    }
  }
}
