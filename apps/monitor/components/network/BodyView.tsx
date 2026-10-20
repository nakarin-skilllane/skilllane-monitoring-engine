'use client'

/**
 * One captured body (request / response payload, message): a head with its content-type, real size and the cap
 * note ("แสดง 64 KB แรก" when the SDK cut it), a copy button, and the content:
 * - `tree` (Preview, Payload, Message): JSON as a collapsible tree (source toggle; numbers as written, so a 64-bit
 *   id never changes), form fields as name: value rows, a multipart summary as its JSON tree, HTML rendered in a
 *   sandboxed frame that runs no script and loads nothing (source toggle), text as text;
 * - `raw` (Response): the text exactly as stored, like DevTools; Pretty re-indents JSON without parsing it, so every
 *   value, key order and repeated key stays as written (also for a body cut at the cap).
 * Copy always copies the stored text. Binary bodies were never stored (size only); empty ones say so. Rendering stops
 * at 128 K characters with a button for the rest, so an unusually large body never freezes the page.
 */
import { useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { bodyKind, countRedacted, fmtBytes, formPairs, parseJsonExact, prettyText, utf8Bytes } from '@/lib/io'
import type { IoBody } from '@/lib/types'
import { JsonTree } from './JsonTree'
import { MASKED_TITLE, MaskedText, Pairs } from './Masked'

const RENDER_CAP = 128 * 1024

/** What a rendered HTML body may do inside the monitor: nothing (no script, no request, no navigation). */
const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`

/** `แสดง 64 KB แรก (ขนาดจริง 1.2 MB)` */
export function truncNote(b: IoBody): string {
  return `แสดง ${fmtBytes(utf8Bytes(b.text))} แรก (ขนาดจริง ${fmtBytes(b.size)})`
}

function Pre({ text, id }: { text: string; id?: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > RENDER_CAP && !all
  return (
    <>
      <pre className="code code--wrap ui-nw-pre" id={id}>
        <MaskedText text={long ? text.slice(0, RENDER_CAP) : text} />
      </pre>
      {long ? (
        <button className="btn btn--sm mt-2" type="button" onClick={() => setAll(true)}>
          แสดงที่เหลือ ({fmtBytes(utf8Bytes(text.slice(RENDER_CAP)))})
        </button>
      ) : null}
    </>
  )
}

export function BodyView({ body, mode, label, empty }: { body: IoBody | null; mode: 'tree' | 'raw'; label: string; empty: string }) {
  const kind = bodyKind(body)
  // a multipart body is stored as a JSON summary (fields + files)
  const json = body && mode === 'tree' && (kind === 'json' || kind === 'multipart') ? parseJsonExact(body.text) : null
  const html = !!body && mode === 'tree' && kind === 'text' && /^text\/html\b/i.test(body.contentType.trim())
  const [source, setSource] = useState(false)
  const [pretty, setPretty] = useState(false)
  if (!body || kind === 'empty') return <p className="hint ui-nw-none">{empty}</p>
  if (kind === 'binary') {
    // size only: binary, but also a stream (SSE), a LOG_CAPTURE_SKIP_ROUTES route or a body the app never read
    const ct = body.contentType.toLowerCase()
    const what = ct.includes('event-stream')
      ? 'เป็น stream'
      : /^(text\/|application\/(json|xml|x-www-form-urlencoded)|.*\+json)/.test(ct)
        ? 'ไม่ได้เก็บเนื้อหา (route ที่ตั้งให้ข้าม หรือ app ไม่ได้อ่าน body)'
        : 'เป็นข้อมูล binary'
    return (
      <p className="hint ui-nw-none">
        {what} ขนาด {fmtBytes(body.size)}
        {body.contentType ? ` (${body.contentType})` : ''} · library เก็บแค่ขนาด ไม่เก็บเนื้อหา
      </p>
    )
  }
  const masked = countRedacted(body.text)
  const parsed = json?.ok ? json.value : undefined
  // JSON-looking text re-indents (a cut body included): the literals are copied, never parsed
  const canPretty = kind === 'json' && /^\s*[[{]/.test(body.text)
  const shown = mode === 'raw' && pretty && canPretty ? prettyText(body.text) : body.text
  const asTree = mode === 'tree' && !source
  const toggle =
    mode === 'raw' ? (
      canPretty ? (
        <div className="seg" role="group" aria-label="รูปแบบการแสดง">
          <button className="seg__btn" type="button" aria-pressed={!pretty} onClick={() => setPretty(false)} title="ข้อความตามที่เก็บไว้ทุกตัวอักษร">
            Raw
          </button>
          <button className="seg__btn" type="button" aria-pressed={pretty} onClick={() => setPretty(true)} title="จัดบรรทัดใหม่ ค่าทุกตัวเหมือนเดิม (ไม่ได้ parse)">
            Pretty
          </button>
        </div>
      ) : null
    ) : kind === 'json' || kind === 'form' || kind === 'multipart' || html ? (
      <button className="btn btn--sm btn--quiet" type="button" aria-pressed={source} onClick={() => setSource((s) => !s)}>
        {source ? (html ? 'ดูหน้าที่แสดงผล' : 'ดูแบบแยกส่วน') : 'ดู source'}
      </button>
    ) : null
  return (
    <div className="code-block ui-nw-body">
      <div className="code-block__head">
        <span className="code-block__title">
          <span className="mono" title={body.contentType || undefined}>
            {body.contentType.split(';')[0].trim() || kind}
          </span>{' '}
          · {fmtBytes(body.size)}
          {kind === 'multipart' ? ' · สรุป field และไฟล์ (ไม่เก็บเนื้อไฟล์)' : ''}
          {body.truncated ? <span className="ui-nw-trunc">{truncNote(body)}</span> : null}
          {masked ? (
            <span className="ui-nw-masked-n" title={MASKED_TITLE}>
              [REDACTED] {masked}
            </span>
          ) : null}
        </span>
        {toggle}
        <CopyButton text={body.text} label="คัดลอก" variant="quiet" size="sm" ariaLabel={`คัดลอก ${label} ตามที่เก็บไว้`} />
      </div>
      <div className="ui-nw-body__main">
        {asTree && json?.ok ? (
          <JsonTree value={parsed} label={label} />
        ) : asTree && kind === 'form' ? (
          <Pairs pairs={formPairs(body.text)} label={label} />
        ) : asTree && html ? (
          <>
            <p className="hint ui-nw-note">แสดงผล HTML ในกรอบที่ปิด script และไม่โหลดอะไรจากภายนอก (รูปและ CSS จากลิงก์จึงไม่ขึ้น)</p>
            <iframe className="ui-nw-html" sandbox="" srcDoc={`${HTML_CSP}${body.text}`} title={`${label} (HTML)`} referrerPolicy="no-referrer" />
          </>
        ) : (
          <>
            {mode === 'tree' && kind === 'json' && !json?.ok ? (
              <p className="hint ui-nw-note">{body.truncated ? 'JSON ไม่ครบเพราะถูกตัดที่ขนาดสูงสุด จึงแสดงเป็นข้อความ' : 'อ่านเป็น JSON ไม่ได้ จึงแสดงเป็นข้อความ'}</p>
            ) : null}
            <Pre text={shown} />
          </>
        )}
      </div>
    </div>
  )
}
