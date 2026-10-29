/**
 * Small pieces of /jobs (server): ICT time text that adds the date on ranges over a day, the "lines written by
 * the library" table of expanded rows, and the readable error row (DESIGN.md §6) of one log line or one group.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CategoryChip, LevelBadge, ServiceChip } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { ActualError, ErrorWhatFix, IdChip, KvList } from '@/components/ErrorParts'
import { fmtCount, fmtDate, fmtDateTime, fmtDateTimeMs, fmtTime, fmtTimeMs, fmtTimeSec, toMs } from '@/lib/format'
import { buildHref, type Keep } from '@/lib/params'
import { actualError, groupKvs, groupTitle, groupWhatFix, type Kv, logKvs, logTitle, logWhatFix } from '@/lib/readable'
import type { ErrorGroup, LogRow } from '@/lib/types'

/** Time formats of the screen: HH:mm:ss within a day, with the date on longer ranges. */
export interface Clock {
  /** `13:58:07` (or `17 ต.ค. 13:58`). */
  sec: (v: string | number | null | undefined) => string
  /** `13:58:07.912` (or `17 ต.ค. 13:58:07.912`). */
  ms: (v: string | number | null | undefined) => string
  /** `13:58` (or `17 ต.ค. 13:58`). */
  min: (v: string | number | null | undefined) => string
}

export function clockOf(fromMs: number, toMs: number): Clock {
  const long = toMs - fromMs > 86_400_000 + 60_000
  return long
    ? { sec: fmtDateTime, ms: fmtDateTimeMs, min: fmtDateTime }
    : { sec: fmtTimeSec, ms: fmtTimeMs, min: fmtTime }
}

/** `<time class="ts">` with the full ICT time in the title. */
export function T({ value, text }: { value: string | number | null | undefined; text: string }) {
  const ms = toMs(value)
  const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  return (
    <time className="ts" dateTime={iso} title={iso ? `${fmtDateTimeMs(ms)} ICT` : undefined}>
      {text}
    </time>
  )
}

/** `17 ต.ค. 14:12:41` */
export const dateSec = (v: string | number | null | undefined) => `${fmtDate(v)} ${fmtTimeSec(v)}`

/** Trace link + copy (`/traces/<id>`, keeps env / from / to); `bare` = without the "trace" key (table cells, fields). */
export function TraceChip({ traceId, keep, bare }: { traceId: string; keep: Keep; bare?: boolean }) {
  if (!traceId) return null
  const href = buildHref(`/traces/${traceId}`, keep)
  if (!bare) return <IdChip label="trace" value={traceId} href={href} />
  return (
    <span className="idchip">
      <Link href={href} title={traceId}>
        {traceId}
      </Link>
      <CopyButton text={traceId} variant="icon" ariaLabel="คัดลอก trace id" />
    </span>
  )
}

export interface LineSpec {
  row: LogRow
  /** Extra chips after the readable ones. */
  extra?: Kv[]
  /** Replaces the readable chips. */
  kvs?: Kv[]
  /** Node after the title (the service when lines of several services are mixed). */
  aside?: ReactNode
}

/** `table.table--dense` of library lines: time, level, title + chips + event code (+ an optional state column). */
export function LinesTable({ caption, lines, clock, state }: { caption: string; lines: LineSpec[]; clock: Clock; state?: (row: LogRow) => ReactNode }) {
  return (
    <div className="table-wrap jb-lines">
      <table className="table table--dense">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">เวลา</th>
            <th scope="col">ระดับ</th>
            <th scope="col">บรรทัดจาก library</th>
            {state ? <th scope="col">สถานะ</th> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ row, extra, kvs, aside }, i) => {
            const err = actualError(row.error)
            return (
              <tr key={`${row.timestamp}-${i}`}>
                <td className="ts">
                  <T value={row.timestamp} text={clock.ms(row.timestamp)} />
                </td>
                <td>
                  <LevelBadge level={row.level} />
                </td>
                <td>
                  <span className="jb-line">
                    <span className="jb-line__head">
                      <span className="jb-line__title">{logTitle(row).title}</span>
                      {aside}
                    </span>
                    <KvList items={[...(kvs ?? logKvs(row)), ...(extra ?? [])]} />
                    <span className="jb-code">{[row.eventCode, err].filter(Boolean).join(' · ')}</span>
                  </span>
                </td>
                {state ? <td>{state(row)}</td> : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** One error line as the readable error row (title = hint, chips, ต้องแก้อะไร, error จริง, service, trace, note). */
export function LogErrorRow({ row, keep, order, note }: { row: LogRow; keep: Keep; order: readonly string[]; note?: ReactNode }) {
  return (
    <article className="err-row">
      <div className="err-row__head">
        <LevelBadge level={row.level} />
        <h3 className="err-row__title">{logTitle(row).title}</h3>
        <CategoryChip category={row.error?.category ?? ''} />
        <span className="err-row__count">
          <T value={row.timestamp} text={fmtDateTimeMs(row.timestamp)} />
        </span>
      </div>
      <KvList items={logKvs(row)} />
      <ErrorWhatFix {...logWhatFix(row)} />
      <ActualError text={actualError(row.error)} />
      <div className="err-row__meta">
        <ServiceChip service={row.service} role={row.role} order={order} />
        <TraceChip traceId={row.traceId} keep={keep} />
        {note ? <span>{note}</span> : null}
      </div>
    </article>
  )
}

/** One error group (count in the head, first trace, link to its detail page). */
export function GroupErrorRow({ group, keep, order, split }: { group: ErrorGroup; keep: Keep; order: readonly string[]; split?: { retry: number; failed: number } }) {
  const g = group
  return (
    <article className="err-row">
      <div className="err-row__head">
        <LevelBadge level={g.level} />
        <h3 className="err-row__title">
          <Link href={buildHref(`/errors/${g.fingerprint}`, keep)}>{groupTitle(g)}</Link>
        </h3>
        <CategoryChip category={g.category} />
        <span className="err-row__count">
          <span>
            <b>{fmtCount(g.count)}</b> ครั้ง
          </span>
          {split ? (
            <>
              <span>
                <b>{fmtCount(split.retry)}</b> retry
              </span>
              <span>
                <b>{fmtCount(split.failed)}</b> ล้มเหลวจริง
              </span>
            </>
          ) : g.users ? (
            <span>
              <b>{fmtCount(g.users)}</b> users
            </span>
          ) : null}
        </span>
      </div>
      <KvList items={groupKvs(g)} />
      <ErrorWhatFix {...groupWhatFix(g)} />
      <ActualError text={actualError({ type: g.errorType, code: g.errorCode, message: g.sampleMessage })} />
      <div className="err-row__meta">
        <ServiceChip service={g.service} role={g.role} order={order} />
        {g.originFunction ? (
          <span>
            source <span className="mono">{g.originFunction}</span>
          </span>
        ) : null}
        <span>
          ล่าสุด <T value={g.lastSeen} text={dateSec(g.lastSeen)} />
        </span>
        <TraceChip traceId={g.sampleTraceId} keep={keep} />
      </div>
    </article>
  )
}
