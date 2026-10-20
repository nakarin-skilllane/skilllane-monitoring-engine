/** One queue subscription (Kafka, RabbitMQ or BullMQ). */
export interface Consumer {
  readonly name: string
  /** Connects and starts consuming; throws when the queue is unreachable. */
  start(): Promise<void>
  /** Stops taking new messages and waits for the ones in progress; then closes. */
  stop(): Promise<void>
  /** Short queue lag text for the stats line, when cheap to read. */
  lag?(): Promise<string | undefined>
  /** Messages not yet written and acked/committed (0 = drained), when cheap to read. */
  pending?(): Promise<number | undefined>
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A readable message, also for AggregateError (e.g. ECONNREFUSED on ::1 and 127.0.0.1). */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message) return err.message
  const inner = (err as AggregateError).errors
  if (Array.isArray(inner) && inner.length > 0) return inner.map(errorMessage).join('; ')
  return (err as NodeJS.ErrnoException).code ?? err.name
}
