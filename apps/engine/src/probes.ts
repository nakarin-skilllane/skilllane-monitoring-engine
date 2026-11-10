/** Last path segments of probe routes (health checks, readiness, metrics): never a user, never a feature. */
export const PROBE_SEGMENTS = ['health', 'healthz', 'ready', 'readiness', 'live', 'liveness', 'metrics', 'ping'] as const
