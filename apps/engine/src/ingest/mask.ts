/**
 * Masking at ingest, for items a sender did not mask with the current rules:
 * another SDK, an older skilllane-monitoring, an app's own hooks under the SDK's
 * attribute names. The rules are the SDK's own (skilllane-monitoring/contract src/mask,
 * SPEC.md §3), not a copy. A sender that masked with MASK_VERSION or later
 * says so in the envelope resource (`skilllane.monitoring.mask`) and its items are stored as
 * they are; everything else is masked here: bodies, header JSON, query
 * strings, URLs, statements, bind values, every other attribute, events,
 * status and exception text, log text, labels and fields.
 */
import { isSensitiveKey, MASK_RESOURCE_KEY, MASK_VERSION, maskObject, REDACTED, redactValue } from 'skilllane-monitoring/contract'

export {
  isSensitiveHeader,
  isSensitiveKey,
  maskBodyText,
  maskEndpoint,
  maskHeaderJson,
  maskHeaderValue,
  maskIdentifier,
  maskJsonText,
  maskNumber,
  maskPathByRoute,
  maskQuery,
  maskSql,
  maskStatement,
  maskUrl,
  REDACTED,
  redactText,
  redactValue,
} from 'skilllane-monitoring/contract'

/** The sender masked its items with these rules (or newer ones). */
export function maskedBySender(resource: Record<string, unknown> | undefined): boolean {
  const version = Number(resource?.[MASK_RESOURCE_KEY])
  return Number.isFinite(version) && version >= MASK_VERSION
}

/** Secrets and personal data in free text → [REDACTED] (the value rule). */
export function maskText(text: string): string {
  return redactValue(text)
}

/** A value under `key`: [REDACTED] for a sensitive key, else its text masked. */
export function maskValue(key: string, value: string): string {
  return isSensitiveKey(key) ? REDACTED : redactValue(value)
}

/** Objects and arrays recursively: sensitive keys → [REDACTED], strings masked. */
export function maskDeep(value: unknown): unknown {
  return maskObject(value)
}
