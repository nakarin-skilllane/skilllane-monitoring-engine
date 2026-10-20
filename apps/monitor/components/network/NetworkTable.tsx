'use client'

/**
 * The Network table of a trace (like the DevTools Network tab): one row per span that carried I/O (the incoming
 * request, outgoing HTTP calls, DB queries, Redis commands, queue publish / consume) in call order, with the
 * DevTools columns Name (path or statement head), Method, Status, Type, Size (request / response bytes), Time and a
 * waterfall bar on the trace's time axis. Filter chips by type. The footer totals the shown rows with each exchange
 * counted once (lib/io.ts ioTotals: a call between two services of the trace is one request, a job's attempts one
 * message), `–` when no size is known. Keyboard: ↑ ↓ Home End move the selected row (the open panel follows, like
 * DevTools), Enter opens it (Esc closes it: TraceView). Rows render up to 500 at a time.
 */
import type { KeyboardEvent } from 'react'
import { useMemo, useState } from 'react'
import { HttpStatus } from '@/components/badges'
import { EmptyState } from '@/components/states'
import { DurBar } from '@/components/table'
import { fmtCount, fmtMs } from '@/lib/format'
import { fmtBytes, IO_FILTER_LABEL, IO_TYPE_LABEL, IO_TYPES, type IoType, ioTotals, type NetRow } from '@/lib/io'
import { svcColor } from '@/lib/services'
import { PANEL_ID } from './SpanIoPanel'

const PAGE = 500

export const rowDomId = (id: string) => `nw-row-${id}`

function sizeText(r: NetRow): { text: string; title: string } {
  const io = r.input.span.io
  const cut = (on: boolean | undefined) => (on ? ' (ตัดที่ 64 KB)' : '')
  if (r.type === 'db') return { text: r.params ? `${fmtCount(r.params)} bind` : '–', title: `${fmtCount(r.params)} ค่า bind` }
  if (r.type === 'queue') return { text: fmtBytes(r.reqBytes), title: r.reqBytes === null ? 'ไม่ได้บันทึก payload' : `payload ${fmtBytes(r.reqBytes)}` }
  if (r.type === 'redis' || (r.reqBytes === null && r.resBytes === null)) return { text: '–', title: 'ไม่ได้บันทึกขนาด' }
  return {
    text: `${fmtBytes(r.reqBytes)} / ${fmtBytes(r.resBytes)}`,
    title: `request ${fmtBytes(r.reqBytes)}${cut(io?.reqTruncated)} · response ${fmtBytes(r.resBytes)}${cut(io?.resTruncated)}`,
  }
}

export function NetworkTable({
  rows,
  total,
  order,
  selectedId,
  openId,
  onPick,
}: {
  rows: NetRow[]
  /** Trace length in ms (the bars' scale). */
  total: number
  order: readonly string[]
  /** The selected span (aria-current), also when its panel is closed. */
  selectedId: string | null
  openId: string | null
  /** Select a row; `open` = open its panel too. */
  onPick: (id: string, open: boolean) => void
}) {
  const [types, setTypes] = useState<ReadonlySet<IoType>>(new Set())
  const [limit, setLimit] = useState(PAGE)
  const counts = useMemo(() => {
    const c = new Map<IoType, number>()
    for (const r of rows) c.set(r.type, (c.get(r.type) ?? 0) + 1)
    return c
  }, [rows])
  const visible = useMemo(() => (types.size ? rows.filter((r) => types.has(r.type)) : rows), [rows, types])
  const shown = visible.slice(0, limit)
  const focusId = shown.some((r) => r.id === selectedId) ? selectedId : (shown[0]?.id ?? null)
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms / total) * 100))
  const totals = useMemo(() => ioTotals(visible), [visible])
  const sizes = [
    totals.http ? `request ${fmtBytes(totals.request)}` : '',
    totals.http ? `response ${fmtBytes(totals.response)}` : '',
    totals.queue ? `message ${fmtBytes(totals.message)}` : '',
  ].filter(Boolean)

  function toggle(t: IoType | null) {
    setTypes((cur) => {
      if (!t) return new Set()
      const next = new Set(cur)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next.size === counts.size ? new Set() : next
    })
  }

  function move(id: string) {
    onPick(id, openId !== null)
    document.getElementById(rowDomId(id))?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    const tr = (e.target as Element).closest('tr[data-id]')
    const id = tr?.getAttribute('data-id')
    if (!id) return
    const i = shown.findIndex((r) => r.id === id)
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: shown.length - 1 }[e.key]
    if (to !== undefined) {
      e.preventDefault()
      const r = shown[Math.max(0, Math.min(shown.length - 1, to))]
      if (r) move(r.id)
      return
    }
    // Esc is the page's (TraceView closes the panel from anywhere)
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick(id, true)
    }
  }

  if (!rows.length)
    return (
      <div className="panel">
        <EmptyState
          icon="traces"
          title="trace นี้ไม่มี request, query หรือ message"
          text="span ทุกตัวเป็นงานภายใน service (handler, ฟังก์ชัน) ไม่มี HTTP เข้า-ออก, database, Redis หรือ queue · ดูลำดับเวลาใน Waterfall"
        />
      </div>
    )

  return (
    <div className="panel ui-nw">
      <div className="panel__head ui-nw__head">
        <div className="chips" role="group" aria-label="กรองตามประเภท">
          <button className="fchip" type="button" aria-pressed={types.size === 0} onClick={() => toggle(null)}>
            ทั้งหมด <span className="fchip__n">{fmtCount(rows.length)}</span>
          </button>
          {IO_TYPES.filter((t) => counts.has(t)).map((t) => (
            <button key={t} className="fchip" type="button" aria-pressed={types.has(t)} onClick={() => toggle(t)}>
              {IO_FILTER_LABEL[t]} <span className="fchip__n">{fmtCount(counts.get(t))}</span>
            </button>
          ))}
        </div>
        <span className="panel__meta ui-nw__keys">↑ ↓ เลือกแถว · Enter เปิด · Esc ปิด</span>
      </div>
      <div className="table-wrap">
        <table className="table table--dense table--reflow ui-nw-table" aria-label={`Network ของ trace: ${fmtCount(visible.length)} รายการ`}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="ui-nw-c-method">
                Method
              </th>
              <th scope="col" className="ui-nw-c-status">
                Status
              </th>
              <th scope="col" className="ui-nw-c-type">
                Type
              </th>
              <th scope="col" className="num ui-nw-c-size" title="request / response">
                Size
              </th>
              <th scope="col" className="num ui-nw-c-time">
                Time
              </th>
              <th scope="col" className="ui-nw-c-wf">
                Waterfall
              </th>
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {shown.map((r) => {
              const size = sizeText(r)
              const sel = r.id === selectedId
              const cls = ['ui-nw-row', 'is-clickable', r.failed ? 'is-bad' : '', r.id === openId ? 'is-open' : ''].filter(Boolean).join(' ')
              return (
                <tr
                  key={r.id}
                  id={rowDomId(r.id)}
                  data-id={r.id}
                  className={cls}
                  tabIndex={r.id === focusId ? 0 : -1}
                  aria-current={sel ? 'true' : undefined}
                  aria-controls={r.id === openId ? PANEL_ID : undefined}
                  onClick={() => onPick(r.id, true)}
                >
                  <td className="ui-nw-name">
                    <span className={r.failed ? 'ui-nw-name__main t-danger' : 'ui-nw-name__main'} title={r.title}>
                      {r.name}
                    </span>
                    {r.sub ? <span className="ui-nw-name__sub">{r.sub}</span> : null}
                  </td>
                  <td className="mono ui-nw-c-method">{r.method ? <span className="method">{r.method}</span> : '–'}</td>
                  <td className="ui-nw-c-status">
                    {r.status ? <HttpStatus status={r.status} /> : <span className={r.failed ? 'mono t-danger' : 'mono t-muted'}>{r.statusText}</span>}
                  </td>
                  <td className="ui-nw-c-type">
                    <span className="tag">{IO_TYPE_LABEL[r.type]}</span>
                  </td>
                  <td className="num ui-nw-c-size" title={size.title}>
                    {size.text}
                  </td>
                  <td className="num ui-nw-c-time">{fmtMs(r.durationMs)}</td>
                  <td className="ui-nw-c-wf">
                    <span className="ui-nw-wf">
                      <DurBar start={pct(r.start)} width={pct(r.durationMs)} color={r.failed ? undefined : svcColor(r.input.span.service, order)} className={r.failed ? 'is-error' : undefined} />
                    </span>
                  </td>
                </tr>
              )
            })}
            {!shown.length ? (
              <tr>
                <td colSpan={7} className="t-muted">
                  ไม่มีรายการประเภทนี้ · กด ทั้งหมด เพื่อดูทุกประเภท
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="panel__foot ui-nw__foot">
        <span title="body ของ request / response และ payload ของ message ในแถวที่แสดง นับครั้งเดียวต่อการเรียก: service ใน trace เรียกกันเองนับครั้งเดียว, job ที่ retry นับ message ครั้งเดียว">
          {types.size ? `${fmtCount(visible.length)} จาก ${fmtCount(rows.length)} รายการ` : `${fmtCount(rows.length)} รายการ`}
          {sizes.map((t) => ` · ${t}`).join('')} · trace จบที่ {fmtMs(total)}
        </span>
        {visible.length > limit ? (
          <button className="btn btn--sm" type="button" onClick={() => setLimit((l) => l + PAGE)}>
            แสดงอีก {fmtCount(Math.min(PAGE, visible.length - limit))} รายการ
          </button>
        ) : null}
      </div>
    </div>
  )
}
