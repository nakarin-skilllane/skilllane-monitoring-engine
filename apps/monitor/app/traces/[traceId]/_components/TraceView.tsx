'use client'

/**
 * Waterfall + "Span ที่เลือก" of one trace (trace-detail.html). Spans are drawn in call order (tree by start
 * time); the bars grow in that order when the waterfall scrolls into view (`.wf` + `--s`, DESIGN.md §7b) and
 * the failed span pulses red once. Log markers sit on a lane above the spans and on their own span's row.
 * Picking a span (row, Enter, or any `[data-pick]` link on the page) fills the panel below and puts
 * `?span=<spanId>` in the URL without a server round trip.
 *
 * Next to the waterfall, the Network view (`?view=network`, components/network) lists every span that carried
 * I/O like the DevTools Network tab; a row, or a waterfall span with I/O, opens the span panel (Headers / Payload /
 * Preview / Response / Timing, Query, Message). From 1280 px the panel sits beside the list or the waterfall,
 * below that it is a sheet over the page (full width on a phone); Esc closes it and focus goes back to the row.
 * The URL says what is on screen in both views: `?span=` the selected span, `?io=` the span whose panel is open
 * (removed when it closes), so a reload or a copied link shows the same.
 */
import Link from 'next/link'
import { Fragment, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { CategoryChip, HttpStatus, ServiceChip, Ts } from '@/components/badges'
import { Icon } from '@/components/icons'
import { NetworkTable, rowDomId } from '@/components/network/NetworkTable'
import { SpanIoPanel } from '@/components/network/SpanIoPanel'
import { DurBar } from '@/components/table'
import { fmtMs, fmtNumber, fmtTimeMs, shortId } from '@/lib/format'
import { type NetRow, netRowsOf } from '@/lib/io'
import { svcColor } from '@/lib/services'
import type { SpanDetail } from '@/lib/types'
import { fmtOff, spanLabel, spanWhy, type WfSpan } from '../../_lib/model'

export interface LogMarker {
  /** Anchor of the log line (`log-3`). */
  id: string
  /** % of the trace. */
  t: number
  /** Vertical position in the lane when markers collide (%). */
  y?: number
  level: string
  tip: string
  tipKey: string
  label: string
  spanId: string
}

export interface SpanErrorRef {
  href: string
  title: string
  category: string
}

export interface WfModel {
  traceId: string
  start: string
  t0: number
  total: number
  spans: WfSpan[]
  markers: LogMarker[]
  /** Axis labels; `hideBelow` = hidden while the axis is narrower than that many px (it would run into the end label). */
  ticks: Array<{ t: number; label: string; hideBelow?: number }>
  gridMs: number
  env: string
  order: string[]
  initialSpanId: string
  failedSpanId: string | null
  /** spanId → error group of the error line written in / about that span. */
  spanErrors: Record<string, SpanErrorRef>
  /** `?view=network`: the Network table instead of the waterfall. */
  view: 'waterfall' | 'network'
  /** Span whose I/O panel is open on load (`?io=`, moved up to the nearest span with I/O), in either view. */
  openSpanId: string | null
  /** Its detail, fetched by the server (links from Log and Jobs open without a loading flash). */
  openDetail: SpanDetail | null
  /** The engine has no detail for it (404): the panel does not ask again. */
  openMissing: boolean
}

const LOG_CLASS: Record<string, string> = { error: 'td-log td-log--err', fatal: 'td-log td-log--err', warn: 'td-log td-log--wrn', debug: 'td-log td-log--dbg' }

/** Panel docked beside the list from this width; below it is a sheet over the page. */
const SHEET_MQ = '(max-width: 1279px)'

/** What the "Span ที่เลือก" button opens for a span with I/O. */
const IO_ACTION: Record<NetRow['type'], string> = { 'http-in': 'ดู request / response', 'http-out': 'ดู request / response', db: 'ดู query', redis: 'ดูคำสั่ง', queue: 'ดู message' }

/** The URL of this page with some params changed (null removes), without a server round trip. */
function writeUrl(changes: Record<string, string | null>) {
  const url = new URL(window.location.href)
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) url.searchParams.delete(k)
    else url.searchParams.set(k, v)
  }
  url.hash = ''
  window.history.replaceState(window.history.state, '', url)
}

/** How a hop was called: through a queue (consumer) or HTTP. */
function via(w: WfSpan, spans: WfSpan[]): string {
  const caller = w.parentN ? spans[w.parentN - 1] : null
  return w.span.kind === 'CONSUMER' || caller?.span.kind === 'PRODUCER' ? 'queue' : 'HTTP'
}

function statusText(w: WfSpan): string {
  const s = w.span
  if (s.statusCode !== 'ERROR') return s.statusCode || 'UNSET'
  // the code (ORA-12899) when the exception type is the generic Error
  const why = spanWhy(s)
  return why ? `ERROR · ${why}` : 'ERROR'
}

/** ms since the epoch of the span's exception event (OTel timeUnixNano), or null. */
function exceptionTime(w: WfSpan): number | null {
  for (const e of w.span.events as Array<{ name?: string; timeUnixNano?: string | number }>) {
    if (e?.name === 'exception' && e.timeUnixNano) {
      const ms = Number(e.timeUnixNano) / 1e6
      if (Number.isFinite(ms)) return ms
    }
  }
  return null
}

export function TraceView({ model }: { model: WfModel }) {
  const { spans, total, order } = model
  const byId = useMemo(() => new Map(spans.map((w) => [w.span.spanId, w])), [spans])
  const [selId, setSelId] = useState(model.initialSpanId)
  const sel = byId.get(selId) ?? spans[0]
  const netRows = useMemo(() => netRowsOf(spans), [spans])
  const netById = useMemo(() => new Map(netRows.map((r) => [r.id, r])), [netRows])
  const [view, setView] = useState(model.view)
  const [openId, setOpenId] = useState<string | null>(model.openSpanId)
  const openRow = openId ? (netById.get(openId) ?? null) : null
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusPanel = useRef(false)
  // the I/O spans inside the open one (its subtree), for the Timing tab
  const inner = useMemo(() => {
    if (!openRow) return []
    const w = openRow.input
    const ids = new Set<string>()
    for (let i = w.n; i < spans.length && spans[i].depth > w.depth; i++) ids.add(spans[i].span.spanId)
    return netRows.filter((r) => ids.has(r.id))
  }, [openRow, spans, netRows])

  const pick = useCallback(
    (id: string, scroll: boolean) => {
      if (!byId.has(id)) return
      setSelId(id)
      writeUrl({ span: id })
      // instant, like the mockup's #span-detail-section link (a smooth scroll is cut short by the router's history sync)
      if (scroll) document.getElementById('span-detail-section')?.scrollIntoView({ block: 'start' })
    },
    [byId],
  )

  /** Close the I/O panel and say so in the URL (`io` removed). */
  const shutPanel = useCallback(() => {
    setOpenId(null)
    writeUrl({ io: null })
  }, [])

  /** Open the I/O panel of a span (closes it for a span without I/O); a sheet over the page takes focus. */
  const openPanel = useCallback(
    (id: string) => {
      if (!netById.has(id)) {
        shutPanel()
        return
      }
      focusPanel.current = window.matchMedia(SHEET_MQ).matches
      setOpenId(id)
      writeUrl({ io: id })
    },
    [netById, shutPanel],
  )

  const closePanel = useCallback(() => {
    const id = openId
    shutPanel()
    if (!id) return
    // back to the row it was opened from: the Network row, else the span's waterfall button
    window.setTimeout(() => (document.getElementById(rowDomId(id)) ?? document.getElementById(`wf-pick-${id}`))?.focus(), 0)
  }, [openId, shutPanel])

  useEffect(() => {
    if (openId && focusPanel.current) headingRef.current?.focus()
    focusPanel.current = false
  }, [openId])

  // Esc closes the panel (not while a drawer is open on top of it); while it is a sheet over the page, Tab stays inside
  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.drawer.is-open')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closePanel()
        return
      }
      const panel = document.getElementById('nw-panel')
      if (e.key !== 'Tab' || !panel || !window.matchMedia(SHEET_MQ).matches) return
      const f = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter(
        (x) => x.offsetWidth || x.offsetHeight || x.getClientRects().length,
      )
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (!panel.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openId, closePanel])

  const switchView = (v: 'waterfall' | 'network') => {
    setView(v)
    writeUrl({ view: v === 'network' ? 'network' : null })
  }

  // links anywhere on the page (callout, log lines, parent) pick a span: [data-pick="<spanId>"]
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[data-pick]')
      const id = a?.getAttribute('data-pick')
      if (!id || !byId.has(id)) return
      e.preventDefault()
      pick(id, true)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [byId, pick])

  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / total) * 100))
  const services = Array.from(new Map(spans.map((w) => [`${w.span.service}`, w.span.service])).values())
  // one rail key per service/role that ran outside the root service
  const hops = Array.from(new Map(spans.filter((w) => w.hop && w.railAt !== null).map((w) => [`${w.span.service}/${w.span.role}`, w])).values())
  const levels = new Set(model.markers.map((m) => m.level))

  return (
    <>
      <section className="section" aria-labelledby="h-wf">
        <div className="section__head">
          <h2 className="section__title" id="h-wf">
            {view === 'network' ? 'Network' : 'Waterfall'}
          </h2>
          <span className="section__meta">
            {view === 'network' ? (
              <>
                {netRows.length} รายการที่มี I/O ตามลำดับที่เรียก · request เข้า, เรียกออก, query, Redis และ queue · คลิกแถวเพื่อดู header, body, query และ message
              </>
            ) : (
              <>
                {spans.length} span ตามเวลาเริ่ม · แกน 0–{fmtOff(total)} ms นับจาก <Ts value={model.start} /> · เส้นตั้งทุก {fmtOff(model.gridMs)} ms · คลิก span เพื่อดูรายละเอียด
              </>
            )}
          </span>
          <div className="section__actions">
            <div className="seg" role="group" aria-label="มุมมองของ trace">
              <button className="seg__btn" type="button" aria-pressed={view === 'waterfall'} onClick={() => switchView('waterfall')}>
                Waterfall
              </button>
              <button className="seg__btn" type="button" aria-pressed={view === 'network'} onClick={() => switchView('network')}>
                Network <span className="tab__count">{netRows.length}</span>
              </button>
            </div>
          </div>
        </div>
        <div className={openRow ? 'ui-nw-split is-open' : 'ui-nw-split'}>
          <div className="ui-nw-split__main">
            {view === 'network' ? (
              <NetworkTable
                rows={netRows}
                total={total}
                order={order}
                selectedId={selId}
                openId={openId}
                onPick={(id, open) => {
                  pick(id, false)
                  if (open || openId) openPanel(id)
                }}
              />
            ) : (
              <div className="panel">
                <div className="table-wrap">
                  <div
                    className="wf td-wf"
                    role="table"
                    aria-label={`Waterfall ของ trace ${shortId(model.traceId)}: ${spans.length} span และหมุด log ${model.markers.length} จุด`}
                    style={{ '--td-grid': `${fmtNumber(pct(model.gridMs), 4)}%` } as CSSProperties}
                  >
                    <div className="wf__scale" role="row">
                      <span role="columnheader">Span</span>
                      <span className="wf__ticks" role="columnheader" aria-label={`แกนเวลา 0 ถึง ${fmtMs(total)}`}>
                        {model.ticks.map((t) => (
                          <span key={t.t} className={t.hideBelow ? `td-tick--${t.hideBelow}` : undefined} style={{ '--t': fmtNumber(t.t, 4) } as CSSProperties}>
                            {t.label}
                          </span>
                        ))}
                        <span className="wf__tick-end">{fmtOff(total)}</span>
                      </span>
                      <span className="td-r" role="columnheader">
                        เวลา
                      </span>
                    </div>

                    {model.markers.length ? (
                      <div className="wf__row td-lane" role="row">
                        <span className="wf__name" role="cell">
                          <Icon name="logs" size="sm" />
                          <span>
                            Log ของ trace <span className="tab__count">{model.markers.length}</span>
                          </span>
                        </span>
                        <span className="wf__track" role="cell">
                          {model.markers.map((m) => (
                            <a
                              key={m.id}
                              className={LOG_CLASS[m.level] ?? 'td-log'}
                              href={`#${m.id}`}
                              style={{ '--t': fmtNumber(m.t, 3), ...(m.y !== undefined ? { '--y': `${m.y}%` } : {}) } as CSSProperties}
                              data-tip={m.tip}
                              data-tip-keys={m.tipKey}
                              aria-label={m.label}
                            />
                          ))}
                        </span>
                        <span className="wf__ms" role="cell" />
                      </div>
                    ) : null}

                    {spans.map((w) => {
                      const s = w.span
                      const selected = w === sel
                      const color = svcColor(s.service, order)
                      const cls = ['wf__row', w.railAt !== null ? 'td-remote' : '', w.isError ? 'is-error' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ')
                      const nameStyle = { '--d': w.depth, ...(w.railAt !== null ? { '--td-rail': color, '--td-rail-at': w.railAt } : {}) } as CSSProperties
                      const caller = w.hop && w.parentN ? spans[w.parentN - 1] : null
                      return (
                        <div key={s.spanId} className={cls} role="row" style={{ '--c': color } as CSSProperties} data-span={w.n}>
                          <span className="wf__name" role="cell" style={nameStyle}>
                            {w.isError ? <span className="lvl lvl--err">ERR</span> : null}
                            <button
                              className="td-pick"
                              type="button"
                              id={`wf-pick-${s.spanId}`}
                              aria-controls={netById.has(s.spanId) ? 'span-detail nw-panel' : 'span-detail'}
                              aria-current={selected ? 'true' : undefined}
                              onClick={() => {
                                pick(s.spanId, false)
                                // a span with I/O opens its panel, like a row of the Network view
                                if (netById.has(s.spanId)) openPanel(s.spanId)
                                else if (openId) shutPanel()
                              }}
                            >
                              {s.name}
                            </button>
                            {w.lib ? <span className="td-lib">{w.lib}</span> : null}
                            <span className="tag">{s.kind}</span>
                            {s.kind === 'SERVER' && s.http?.status ? <HttpStatus status={s.http.status} /> : null}
                            {s.peer && (s.kind === 'CLIENT' || s.kind === 'PRODUCER') ? <span className="td-peer">→ {s.peer}</span> : null}
                            {w.hop ? (
                              <span className="td-hop" title={`รันใน ${s.service}${caller ? ` เรียกมาจาก span #${caller.n} ผ่าน ${via(w, spans)}` : ''}`}>
                                <Icon name="hop" />
                                {s.service}/{s.role}
                              </span>
                            ) : null}
                          </span>
                          <span className="wf__track" role="cell">
                            <DurBar start={pct(w.start)} width={pct(s.durationMs)} color={w.isError ? undefined : color} className={w.isError ? 'is-error' : undefined} />
                            {model.markers
                              .filter((m) => m.spanId === s.spanId)
                              .map((m) => (
                                <a
                                  key={m.id}
                                  className={LOG_CLASS[m.level] ?? 'td-log'}
                                  href={`#${m.id}`}
                                  style={{ '--t': fmtNumber(m.t, 3) } as CSSProperties}
                                  tabIndex={-1}
                                  data-tip={m.tip}
                                  data-tip-keys={m.tipKey}
                                  aria-label={`${m.label} (span นี้)`}
                                />
                              ))}
                          </span>
                          <span className="wf__ms" role="cell">
                            {fmtMs(s.durationMs)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="panel__foot td-wf-foot">
                  <ul className="legend">
                    {services.map((svc) => (
                      <li className="legend__item" key={svc}>
                        <span className="legend__key" style={{ '--c': svcColor(svc, order) } as CSSProperties} />
                        {svc}
                      </li>
                    ))}
                    {hops.slice(0, 2).map((w) => (
                      <li className="legend__item" key={`rail-${w.n}`}>
                        <span className="td-key-rail" style={{ '--td-rail': svcColor(w.span.service, order) } as CSSProperties} aria-hidden="true" />
                        ช่วงที่รันใน {w.span.service}/{w.span.role} (เรียกผ่าน {via(w, spans)} จาก span #{w.parentN})
                      </li>
                    ))}
                    {spans.some((w) => w.isError) ? (
                      <li className="legend__item">
                        <span className="legend__key" style={{ '--c': 'var(--danger-solid)' } as CSSProperties} />
                        span ที่ error (มี ERR กำกับ)
                      </li>
                    ) : null}
                    {levels.has('info') || levels.has('debug') ? (
                      <li className="legend__item">
                        <span className="td-key-log" aria-hidden="true" />
                        log INF
                      </li>
                    ) : null}
                    {levels.has('warn') ? (
                      <li className="legend__item">
                        <span className="td-key-log td-key-log--wrn" aria-hidden="true" />
                        log WRN
                      </li>
                    ) : null}
                    {levels.has('error') || levels.has('fatal') ? (
                      <li className="legend__item">
                        <span className="td-key-log td-key-log--err" aria-hidden="true" />
                        log ERR
                      </li>
                    ) : null}
                  </ul>
                  <details className="chart__table">
                    <summary className="summary-line">ดูเป็นตาราง ({spans.length} span)</summary>
                    <div className="table-wrap">
                      <table className="table table--dense">
                        <caption>เวลาเป็น ms นับจาก {fmtTimeMs(model.start)} ICT</caption>
                        <thead>
                          <tr>
                            <th scope="col" className="num">
                              #
                            </th>
                            <th scope="col">Span</th>
                            <th scope="col">Service</th>
                            <th scope="col">Kind</th>
                            <th scope="col" className="num">
                              Parent
                            </th>
                            <th scope="col" className="num">
                              เริ่ม
                            </th>
                            <th scope="col" className="num">
                              จบ
                            </th>
                            <th scope="col" className="num">
                              เวลา
                            </th>
                            <th scope="col">สถานะ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {spans.map((w) => (
                            <tr key={w.span.spanId} aria-current={w === sel ? 'true' : undefined}>
                              <td className="num">{w.n}</td>
                              <td className="mono nowrap">{spanLabel(w)}</td>
                              <td>
                                <ServiceChip service={w.span.service} role={w.span.role} order={order} />
                              </td>
                              <td className="mono">{w.span.kind}</td>
                              <td className={w.parentN ? 'num' : 'num t-muted'}>{w.parentN ?? '–'}</td>
                              <td className="num">{fmtOff(w.start)}</td>
                              <td className="num">{fmtOff(w.end)}</td>
                              <td className="num">{fmtOff(w.span.durationMs)}</td>
                              <td className={w.span.statusCode === 'ERROR' ? 'mono t-danger' : 'mono t-muted'}>{statusText(w)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </div>
              </div>
            )}
          </div>
          {openRow ? (
            <SpanIoPanel
              traceId={model.traceId}
              row={openRow}
              inner={inner}
              total={total}
              order={order}
              initial={model.openDetail}
              initialMissing={model.openMissing && openRow.id === model.openSpanId}
              onClose={closePanel}
              onOpen={(id) => {
                pick(id, false)
                openPanel(id)
              }}
              headingRef={headingRef}
            />
          ) : null}
        </div>
      </section>

      {sel ? (
        <SpanPanel
          w={sel}
          model={model}
          byId={byId}
          io={netById.get(sel.span.spanId) ?? null}
          onOpenIo={(id) => {
            openPanel(id)
            document.getElementById('h-wf')?.scrollIntoView({ block: 'start' })
          }}
        />
      ) : null}
    </>
  )
}

function SpanPanel({ w, model, byId, io, onOpenIo }: { w: WfSpan; model: WfModel; byId: Map<string, WfSpan>; io: NetRow | null; onOpenIo: (id: string) => void }) {
  const s = w.span
  const parent = w.parentN ? model.spans[w.parentN - 1] : null
  const excAt = exceptionTime(w)
  const err = model.spanErrors[s.spanId]
  const attrs = Object.entries(s.attributes ?? {})
  const failed = model.failedSpanId === s.spanId
  const startAbs = model.t0 + w.start
  return (
    <section className="section" id="span-detail-section" aria-labelledby="h-span">
      <div className="section__head">
        <h2 className="section__title" id="h-span">
          Span ที่เลือก
        </h2>
        <span className="section__meta">
          #{w.n} จาก {model.spans.length}
          {failed ? ' · ขั้นที่พัง (failed step)' : ''}
        </span>
      </div>
      <div className="panel" id="span-detail">
        <div className="panel__head td-sd-head">
          {w.isError ? <span className="lvl lvl--err">ERR</span> : null}
          <h3 className="td-sd-title">{spanLabel(w)}</h3>
          <span className="tag">{s.kind}</span>
          <ServiceChip service={s.service} role={s.role} order={model.order} />
          <div className="panel__actions">
            {io ? (
              <button className="btn btn--sm" type="button" aria-controls="nw-panel" onClick={() => onOpenIo(io.id)}>
                {IO_ACTION[io.type]}
              </button>
            ) : null}
            <CopyButton text={s.spanId} label="คัดลอก span id" variant="quiet" size="sm" />
          </div>
        </div>
        <div className="panel__body">
          <div className="grid grid--2 td-sd-grid">
            <div>
              <div className="field-group">
                <h3 className="field-group__title">Span</h3>
                <dl className="fields">
                  <dt>
                    ประเภท<span className="fname">kind</span>
                  </dt>
                  <dd className="mono">{s.kind}</dd>
                  <dt>
                    Service · role<span className="fname">service · role</span>
                  </dt>
                  <dd>
                    <ServiceChip service={s.service} role={s.role} order={model.order} />
                  </dd>
                  <dt>
                    เริ่มที่<span className="fname">timestamp</span>
                  </dt>
                  <dd>
                    <span className="mono">+{fmtMs(w.start)}</span> · <Ts value={startAbs} />
                  </dd>
                  <dt>
                    เวลาที่ใช้<span className="fname">duration_ns</span>
                  </dt>
                  <dd>
                    <span className="mono">{fmtMs(s.durationMs)}</span> · {fmtNumber((s.durationMs / model.total) * 100, 1)} % ของ trace
                  </dd>
                  <dt>
                    สถานะ<span className="fname">status_code · status_message</span>
                  </dt>
                  <dd>
                    {s.statusCode === 'ERROR' ? (
                      <>
                        <span className="mono t-danger">ERROR</span>
                        {s.statusMessage || s.http?.status ? (
                          <>
                            {' '}
                            · <span className="mono">{s.statusMessage || `HTTP ${s.http?.status}`}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="mono t-muted">{s.statusCode || 'UNSET'}</span>
                    )}
                  </dd>
                  <dt>
                    ปลายทาง<span className="fname">peer</span>
                  </dt>
                  <dd className="mono">{s.peer || '–'}</dd>
                  <dt>
                    Span id<span className="fname">span_id</span>
                  </dt>
                  <dd className="mono">{s.spanId}</dd>
                  <dt>
                    Parent<span className="fname">parent_span_id</span>
                  </dt>
                  <dd>
                    {parent ? (
                      <>
                        <a href="#span-detail-section" data-pick={parent.span.spanId} className="mono">
                          #{parent.n} {spanLabel(parent)}
                        </a>{' '}
                        <span className="mono t-muted">{parent.span.spanId}</span>
                      </>
                    ) : s.parentSpanId && !byId.has(s.parentSpanId) ? (
                      <span className="mono t-muted">{s.parentSpanId} (ไม่อยู่ใน trace นี้)</span>
                    ) : (
                      <span className="t-muted">– (span แรกของ trace)</span>
                    )}
                  </dd>
                </dl>
              </div>
              {s.db ? (
                <div className="field-group">
                  <h3 className="field-group__title">Database</h3>
                  <dl className="fields">
                    <dt>
                      ระบบ<span className="fname">db_system</span>
                    </dt>
                    <dd className="mono">{s.db.system || '–'}</dd>
                    {s.db.statement ? (
                      <>
                        <dt>
                          คำสั่ง<span className="fname">db_statement</span>
                        </dt>
                        <dd>
                          <pre className="code code--wrap">{s.db.statement}</pre>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </div>
            <div>
              {s.exception ? (
                <div className="field-group">
                  <h3 className="field-group__title">Exception event</h3>
                  <dl className="fields">
                    {excAt !== null ? (
                      <>
                        <dt>
                          เวลา<span className="fname">events[].time</span>
                        </dt>
                        <dd>
                          <span className="mono">+{fmtMs(excAt - model.t0)}</span> · <Ts value={excAt} />
                        </dd>
                      </>
                    ) : null}
                    <dt>
                      ประเภท<span className="fname">exception_type</span>
                    </dt>
                    <dd className="mono">{s.exception.type || '–'}</dd>
                    <dt>
                      ข้อความ<span className="fname">exception_message</span>
                    </dt>
                    <dd>
                      <span className="err-row__actual">{s.exception.message}</span>
                    </dd>
                    {err ? (
                      <>
                        <dt>
                          ตรงกับ error<span className="fname">logs.error_hint</span>
                        </dt>
                        <dd>
                          <Link href={err.href}>{err.title}</Link> {err.category ? <CategoryChip category={err.category} /> : null}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ) : null}
              <div className="field-group">
                <h3 className="field-group__title">
                  Attribute ทั้งหมด<span className="fname td-fname-inline">attributes</span>
                </h3>
                <div className="table-wrap">
                  <table className="table table--dense">
                    <thead>
                      <tr>
                        <th scope="col">key</th>
                        <th scope="col">value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attrs.length ? (
                        attrs.map(([k, v]) => (
                          <tr key={k}>
                            <td className="mono nowrap">{k}</td>
                            <td className="mono">{v}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td className="t-muted" colSpan={2}>
                            span นี้ไม่มี attribute เพิ่มเติม
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="field-group">
                <h3 className="field-group__title">
                  Resource<span className="fname td-fname-inline">resource</span>
                </h3>
                <ul className="kv-list" aria-label="Resource ของ service">
                  {(
                    [
                      ['service.name', s.service],
                      ['app.role', s.role],
                      ['service.version', s.version],
                      ['deployment.environment.name', model.env],
                    ] as Array<[string, string]>
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <Fragment key={k}>
                        <li className="kv">
                          <span className="kv__k">{k}</span>
                          <span className="kv__v">{v}</span>
                        </li>
                      </Fragment>
                    ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
