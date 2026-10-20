/**
 * The readable error rule (BRIEF.md, DESIGN.md §6) and the Copy-for-AI template (§6b),
 * as data. Every screen renders an error line from these, so it reads the same everywhere.
 * Components: components/ErrorParts.tsx (KvList, ErrorDetail, ErrorActual).
 */
import { fmtAiTime, fmtMs } from './format'
import { aiStack } from './stack'
import type { ErrorGroup, LogRow } from './types'

export interface Kv {
  k: string
  v: string
  /** kv--bad (5xx, failed) / kv--warn (4xx). */
  tone?: 'bad' | 'warn'
}

export const CATEGORY_LABEL: Record<string, string> = {
  bug: 'ต้องแก้โค้ด',
  input: 'ข้อมูลที่ส่งมาผิด',
  data: 'ข้อมูลในระบบขัดกัน',
  dependency: 'ระบบที่เรียกใช้มีปัญหา',
  config: 'ตั้งค่าผิด',
}

export const LEVEL_SHORT: Record<string, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' }

/** Queue / job system of `event_module` as the design writes it (the `.tag` after a job): BullMQ, Kafka … */
export const MODULE_LABEL: Record<string, string> = { bullmq: 'BullMQ', kafka: 'Kafka', rabbitmq: 'RabbitMQ', cron: 'cron', task: 'task' }
export const moduleName = (module: string): string => MODULE_LABEL[module] ?? module

/** Dependency / database type as people write it (`Redis "cache"`, `Oracle`), else the raw type. */
const SYSTEM_LABEL: Record<string, string> = {
  redis: 'Redis',
  oracle: 'Oracle',
  postgres: 'PostgreSQL',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  kafka: 'Kafka',
  rabbitmq: 'RabbitMQ',
  bullmq: 'BullMQ',
  http: 'HTTP',
  'aws-api': 'AWS',
  s3: 'S3',
  smtp: 'SMTP',
  google: 'Google',
}
export const systemLabel = (type: string): string => SYSTEM_LABEL[type] ?? type

/** `title` of every event in the SDK catalog (skilllane-monitoring/packages/monitoring/src/catalog/event-catalog.ts). */
const EVENT_TITLES: Record<string, string> = {
  'app.started': 'app started',
  'app.boot_failed': 'boot failed',
  'app.shutdown': 'shutting down',
  'app.uncaught_exception': 'uncaught exception',
  'app.unhandled_rejection': 'unhandled rejection',
  'otel.not_started': 'opentelemetry not started',
  'http.request': 'request completed',
  'http.outbound_failed': 'outbound request failed',
  'dependency.down': '{type} "{name}" is down',
  'dependency.still_down': '{type} "{name}" still down',
  'dependency.up': '{type} "{name}" is back',
  'job.started': 'job started',
  'job.finished': 'job finished',
  'job.retry': 'job will retry',
  'job.failed': 'job failed',
  'job.stalled': 'job stalled',
  'job.redelivered': 'message redelivered',
  'consumer.rebalancing': 'consumer group rebalancing',
  'consumer.joined': 'consumer joined group',
  'consumer.crashed': 'consumer crashed',
  'message.dead_lettered': 'message moved to dlq',
  'auth.rejected': 'authentication rejected',
}

/** Event title with the dependency filled in (`redis "cache" connected`); '' for app.log and unknown codes. */
export function eventTitle(row: Pick<LogRow, 'eventCode' | 'reason' | 'dependency'>): string {
  let t = EVENT_TITLES[row.eventCode]
  if (!t) return ''
  if (row.eventCode === 'dependency.up' && row.reason === 'connected') t = '{type} "{name}" connected'
  return t.replace('{type}', row.dependency?.type || 'dependency').replace('{name}', row.dependency?.name || row.dependency?.host || '?')
}

const firstLine = (s: string) => (s.length > 240 ? `${s.slice(0, 240)}…` : s).split('\n')[0]

/**
 * DESIGN.md §6: title = error_hint, else the event title (`http.request` → `request completed`), else the message;
 * `prefix` = the event code shown before it in small mono, or the logger on app.log lines.
 */
export function logTitle(row: LogRow): { prefix: string; title: string } {
  const title = row.error?.hint || eventTitle(row) || firstLine(row.message) || row.eventCode || '(ไม่มีข้อความ)'
  const prefix = row.eventCode && row.eventCode !== 'app.log' ? row.eventCode : row.logger
  return { prefix, title }
}

/** Chips in the fixed order: method, route, status, source | job (+ id, attempt), file, target, duration. */
export function logKvs(row: LogRow): Kv[] {
  const out: Kv[] = []
  const push = (k: string, v: string | number | null | undefined, tone?: Kv['tone']) => {
    if (v === null || v === undefined || v === '' || v === 0) return
    out.push(tone ? { k, v: String(v), tone } : { k, v: String(v) })
  }
  push('method', row.http?.method)
  push('route', row.http?.route || row.http?.path)
  const status = row.http?.status ?? 0
  push('status', status || undefined, status >= 500 ? 'bad' : status >= 400 ? 'warn' : undefined)
  if (row.job) {
    push('job', row.job.type || row.job.queue)
    push('id', row.job.id)
    if (row.job.attempt) push('attempt', row.job.maxAttempts ? `${row.job.attempt}/${row.job.maxAttempts}` : row.job.attempt)
  } else {
    push('source', row.error?.originFunction)
  }
  push('file', row.error?.originFile)
  push('target', row.error?.target)
  if (row.durationMs !== null) push('duration', fmtMs(row.durationMs))
  return out
}

/** "ต้องแก้อะไร": error_fix (this case), else error_hint_detail. */
export function logDetail(row: LogRow): string {
  return row.error?.fix || row.error?.hintDetail || ''
}

/** "error จริง": `Type [CODE] message`, or `Type: message` without a code. */
export function actualError(e: { type?: string; code?: string; message?: string } | null | undefined): string {
  if (!e) return ''
  const type = e.type ?? ''
  const message = e.message ?? ''
  if (e.code) return [type, `[${e.code}]`, message].filter(Boolean).join(' ')
  return type && message ? `${type}: ${message}` : type || message
}

/** Group title: hint, else the sample message. */
export function groupTitle(g: ErrorGroup): string {
  return g.hint || g.sampleMessage || g.errorType || g.errorCode || '(ไม่มีข้อความ)'
}

/** Group chips: route (first), job, source, file, target. */
export function groupKvs(g: ErrorGroup): Kv[] {
  const out: Kv[] = []
  const route = g.routes[0]
  if (route) {
    const [method, ...path] = route.split(' ')
    if (path.length) {
      out.push({ k: 'method', v: method })
      out.push({ k: 'route', v: path.join(' ') })
    } else out.push({ k: 'route', v: route })
  }
  if (g.jobType || g.jobQueue) out.push({ k: 'job', v: g.jobType || g.jobQueue })
  else if (g.originFunction) out.push({ k: 'source', v: g.originFunction })
  if (g.originFile) out.push({ k: 'file', v: g.originFile })
  if (g.target) out.push({ k: 'target', v: g.target })
  return out
}

/** "ต้องแก้อะไร" of a group = error_fix of its latest occurrence; hint detail is the "what" line. */
export function groupDetail(g: ErrorGroup): string {
  return g.fix || g.hintDetail
}

/** At most `max` stack frames for Copy for AI: app frames first, short paths (no home directory), no `async`. */
export function stackSummary(stack: string, max = 3): string[] {
  return aiStack(stack, max)
}

// ---------- Copy for AI (DESIGN.md §6b) ----------

/** Fields of the one template. No user id, organization, role, body, query string, IP or headers (PII rule). */
export interface AiErrorFields {
  hint: string
  code?: string
  category?: string
  /** Version for "· NEW since <version>". */
  newSince?: string
  level?: string
  service?: string
  role?: string
  version?: string
  env?: string
  /** One occurrence only. */
  when?: string
  /** `POST /question-bank/import → 500 in 1,842 ms`. */
  request?: string
  /** `bullmq queue report · report:generate #88412 · attempt 2/3 → failed`. */
  job?: string
  thisCase?: string
  what?: string
  where?: string
  usecase?: string
  origin?: string
  originFile?: string
  target?: string
  failedStep?: string
  error?: string
  stack?: string[]
  traceId?: string
  fingerprint?: string
  /** Trace pages: spans / span_tree / logs lines. */
  extra?: Array<[string, string]>
  counts?: string
}

/** Markdown in the §6b order; a key without a value is dropped, never renamed. */
export function aiErrorMarkdown(f: AiErrorFields): string {
  const head = `### ${f.hint}${f.code || f.category ? ` (${[f.code, f.category ? `category: ${f.category}` : ''].filter(Boolean).join(', ')})` : ''}${f.newSince ? ` · NEW since ${f.newSince}` : ''}`
  const svc = f.service ? `${f.service}${f.role ? `/${f.role}` : ''}${f.version ? ` ${f.version}` : ''}` : ''
  const where = [f.where, f.usecase ? `usecase ${f.usecase}` : ''].filter(Boolean).join(' · ')
  const origin = [f.origin, f.originFile].filter(Boolean).join(' · ')
  const lines: Array<[string, string | undefined]> = [
    ['level', f.level],
    ['service', svc],
    ['env', f.env],
    ['when', f.when],
    [f.job ? 'job' : 'request', f.job || f.request],
    ['this_case', f.thisCase],
    ['what', f.what],
    ['where', where],
    ['origin', origin],
    ['target', f.target],
    ['failed_step', f.failedStep],
    ['error', f.error],
  ]
  const out = [head, ...lines.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`)]
  if (f.stack?.length) out.push('- stack:', ...f.stack.map((s) => `  - ${s}`))
  if (f.traceId) out.push(`- trace_id: ${f.traceId}`)
  if (f.fingerprint) out.push(`- fingerprint: ${f.fingerprint}`)
  for (const [k, v] of f.extra ?? []) if (v) out.push(`- ${k}: ${v}`)
  if (f.counts) out.push(`- counts: ${f.counts}`)
  out.push('- fields: see docs/DATA-DICTIONARY.md')
  return out.join('\n')
}

/** Result of a job attempt for the `job:` line: `→ retry` / `→ failed`. */
function jobResult(row: LogRow): string {
  if (row.eventCode === 'job.retry' || row.eventCode === 'job.redelivered') return ' → retry'
  if (row.eventCode === 'job.failed' || row.eventCode === 'job.stalled' || row.eventCode === 'message.dead_lettered') return ' → failed'
  if (row.eventCode === 'job.finished') return ' → finished'
  return ''
}

/**
 * Template fields of one log line (an error occurrence). `when` is the ICT time with the year (§6b), the hint
 * falls back to the event title, a job line names its queue system (`BullMQ queue report · report:generate #88412
 * · attempt 2/3 → retry`) and its `where` is the job, not the outbound call it made.
 */
export function aiFieldsOfLog(row: LogRow): AiErrorFields {
  const e = row.error
  // job lines carry the outbound call's http (domain + status only): that is not "the request"
  const h = row.http && (row.http.method || row.http.route || row.http.path) && !row.job ? row.http : null
  const request = h
    ? `${h.method} ${h.route || h.path}${h.status ? ` → ${h.status}` : ''}${row.durationMs !== null ? ` in ${fmtMs(row.durationMs)}` : ''}`
    : undefined
  const j = row.job
  const sys = j ? moduleName(row.eventModule) || 'job' : ''
  const job = j
    ? `${sys} queue ${j.queue} · ${j.type}${j.id ? ` #${j.id}` : ''}${j.attempt ? ` · attempt ${j.attempt}/${j.maxAttempts || '?'}` : ''}${jobResult(row)}`
    : undefined
  const where = h
    ? `${h.method} ${h.route || h.path}`.trim()
    : j
      ? `job ${j.type || j.queue}${j.queue && j.type ? ` (${sys} queue ${j.queue})` : ''}`
      : row.dependency
        ? `dependency ${row.dependency.type} ${row.dependency.name || row.dependency.host}`.trim()
        : undefined
  return {
    hint: e?.hint || eventTitle(row) || firstLine(row.message),
    code: e?.code,
    category: e?.category,
    level: row.level,
    service: row.service,
    role: row.role,
    version: row.version,
    env: row.env,
    when: fmtAiTime(row.timestamp),
    request,
    job,
    thisCase: e?.fix,
    what: e?.hintDetail,
    where,
    usecase: row.usecase,
    origin: e?.originFunction,
    originFile: e?.originFile,
    target: e?.target,
    failedStep: row.failedStep,
    error: actualError(e),
    stack: e?.stack ? stackSummary(e.stack) : undefined,
    traceId: row.traceId,
    fingerprint: row.fingerprint ?? undefined,
  }
}
