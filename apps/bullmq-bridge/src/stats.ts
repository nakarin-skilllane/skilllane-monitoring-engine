/**
 * Bridge counters; one line every 30 s (main.ts), the shape of the engine's
 * ingest stats line:
 *   bullmq: jobs 120 (+4) · forwarded rows 3400 · failed 2 · unrecoverable 1 · pending <lag>
 */
export class BridgeStats {
  /** Job attempts taken from the queues (every call of the processor). */
  jobs = 0
  /** Items of the envelopes the ingest accepted (202). */
  forwardedRows = 0
  /** Attempts that threw a retryable error (503 / 5xx / 401 / network); BullMQ retries them. */
  failed = 0
  /** Jobs failed for good: not an envelope, or the ingest answered 400. */
  unrecoverable = 0
  private lastJobs = 0

  /** One line for stdout; `pending` is the per-queue lag text when cheap to read. */
  line(pending?: string): string {
    const parts = [
      `bullmq: jobs ${this.jobs} (+${this.jobs - this.lastJobs})`,
      `forwarded rows ${this.forwardedRows}`,
      `failed ${this.failed}`,
      `unrecoverable ${this.unrecoverable}`,
    ]
    if (pending) parts.push(`pending ${pending}`)
    this.lastJobs = this.jobs
    return parts.join(' · ')
  }
}
