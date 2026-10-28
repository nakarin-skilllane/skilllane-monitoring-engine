/**
 * Shapes of the daily report (SPEC.md section 8, "Daily report").
 * A report date D covers [D-1 09:00, D 09:00) Asia/Bangkok. Times are milliseconds since
 * the epoch (UTC); dates are YYYY-MM-DD. Ratios are fractions: 0.25 = 25 %.
 */
export const REPORT_SCHEMA_VERSION = 2

export type ReportStatus = 'ok' | 'partial' | 'bad'
export type ErrorTrend = 'new' | 'up' | 'same' | 'down'
/** Stage 1 writes `disabled`; the AI layer (stage 4) writes the others. */
export type AiStatus = 'ok' | 'unavailable' | 'quota' | 'error' | 'disabled'

export interface ReportRules {
  badErrorRateX: number
  badOutageMin: number
  /** A feature below this success rate makes the report bad. */
  badFeatureSuccess: number
  warnErrorRateX: number
  newLookbackDays: number
  increaseX: number
  increaseMin: number
  /** Percentage points below its 7-day rate that mark a feature "below normal". */
  featureDropPt: number
  /** Total outage minutes from which a dependency counts as a problem. */
  dependencyMin: number
  slowX: number
  spikeX: number
  spikeMinReq: number
}

/** A number of the window against the average of the 6 windows before it. */
export interface Compare {
  value: number
  /** null: fewer than 3 of the 6 windows before had data. */
  baseline: number | null
  /** (value − baseline) / baseline; 0 when both are 0; null when there is no baseline or it is 0 and value is not. */
  changePct: number | null
}

export interface ReportFigures {
  usersAffected: Compare
  orgsAffected: Compare
  errorRate: Compare
  p95Ms: Compare
  requests: Compare
  /** Windows among the 6 before that had requests. */
  baselineWindows: number
  /** Error groups (fingerprints) of the window that are new / increased; all of them, not only topErrors. */
  errorGroups: { new: number; up: number }
}

/** One window of the 7 (6 before + this one), oldest first. */
export interface TrendPoint {
  reportDate: string
  hasData: boolean
  usersAffected: number
  orgsAffected: number
  errorRate: number
  p95Ms: number
  requests: number
}

/** A main feature, picked from usage (features.ts). */
export interface ReportFeature {
  /** `service:resource`. */
  featureId: string
  name: string
  /** 1 − errors / requests in the window; null without requests. */
  successRate: number | null
  /** The same over the 6 windows before; null without requests there. */
  successRate7d: number | null
  /** Requests in the window. */
  volume: number
  /** ok · below = under its 7-day rate by more than featureDropPt points · bad = under badFeatureSuccess · idle = no requests. */
  state: 'ok' | 'below' | 'bad' | 'idle'
  note: string
}

export type IncidentSource = 'dependency.down' | 'error_spike' | 'job.failed'

export interface ReportIncident {
  id: string
  source: IncidentSource
  startedAtMs: number
  /** null = still going at the end of the window. */
  endedAtMs: number | null
  /** Thai, business wording. */
  what: string
  /** Users with an error line during it; null when not counted. */
  usersAffected: number | null
  state: 'ongoing' | 'resolved'
}

export interface ReportFollowup {
  kind: 'new' | 'recurring' | 'threshold'
  /** Fingerprint, figure name or dependency key. */
  key: string
  text: string
}

export interface ReportError {
  /** error_fingerprint (decimal string). */
  fingerprint: string
  service: string
  errorType: string
  errorHint: string
  /** Logger of its lines: the heading when there is no errorType (a plain logger.error). */
  logger: string
  /** Its message (masked, ≤ 160 characters) when it has neither errorType nor errorHint; else ''. */
  message: string
  /** `METHOD /route`, `queue type`, or ''. */
  route: string
  /** `origin_file › origin_function`, or ''. */
  location: string
  count: number
  /** Average count of the windows before that had data; null without a baseline. */
  count7dAvg: number | null
  changePct: number | null
  users: number
  firstSeenMs: number
  trend: 'new' | 'up'
  sampleTraceId: string
}

export interface OutageWindow {
  fromMs: number
  toMs: number
  /** Still down at the end of the window. */
  ongoing: boolean
}

export interface ReportDependency {
  /** `type:name@host:port`. */
  key: string
  /** `type name`, e.g. `redis cache`. */
  name: string
  host: string
  port: number
  downMinutes: number
  /** dependency.down lines in the window. */
  downEvents: number
  windows: OutageWindow[]
  lastError: string
  /** downMinutes ≥ rules.dependencyMin. */
  problem: boolean
  note: string
}

export interface ReportJob {
  /** job_type (`Class.method` for cron). */
  job: string
  kind: 'cron' | 'queue'
  service: string
  /** Runs that ended (finished + failed). */
  total: number
  failed: number
  /** Cron runs that did not happen (estimate from the usual gap). */
  missed: number
  note: string
}

export interface ReportDeploy {
  service: string
  version: string
  previousVersion: string
  deployedAtMs: number
  /** New error groups of the service that started within 2 h after the deploy. */
  relatedFingerprints: string[]
}

export interface SlowRoute {
  route: string
  service: string
  requests: number
  p95Ms: number
  /** p95 over the 6 windows before, merged (not an average of daily p95). */
  p95_7dMs: number
}

/** Stage 4. Stage 1 writes []. */
export interface AiNote {
  /** summaryOverview | summaryDetail | an error fingerprint | an incident id. */
  target: string
  text: string
}

export interface DailyPayload {
  schemaVersion: typeof REPORT_SCHEMA_VERSION
  env: string
  reportDate: string
  windowStartMs: number
  windowEndMs: number
  rulesUsed: ReportRules
  headline: { statusAuto: ReportStatus; reasons: string[]; summaryOverview: string; summaryDetail: string }
  figures: ReportFigures
  trend: TrendPoint[]
  features: ReportFeature[]
  incidents: ReportIncident[]
  followups: ReportFollowup[]
  /** ≤ 5. */
  topErrors: ReportError[]
  dependencies: ReportDependency[]
  jobs: ReportJob[]
  deploys: ReportDeploy[]
  /** ≤ 5. */
  slowRoutes: SlowRoute[]
  aiNotes: AiNote[]
}

/** One row of daily_reports as the API returns it. */
export interface StoredReport {
  env: string
  reportDate: string
  windowStartMs: number
  windowEndMs: number
  /** ISO. */
  generatedAt: string
  status: ReportStatus
  payload: DailyPayload
  aiStatus: AiStatus
  aiMessage: string
}

export interface ReportDateItem {
  reportDate: string
  status: ReportStatus
}
