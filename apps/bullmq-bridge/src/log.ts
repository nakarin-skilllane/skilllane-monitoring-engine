/**
 * stdout only, one line per entry, like the engine's Nest logger. The bridge
 * never sends its own telemetry to the queue: that would loop back into itself.
 */
export type LogLevel = 'LOG' | 'WARN' | 'ERROR'

export class Logger {
  constructor(private readonly context: string) {}

  log(message: string): void {
    this.write('LOG', message)
  }

  warn(message: string): void {
    this.write('WARN', message)
  }

  error(message: string): void {
    this.write('ERROR', message)
  }

  private write(level: LogLevel, message: string): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} [${this.context}] ${message}`
    if (level === 'LOG') process.stdout.write(`${line}\n`)
    else process.stderr.write(`${line}\n`)
  }
}

/** A readable message, also for AggregateError (e.g. ECONNREFUSED on ::1 and 127.0.0.1). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message) return err.message
  const inner = (err as AggregateError).errors
  if (Array.isArray(inner) && inner.length > 0) return inner.map(errorMessage).join('; ')
  return (err as NodeJS.ErrnoException).code ?? err.name
}

/** `promise`, or `fallback` after `ms`; never rejects. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}
