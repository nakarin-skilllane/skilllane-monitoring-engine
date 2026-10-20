/**
 * The two charts of error-detail.html (§7): occurrences per spark bucket over the range (viewBox 1140 × 236,
 * deploy line with the version before / after it, the max labelled, version per bucket in the tooltip) and,
 * for a NEW group, occurrences per minute of the last hour (1140 × 110, "ล่าสุด HH:MM" at the newest bar).
 * Motion markup as in components/charts (svg[data-mo-ready], bar baselines, --mo-x).
 */
import type { CSSProperties } from 'react'
import { barPath, niceScale, r1, tickInterval, tickLabel, timeTicks, tipAttrs } from '@/lib/chart'
import { fmtCount, fmtDate, fmtDateTime, fmtTime, sameDay } from '@/lib/format'
import type { Deploy } from '@/lib/types'

const W = 1140
const L = 40
const R = 20
const PW = W - L - R

function motion(x: number, base: number): CSSProperties {
  return { transformOrigin: `0 ${base}px`, '--mo-x': Math.max(0, Math.min(1, x / W)).toFixed(3) } as CSSProperties
}

function YAxis({ ticks, max, top, base }: { ticks: number[]; max: number; top: number; base: number }) {
  return (
    <>
      {ticks.map((v) => {
        const y = r1(base - (v / max) * (base - top))
        return (
          <g key={v}>
            {v > 0 ? <line className="c-grid" x1={L} x2={W - R} y1={y} y2={y} /> : null}
            <text className="c-tick c-tick--end" x={L - 8} y={y + 4}>
              {tickLabel(v)}
            </text>
          </g>
        )
      })}
      <line className="c-axis" x1={L} x2={W - R} y1={base} y2={base} />
    </>
  )
}

export interface HourBucket {
  start: number
  end: number
  count: number
  /** Tooltip / table: version(s) running in the bucket. */
  version: string
  label: string
}

export function HourChart({ buckets, deploys, titleId, descId, desc }: { buckets: HourBucket[]; deploys: Deploy[]; titleId: string; descId: string; desc: string }) {
  const top = 16
  const base = 196
  const n = Math.max(1, buckets.length)
  const slot = PW / n
  const bar = Math.max(1, Math.min(24, slot - 2))
  const t0 = buckets[0]?.start ?? 0
  const t1 = buckets[buckets.length - 1]?.end ?? t0 + 1
  const span = Math.max(1, t1 - t0)
  const xOf = (t: number) => L + Math.max(0, Math.min(1, (t - t0) / span)) * PW
  const max = Math.max(0, ...buckets.map((b) => b.count))
  // occurrences are whole numbers: never a 0.25 tick
  const scale = niceScale(max, 4, { integer: true })
  // Nominal range (buckets × step): the last bucket may run a few seconds past it.
  const interval = tickInterval(n * ((buckets[0]?.end ?? 1) - (buckets[0]?.start ?? 0)))
  const ticks = timeTicks(t0, t1, interval)
  const maxIdx = buckets.findIndex((b) => b.count === max)
  // label boxes of each deploy (previous version left of the line, `deploy x · HH:MM` right of it, or left when no room)
  const boxesAt = (y: number) =>
    deploys.map((d) => {
      const x = r1(xOf(Date.parse(d.at)))
      const room = x + 6 + 140 < W - R
      const text = `deploy ${d.version} · ${fmtTime(d.at)}`
      const w = text.length * 6.4
      const prevW = room && d.previousVersion ? d.previousVersion.length * 6.4 : 0
      return { d, x, y, room, text, x1: room ? x - 6 - prevW : x - 6 - w, x2: room ? x + 6 + w : x + 6, y1: y - 12, y2: y + 4 }
    })
  const maxX = maxIdx >= 0 ? r1(L + maxIdx * slot + slot / 2) : 0
  const maxY = maxIdx >= 0 ? r1(base - (max / scale.max) * (base - top) - 6) : 0
  const maxW = fmtCount(max).length * 7 + 4
  const hitsMax = (list: ReturnType<typeof boxesAt>) => max > 0 && list.some((b) => maxX + maxW / 2 > b.x1 && maxX - maxW / 2 < b.x2 && maxY + 2 > b.y1 && maxY - 12 < b.y2)
  // labels never overprint: the deploy labels move below the max label (their halo keeps them readable over the
  // bar); only when that does not fit either, the max label gives way (the max is in the KPI foot and the tooltip)
  let deployBoxes = boxesAt(30)
  if (hitsMax(deployBoxes)) {
    const lower = boxesAt(Math.min(base - 8, maxY + 18))
    if (!hitsMax(lower)) deployBoxes = lower
  }
  const maxHidden = hitsMax(deployBoxes)
  return (
    <svg viewBox={`0 0 ${W} 236`} role="img" aria-labelledby={`${titleId} ${descId}`} style={{ '--chart-min': '1026px' } as CSSProperties} data-mo-ready="">
      <desc id={descId}>{desc}</desc>
      <YAxis ticks={scale.ticks} max={scale.max} top={top} base={base} />
      {ticks.map((t, i) => {
        const x = r1(xOf(t))
        const day = interval < 86_400_000 && (i === 0 || !sameDay(t, ticks[i - 1]))
        return (
          <g key={t}>
            <line className="c-axis" x1={x} x2={x} y1={base} y2={base + 4} />
            <text className="c-tick c-tick--mid" x={x} y="214">
              {interval >= 86_400_000 ? fmtDate(t) : fmtTime(t)}
            </text>
            {day ? (
              <text className="c-tick c-tick--mid" x={x} y="230">
                {fmtDate(t)}
              </text>
            ) : null}
          </g>
        )
      })}
      {buckets.map((b, i) => {
        if (b.count <= 0) return null
        const h = Math.max(1.5, (b.count / scale.max) * (base - top))
        const x = L + i * slot + (slot - bar) / 2
        return <path key={b.start} className="c-bar" d={barPath(x, base - h, bar, h)} style={motion(x, base)} />
      })}
      {deployBoxes.map(({ d, x, y, room, text }) => (
        <g key={d.at}>
          <line className="c-event" x1={x} x2={x} y1={top} y2={base} />
          {/* c-halo: a tall bar behind the label never makes it unreadable */}
          {room && d.previousVersion ? (
            <text className="c-label c-label--muted c-halo" x={x - 6} y={y} textAnchor="end">
              {d.previousVersion}
            </text>
          ) : null}
          <text className="c-event-label c-halo" x={room ? x + 6 : x - 6} y={y} textAnchor={room ? undefined : 'end'}>
            {text}
          </text>
        </g>
      ))}
      {maxIdx >= 0 && max > 0 && !maxHidden ? (
        <text className="c-label c-halo" x={maxX} y={maxY} textAnchor="middle">
          {fmtCount(max)}
        </text>
      ) : null}
      <g>
        {buckets.map((b, i) => (
          <rect
            key={b.start}
            className="c-hit"
            x={r1(L + i * slot)}
            y={top}
            width={r1(slot)}
            height={base - top}
            {...tipAttrs(b.label, [{ value: fmtCount(b.count), name: 'ครั้ง' }, ...(b.version ? [{ value: b.version, name: 'version' }] : [])])}
          />
        ))}
      </g>
    </svg>
  )
}

export function MinuteChart({ minutes, titleId, descId, desc }: { minutes: Array<{ t: number; count: number }>; titleId: string; descId: string; desc: string }) {
  const top = 12
  const base = 84
  const n = Math.max(1, minutes.length)
  const slot = PW / n
  const bar = Math.max(1, Math.min(10, slot - 4))
  const t0 = minutes[0]?.t ?? 0
  const max = Math.max(0, ...minutes.map((m) => m.count))
  const scale = niceScale(max, 2, { integer: true })
  const ticks = timeTicks(t0, minutes[minutes.length - 1]?.t ?? t0, 10 * 60_000)
  let last = -1
  minutes.forEach((m, i) => m.count > 0 && (last = i))
  const lastX = last >= 0 ? L + last * slot + (slot - bar) / 2 : 0
  const lastTop = last >= 0 ? base - Math.max(1.5, (minutes[last].count / scale.max) * (base - top)) : 0
  const lastRoom = lastX + bar + 76 < W - R
  return (
    <svg viewBox={`0 0 ${W} 110`} role="img" aria-labelledby={`${titleId} ${descId}`} style={{ '--chart-min': '1026px' } as CSSProperties} data-mo-ready="">
      <desc id={descId}>{desc}</desc>
      <YAxis ticks={scale.ticks} max={scale.max} top={top} base={base} />
      {ticks.map((t) => (
        <text key={t} className="c-tick c-tick--mid" x={r1(L + ((t - t0) / 60_000 + 0.5) * slot)} y="102">
          {fmtTime(t)}
        </text>
      ))}
      {minutes.map((m, i) => {
        if (m.count <= 0) return null
        const h = Math.max(1.5, (m.count / scale.max) * (base - top))
        const x = L + i * slot + (slot - bar) / 2
        return <path key={m.t} className="c-bar" d={barPath(x, base - h, bar, h)} style={motion(x, base)} />
      })}
      {last >= 0 ? (
        <text
          className="c-label c-label--muted"
          x={r1(lastRoom ? lastX + bar + 3 : lastX + bar)}
          y={r1(lastRoom ? Math.max(top + 4, lastTop - 4) : top + 2)}
          textAnchor={lastRoom ? undefined : 'end'}
        >
          ล่าสุด {fmtTime(minutes[last].t)}
        </text>
      ) : null}
      <g>
        {minutes.map((m, i) => (
          <rect key={m.t} className="c-hit" x={r1(L + i * slot)} y={top} width={r1(slot)} height={base - top} {...tipAttrs(fmtDateTime(m.t), [{ value: fmtCount(m.count), name: 'ครั้ง' }])} />
        ))}
      </g>
    </svg>
  )
}
