import { Controller, Get } from '@nestjs/common'
import { config } from '../config'

@Controller()
export class HealthController {
  @Get('health')
  health() {
    return { ok: true, service: config.service, role: config.role }
  }
}
