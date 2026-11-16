'use client'

/**
 * Controls of the log console (logs-console.html): the Service and Pod multi-select dropdowns (`.lc-dd`: "ทุก …",
 * a checkbox per row, "เฉพาะอันนี้", ERR / WRN counts; pods grouped by service with the replaced ones under
 * "ปิดแล้ว (ถูกแทนตอน deploy)") and the minute strip (`.lc-tl`: lines per bucket, WRN / ERR on top, outages behind,
 * the window on screen framed; a click jumps to that bucket).
 */
import { type CSSProperties, useEffect, useRef } from 'react'
import { Icon } from '@/components/icons'
import { fmtCount, fmtTime } from '@/lib/format'
import { svcColor } from '@/lib/services'
import type { LogPod, LogsHistogramBucket } from '@/lib/types'
import { podShort } from '../_lib/console'
import type { Outage } from '../_lib/lines'
import type { Source } from '../_lib/query'

/** Per source: ERR / WRN / lines over the range (summed from its pods). */
export interface SourceCounts {
  errors: number
  warns: number
  lines: number
}

function Badge({ errors, warns }: { errors: number; warns?: number }) {
  if (errors) {
    return (
      <span className="lc-badge lc-badge--err" title="ERR ในช่วงนี้">
        {fmtCount(errors)} ERR
      </span>
    )
  }
  if (warns) {
    return (
      <span className="lc-badge lc-badge--wrn" title="WRN ในช่วงนี้">
        {fmtCount(warns)} WRN
      </span>
    )
  }
  return <span />
}

/** Closes an open panel on a click outside it or Esc (focus back to its button). */
function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
      root.current?.querySelector<HTMLButtonElement>('.lc-dd__btn')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close, root])
}

export function SourceDropdown({
  sources,
  selected,
  all,
  counts,
  order,
  open,
  onOpen,
  onChange,
}: {
  sources: readonly Source[]
  /** Selected source ids; ignored when `all`. */
  selected: readonly string[]
  all: boolean
  counts: Readonly<Record<string, SourceCounts>>
  order: readonly string[]
  open: boolean
  onOpen: (open: boolean) => void
  onChange: (ids: string[]) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const allBox = useRef<HTMLInputElement>(null)
  useDismiss(open, () => onOpen(false), root)
  const ids = all ? sources.map((s) => s.id) : selected
  const n = ids.length
  const indeterminate = n > 0 && n < sources.length
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = indeterminate
  }, [indeterminate, open])
  const label = all || (n === sources.length && n > 0) ? `ทุก service (${sources.length})` : n === 1 ? ids[0] : n ? `${n} จาก ${sources.length} service` : 'ยังไม่ได้เลือก'
  const toggle = (id: string, on: boolean) => onChange(on ? sources.map((s) => s.id).filter((x) => x === id || ids.includes(x)) : ids.filter((x) => x !== id))
  return (
    <div className="lc-dd" ref={root}>
      <button className="lc-dd__btn" type="button" aria-haspopup="true" aria-expanded={open} aria-controls="lc-dd-svc" onClick={() => onOpen(!open)}>
        <span className="lc-dd__k">Service</span>
        {n && !all ? (
          <span className="lc-dd__dots">
            {ids.slice(0, 6).map((id) => (
              <span key={id} className="lc-dot" style={{ '--c': svcColor(id.split('/')[0], order) } as CSSProperties} />
            ))}
          </span>
        ) : null}
        <span className="lc-dd__v">{label}</span>
        <Icon name="chevron" className="lc-dd__chev" />
      </button>
      <div className="lc-dd__panel" id="lc-dd-svc" role="group" aria-label="เลือก service (เลือกได้หลายตัว)" hidden={!open}>
        <label className="lc-opt lc-opt--all">
          <input ref={allBox} type="checkbox" checked={n === sources.length && n > 0} onChange={(e) => onChange(e.target.checked ? sources.map((s) => s.id) : [])} />
          <span className="lc-opt__name">ทุก service</span>
          <span />
          <span />
          <kbd>0</kbd>
        </label>
        {sources.map((s, i) => {
          const c = counts[s.id]
          return (
            <label className="lc-opt" key={s.id}>
              <input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span className="lc-opt__name">
                <span className="lc-dot" style={{ '--c': svcColor(s.service, order) } as CSSProperties} />
                {s.service}
                <span className="lc-opt__role">/{s.role}</span>
              </span>
              <Badge errors={c?.errors ?? 0} warns={c?.warns ?? 0} />
              <button
                type="button"
                className="lc-opt__only"
                onClick={(e) => {
                  e.preventDefault()
                  onChange([s.id])
                }}
              >
                เฉพาะอันนี้
              </button>
              {i < 9 ? <kbd>{i + 1}</kbd> : <span />}
            </label>
          )
        })}
        <p className="lc-dd__foot">เลือกมากกว่า 1 service: ทุกบรรทัดมีชื่อ service นำหน้า</p>
      </div>
    </div>
  )
}

export function PodDropdown({
  pods,
  groups,
  selected,
  byTrace,
  order,
  open,
  onOpen,
  onChange,
}: {
  /** Every pod of the shown services (live first). */
  pods: readonly LogPod[]
  /** Source ids in dropdown order (the groups). */
  groups: readonly string[]
  /** Selected hosts; null = every pod. */
  selected: readonly string[] | null
  /** A trace filter shows every pod (the button is off). */
  byTrace: boolean
  order: readonly string[]
  open: boolean
  onOpen: (open: boolean) => void
  onChange: (hosts: string[] | null) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const allBox = useRef<HTMLInputElement>(null)
  useDismiss(open, () => onOpen(false), root)
  const hosts = [...new Set(pods.map((p) => p.host))]
  const total = hosts.length
  const on = selected ? new Set(selected) : null
  const indeterminate = !!on && on.size > 0
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = indeterminate
  }, [indeterminate, open])
  const disabled = byTrace || total < 2
  const text = byTrace
    ? 'ทุก pod (ดู trace)'
    : !total
      ? '–'
      : total === 1
        ? podShort(hosts[0])
        : !on
          ? `ทุก pod (${total})`
          : on.size === 1
            ? podShort([...on][0])
            : on.size
              ? `${on.size} จาก ${total} pod`
              : 'ยังไม่ได้เลือก'
  const toggle = (host: string, checked: boolean) => {
    const cur = new Set(on ?? hosts)
    if (checked) cur.add(host)
    else cur.delete(host)
    onChange(cur.size === total ? null : hosts.filter((h) => cur.has(h)))
  }
  const opt = (p: LogPod) => (
    <label className={p.gone ? 'lc-opt lc-opt--gone' : 'lc-opt'} key={`${p.service}/${p.role}/${p.host}`} title={`${p.host}${p.gone ? ` · ปิดตอน ${fmtTime(p.lastSeen)}` : ''}`}>
      <input type="checkbox" checked={!on || on.has(p.host)} onChange={(e) => toggle(p.host, e.target.checked)} />
      <span className="lc-opt__name">{podShort(p.host)}</span>
      <Badge errors={p.errors} />
      <span className="lc-opt__n">{fmtCount(p.lines)} บรรทัด</span>
      <button
        type="button"
        className="lc-opt__only"
        onClick={(e) => {
          e.preventDefault()
          onChange([p.host])
        }}
      >
        เฉพาะอันนี้
      </button>
    </label>
  )
  return (
    <div className="lc-dd" ref={root}>
      <button
        className="lc-dd__btn"
        type="button"
        aria-haspopup="true"
        aria-expanded={open && !disabled}
        aria-controls="lc-dd-pod"
        disabled={disabled}
        title={byTrace ? 'ดู trace: แสดงทุก pod' : total < 2 ? 'service ที่เลือกมี pod เดียว' : undefined}
        onClick={() => onOpen(!open)}
      >
        <span className="lc-dd__k">Pod</span>
        <span className="lc-dd__v">{text}</span>
        <Icon name="chevron" className="lc-dd__chev" />
      </button>
      <div className="lc-dd__panel" id="lc-dd-pod" role="group" aria-label="เลือก pod (เลือกได้หลายตัว)" hidden={!open || disabled}>
        <label className="lc-opt lc-opt--all">
          <input ref={allBox} type="checkbox" checked={!on} onChange={(e) => onChange(e.target.checked ? null : [])} />
          <span className="lc-opt__name">ทุก pod</span>
          <span />
          <span className="lc-opt__n">{fmtCount(total)} ตัว</span>
          <kbd>p</kbd>
        </label>
        {groups.map((id) => {
          const ps = pods.filter((p) => `${p.service}/${p.role}` === id)
          if (!ps.length) return null
          const live = ps.filter((p) => !p.gone)
          const gone = ps.filter((p) => p.gone)
          return (
            <div key={id} role="group" aria-label={id}>
              <p className="lc-dd__group">
                <span className="lc-dot" style={{ '--c': svcColor(id.split('/')[0], order) } as CSSProperties} />
                {id}
              </p>
              {live.map(opt)}
              {gone.length ? <p className="lc-dd__group lc-dd__group--sub">ปิดแล้ว (ถูกแทนตอน deploy)</p> : null}
              {gone.map(opt)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Five time labels under the strip: start, quarters, end. */
function ticksOf(fromMs: number, toMs: number): Array<{ left: number; text: string }> {
  return [0, 25, 50, 75, 100].map((left) => ({ left, text: fmtTime(fromMs + ((toMs - fromMs) * left) / 100) }))
}

export function MinuteStrip({
  buckets,
  stepMs,
  fromMs,
  toMs,
  outages,
  visible,
  onJump,
}: {
  buckets: readonly LogsHistogramBucket[]
  stepMs: number
  fromMs: number
  toMs: number
  outages: readonly Outage[]
  /** Time span of the lines on screen, framed. */
  visible: [number, number] | null
  onJump: (fromMs: number, toMs: number) => void
}) {
  const span = Math.max(1, toMs - fromMs)
  const x = (t: number) => Math.max(0, Math.min(100, ((t - fromMs) / span) * 100))
  const per = stepMs <= 60_000 ? 'นาที' : 'ช่วง'
  const data = buckets.map((b) => {
    const t = Date.parse(b.t)
    return { t, tot: b.debug + b.info + b.warn + b.error + b.fatal, wrn: b.warn, err: b.error + b.fatal }
  })
  const max = Math.max(1, ...data.map((d) => d.tot))
  return (
    <div className="lc-tl" aria-label={`จำนวนบรรทัดต่อ${per} คลิกเพื่อไป${per}นั้น`}>
      <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        {outages.map((o) => (
          <rect key={`${o.key}-${o.from}`} className="lc-tl__out" x={x(o.from)} y="0" width={Math.max(0.3, x(o.to ?? toMs) - x(o.from))} height="20">
            <title>{`${o.dep} down`}</title>
          </rect>
        ))}
        {data.map((d) => {
          const x0 = x(d.t)
          const w = Math.max(0.2, x(Math.min(toMs, d.t + stepMs)) - x0)
          const bh = (d.tot / max) * 20
          const eh = Math.min(bh, Math.max(d.err ? 3 : 0, (d.err / max) * 20))
          const wh = Math.min(bh - eh, Math.max(d.wrn ? 2 : 0, (d.wrn / max) * 20))
          const bx = x0 + w * 0.12
          const bw = w * 0.76
          return (
            <g key={d.t}>
              <rect className="lc-tl__b" x={bx} y={20 - bh} width={bw} height={bh} />
              {wh ? <rect className="lc-tl__w" x={bx} y={20 - eh - wh} width={bw} height={wh} /> : null}
              {eh ? <rect className="lc-tl__e" x={bx} y={20 - eh} width={bw} height={eh} /> : null}
              <rect className="lc-tl__hit" x={x0} y="0" width={w} height="20" onClick={() => onJump(d.t, d.t + stepMs)}>
                <title>{`${fmtTime(d.t)} · ${fmtCount(d.tot)} บรรทัด${d.err ? ` · ${fmtCount(d.err)} ERR` : ''}${d.wrn ? ` · ${fmtCount(d.wrn)} WRN` : ''}`}</title>
              </rect>
            </g>
          )
        })}
        {visible ? (
          <rect className="lc-tl__view" vectorEffect="non-scaling-stroke" x={x(visible[0])} y="0.3" width={Math.max(0.6, x(visible[1]) - x(visible[0]))} height="19.4" />
        ) : null}
      </svg>
      <div className="lc-tl__ticks" aria-hidden="true">
        {ticksOf(fromMs, toMs).map((t) => (
          <span key={t.left} style={{ left: `${t.left}%` }}>
            {t.text}
          </span>
        ))}
      </div>
    </div>
  )
}
