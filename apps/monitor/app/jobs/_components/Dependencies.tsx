/**
 * "ระบบที่เรียกใช้ (dependency)" (server): which log lines set a dependency's state, then one row per target
 * with its state now, a strip over the range (down spans, 4xx ticks, hover / Tab tooltips) and the line that set
 * the state; the expanded row zooms into the latest outage at true scale next to its lines, or lists the 4xx lines.
 */
import Link from 'next/link'
import { LevelBadge, ServiceChip, StateChip, Tag } from '@/components/badges'
import { ChartFrame } from '@/components/charts/ChartFrame'
import { ErrorDetailText } from '@/components/ErrorParts'
import { ExpandRow } from '@/components/ExpandRow'
import { Section } from '@/components/Panel'
import { tickInterval, timeTicks, timeTickText, tipAttrs } from '@/lib/chart'
import { fmtCount, fmtDate, fmtDateTime, fmtDuration, fmtTime, fmtTimeMs, fmtTimeSec } from '@/lib/format'
import { buildHref, inRange, type Keep } from '@/lib/params'
import { logDetail, type Kv } from '@/lib/readable'
import type { LogRow } from '@/lib/types'
import { affectsOf, codeCounts, type DepRow, depName, durationThai, hostPort, type Outage, outageMs, statusCounts } from '../_data'
import { type Clock, LinesTable, T } from './parts'

export interface DependenciesProps {
  rows: DepRow[]
  env?: string
  fromMs: number
  toMs: number
  rangeLabel: string
  rangeShort: string
  keep: Keep
  order: readonly string[]
  clock: Clock
  /** Log link of a dependency's outbound lines. */
  outboundLogsHref: (host: string) => string
}

const W = 1440
const r2 = (n: number) => Math.round(n * 100) / 100

/** Retry count the library wrote on a line (`dependency.attempt`). */
const retryOf = (r: LogRow): string => r.fields['dependency.attempt'] ?? ''

function latestOutage(row: DepRow): Outage | null {
  return row.outages.length ? row.outages[row.outages.length - 1] : null
}

/** The state strip over the range: up band, down spans (≥ 3 px), 4xx ticks, one focusable hit per mark group. */
function Strip({ row, fromMs, toMs, rangeShort }: { row: DepRow; fromMs: number; toMs: number; rangeShort: string }) {
  const span = Math.max(1, toMs - fromMs)
  const x = (t: number) => r2((Math.min(Math.max(t, fromMs), toMs) - fromMs) / span * W)
  const ticks = timeTicks(fromMs, toMs).map(x)
  const who = depName(row)
  const outages = row.outages
  const warn = [...row.outbound].reverse()
  // 4xx ticks closer than ~2 % of the strip share one hit target
  const clusters: LogRow[][] = []
  for (const r of warn) {
    const last = clusters[clusters.length - 1]
    if (last && x(Date.parse(r.timestamp)) - x(Date.parse(last[0].timestamp)) < 30) last.push(r)
    else clusters.push([r])
  }
  const words: string[] = []
  if (outages.length) {
    words.push(
      `up ตลอด ยกเว้น ${outages
        .map((o) => `down ${durationThai(outageMs(o, toMs))} ${fmtTimeSec(o.start)} ถึง ${o.end ? fmtTimeSec(o.end) : 'ตอนนี้'}`)
        .join(', ')}`,
    )
  } else words.push('up ตลอด')
  if (warn.length) words.push(`ถูกปฏิเสธ ${statusCounts(warn).map((s) => `${s.status} ${s.n} ครั้ง`).join(' ')}`)
  return (
    <svg className="jb-tl" viewBox={`0 0 ${W} 20`} preserveAspectRatio="none" role="img" aria-label={`${who} ${inRange(rangeShort)}: ${words.join(' · ')}`}>
      {ticks.map((t) => (
        <line key={t} className="c-grid" x1={t} x2={t} y1="0" y2="20" />
      ))}
      <rect className="jb-tl__up" x="0" y="5" width={W} height="10" />
      {outages.map((o) => {
        const a = x(o.start)
        const b = x(o.end ?? toMs)
        return b - a > 6 ? <rect key={`s${o.start}`} className="jb-tl__span" x={a} y="5" width={r2(b - a)} height="10" /> : null
      })}
      {warn.map((r, i) => (
        <line key={`wh${i}`} className="jb-tl__halo" x1={x(Date.parse(r.timestamp))} x2={x(Date.parse(r.timestamp))} y1="2" y2="18" />
      ))}
      {warn.map((r, i) => (
        <line key={`w${i}`} className="jb-tl__warn" x1={x(Date.parse(r.timestamp))} x2={x(Date.parse(r.timestamp))} y1="2" y2="18" />
      ))}
      {outages.map((o) => (
        <g key={`d${o.start}`}>
          <line className="jb-tl__halo" x1={x(o.start)} x2={x(o.start)} y1="0" y2="20" />
          <line className="jb-tl__down" x1={x(o.start)} x2={x(o.start)} y1="0" y2="20" />
        </g>
      ))}
      {outages.map((o) => {
        const still = [...o.lines].reverse().find((r) => r.eventCode === 'dependency.still_down')
        const lines = [{ value: fmtDuration(outageMs(o, toMs)), name: `down ${fmtTimeMs(o.start)}–${o.end ? fmtTimeMs(o.end) : 'ตอนนี้'}` }]
        if (still) lines.push({ value: retryOf(still) ? `retry ${retryOf(still)}` : 'still_down', name: `still_down ${fmtTimeMs(still.timestamp)}` })
        const at = x(o.start)
        return <line key={`h${o.start}`} className="c-hit jb-tl__hit" x1={at} x2={at} y1="0" y2="20" tabIndex={0} {...tipAttrs(`${who} · ${fmtDate(o.start)}`, lines)} />
      })}
      {clusters.map((c) => {
        const xs = c.map((r) => x(Date.parse(r.timestamp)))
        const at = r2(xs.reduce((s, v) => s + v, 0) / xs.length)
        const shown = c.slice(0, 8).map((r) => ({ value: String(r.http?.status || r.error?.code || 'fail'), name: fmtTimeSec(r.timestamp) }))
        if (c.length > 8) shown.push({ value: `+${c.length - 8}`, name: 'บรรทัด' })
        return <line key={`c${c[0].timestamp}`} className="c-hit jb-tl__hit" x1={at} x2={at} y1="0" y2="20" tabIndex={0} {...tipAttrs(`${row.name} · ${fmtDate(c[0].timestamp)} http.outbound_failed`, shown)} />
      })}
    </svg>
  )
}

/** Width of an event label in the zoom's viewBox units (the mono label font). */
const labelWidth = (text: string) => text.length * 6.3

/** A library line in the zoom: 1 px line + label on its `side`, on the other side when it would run out of the plot. */
function EventMark({ at, y1, labelY, text, side = 'right' }: { at: number; y1: number; labelY: number; text: string; side?: 'left' | 'right' }) {
  const width = labelWidth(text)
  const left = side === 'left' ? at - 4 - width >= 0 : at + 4 + width > 498
  return (
    <>
      <line className="c-event" x1={at} x2={at} y1={y1} y2="40" />
      <text className="c-event-label" x={left ? at - 4 : at + 4} y={labelY} textAnchor={left ? 'end' : undefined}>
        {text}
      </text>
    </>
  )
}

const ZOOM_WINDOWS = [60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200, 86400, 604800].map((s) => s * 1000)
const ICT_MS = 7 * 3600_000
const Z_X0 = 12
const Z_X1 = 488
const Z_RIGHT = 498

/**
 * Window of the zoom where every label sits next to its own line as in the mockup: dependency.down on the left of
 * its line, still_down and up on the right (up on the second row), none running out of the plot. Starts on a tick
 * (window / 6, ICT), the outage as centred as that allows; null when no window up to 4 sizes larger fits.
 */
function labelWindow(start: number, end: number, marks: { down?: number; still?: number; up?: number; upText: string }) {
  const d = Math.max(1000, end - start)
  const sizes = ZOOM_WINDOWS.filter((w) => w >= d * 2.2).slice(0, 4)
  for (const win of sizes) {
    const step = win / 6
    const px = (t: number, ws: number) => Z_X0 + ((t - ws) / win) * (Z_X1 - Z_X0)
    const fits = (ws: number) =>
      (marks.down === undefined || px(marks.down, ws) - 4 - labelWidth('dependency.down') >= 0) &&
      (marks.still === undefined || px(marks.still, ws) + 4 + labelWidth('dependency.still_down') <= Z_RIGHT) &&
      (marks.up === undefined || px(marks.up, ws) + 4 + labelWidth(marks.upText) <= Z_RIGHT)
    const centre = start + d / 2
    const options: number[] = []
    for (let ws = Math.floor((end - win + ICT_MS) / step) * step - ICT_MS; ws <= start; ws += step) if (ws + win >= end && fits(ws)) options.push(ws)
    if (options.length) return { win, ws: options.sort((a, b) => Math.abs(a + win / 2 - centre) - Math.abs(b + win / 2 - centre))[0] }
  }
  return null
}

/** The latest outage at true scale: up / down bands, a vertical line per library line, round time ticks. */
function Zoom({ row, outage, toMs, titleId }: { row: DepRow; outage: Outage; toMs: number; titleId: string }) {
  const X0 = Z_X0
  const X1 = Z_X1
  const end = outage.end ?? toMs
  const d = Math.max(1000, end - outage.start)
  const down = outage.lines.find((r) => r.eventCode === 'dependency.down')
  const still = [...outage.lines].reverse().find((r) => r.eventCode === 'dependency.still_down')
  const up = [...outage.lines].reverse().find((r) => r.eventCode === 'dependency.up')
  const durText = fmtDuration(outageMs(outage, toMs))
  const upText = `dependency.up · ${durText}`
  const fitted = labelWindow(outage.start, end, {
    down: down ? Date.parse(down.timestamp) : undefined,
    still: still ? Date.parse(still.timestamp) : undefined,
    up: up && outage.end ? Date.parse(up.timestamp) : undefined,
    upText,
  })
  const win = fitted?.win ?? ZOOM_WINDOWS.find((w) => w >= d * 2.2) ?? ZOOM_WINDOWS[ZOOM_WINDOWS.length - 1]
  const step = win / 6
  let ws = fitted?.ws ?? 0
  if (!fitted) {
    // window start on the roundest boundary (half, third, sixth of the window) that keeps the outage well inside
    const centre = outage.start + d / 2
    ws = Math.floor((outage.start - (win - d) / 2 + ICT_MS) / step) * step - ICT_MS
    if (ws + win < end) ws += step
    for (const align of [win / 2, win / 3, step]) {
      const base = Math.floor((centre - win / 2 + ICT_MS) / align) * align - ICT_MS
      // room on the left for the dependency.down label, on the right for the up label
      const fits = [base, base + align].filter((s) => outage.start >= s + win * 0.2 && end <= s + win * 0.95)
      if (fits.length) {
        ws = fits.sort((a, b) => Math.abs(a + win / 2 - centre) - Math.abs(b + win / 2 - centre))[0]
        break
      }
    }
  }
  const x = (t: number) => r2(X0 + ((Math.min(Math.max(t, ws), ws + win) - ws) / win) * (X1 - X0))
  const xs = x(outage.start)
  const xe = x(end)
  const xNow = x(toMs)
  const tick = (t: number) => (step < 60_000 ? fmtTimeSec(t) : step < 86_400_000 ? fmtTime(t) : fmtDate(t))
  const ticks = Array.from({ length: 7 }, (_, i) => ws + i * step)
  const winText = win < 3600_000 ? `${win / 60_000} นาที` : win < 86_400_000 ? `${win / 3600_000} ชั่วโมง` : `${win / 86_400_000} วัน`
  const descId = `${titleId}-desc`
  return (
    <ChartFrame
      bare
      timeAxis={false}
      titleId={titleId}
      title={`${row.type} "${row.name}" ช่วง ${tick(ws)}–${tick(ws + win)}`}
      sub={`ขยาย ${winText}ตามสเกลจริง · เส้นตั้ง = เวลาของบรรทัด log`}
      legend={[
        { label: 'up', color: 'var(--ok-line)' },
        { label: 'down', color: 'var(--danger-solid)' },
      ]}
    >
      <svg viewBox="0 0 500 86" role="img" aria-labelledby={`${titleId} ${descId}`} style={{ ['--chart-min' as string]: '450px' }}>
        <desc id={descId}>
          up จนถึง {fmtTimeMs(outage.start)} จากนั้น down {durationThai(outageMs(outage, toMs))}
          {outage.end ? ` จนถึง ${fmtTimeMs(outage.end)} แล้ว up อีกครั้ง` : ' และยัง down อยู่'}
        </desc>
        {down ? <EventMark at={x(Date.parse(down.timestamp))} y1={3} labelY={12} text="dependency.down" side="left" /> : null}
        {still ? <EventMark at={x(Date.parse(still.timestamp))} y1={3} labelY={12} text="dependency.still_down" /> : null}
        {up && outage.end ? <EventMark at={x(Date.parse(up.timestamp))} y1={21} labelY={30} text={upText} /> : null}
        {xs - X0 > 2 ? <rect className="jb-z-up" x={X0} y="42" width={r2(xs - 1 - X0)} height="14" /> : null}
        <rect className="jb-z-down" x={r2(xs + 1)} y="42" width={r2(Math.max(2, xe - xs - 1))} height="14" />
        {outage.end && xNow - xe > 2 ? <rect className="jb-z-up" x={r2(xe + 1)} y="42" width={r2(Math.min(X1, xNow) - xe - 1)} height="14" /> : null}
        <line className="c-axis" x1={X0} x2={X1} y1="64" y2="64" />
        {ticks.map((t) => (
          <line key={`t${t}`} className="c-axis" x1={x(t)} x2={x(t)} y1="64" y2="68" />
        ))}
        {ticks.map((t, i) => (
          <text key={`l${t}`} className={i === 0 ? 'c-tick' : i === ticks.length - 1 ? 'c-tick c-tick--end' : 'c-tick c-tick--mid'} x={x(t)} y="81">
            {tick(t)}
          </text>
        ))}
        {xs - X0 > 2 ? (
          <rect className="c-hit" x={X0} y="38" width={r2(xs - X0)} height="22" tabIndex={0} {...tipAttrs(`${tick(ws)}–${fmtTimeMs(outage.start)}`, [{ value: 'up', name: 'ก่อนบรรทัด dependency.down' }])} />
        ) : null}
        <rect
          className="c-hit"
          x={xs}
          y="38"
          width={r2(Math.max(4, xe - xs))}
          height="22"
          tabIndex={0}
          {...tipAttrs(`${fmtTimeMs(outage.start)}–${outage.end ? fmtTimeMs(outage.end) : 'ตอนนี้'}`, [
            { value: durText, name: 'down' },
            ...(still ? [{ value: retryOf(still) ? `retry ${retryOf(still)}` : 'still_down', name: `still_down ${fmtTimeMs(still.timestamp)}` }] : []),
          ])}
        />
        {outage.end && X1 - xe > 2 ? (
          <rect
            className="c-hit"
            x={xe}
            y="38"
            width={r2(X1 - xe)}
            height="22"
            tabIndex={0}
            {...tipAttrs(`ตั้งแต่ ${fmtTimeMs(outage.end)}`, [{ value: 'up', name: `dependency.up${up?.reason ? ` · ${up.reason}` : ''}` }])}
          />
        ) : null}
      </svg>
    </ChartFrame>
  )
}

/** Chips of a dependency.* line: target, affects, retry, reason, duration. */
function stateKvs(r: LogRow): Kv[] {
  const out: Kv[] = []
  if (r.dependency) out.push({ k: 'target', v: hostPort(r.dependency) })
  const affects = affectsOf(r)
  if (affects) out.push({ k: 'affects', v: affects })
  if (retryOf(r)) out.push({ k: 'retry', v: retryOf(r) })
  if (r.reason) out.push({ k: 'reason', v: r.reason })
  if (r.durationMs !== null) out.push({ k: 'duration', v: fmtDuration(r.durationMs) })
  return out
}

function lineState(r: LogRow) {
  if (r.eventCode === 'dependency.down') return <StateChip state="down">down</StateChip>
  if (r.eventCode === 'dependency.still_down') return <StateChip state="down">ยัง down</StateChip>
  return <StateChip state="ok">up</StateChip>
}

export function Dependencies(p: DependenciesProps) {
  const { rows, fromMs, toMs, keep, order, clock, rangeShort } = p
  const span = Math.max(1, toMs - fromMs)
  const interval = tickInterval(span)
  const ticks = timeTicks(fromMs, toMs).filter((t) => (t - fromMs) / span < 0.84 && (t - fromMs) / span > 0.04)
  const everyText = interval >= 86_400_000 ? 'ทุกวัน' : interval >= 3600_000 ? `ทุก ${interval / 3600_000} ชั่วโมง` : `ทุก ${interval / 60_000} นาที`
  const degraded = rows.filter((r) => r.state === 'degraded')
  // open the row that is down now, else the one with the latest outage in the range
  const openId =
    rows.find((r) => r.state === 'down')?.id ??
    [...rows].filter((r) => r.outages.length).sort((a, b) => (latestOutage(b)?.start ?? 0) - (latestOutage(a)?.start ?? 0))[0]?.id
  const thinOutage = rows.flatMap((r) => r.outages).find((o) => (outageMs(o, toMs) / span) * 300 < 1)

  return (
    <Section
      id="dependencies"
      className="jb-anchor"
      title="ระบบที่เรียกใช้ (dependency)"
      meta={`${rows.length} รายการของ ${p.env ?? 'ทุก env'} · สถานะมาจากบรรทัด log ที่ library เขียนเองเมื่อต่อไม่ได้และเมื่อกลับมา`}
    >
      <ol className="flow jb-flow" aria-label="บรรทัด log ที่กำหนดสถานะ dependency">
        <li className="flow__node flow__node--lead">
          <LevelBadge level="error" />
          <code>dependency.down</code>
          <span className="flow__text">
            ต่อไม่ได้ครั้งแรก: สถานะเป็น <b>down</b> ตั้งแต่เวลาของบรรทัดนี้
          </span>
        </li>
        <li className="flow__node flow__node--lead">
          <LevelBadge level="warn" />
          <code>dependency.still_down</code>
          <span className="flow__text">ทุก 30 s ระหว่างที่ยังต่อไม่ได้ พร้อม retry และเวลาที่ล่มมาแล้ว</span>
        </li>
        <li className="flow__node flow__node--lead">
          <LevelBadge level="info" />
          <code>dependency.up</code>
          <span className="flow__text">
            กลับมาแล้ว: สถานะเป็น <b>up</b> และ duration คือเวลาที่ล่มทั้งหมด
          </span>
        </li>
      </ol>
      <p className="hint">
        Library เขียนเมื่อเชื่อมต่อครั้งแรก (<code>dependency.up</code> reason connected) และเมื่อสถานะเปลี่ยน ถ้าไม่มีบรรทัดอื่นในช่วงนี้แปลว่าไม่ได้ล่ม (แสดงเป็น up)
        {degraded.length ? (
          <>
            {' '}
            · {degraded.map((d) => d.name).join(', ')} มีแค่ <code>http.outbound_failed</code> (ตอบ 4xx) ซึ่งไม่เปลี่ยนสถานะ จึงแสดงเป็นเตือน
          </>
        ) : null}
      </p>
      <div className="table-wrap mt-3">
        <table className="table table--reflow jb-deps">
          <caption className="sr-only">Dependency ของ {p.env ?? 'ทุก env'}: สถานะตอนนี้ ประวัติ {rangeShort} และบรรทัด log ที่ให้สถานะนั้น</caption>
          <thead>
            <tr>
              <th scope="col" className="col-tight">
                <span className="sr-only">ขยาย</span>
              </th>
              <th scope="col">Dependency · host:port</th>
              <th scope="col">Service</th>
              <th scope="col">สถานะตอนนี้</th>
              <th scope="col" className="jb-tl-col">
                {rangeShort} ({fmtDateTime(fromMs)} → {fmtDateTime(toMs)})
                <div className="mini-axis" aria-hidden="true">
                  {ticks.map((t) => (
                    <span key={t} style={{ ['--x' as string]: (((t - fromMs) / span) * 100).toFixed(3) }}>
                      {timeTickText(t, interval)}
                    </span>
                  ))}
                  <span className="mini-axis__end">{fmtTime(toMs)}</span>
                </div>
              </th>
              <th scope="col">ที่มาของสถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const o = latestOutage(d)
              const latestState = d.stateLines[0]
              const codes = statusCounts(d.outbound)
              const counted = codes.length === 1 ? [{ ...codes[0], n: d.outboundFailures || codes[0].n }] : codes
              // state now
              let stateNode
              if (d.state === 'down') {
                stateNode = (
                  <>
                    <StateChip state="down">down ตั้งแต่ {d.since ? clock.sec(d.since) : '–'}</StateChip>
                    <span className="cell-sub">
                      ล่มมาแล้ว {d.since ? fmtDuration(toMs - Date.parse(d.since)) : '–'}
                      {d.attempts ? ` · ${fmtCount(d.attempts)} บรรทัดที่ล้มเหลว` : ''}
                    </span>
                  </>
                )
              } else if (d.state === 'degraded') {
                stateNode = (
                  <>
                    <StateChip state="warn">up · {counted.map((c) => `${c.status} × ${fmtCount(c.n)}`).join(' · ') || `4xx × ${fmtCount(d.outboundFailures)}`}</StateChip>
                    <span className="cell-sub">
                      ถูกปฏิเสธ {fmtCount(d.outboundFailures)} ครั้ง{inRange(p.rangeLabel)}
                    </span>
                  </>
                )
              } else if (o && o.end) {
                stateNode = (
                  <>
                    <StateChip state="ok">up ตั้งแต่ {clock.sec(o.end)}</StateChip>
                    <span className="cell-sub">
                      <span className="t-danger">down {fmtDuration(outageMs(o, toMs))}</span> {clock.sec(o.start)}–{clock.sec(o.end)}
                    </span>
                  </>
                )
              } else {
                stateNode = (
                  <>
                    <StateChip state="ok">up</StateChip>
                    <span className="cell-sub">ไม่ได้ล่ม{inRange(rangeShort)}</span>
                  </>
                )
              }
              // the line that set the state
              let srcNode
              if (d.state === 'degraded' && d.outbound.length) {
                srcNode = (
                  <>
                    <span className="jb-src__line">
                      <LevelBadge level={d.outbound[0].level} />
                      <code>http.outbound_failed</code>
                    </span>
                    <span className="cell-sub">
                      × {fmtCount(d.outboundFailures)} · ล่าสุด {clock.sec(d.outbound[0].timestamp)} · ไม่ใช่ dependency.down
                    </span>
                  </>
                )
              } else if (latestState && (o || d.state === 'down')) {
                srcNode = (
                  <>
                    <span className="jb-src__line">
                      <LevelBadge level={latestState.level} />
                      <code>{latestState.eventCode}</code>
                    </span>
                    <span className="cell-sub">
                      {clock.ms(latestState.timestamp)} · ล่าสุดจาก {fmtCount(o ? o.lines.length : d.stateLines.length)} บรรทัด
                    </span>
                  </>
                )
              } else if (d.since) {
                srcNode = (
                  <>
                    <span className="jb-src__line">
                      <LevelBadge level="info" />
                      <code>dependency.up</code>
                    </span>
                    <span className="cell-sub">
                      reason connected ตอน pod เริ่ม · ไม่มีบรรทัดอื่น{inRange(rangeShort)}
                    </span>
                  </>
                )
              } else {
                srcNode = <span className="cell-sub">ไม่มีบรรทัด dependency.* ใน 7 วัน</span>
              }
              const cells = (
                <>
                  <td className="jd-dep" id={d.hostId !== d.id ? d.hostId : undefined}>
                    <span className="dep" id={d.id}>
                      <span className="dep__top">
                        <Tag>{d.type}</Tag>
                        <span className="dep__name">{d.name}</span>
                      </span>
                      <span className="dep__host">{hostPort(d)}</span>
                    </span>
                  </td>
                  <td className="jd-svc">
                    {d.users.length > 1 ? (
                      <span className="svc-list">
                        {d.users.map((m) => (
                          <ServiceChip key={`${m.service}/${m.role}`} service={m.service} role={m.role} order={order} />
                        ))}
                      </span>
                    ) : (
                      <ServiceChip service={d.users[0].service} role={d.users[0].role} order={order} />
                    )}
                  </td>
                  <td className="jd-state">
                    <span className="jb-state">{stateNode}</span>
                  </td>
                  <td className="jd-tl">
                    <Strip row={d} fromMs={fromMs} toMs={toMs} rangeShort={rangeShort} />
                  </td>
                  <td className="jd-src">
                    <span className="jb-src">{srcNode}</span>
                  </td>
                </>
              )

              // expanded: the latest outage, and / or the 4xx lines
              const parts = []
              if (o) {
                const fp = o.lines.find((r) => r.fingerprint)
                const errCodes = codeCounts(o.lines)
                const lastRetry = [...o.lines].reverse().find((r) => retryOf(r))
                parts.push(
                  <div key="outage">
                    <div className="jb-zoom">
                      <Zoom row={d} outage={o} toMs={toMs} titleId={`${d.id}-zoom`} />
                      <LinesTable
                        caption={`บรรทัด dependency.* ของ ${depName(d)} ${hostPort(d)} ที่กำหนดสถานะ`}
                        clock={clock}
                        state={lineState}
                        lines={o.lines.map((row) => ({
                          row,
                          kvs: stateKvs(row),
                          aside: d.users.length > 1 ? <ServiceChip service={row.service} role={row.role} order={order} /> : undefined,
                        }))}
                      />
                    </div>
                    <p className="hint mt-2">
                      {fp ? (
                        <>
                          Error group ที่เกี่ยวข้อง: <Link href={buildHref(`/errors/${fp.fingerprint}`, keep)}>{fp.error?.hint || fp.message}</Link>
                          {' · '}
                        </>
                      ) : null}
                      {errCodes.map((c) => `${c.code} ${fmtCount(c.n)} ครั้ง`).join(' · ')}
                      {errCodes.length ? ' · ' : ''}
                      <span className="mono">attempts</span> ใน /api/dependencies = {fmtCount(d.attempts)} (บรรทัดที่ล้มเหลวในช่วงนี้: down + still_down
                      {d.outboundFailures ? ' + http.outbound_failed' : ''})
                      {lastRetry ? ` · client retry ล่าสุด ${retryOf(lastRetry)} (จากบรรทัด ${lastRetry.eventCode.replace('dependency.', '')})` : ''}
                      {d.outages.length > 1 ? ` · ล่ม ${d.outages.length} ครั้ง${inRange(p.rangeLabel)} กราฟขยายครั้งล่าสุด` : ''}
                    </p>
                  </div>,
                )
              }
              if (d.outbound.length) {
                const shown = d.outbound.slice(0, 10)
                parts.push(
                  <div key="outbound" className="jb-detail">
                    <ErrorDetailText text={logDetail(d.outbound[0])} label="ต้องแก้อะไร" />
                    <LinesTable caption={`บรรทัด http.outbound_failed ของ ${d.name}`} clock={clock} lines={shown.map((row) => ({ row }))} />
                    <p className="hint">
                      {d.outboundFailures > shown.length ? (
                        <>
                          แสดง {shown.length} จาก {fmtCount(d.outboundFailures)} บรรทัด · <Link href={p.outboundLogsHref(d.host)}>ดูทั้งหมดใน Log</Link> ·{' '}
                        </>
                      ) : null}
                      4xx ไม่ทำให้ library เขียน dependency.down เพราะปลายทางยังตอบอยู่ สถานะจึงยังเป็น up แต่หน้าจอนี้เตือนจากบรรทัดเหล่านี้
                    </p>
                  </div>,
                )
              }
              return parts.length ? (
                <ExpandRow
                  key={d.id}
                  label={`ขยาย ${depName(d)} ${hostPort(d)}`}
                  colSpan={5}
                  toggleCellClassName="jd-tog"
                  defaultOpen={d.id === openId}
                  cells={cells}
                  detail={<div className="jb-detail">{parts}</div>}
                />
              ) : (
                <tr key={d.id}>
                  <td className="jd-tog" />
                  {cells}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ul className="legend jb-legend">
        <li className="legend__item">
          <span className="legend__key" style={{ ['--c' as string]: 'var(--ok-line)' }} />
          up
        </li>
        <li className="legend__item">
          <span className="legend__key" style={{ ['--c' as string]: 'var(--danger-solid)' }} />
          down (ขีดกว้างอย่างน้อย 3 px{thinOutage ? `: ${fmtDuration(outageMs(thinOutage, toMs))} ${inRange(rangeShort)} แคบกว่า 1 px` : ''})
        </li>
        <li className="legend__item">
          <span className="legend__key" style={{ ['--c' as string]: 'var(--warn-solid)' }} />
          ถูกปฏิเสธ 4xx
        </li>
        <li className="legend__item t-muted">ขีดจางบนล่าง = {everyText} · ชี้หรือกด Tab ที่ขีดเพื่อดูเวลา</li>
      </ul>
    </Section>
  )
}
