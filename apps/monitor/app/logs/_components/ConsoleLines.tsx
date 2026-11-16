'use client'

/**
 * What the log console draws (logs-console.html): a line in the terminal format (`.ln`: time · level · service ·
 * context · logger message key=value duration, the error's detail / how to fix / actual error indented under it), a
 * separator (`.ln-sep`: deploy, outage, recovered), a request block of the Timeline view (`.tg`: head with route,
 * status, services, a rail of ticks and the duration; open = its lines on a time rail), and the detail that opens
 * under a line (`.ln-x`, never a side panel). Pure renders: the console owns the state.
 */
import Link from 'next/link'
import { type CSSProperties, Fragment, memo, type ReactNode } from 'react'
import { fmtCount, fmtDateTimeMs, fmtDuration, fmtTime, fmtTimeMs } from '@/lib/format'
import { buildHref, type Keep } from '@/lib/params'
import { actualError, LEVEL_SHORT, logTitle } from '@/lib/readable'
import { svcColor } from '@/lib/services'
import type { LogRepeat, LogRow } from '@/lib/types'
import { type BlockEvent, ctxOf, eventsOf, isAborted, isGap, isSlow, kvsOf, type LineRec, loggerOf, offText, rankOf, type RequestGroup, type Separator, srcOf, statusClass } from '../_lib/console'
import { actualText } from '../_lib/lines'

/** Error groups of the range by fingerprint (/api/errors): the NEW badge and the counts in a line's detail. */
export interface ErrorInfo {
  count: number
  users: number
  isNew: boolean
  since: string
  title: string
}

/** What every line needs to draw itself; one object per render of the console. */
export interface LineCtx {
  order: readonly string[]
  short: (src: string) => string
  /** Several services on screen (or a trace): every line carries its service. */
  merged: boolean
  /** The range spans more than one day: times carry the date. */
  withDate: boolean
  view: 'timeline' | 'raw'
  keep: Keep
  errors: Readonly<Record<string, ErrorInfo>>
  /** The console URL with some params changed (repeat / check links keep the services and pods). */
  href: (changes: Record<string, string | null>) => string
}

const svcVar = (src: string, order: readonly string[]) => svcColor(src.split('/')[0], order)
const lvlShort = (level: string) => LEVEL_SHORT[level] ?? level.slice(0, 3).toUpperCase()
const timeOf = (row: LogRow, withDate: boolean) => (withDate ? fmtDateTimeMs(row.timestamp) : fmtTimeMs(row.timestamp))

/** Text with the grep words marked. */
export function Hl({ text, terms }: { text: string; terms: readonly string[] }) {
  if (!terms.length || !text) return <>{text}</>
  const low = text.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  while (i < text.length) {
    let best = -1
    let len = 0
    for (const t of terms) {
      const k = low.indexOf(t, i)
      if (k >= 0 && (best < 0 || k < best)) {
        best = k
        len = t.length
      }
    }
    if (best < 0) {
      out.push(text.slice(i))
      break
    }
    if (best > i) out.push(text.slice(i, best))
    out.push(<mark key={best}>{text.slice(best, best + len)}</mark>)
    i = best + len
  }
  return <>{out}</>
}

/** `⟲ ×1,248 ทุก ~30 วิ` on the kept line of a collapsed repeat: opens every line of it. */
function RepeatTag({ repeat, ctx }: { repeat: LogRepeat; ctx: LineCtx }) {
  const n = fmtCount(repeat.count)
  if (repeat.kind === 'check') {
    const to = new Date(Date.parse(repeat.lastSeen) + 60_000).toISOString()
    const every = repeat.everyS ? ` · ${everyText(repeat.everyS)}` : ''
    return (
      <Link className="ln__rep" href={ctx.href({ check: repeat.pattern, from: repeat.firstSeen, to })} title={`เรียก ${repeat.template} ตามตารางเวลา ${n} ครั้ง${repeat.client ? ` โดย ${repeat.client}` : ''}: แสดงทุกครั้ง`}>
        ⟲ ตามตารางเวลา ×{n}
        {every}
      </Link>
    )
  }
  if (repeat.kind === 'burst') {
    const ms = Date.parse(repeat.lastSeen) - Date.parse(repeat.firstSeen)
    const to = new Date(Date.parse(repeat.lastSeen) + 1).toISOString()
    return (
      <Link className="ln__rep" href={ctx.href({ pattern: repeat.pattern, from: repeat.firstSeen, to })} title={`ซ้ำติดกัน ${n} บรรทัด: ${repeat.template} · กดเพื่อดูทุกบรรทัด`}>
        ⟲ ×{n} ใน {ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} วิ`}
      </Link>
    )
  }
  return (
    <Link className="ln__rep" href={ctx.href({ pattern: repeat.pattern })} title={`log ซ้ำตามรอบถูกยุบเหลือบรรทัดล่าสุด: ${repeat.template} · กดเพื่อดูทุกบรรทัด`}>
      ⟲ ×{n} ตั้งแต่ {fmtTime(repeat.firstSeen)}
    </Link>
  )
}

/** `ทุก ~3 นาที`, `ทุก ~30 วิ`: the median interval of a scheduled caller. */
function everyText(s: number): string {
  const one = (n: number) => {
    const r = Math.round(n * 10) / 10
    return Number.isInteger(r) ? String(r) : r.toFixed(1)
  }
  if (s < 90) return `ทุก ~${Math.round(s)} วิ`
  if (s < 5400) return `ทุก ~${one(s / 60)} นาที`
  return `ทุก ~${one(s / 3600)} ชม.`
}

/** logger · message · key=value · duration · NEW · ⟲ of a line. */
function Message({ row, ctx, terms, withRepeat = true }: { row: LogRow; ctx: LineCtx; terms: readonly string[]; withRepeat?: boolean }) {
  const logger = loggerOf(row)
  const isNew = !!row.fingerprint && !!ctx.errors[row.fingerprint]?.isNew
  return (
    <>
      {logger ? (
        <span className="ln__lg">
          <Hl text={logger} terms={terms} />
        </span>
      ) : null}
      <span className="ln__msg">
        <Hl text={logTitle(row).title} terms={terms} />
      </span>
      {kvsOf(row).map((kv) => (
        <span className="ln__kv" key={kv.k}>
          <i>{kv.k}=</i>
          {kv.k === 'status' ? (
            <span className={statusClass(Number(kv.v))}>{kv.v}</span>
          ) : (
            <Hl text={kv.v} terms={terms} />
          )}
        </span>
      ))}
      {row.durationMs !== null ? <span className={isSlow(row) ? 'ln__d ln__d--slow' : 'ln__d'}>{fmtDuration(row.durationMs)}</span> : null}
      {isNew ? (
        <span className="ln__new" title={`error group ใหม่${ctx.errors[row.fingerprint!]?.since ? `ใน ${ctx.errors[row.fingerprint!].since}` : ''}`}>
          NEW
        </span>
      ) : null}
      {withRepeat && row.repeat ? <RepeatTag repeat={row.repeat} ctx={ctx} /> : null}
    </>
  )
}

/** error detail / how to fix / actual error of a line, in the order the SDK writes them under it. */
export function errorParts(row: LogRow): Array<[string, string, string]> {
  const e = row.error
  if (!e) return []
  return (
    [
      ['error detail', e.detail, ''],
      ['how to fix', e.howToFix, 'is-fix'],
      ['actual error', actualText(row), 'is-actual'],
    ] as Array<[string, string, string]>
  ).filter(([, v]) => !!v)
}

/** One line of the raw view (and a single line of the Timeline view): `.ln` + its error lines + its open detail. */
export const RawLine = memo(function RawLine({
  line,
  ctx,
  terms,
  selected,
  open,
  fresh,
  detail,
}: {
  line: LineRec
  ctx: LineCtx
  terms: readonly string[]
  selected: boolean
  open: boolean
  fresh: boolean
  detail: ReactNode
}) {
  const row = line.row
  const c = ctxOf(row)
  const src = srcOf(row)
  const noise = !!row.repeat
  const cls = ['ln', `ln--${row.level}`, noise ? 'ln--noise' : '', selected ? 'is-sel' : '', fresh ? 'is-new' : ''].filter(Boolean).join(' ')
  const parts = errorParts(row)
  return (
    <>
      <div className={cls} data-id={line.id} data-t={line.ms} data-nav={`l:${line.id}`} data-trace={row.traceId || undefined} aria-expanded={open}>
        <span className="ln__t">{timeOf(row, ctx.withDate)}</span>
        <span className="ln__l">{lvlShort(row.level)}</span>
        {ctx.merged ? (
          <span className="ln__s" style={{ '--c': svcVar(src, ctx.order) } as CSSProperties} title={src}>
            {ctx.short(src)}
          </span>
        ) : null}
        <span className={c.life ? 'ln__c ln__c--life' : 'ln__c'} title={c.text}>
          <Hl text={c.text} terms={terms} />
        </span>
        <span className="ln__m">
          <Message row={row} ctx={ctx} terms={terms} />
        </span>
      </div>
      {parts.map(([k, v, cl], i) => (
        <div className={i === parts.length - 1 ? 'ln-cont ln-cont--last' : 'ln-cont'} key={k}>
          <div>
            <i>{k}</i>
            <span className={cl || undefined}>
              <Hl text={v} terms={terms} />
            </span>
          </div>
        </div>
      ))}
      {open ? detail : null}
    </>
  )
})

/** deploy (also "ไม่มี deploy ในช่วงนี้" at the range start), outage, recovered: a rule across the stream. */
export function SepLine({ sep }: { sep: Separator }) {
  return (
    <div className={`ln-sep ln-sep--${sep.kind}`} data-t={sep.t} role="separator" aria-label={sep.text}>
      <div>{sep.text}</div>
    </div>
  )
}

// ---------- Timeline: one request ----------

/** What the head says about the request's answer: `200`, `502`, `ยกเลิก`. */
function StatusText({ g }: { g: RequestGroup }) {
  if (!g.root) return null
  if (g.aborted) return <span className="tg__status s4">ยกเลิก</span>
  return g.status ? <span className={`tg__status ${statusClass(g.status)}`}>{g.status}</span> : null
}

function EventRow({
  g,
  e,
  ctx,
  terms,
  open,
  detail,
}: {
  g: RequestGroup
  e: BlockEvent
  ctx: LineCtx
  terms: readonly string[]
  open: boolean
  detail: ReactNode
}) {
  const off = offText(e.t - g.start)
  const style = { '--c': svcVar(e.src, ctx.order) } as CSSProperties
  if (e.arrive) {
    const r = e.arrive.row
    return (
      <div className="tg__ev tg__ev--arrive" style={style}>
        <span className="tg__off">{off}</span>
        <span className="tg__node" />
        <span className="tg__svc">{ctx.short(e.src)}</span>
        <span />
        <span className="tg__msg">
          รับ request{' '}
          <b>
            <Hl text={g.title} terms={terms} />
          </b>
          {r.userId ? <span className="ln__lg"> จาก {r.userId}</span> : null}
        </span>
      </div>
    )
  }
  const l = e.line!
  const row = l.row
  const parts = errorParts(row)
  let msg: ReactNode
  if (row.eventCode === 'http.request') {
    const status = row.httpStatus ?? row.http?.status ?? 0
    msg = isAborted(row) ? (
      <>
        client ปิดการเชื่อมต่อก่อนได้คำตอบ {row.durationMs !== null ? <span className="ln__d">หลัง {fmtDuration(row.durationMs)}</span> : null}
      </>
    ) : (
      <>
        ตอบ {status ? <b className={statusClass(status)}>{status}</b> : null}{' '}
        {row.durationMs !== null ? <span className="ln__d">ใช้เวลา {fmtDuration(row.durationMs)}</span> : null}
        {e.src !== srcOf(g.root?.row ?? row) ? <span className="ln__lg"> {routeTitle(row)}</span> : null}
      </>
    )
  } else msg = <Message row={row} ctx={ctx} terms={terms} />
  return (
    <>
      <div className={`tg__ev tg__ev--${row.level}${open ? ' is-open' : ''}`} style={style} data-id={l.id} data-nav={`l:${l.id}`} aria-expanded={open}>
        <span className="tg__off">{off}</span>
        <span className="tg__node" />
        <span className="tg__svc" title={e.src}>
          {ctx.short(e.src)}
        </span>
        <span className={`ln--${row.level}`}>
          <span className="ln__l">{lvlShort(row.level)}</span>
        </span>
        <span className="tg__msg">
          {msg}
          {parts.length ? (
            <span className="tg__errd">
              {parts.map(([k, v, cl]) => (
                <Fragment key={k}>
                  <i>{k}</i>
                  <span className={cl || undefined}>
                    <Hl text={v} terms={terms} />
                  </span>
                </Fragment>
              ))}
            </span>
          ) : null}
        </span>
      </div>
      {open ? detail : null}
    </>
  )
}

/** `POST /etl/parse-excel` of a downstream request line (its own route, not the block's). */
function routeTitle(row: LogRow): string {
  const h = row.http
  return h ? `${h.method} ${h.route || h.path}`.trim() : ''
}

/** One request of the Timeline view: the head (a button) and, open, its lines on a time rail. */
export const RequestBlock = memo(function RequestBlock({
  g,
  ctx,
  terms,
  open,
  selected,
  openLines,
  detailOf,
  actions,
}: {
  g: RequestGroup
  ctx: LineCtx
  terms: readonly string[]
  open: boolean
  selected: boolean
  /** Line ids whose detail is open. */
  openLines: ReadonlySet<string>
  detailOf: (line: LineRec) => ReactNode
  actions: ReactNode
}) {
  const ev = eventsOf(g)
  const lvl = rankOf(g.level) >= 3 ? (g.level === 'fatal' ? 'fatal' : 'error') : g.level === 'warn' ? 'warn' : ''
  const err = g.errLine?.row
  const errNew = !!err?.fingerprint && !!ctx.errors[err.fingerprint]?.isNew
  const path = g.srcs.length < 2 && !ctx.merged ? [] : g.srcs
  const rows: ReactNode[] = []
  if (open) {
    let prev: BlockEvent | null = null
    for (const e of ev) {
      const gap = prev ? e.t - prev.t : 0
      if (prev && isGap(gap, g.total)) {
        rows.push(
          <div className="tg__gap" key={`gap-${e.t}-${rows.length}`}>
            <span />
            <span className="tg__node" />
            <span>
              ⋯ ไม่มี log {fmtDuration(gap)}
              {e.src !== prev.src ? ` · ต่อที่ ${ctx.short(e.src)}` : ''}
            </span>
          </div>,
        )
      }
      rows.push(<EventRow key={e.arrive ? 'arrive' : e.line!.id} g={g} e={e} ctx={ctx} terms={terms} open={!!e.line && openLines.has(e.line.id)} detail={e.line ? detailOf(e.line) : null} />)
      prev = e
    }
  }
  return (
    <div className={`tg${lvl ? ` tg--${lvl}` : ''}${open ? ' is-open' : ''}${selected ? ' is-sel' : ''}`} data-nav={`g:${g.trace}`} data-t={g.start} data-trace={g.trace}>
      <button className="tg__head" type="button" aria-expanded={open} data-g={g.trace}>
        <span className="tg__chev" aria-hidden="true">
          ›
        </span>
        <span className="tg__time">{ctx.withDate ? fmtDateTimeMs(g.start) : fmtTimeMs(g.start)}</span>
        <span className="tg__what">
          <span className={`ln--${g.level}`}>
            <span className="ln__l">{lvlShort(g.level)}</span>
          </span>
          <span className="tg__route">
            <Hl text={g.title} terms={terms} />
          </span>
          <StatusText g={g} />
          {err ? (
            <span className="tg__err">
              <Hl text={logTitle(err).title} terms={terms} />
            </span>
          ) : null}
          {errNew ? <span className="ln__new">NEW</span> : null}
          <span className="ln__lg">{fmtCount(g.lines.length)} บรรทัด</span>
        </span>
        <span className="tg__path">
          {path.map((s, i) => (
            <span key={s} className="tg__svcname" style={{ '--c': svcVar(s, ctx.order) } as CSSProperties}>
              {i ? (
                <span className="tg__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
              <span className="lc-dot" />
              {ctx.short(s)}
            </span>
          ))}
        </span>
        <span className="tg__bar" aria-hidden="true">
          {ev.map((e, i) => {
            const r = rankOf(e.line?.row.level ?? 'info')
            return (
              <i
                key={i}
                className={`tg__tick${r >= 3 ? ' is-err' : r === 2 ? ' is-wrn' : ''}`}
                style={{ '--x': (((e.t - g.start) / g.total) * 100).toFixed(2), '--c': svcVar(e.src, ctx.order) } as CSSProperties}
              />
            )
          })}
        </span>
        <span className="tg__dur">{fmtDuration(g.total)}</span>
      </button>
      {open ? (
        <div className="tg__body">
          {rows}
          {g.truncated ? <p className="tg__trunc">แสดงเฉพาะบรรทัดล่าสุดของ request นี้ (มีมากเกินกว่าที่โหลดได้ในครั้งเดียว) · เปิด trace เพื่อดูทั้งหมด</p> : null}
          <div className="tg__acts ln-x__acts">{actions}</div>
        </div>
      ) : null}
    </div>
  )
})

// ---------- the detail under a line ----------

/** dt / dd rows of a line's detail (logs-console.html `.ln-x dl`). */
export function detailRows(row: LogRow, ctx: LineCtx, request: LogRow | null): Array<[string, ReactNode]> {
  const d: Array<[string, ReactNode]> = []
  if (request?.http) {
    const status = request.httpStatus ?? request.http.status
    d.push([
      'request',
      <>
        {routeTitle(request)}
        {status ? (
          <>
            {' → '}
            <span className={statusClass(status)}>{status}</span>
          </>
        ) : null}
        {request.durationMs !== null ? ` · ${fmtDuration(request.durationMs)}` : ''}
      </>,
    ])
  } else if (row.requestRoute) d.push(['request', row.requestRoute])
  if (row.job) {
    const j = row.job
    d.push([
      'job',
      <>
        {j.type || j.queue}
        {j.id ? ` #${j.id}` : ''}
        <span className="t-dim">
          {j.queue ? ` · queue ${j.queue}` : ''}
          {j.attempt ? ` · ครั้งที่ ${j.attempt}/${j.maxAttempts || '?'}` : ''}
        </span>
      </>,
    ])
  }
  if (row.error || row.fingerprint) {
    const g = row.fingerprint ? ctx.errors[row.fingerprint] : undefined
    const e = row.error
    d.push([
      'error',
      <>
        {e?.code || e?.type || 'error'}
        <span className="t-dim">
          {e?.category ? ` · หมวด ${e.category}` : ''}
          {g ? ` · เกิด ${fmtCount(g.count)} ครั้งในช่วงนี้${g.users ? ` · ${fmtCount(g.users)} users` : ''}` : ''}
          {g?.isNew ? ` · ใหม่${g.since ? `ใน ${g.since}` : ''}` : ''}
        </span>
      </>,
    ])
    if (e?.originFunction || e?.originFile) {
      d.push([
        'ที่มา',
        <>
          {e.originFunction} <span className="t-dim">{e.originFile}</span>
        </>,
      ])
    }
    if (e && !e.detail && !e.howToFix && actualError(e)) d.push(['actual error', actualText(row)])
  }
  if (row.usecase) d.push(['usecase', row.usecase])
  if (row.failedStep) d.push(['failed step', row.failedStep])
  if (row.dbStatement) d.push(['sql', <span className="ln-x__sql">{row.dbStatement}</span>])
  if (row.dependency) {
    const dep = row.dependency
    d.push(['dependency', `${[dep.type, dep.name].filter(Boolean).join(' ')}${dep.host ? ` → ${dep.host}${dep.port ? `:${dep.port}` : ''}` : ''}`])
  }
  if (row.traceId) d.push(['trace', row.traceId])
  if (row.userId) d.push(['user', <>{row.userId}{row.userRoles.length ? <span className="t-dim"> · {row.userRoles.join(', ')}</span> : null}</>])
  d.push([
    'process',
    <>
      {srcOf(row)}
      <span className="t-dim">
        {row.host ? ` · pod ${row.host}` : ''}
        {row.version ? ` · v${row.version}` : ''}
        {row.env ? ` · ${row.env}` : ''}
      </span>
    </>,
  ])
  if (row.eventCode && row.eventCode !== 'app.log') d.push(['event', row.eventCode])
  if (row.logger) d.push(['logger', row.logger])
  if (row.message && row.message !== logTitle(row).title) d.push(['message', <span className="ln-x__pre">{row.message}</span>])
  d.push(['เวลา', `${fmtDateTimeMs(row.timestamp)} ICT`])
  return d
}

/** "ใน request เดียวกัน N บรรทัด จาก M service" of the raw view's detail. */
export function Siblings({ lines, me, ctx }: { lines: readonly LineRec[]; me: string; ctx: LineCtx }) {
  const svcs = new Set(lines.map((x) => srcOf(x.row)))
  return (
    <div className="ln-x__sibs">
      <p>
        ใน request เดียวกัน {fmtCount(lines.length)} บรรทัด{svcs.size > 1 ? ` จาก ${svcs.size} service` : ''}
      </p>
      {lines.map((x) => {
        const r = x.row
        const s = srcOf(r)
        const status = r.eventCode === 'http.request' ? (r.httpStatus ?? r.http?.status ?? 0) : 0
        return (
          <div key={x.id} className={x.id === me ? 'ln-x__sib is-me' : 'ln-x__sib'}>
            <span>{fmtTimeMs(r.timestamp)}</span>
            <span className={`ln--${r.level}`}>
              <span className="ln__l">{lvlShort(r.level)}</span>
            </span>
            <span style={{ color: svcVar(s, ctx.order) }}>{ctx.short(s)}</span>
            <span>
              {loggerOf(r) ? <span className="ln__lg">{loggerOf(r)}</span> : null}
              {logTitle(r).title}
              {status ? (
                <span className="ln__kv">
                  <span className={statusClass(status)}>{status}</span>
                </span>
              ) : null}
              {r.durationMs !== null ? <span className="ln__d">{fmtDuration(r.durationMs)}</span> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Trace page links of a line: the trace (its span selected) and its captured I/O in the Network view. */
export function traceLinks(row: LogRow, keep: Keep): { trace: string; io: string | null; ioLabel: string } | null {
  if (!row.traceId) return null
  const trace = buildHref(`/traces/${row.traceId}`, keep, row.spanId ? { span: row.spanId } : undefined)
  // the trace page opens the nearest span above it that has I/O when this one has none
  const io = row.spanId ? buildHref(`/traces/${row.traceId}`, keep, { view: 'network', span: row.spanId, io: row.spanId }) : null
  const ioLabel = row.eventCode === 'http.request' ? 'ดู request/response' : row.job ? 'ดู message ของ job' : 'ดูใน Network'
  return { trace, io, ioLabel }
}
