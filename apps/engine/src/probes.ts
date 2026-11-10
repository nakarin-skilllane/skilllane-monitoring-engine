/** Last path segments of probe routes (health checks, readiness, metrics): never a user, never a feature. */
export const PROBE_SEGMENTS = ['health', 'healthz', 'ready', 'readiness', 'live', 'liveness', 'metrics', 'ping'] as const

/**
 * User agents (prefixes) of uptime checkers: a `GET /` they get answered 2xx is a probe too. An internal script polls
 * school-core-api's `/` every 3 minutes with python-requests (2026-11-10). Matched by agent, never by IP (it changes).
 */
export const UPTIME_AGENTS = ['python-requests/'] as const
