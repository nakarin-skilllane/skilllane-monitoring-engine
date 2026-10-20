/**
 * Captured values as the SDK stored them: every `[REDACTED]` (a key, header or pattern the masking rules hit)
 * is drawn as a masked chip (`.ui-nw-masked`), so a reader sees at once which values were never stored.
 * `MaskedText` for any string, `Pairs` for headers / query / form fields (name: value rows, DevTools style).
 */
import { REDACTED, splitMasked } from '@/lib/io'
import type { KvPair } from '@/lib/types'

export const MASKED_TITLE = 'ค่าถูก mask ก่อนเก็บ (กฎ masking ของ skilllane-monitoring ในแอป หรือของ engine ตอนรับเข้า) · ไม่ได้เก็บค่าจริง'

export function MaskedText({ text }: { text: string }) {
  if (!text.includes(REDACTED)) return <>{text}</>
  return (
    <>
      {splitMasked(text).map((p, i) =>
        p.masked ? (
          <span key={i} className="ui-nw-masked" title={MASKED_TITLE}>
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/** name: value rows (headers keep their order and repeats). */
export function Pairs({ pairs, label, empty = 'ไม่มี' }: { pairs: readonly KvPair[]; label: string; empty?: string }) {
  if (!pairs.length) return <p className="hint ui-nw-none">{empty}</p>
  return (
    <dl className="ui-nw-pairs" aria-label={label}>
      {pairs.map(([k, v], i) => (
        <div className="ui-nw-pairs__row" key={`${k}-${i}`}>
          <dt>{k}</dt>
          <dd>
            <MaskedText text={v} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** `name: value` lines, what the copy button of a header block copies. */
export const pairsText = (pairs: readonly KvPair[]) => pairs.map(([k, v]) => `${k}: ${v}`).join('\n')
