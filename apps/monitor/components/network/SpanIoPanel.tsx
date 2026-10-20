'use client'

/**
 * The span panel of the trace Network view, with the tabs of the browser's DevTools so developers find their way:
 * HTTP spans Headers (General · Response headers · Request headers) / Payload (query string + request body) /
 * Preview (JSON tree) / Response (raw, pretty toggle) / Timing, plus "Copy as cURL"; DB and Redis spans a Query
 * tab (formatted statement, bind values, FULL QUERY to copy and run); queue / job spans a Message tab (headers +
 * payload). The detail comes from GET /api/traces/:id/spans/:spanId (once per span, cached for the page); while it
 * loads, or when the engine has nothing stored for the span, the panel shows what the trace itself knows.
 * A failed row says why under its title (the span's exception or status message: ORA-12899 …, the job attempt's
 * GaxiosError), on every tab. The selected tab is `?tab=` (kept when another row is opened, like DevTools).
 */
import { useSearchParams } from 'next/navigation'
import { Fragment, type ReactNode, type Ref, useEffect, useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { HttpStatus, ServiceChip, Tag, Ts } from '@/components/badges'
import { DurBar } from '@/components/table'
import { Icon } from '@/components/icons'
import { EngineErrorState, Skeleton } from '@/components/states'
import { type TabItem, Tabs } from '@/components/Tabs'
import { clientGet, type ClientEngineError } from '@/lib/engine-client'
import { fmtCount, fmtMs, fmtNumber } from '@/lib/format'
import { curlOf, detailFromSpan, fmtBytes, hasCapture, IO_TYPE_LABEL, type NetInput, type NetRow, normalizeSpanDetail } from '@/lib/io'
import { moduleName } from '@/lib/readable'
import type { SpanDetail, SpanHttpIo, SpanMessageIo, SpanRow } from '@/lib/types'
import { BodyView, truncNote } from './BodyView'
import { MASKED_TITLE, MaskedText, Pairs, pairsText } from './Masked'
import { QueryView } from './QueryView'

type Load = { state: 'loading' } | { state: 'ok'; detail: SpanDetail } | { state: 'missing' } | { state: 'error'; error: ClientEngineError }

/** Details already fetched on this page (`<traceId>/<spanId>`), and spans the engine has nothing for (404). */
const cache = new Map<string, SpanDetail>()
const missing = new Set<string>()

export const PANEL_ID = 'nw-panel'

const known = (key: string): Load => (cache.has(key) ? { state: 'ok', detail: cache.get(key)! } : missing.has(key) ? { state: 'missing' } : { state: 'loading' })

function useSpanDetail(traceId: string, row: NetRow, initial: SpanDetail | null | undefined, initialMissing: boolean): [Load, () => void] {
  const key = `${traceId}/${row.id}`
  // what the server already asked for the span of the URL
  if (initial && initial.span.spanId === row.id && !cache.has(key)) cache.set(key, initial)
  if (initialMissing) missing.add(key)
  const [load, setLoad] = useState<Load>(() => known(key))
  // the env of the page (a user limited to some envs reads one env at a time)
  const envParam = useSearchParams().get('env')
  const env = envParam && envParam !== 'all' ? envParam : undefined
  const [seen, setSeen] = useState(key)
  const [attempt, setAttempt] = useState(0)
  // another row: start from what is known (render-time sync, no flash of the previous span)
  if (seen !== key) {
    setSeen(key)
    setLoad(known(key))
  }
  useEffect(() => {
    if (cache.has(key) || missing.has(key)) return
    let live = true
    clientGet<unknown>(`/traces/${encodeURIComponent(traceId)}/spans/${encodeURIComponent(row.id)}`, env ? { env } : undefined).then((res) => {
      if (!live) return
      if (!res.ok) {
        const gone = res.error.kind === 'http' && res.error.status === 404
        if (gone) missing.add(key)
        setLoad(gone ? { state: 'missing' } : { state: 'error', error: res.error })
        return
      }
      const detail = normalizeSpanDetail(res.data, row.input.span)
      if (!detail) {
        setLoad({ state: 'missing' })
        return
      }
      cache.set(key, detail)
      setLoad({ state: 'ok', detail })
    })
    return () => {
      live = false
    }
    // row.input.span is the same span for one key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, env])
  return [load, () => setAttempt((a) => a + 1)]
}

/** Why a span failed: `ORA-12899: value too large …`, `GaxiosError: Quota exceeded …`; null when it says nothing. */
function failureOf(s: SpanRow): string | null {
  const type = s.exception?.type ?? ''
  const message = s.exception?.message || s.statusMessage || ''
  if (!type && !message) return null
  return type && !message.startsWith(type) ? `${type}${message ? `: ${message}` : ''}` : message
}

/** A collapsible block (DevTools sections); its copy button sits on the summary row but outside the summary. */
function Section({ title, count, copy, children }: { title: string; count?: number; copy?: string; children: ReactNode }) {
  return (
    <div className={copy ? 'ui-nw-sec ui-nw-sec--copy' : 'ui-nw-sec'}>
      <details className="disclosure" open>
        <summary>
          {title}
          {count !== undefined ? <span className="tab__count">{fmtCount(count)}</span> : null}
        </summary>
        <div className="disclosure__body">{children}</div>
      </details>
      {copy ? <CopyButton text={copy} label="คัดลอก" variant="quiet" size="sm" ariaLabel={`คัดลอก ${title}`} className="ui-nw-sec__copy" /> : null}
    </div>
  )
}

function General({ http, row, order }: { http: SpanHttpIo; row: NetRow; order: readonly string[] }) {
  const s = row.input.span
  const rows: Array<[string, ReactNode]> = [
    ['Request URL', http.url ? <MaskedText text={http.url} /> : '–'],
    ['Request Method', http.method || '–'],
    [
      'Status Code',
      http.status ? (
        <>
          <HttpStatus status={http.status} /> {s.statusCode === 'ERROR' && s.statusMessage ? <span className="t-muted">{s.statusMessage}</span> : null}
        </>
      ) : (
        '–'
      ),
    ],
    ['Remote Address', http.remoteAddress || '–'],
  ]
  if (http.route) rows.push(['Route', http.route])
  if (!http.requestHeaders.length && http.userAgent) rows.push(['User-Agent', http.userAgent])
  return (
    <dl className="ui-nw-pairs ui-nw-pairs--general">
      {rows.map(([k, v]) => (
        <div className="ui-nw-pairs__row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      <div className="ui-nw-pairs__row">
        <dt>Service</dt>
        <dd>
          <ServiceChip service={s.service} role={s.role} order={order} />
        </dd>
      </div>
    </dl>
  )
}

function HeadersTab({ http, row, order, stored }: { http: SpanHttpIo; row: NetRow; order: readonly string[]; stored: boolean }) {
  const none = stored ? 'ไม่มี header' : 'ยังไม่ได้บันทึก header ของ span นี้'
  return (
    <div className="stack">
      <Section title="General">
        <General http={http} row={row} order={order} />
      </Section>
      <Section title="Response Headers" count={http.responseHeaders.length} copy={http.responseHeaders.length ? pairsText(http.responseHeaders) : undefined}>
        <Pairs pairs={http.responseHeaders} label="Response headers" empty={none} />
      </Section>
      <Section title="Request Headers" count={http.requestHeaders.length} copy={http.requestHeaders.length ? pairsText(http.requestHeaders) : undefined}>
        <Pairs pairs={http.requestHeaders} label="Request headers" empty={none} />
      </Section>
    </div>
  )
}

function PayloadTab({ http, stored }: { http: SpanHttpIo; stored: boolean }) {
  const body = http.requestBody
  if (!http.query.length && !body)
    return <p className="hint ui-nw-none">{stored ? 'request นี้ไม่มี query string และไม่มี body' : 'ยังไม่ได้บันทึก query string และ body ของ span นี้'}</p>
  return (
    <div className="stack">
      {http.query.length ? (
        <Section title="Query String Parameters" count={http.query.length} copy={http.query.map(([k, v]) => `${k}=${v}`).join('\n')}>
          <Pairs pairs={http.query} label="Query string" />
        </Section>
      ) : null}
      <Section title={body && /x-www-form-urlencoded|multipart\//i.test(body.contentType) ? 'Form Data' : 'Request Payload'}>
        <BodyView body={body} mode="tree" label="request body" empty="ไม่มี request body" />
      </Section>
    </div>
  )
}

function MessageTab({ message, row, stored }: { message: SpanMessageIo; row: NetRow; stored: boolean }) {
  const a = row.input.span.attributes ?? {}
  const facts: Array<[string, string, string]> = [
    ['ระบบ', 'messaging.system', message.system ? moduleName(message.system) : ''],
    ['ปลายทาง', 'messaging.destination.name', message.destination],
    ['Operation', 'messaging.operation', message.operation],
    ['Message id', 'messaging.message.id', message.id && message.id !== a['job.id'] ? message.id : ''],
    ['Job', 'job.type · job.id', [a['job.type'], a['job.id'] ? `#${a['job.id']}` : ''].filter(Boolean).join(' ')],
    ['Attempt', 'job.attempt · job.max_attempts', a['job.attempt'] ? `${a['job.attempt']}${a['job.max_attempts'] ? `/${a['job.max_attempts']}` : ''}` : ''],
    ['ขนาด', 'messaging.message.body.size', message.body ? fmtBytes(message.body.size) : ''],
  ]
  return (
    <div className="stack">
      <dl className="fields">
        {facts
          .filter(([, , v]) => v)
          .map(([k, f, v]) => (
            <Fragment key={k}>
              <dt>
                {k}
                <span className="fname">{f}</span>
              </dt>
              <dd className="mono">{v}</dd>
            </Fragment>
          ))}
      </dl>
      <Section title="Headers" count={message.headers.length} copy={message.headers.length ? pairsText(message.headers) : undefined}>
        <Pairs pairs={message.headers} label="Message headers" empty={stored ? 'ไม่มี header' : 'ยังไม่ได้บันทึก header ของ message นี้'} />
      </Section>
      <Section title={row.input.span.kind === 'CONSUMER' ? 'Payload ที่ได้รับ' : 'Payload ที่ส่ง'}>
        <BodyView body={message.body} mode="tree" label="message payload" empty={stored ? 'message นี้ไม่มี payload' : 'ยังไม่ได้บันทึก payload ของ message นี้'} />
      </Section>
    </div>
  )
}

function TimingTab({ detail, row, total, inner, onOpen }: { detail: SpanDetail; row: NetRow; total: number; inner: NetRow[]; onOpen: (id: string) => void }) {
  const t = detail.timing
  const off = row.start
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / total) * 100))
  const byType = new Map<string, { n: number; ms: number }>()
  for (const r of inner) {
    const cur = byType.get(r.type) ?? { n: 0, ms: 0 }
    byType.set(r.type, { n: cur.n + 1, ms: cur.ms + r.durationMs })
  }
  return (
    <div className="stack">
      <dl className="fields">
        <dt>
          เริ่ม<span className="fname">start_time</span>
        </dt>
        <dd>
          <Ts value={t.start} format="date-ms" /> ICT
        </dd>
        <dt>
          นับจากต้น trace<span className="fname">offset</span>
        </dt>
        <dd className="mono">+{fmtMs(off)}</dd>
        <dt>
          เวลาที่ใช้<span className="fname">duration_ns</span>
        </dt>
        <dd>
          <span className="mono">{fmtMs(t.durationMs)}</span> · {fmtNumber(pct(t.durationMs), 1)} % ของ trace
        </dd>
        <dt>
          จบที่<span className="fname">offset + duration</span>
        </dt>
        <dd className="mono">+{fmtMs(off + t.durationMs)}</dd>
      </dl>
      <div className="ui-nw-tl" aria-hidden="true">
        <span className="ui-nw-tl__track">
          <DurBar start={pct(off)} width={pct(t.durationMs)} className={row.failed ? 'is-error' : undefined} />
        </span>
        <span className="mini-axis">
          <span className="mini-axis__start">0</span>
          <span className="mini-axis__end">{fmtMs(total)}</span>
        </span>
      </div>
      {inner.length ? (
        <div className="field-group">
          <h4 className="field-group__title">I/O ภายใน span นี้</h4>
          <p className="hint ui-nw-note">
            {[...byType.entries()].map(([k, v]) => `${IO_TYPE_LABEL[k as NetRow['type']]} ${fmtCount(v.n)} ครั้ง ${fmtMs(v.ms)}`).join(' · ')} (ทำพร้อมกันได้ จึงรวมแล้วอาจเกินเวลาของ span)
          </p>
          <ul className="ui-nw-inner">
            {inner.slice(0, 50).map((r) => (
              <li key={r.id}>
                <button type="button" className="ui-nw-inner__btn" onClick={() => onOpen(r.id)}>
                  <Tag>{IO_TYPE_LABEL[r.type]}</Tag>
                  <span className={r.failed ? 'ui-nw-inner__name t-danger' : 'ui-nw-inner__name'}>{r.name}</span>
                  <span className="mono t-muted">+{fmtMs(r.start)}</span>
                  <span className="mono">{fmtMs(r.durationMs)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function SpanIoPanel({
  traceId,
  row,
  inner,
  total,
  order,
  initial,
  initialMissing = false,
  onClose,
  onOpen,
  headingRef,
}: {
  traceId: string
  row: NetRow<NetInput>
  /** Network rows inside this span (its subtree), for Timing. */
  inner: NetRow[]
  /** Trace length in ms. */
  total: number
  order: readonly string[]
  /** Detail fetched by the server for the span of the URL. */
  initial?: SpanDetail | null
  /** The server's call for this span answered 404: do not ask again. */
  initialMissing?: boolean
  onClose: () => void
  /** Open another row (Timing's inner I/O list). */
  onOpen: (id: string) => void
  headingRef?: Ref<HTMLHeadingElement>
}) {
  const [load, retry] = useSpanDetail(traceId, row, initial, initialMissing)
  const s = row.input.span
  const detail = load.state === 'ok' ? load.detail : detailFromSpan(s, row.start)
  // what the tabs say about empty parts: "ไม่มี" when the SDK captured this span, "ยังไม่ได้บันทึก" when not
  const stored = load.state === 'ok' && hasCapture(detail)
  const bare = load.state === 'missing' || (load.state === 'ok' && !stored && row.type !== 'db' && row.type !== 'redis')
  const http = detail.http
  const isHttp = row.type === 'http-in' || row.type === 'http-out'
  const curl = isHttp && http && stored && http.url ? curlOf(http) : null
  const loading = load.state === 'loading'
  const wait = <Skeleton variant="text" />
  const timing = { key: 'timing', label: 'Timing', panel: <TimingTab detail={detail} row={row} total={total} inner={inner} onOpen={onOpen} /> }
  let items: TabItem[] = []
  let first = 'timing'
  if (isHttp && http) {
    first = 'headers'
    const res = http.responseBody
    items = [
      { key: 'headers', label: 'Headers', count: stored ? http.requestHeaders.length + http.responseHeaders.length : undefined, panel: loading ? wait : <HeadersTab http={http} row={row} order={order} stored={stored} /> },
      { key: 'payload', label: 'Payload', panel: loading ? wait : <PayloadTab http={http} stored={stored} /> },
      { key: 'preview', label: 'Preview', panel: loading ? wait : <BodyView body={res} mode="tree" label="response body" empty={stored ? 'response นี้ไม่มี body' : 'ยังไม่ได้บันทึก response body ของ span นี้'} /> },
      { key: 'response', label: 'Response', panel: loading ? wait : <BodyView body={res} mode="raw" label="response body" empty={stored ? 'response นี้ไม่มี body' : 'ยังไม่ได้บันทึก response body ของ span นี้'} /> },
      timing,
    ]
  } else if ((row.type === 'db' || row.type === 'redis') && detail.db) {
    first = 'query'
    // the SDK's `{ key: '…' }` entry marks a cut list, not a bind value
    items = [{ key: 'query', label: 'Query', count: row.type === 'db' && stored ? detail.db.params.filter((p) => p.key !== '…').length : undefined, panel: loading ? wait : <QueryView db={detail.db} id={`${PANEL_ID}-q`} redis={row.type === 'redis'} /> }, timing]
  } else if (row.type === 'queue' && detail.message) {
    first = 'message'
    items = [{ key: 'message', label: 'Message', panel: loading ? wait : <MessageTab message={detail.message} row={row} stored={stored} /> }, timing]
  } else items = [timing]

  const headRedacted = curl?.redacted ?? 0
  const failure = row.failed ? failureOf(s) : null
  const files = curl?.files.map((f) => `@${f}`).join(', ') ?? ''
  return (
    <section className="ui-nw-sheet" id={PANEL_ID} aria-labelledby={`${PANEL_ID}-title`}>
      <div className="ui-nw-sheet__head">
        <div className="ui-nw-sheet__heading">
          <div className="ui-nw-sheet__sub">
            <Tag>{IO_TYPE_LABEL[row.type]}</Tag>
            {row.method ? <span className="method">{row.method}</span> : null}
            {row.status ? <HttpStatus status={row.status} /> : <span className={row.failed ? 'mono t-danger' : 'mono t-muted'}>{row.statusText}</span>}
            <ServiceChip service={s.service} role={s.role} order={order} />
            <span className="mono t-ink2">{fmtMs(s.durationMs)}</span>
          </div>
          <h3 className="ui-nw-sheet__title" id={`${PANEL_ID}-title`} tabIndex={-1} ref={headingRef} title={row.title}>
            {row.name}
            {row.sub ? <span className="ui-nw-sheet__host">{row.sub}</span> : null}
          </h3>
          {failure ? (
            <p className="ui-nw-sheet__err" title={failure}>
              <MaskedText text={failure} />
            </p>
          ) : null}
          {curl ? (
            <div className="ui-nw-sheet__tools">
              <CopyButton
                text={curl.text}
                label="Copy as cURL"
                variant="quiet"
                size="sm"
                title={[
                  headRedacted ? `มี [REDACTED] ${headRedacted} ค่า ต้องแทนค่าจริงก่อนรัน` : '',
                  curl.partial.includes('truncated') ? 'body ถูกตัดที่ 64 KB' : '',
                  curl.files.length ? `อ่านไฟล์ ${files} จากโฟลเดอร์ที่รัน` : '',
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined}
              />
              {headRedacted ? (
                <span className="ui-nw-warn" title={MASKED_TITLE}>
                  [REDACTED] {headRedacted} ค่า ต้องแทนก่อนรัน
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <button className="btn-icon" type="button" aria-label="ปิดแผงรายละเอียด (Esc)" title="ปิด (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {bare ? (
        <p className="hint ui-nw-sheet__note">
          ไม่มี header และ body ที่เก็บไว้ของ span นี้ (บันทึกก่อนเปิดเก็บ I/O หรือ instrumentation ไม่ได้ส่งมา) · แสดงเท่าที่ trace มี
        </p>
      ) : null}
      {load.state === 'error' ? (
        <div className="ui-nw-sheet__note">
          <EngineErrorState error={load.error} inPanel={false} onRetry={retry} />
        </div>
      ) : null}
      {stored && (http?.requestBody?.truncated || http?.responseBody?.truncated) ? (
        <p className="hint ui-nw-sheet__note">
          body ใหญ่กว่าขนาดสูงสุดที่เก็บ:{' '}
          {[http.requestBody?.truncated ? `request ${truncNote(http.requestBody)}` : '', http.responseBody?.truncated ? `response ${truncNote(http.responseBody)}` : ''].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {curl && (curl.partial.includes('multipart') || curl.partial.includes('binary')) ? (
        <p className="hint ui-nw-sheet__note">
          {curl.partial.includes('multipart')
            ? `Copy as cURL ส่ง field ตามค่าที่เก็บไว้${curl.files.length ? ` และอ่านไฟล์ที่อัปโหลดจาก ${files}` : ''} (library ไม่เก็บเนื้อไฟล์) · วางไฟล์นั้นไว้ในโฟลเดอร์ที่รันก่อน`
            : `Copy as cURL อ่าน body จาก ${files} (library เก็บแค่ขนาดของ body นี้) · วางไฟล์นั้นไว้ในโฟลเดอร์ที่รันก่อน`}
        </p>
      ) : null}
      <Tabs key={row.id} className="ui-nw-tabs" items={items} label={`รายละเอียด ${IO_TYPE_LABEL[row.type]} ${row.name}`} param="tab" defaultKey={first} />
    </section>
  )
}
