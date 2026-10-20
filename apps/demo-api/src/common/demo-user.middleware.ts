import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'

export interface DemoUser {
  id: string
  schoolId?: string
  currentRole?: string
}

/**
 * Stands in for the real auth guard: the demo user comes from headers
 * (x-demo-user, x-demo-school, current-role). skilllane-monitoring reads req.user
 * (id, schoolId, currentRole) for user.id, organization.id and user.roles.
 */
@Injectable()
export class DemoUserMiddleware implements NestMiddleware {
  use(req: Request & { user?: DemoUser }, _res: Response, next: NextFunction) {
    const id = header(req, 'x-demo-user')
    if (id) {
      req.user = {
        id,
        schoolId: header(req, 'x-demo-school'),
        currentRole: header(req, 'current-role'),
      }
    }
    next()
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name]
  const first = Array.isArray(value) ? value[0] : value
  return first?.trim() || undefined
}
