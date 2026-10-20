import { Injectable } from '@nestjs/common'
import { join } from 'path'
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { instrumentationConfigOf } from 'skilllane-monitoring/otel'

/**
 * Stand-in for node-oracledb: no database, but the same CLIENT spans the
 * oracledb instrumentation makes (name "oracle <OP> <TABLE>", db.system
 * oracle, db.statement) and the same error shapes. With the instrumentation's
 * `enhancedDatabaseReporting` (the skilllane-monitoring default) it also writes what
 * the real one writes for the binds — `db.operation.parameter.<i>` as strings,
 * and its `requestHook` with the execute's arguments, from which the SDK
 * writes the typed, masked `skilllane.monitoring.db.parameters`.
 */
const tracer = trace.getTracer('demo-oracledb')
const INSTRUMENTATION = '@opentelemetry/instrumentation-oracledb'

/** node-oracledb binds: by position (array) or by name (object). */
export type Binds = unknown[] | Record<string, unknown>

/** OracleTelemetryTraceHandler._extractValue of the real instrumentation. */
function extractValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Buffer.isBuffer(value)) return value.toString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** OracleTelemetryTraceHandler._getValues: db.operation.parameter.<index | name>. */
function operationParameters(binds: Binds): Record<string, string> {
  const entries = Array.isArray(binds)
    ? binds.map((value, index) => [String(index), value] as const)
    : Object.entries(binds)
  return Object.fromEntries(
    entries.map(([key, value]) => [`db.operation.parameter.${key}`, extractValue(value)]),
  )
}

/** What the instrumentation does with an execute's statement and binds. */
function reportBinds(span: Span, statement: string, binds: Binds | undefined): void {
  const config = instrumentationConfigOf(INSTRUMENTATION)
  if (!config || !binds) return
  try {
    config.requestHook?.(span, {
      inputArgs: [statement, binds, { autoCommit: true }],
      connection: { hostName: 'oracle.example.internal', port: 1521, serviceName: 'APP', user: 'APP' },
    })
  } catch {
    // like safeExecuteInTheMiddle
  }
  if (config.enhancedDatabaseReporting) span.setAttributes(operationParameters(binds))
}

export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

/** node-oracledb error: `errorNum` + `code` + the ORA message. */
export class OracleDbError extends Error {
  readonly errorNum: number
  readonly code: string
  readonly offset = 0

  constructor(errorNum: number, message: string) {
    super(message)
    this.name = 'Error'
    this.errorNum = errorNum
    this.code = `ORA-${String(errorNum).padStart(5, '0')}`
  }
}

// Frames node-oracledb (thin mode) puts on top of the caller's frames.
const DRIVER = join(process.cwd(), 'node_modules', 'oracledb', 'lib')
const DRIVER_FRAMES = [
  `Protocol._processMessage (${DRIVER}/thin/protocol/protocol.js:179:17)`,
  'process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
  `async ThinConnectionImpl._execute (${DRIVER}/thin/connection.js:195:7)`,
  `async ThinConnectionImpl.execute (${DRIVER}/thin/connection.js:927:14)`,
  `async Connection.execute (${DRIVER}/connection.js:861:16)`,
].map((frame) => `    at ${frame}`)

/**
 * The import scenario's error: a title longer than the column. The stack
 * looks like a driver error raised in the caller (the frames below it).
 */
export function titleTooLong(): OracleDbError {
  const error = new OracleDbError(
    12899,
    'ORA-12899: value too large for column "APP"."QUESTION_BANK"."TITLE" (actual: 312, maximum: 255)',
  )
  Error.captureStackTrace(error, titleTooLong)
  const [head, ...callers] = (error.stack ?? '').split('\n')
  error.stack = [head, ...DRIVER_FRAMES, ...callers].join('\n')
  return error
}

/** TypeORM's findOneOrFail error; the exception filter answers 404. */
export class EntityNotFoundError extends Error {
  constructor(entity: string, criteria: Record<string, unknown>) {
    super(
      `Could not find any entity of type "${entity}" matching: ${JSON.stringify(criteria, null, 4)}`,
    )
    this.name = 'EntityNotFoundError'
  }
}

@Injectable()
export class OracleClient {
  /** Runs `work` inside an "oracle <op> <table>" CLIENT span; `binds` as passed to execute(). */
  async run<T>(
    operation: SqlOperation,
    table: string,
    statement: string,
    work: () => Promise<T>,
    binds?: Binds,
  ): Promise<T> {
    return tracer.startActiveSpan(
      `oracle ${operation} ${table}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system': 'oracle',
          'db.name': 'APP',
          'db.operation': operation,
          'db.sql.table': table,
          'db.statement': statement,
          'db.user': 'APP',
          'server.address': 'oracle.example.internal',
          'server.port': 1521,
        },
      },
      async (span) => {
        reportBinds(span, statement, binds)
        try {
          return await work()
        } catch (error) {
          span.recordException(error as Error)
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (error as Error)?.message,
          })
          throw error
        } finally {
          span.end()
        }
      },
    )
  }
}
