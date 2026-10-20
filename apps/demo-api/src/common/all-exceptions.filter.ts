import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'

/**
 * Like school-core-api's exception filter: every error is logged with the
 * error object (hint, fix, origin come from skilllane-monitoring), 4xx end up at
 * warn, 5xx at error. A TypeORM-style EntityNotFoundError answers 404.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // No context on purpose: the line is attributed to the class that threw.
  private readonly logger = new Logger()

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const res = http.getResponse()
    const { status, body } = responseFor(exception)
    // 401 already has its auth.rejected line from the guard.
    if (status !== HttpStatus.UNAUTHORIZED) this.logger.error(exception)
    const requestId = res.getHeader?.('request-id')
    this.adapterHost.httpAdapter.reply(
      res,
      requestId ? { ...body, requestId } : body,
      status,
    )
  }
}

function responseFor(exception: unknown): { status: number; body: object } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus()
    const response = exception.getResponse()
    return {
      status,
      body:
        typeof response === 'object'
          ? response
          : { statusCode: status, message: response },
    }
  }
  if ((exception as Error)?.name === 'EntityNotFoundError') {
    return {
      status: HttpStatus.NOT_FOUND,
      body: { statusCode: 404, message: 'Not Found', error: 'Not Found' },
    }
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { statusCode: 500, message: 'Internal server error' },
  }
}
