import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import { randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { accessToken, emailOf, passwordHash, studentName } from '../common/school-data'
import { between, chance, sleep } from '../common/util'
import { OracleClient } from '../infra/oracle'

interface LoginBody {
  email?: string
  password?: string
  rememberMe?: boolean
  device?: { platform?: string; appVersion?: string }
}

/**
 * Sign-in with email + password: the request body (password), the response
 * body (tokens, email) and the Set-Cookie header are what the SDK masks.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name)

  constructor(private readonly oracle: OracleClient) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = (body.email ?? '').trim().toLowerCase()
    const userNumber = Number(email.replace(/\D/g, '').slice(0, 4)) || between(1001, 1025)
    const userId = `u_${userNumber}`
    const user = await this.oracle.run(
      'SELECT',
      'APP_USER',
      'SELECT "ID", "EMAIL", "PASSWORD_HASH", "DISPLAY_NAME", "ROLE", "SCHOOL_ID" FROM "APP"."APP_USER" WHERE LOWER("EMAIL") = :1 AND "STATUS" = :2',
      async () => {
        await sleep(between(10, 40))
        return {
          id: userId,
          email: email || emailOf(userId),
          displayName: studentName(userNumber),
          role: 'teacher',
          schoolId: `s_${101 + (userNumber % 6)}`,
          passwordHash: passwordHash(body.password ?? ''),
        }
      },
      [email, 'ACTIVE'],
    )
    // Wrong password: the hash does not match.
    if (!body.password || chance(0.15)) {
      this.logger.warn('Authentication rejected', {
        event: 'auth.rejected',
        reason: 'invalid_password',
      })
      throw new UnauthorizedException('Invalid email or password')
    }
    const refreshToken = randomBytes(32).toString('base64url')
    await this.oracle.run(
      'INSERT',
      'USER_SESSION',
      'INSERT INTO "APP"."USER_SESSION" ("ID", "USER_ID", "REFRESH_TOKEN_HASH", "USER_AGENT", "IP_ADDRESS", "EXPIRES_AT") VALUES (:1, :2, :3, :4, :5, :6)',
      () => sleep(between(10, 30)),
      [
        randomBytes(8).toString('hex'),
        user.id,
        passwordHash(refreshToken),
        req.headers['user-agent'] ?? '',
        req.ip ?? '',
        new Date(Date.now() + (body.rememberMe ? 30 : 1) * 86_400_000),
      ],
    )
    res.cookie('session', randomBytes(16).toString('hex'), { httpOnly: true, sameSite: 'lax' })
    return {
      accessToken: accessToken(user.id, user.schoolId, user.role),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: 3_600,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        schoolId: user.schoolId,
      },
    }
  }
}
