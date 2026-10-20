/**
 * Service identity colours (DESIGN.md §3): fixed per service, never by rank or filter.
 * school-core-api = --svc-1, school-etl-api = --svc-2, video-transcoder-api = --svc-3;
 * the next services take 4, 5, 6 in order of first appearance in /api/meta; a 7th is
 * drawn in --muted and labelled "อื่น ๆ". Roles share their service's colour.
 */
import type { Meta } from './types'

export const KNOWN_SERVICES = ['school-core-api', 'school-etl-api', 'video-transcoder-api'] as const
export const SERVICE_SLOTS = 6
export const OTHER_SERVICES_LABEL = 'อื่น ๆ'

/** Fixed order: the known services, then the others in /api/meta order. Pass to ServiceChip `order`. */
export function serviceOrder(meta?: Pick<Meta, 'services'> | null): string[] {
  const order: string[] = [...KNOWN_SERVICES]
  for (const s of meta?.services ?? []) if (!order.includes(s.service)) order.push(s.service)
  return order
}

/** 1–6, or 0 for a service beyond the six slots (drawn in --muted). */
export function serviceSlot(service: string, order: readonly string[] = KNOWN_SERVICES): number {
  let i = order.indexOf(service)
  if (i < 0) {
    // Not in the order (e.g. meta not loaded): place it after the given ones, stable per name.
    i = order.length
  }
  return i < SERVICE_SLOTS ? i + 1 : 0
}

/** `svc-N` class (sets --c), or '' for the muted 7th+ service. */
export function svcClass(service: string, order?: readonly string[]): string {
  const slot = serviceSlot(service, order)
  return slot ? `svc-${slot}` : ''
}

/** CSS colour of a service: `var(--svc-N)` or `var(--muted)`. */
export function svcColor(service: string, order?: readonly string[]): string {
  const slot = serviceSlot(service, order)
  return slot ? `var(--svc-${slot})` : 'var(--muted)'
}
