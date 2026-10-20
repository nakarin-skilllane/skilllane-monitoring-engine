import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'

/** Rejects requests without a demo user; the log line is auth.rejected. */
@Injectable()
export class DemoAuthGuard implements CanActivate {
  private readonly logger = new Logger(DemoAuthGuard.name)

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest()
    if (req.user?.id) return true
    this.logger.warn('Authentication rejected', {
      event: 'auth.rejected',
      reason: 'missing_user_header',
    })
    throw new UnauthorizedException('Missing x-demo-user header')
  }
}
