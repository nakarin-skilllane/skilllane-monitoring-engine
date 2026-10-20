/**
 * "Queue, topic และ cron" (server): one row group per queue system (BullMQ, Kafka, RabbitMQ, cron), counts and
 * the outcome bar per queue + type, the latest real failure, consumer events, and an expandable row with the
 * lines behind the numbers (failures of queues without their own section, consumer.*, job.redelivered).
 */
import type { CSSProperties, ReactNode } from 'react'
import { LevelBadge, ServiceChip, StateChip, Tag } from '@/components/badges'
import { ExpandRow } from '@/components/ExpandRow'
import { tipAttrs } from '@/lib/chart'
import { fmtCount, fmtDuration } from '@/lib/format'
import { inRange, type Keep } from '@/lib/params'
import type { JobStat, LogRow } from '@/lib/types'
import {
  consumerEventLabel,
  cronEvery,
  type DepRow,
  hostPort,
  isCronLike,
  jobKey,
  moduleLabel,
  outcome,
  partitionsOf,
  type QueueGroup,
  statName,
  unitOf,
} from '../_data'
import { type Clock, LinesTable, LogErrorRow, T } from './parts'

export interface QueueTableProps {
  groups: QueueGroup[]
  /** Latest real failures (level error / fatal) per job key, newest first. */
  finals: Map<string, LogRow[]>
  /** job.redelivered lines per job key, newest first. */
  redelivered: Map<string, LogRow[]>
  consumerEvents: LogRow[]
  featured: JobStat | null
  deps: DepRow[]
  env?: string
  rangeLabel: string
  rangeMs: number
  keep: Keep
  order: readonly string[]
  clock: Clock
}

/** The group header's sentence: how many queues, on which broker (from the watched dependencies). */
function groupWhere(g: QueueGroup, deps: DepRow[]): string {
  const n = new Set(g.stats.map((s) => s.queue)).size
  const owned = (d: DepRow) => d.members.some((m) => g.owners.some((o) => o.service === m.service && o.role === m.role))
  const broker = (pick: (d: DepRow) => boolean) => deps.find((d) => pick(d) && owned(d)) ?? deps.find(pick)
  switch (g.module) {
    case 'bullmq': {
      const d = broker((x) => x.type === 'redis' && x.name === 'queue')
      return `${n} queue${d ? ` บน redis "${d.name}" ${hostPort(d)}` : ''}`
    }
    case 'kafka': {
      const d = broker((x) => x.type === 'kafka')
      return `consumer ${n} topic${d ? ` บน ${hostPort(d)}` : ''}`
    }
    case 'rabbitmq': {
      const d = broker((x) => x.type === 'rabbitmq')
      return `consumer ${n} queue${d ? ` บน ${hostPort(d)}` : ''}`
    }
    case 'cron':
      return '@nestjs/schedule · ชื่อ job คือ Class.method'
    default:
      return `${g.stats.length} งาน`
  }
}

/** Attempts that ended in the range but started before it (their job.started line is older than `from`). */
const startedBefore = (s: JobStat): number => Math.max(0, s.finished + s.retried + s.failed - s.started)

/** `รวม 1 งานที่เริ่มก่อนช่วงนี้`: why the ends can outnumber the starts. */
function beforeText(s: JobStat, n: number): string {
  const unit = unitOf(s.module)
  return `รวม ${fmtCount(n)} ${unit === 'attempt' ? 'งาน' : unit === 'รอบ' ? 'รอบ' : `${unit} `}ที่เริ่มก่อนช่วงนี้`
}

function OutcomeBar({ s }: { s: JobStat }) {
  const segs = outcome(s)
  const unit = unitOf(s.module)
  const name = statName(s)
  const before = startedBefore(s)
  const parts = segs
    .filter((x) => x.n > 0)
    .map((x) => `${x.label} ${fmtCount(x.n)}`)
    .join(' ')
  const aria = before ? `${parts} (เริ่ม ${fmtCount(s.started)} ${unit} ในช่วงนี้ · ${beforeText(s, before)})` : `${parts} จาก ${fmtCount(s.started)} ${unit}`
  const tip = tipAttrs(`${name} · ${fmtCount(s.started)} ${unit}`, [
    ...segs.map((x) => ({ value: fmtCount(x.n), name: x.label, key: x.key })),
    ...(before ? [{ value: fmtCount(before), name: 'เริ่มก่อนช่วงนี้' }] : []),
  ])
  return (
    <span className="jb-out" tabIndex={0} role="img" aria-label={aria} {...tip}>
      {segs
        .filter((x) => x.n > 0)
        .map((x) => (
          <i key={x.label} className={x.cls} style={{ '--n': x.n } as CSSProperties} />
        ))}
    </span>
  )
}

function LastFailure({ s, row, clock }: { s: JobStat; row: LogRow | undefined; clock: Clock }) {
  if (!row) {
    return s.lastFailedAt ? (
      <td className="jb-c-last">
        <span className="jb-last">
          <T value={s.lastFailedAt} text={clock.sec(s.lastFailedAt)} />
        </span>
      </td>
    ) : (
      <td className="jb-c-last t-muted">–</td>
    )
  }
  const j = row.job
  const sub = isCronLike(s.module)
    ? `รอบ ${clock.min(row.timestamp)}`
    : j?.id
      ? `#${j.id}${j.attempt ? ` · attempt ${j.attempt}/${j.maxAttempts || '?'}` : ''}`
      : ''
  return (
    <td className="jb-c-last">
      <span className="jb-last">
        <T value={row.timestamp} text={clock.sec(row.timestamp)} />
        <span className="jb-last__hint">{row.error?.hint || row.message}</span>
        {sub ? <span className="cell-sub">{sub}</span> : null}
      </span>
    </td>
  )
}

/** Rebalance length: from consumer.rebalancing to the next consumer.joined of the same queue. */
function rebalanceMs(lines: LogRow[]): number | null {
  const asc = [...lines].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const i = asc.findIndex((r) => r.eventCode === 'consumer.rebalancing')
  if (i < 0) return null
  const j = asc.slice(i + 1).find((r) => r.eventCode === 'consumer.joined')
  return j ? Date.parse(j.timestamp) - Date.parse(asc[i].timestamp) : null
}

export function QueueTable(p: QueueTableProps) {
  const { groups, finals, redelivered, consumerEvents, featured, deps, keep, order, clock } = p
  return (
    <div className="table-wrap">
      <table className="table table--reflow jb-table" id="jobs-table">
        <caption className="sr-only">
          Queue, topic และ cron ของ {p.env ?? 'ทุก env'} {inRange(p.rangeLabel)} แยกตามระบบ queue
        </caption>
        <thead>
          <tr>
            <th scope="col" className="col-tight">
              <span className="sr-only">ขยาย</span>
            </th>
            <th scope="col">Queue / topic · job type</th>
            <th scope="col" className="num" title="บรรทัด job.started นับทุก attempt">
              เริ่ม
            </th>
            <th scope="col" className="num">
              สำเร็จ
            </th>
            <th scope="col" className="num">
              Retry
            </th>
            <th scope="col" className="num">
              ล้มเหลว
            </th>
            <th scope="col">ผลลัพธ์</th>
            <th scope="col" className="num">
              p95
            </th>
            <th scope="col">ล้มเหลวล่าสุด</th>
            <th scope="col">เหตุการณ์</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.module} data-src={g.module}>
            <tr className="jb-group">
              <th scope="rowgroup" colSpan={10}>
                <span className="jb-group__in">
                  <Tag>{moduleLabel(g.module)}</Tag>
                  {g.owners.map((o) => (
                    <ServiceChip key={`${o.service}/${o.role}`} service={o.service} role={o.role} order={order} />
                  ))}
                  <span>{groupWhere(g, deps)}</span>
                </span>
              </th>
            </tr>
            {g.stats.map((s) => {
              const key = jobKey(s)
              const fails = finals.get(key) ?? []
              const last = fails[0]
              const isFeatured = !!featured && jobKey(featured) === key && featured.service === s.service && featured.role === s.role
              const cronLike = isCronLike(s.module)
              const consumer = consumerEvents.filter((r) => r.job?.queue === s.queue && r.service === s.service && r.role === s.role)
              const redeliv = redelivered.get(key) ?? []
              const schedule = cronLike ? cronEvery(s.started, p.rangeMs) : null

              // events column
              const evs: ReactNode[] = []
              if (isFeatured) {
                evs.push(
                  <a key="list" className="small" href="#failures">
                    ดูรายการ {fmtCount(s.retried + s.failed)} บรรทัด
                  </a>,
                )
              } else if (s.failed > 0 && s.retried === 0 && last?.job?.maxAttempts === 1) {
                evs.push(
                  <span key="att" className="jb-ev">
                    ตั้ง attempts = 1 จึงไม่ retry
                  </span>,
                )
              }
              if (s.module === 'rabbitmq' && s.retried > 0) {
                evs.push(
                  <span key="rd" className="jb-ev">
                    <LevelBadge level="warn" />
                    redelivered {fmtCount(s.retried)} ครั้ง
                  </span>,
                )
              }
              const ce = consumer.find((r) => r.level !== 'info' && r.level !== 'debug') ?? consumer[0]
              if (ce) {
                evs.push(
                  <span key="ce" className="jb-ev">
                    <LevelBadge level={ce.level} />
                    {consumerEventLabel(ce)} <T value={ce.timestamp} text={clock.min(ce.timestamp)} />
                  </span>,
                )
              }
              if (cronLike && s.lastRunAt) {
                const failedLast = !!s.lastFailedAt && s.lastFailedAt >= s.lastRunAt
                evs.push(
                  <StateChip key="run" state={failedLast ? 'down' : 'ok'}>
                    ล่าสุด {clock.min(s.lastRunAt)} {failedLast ? 'ล้มเหลว' : 'สำเร็จ'}
                  </StateChip>,
                )
              }

              // expanded lines
              const parts: ReactNode[] = []
              if (fails.length && !isFeatured) {
                const note = cronLike
                  ? `cron ไม่ retry เอง${s.lastRunAt && s.lastRunAt > fails[0].timestamp ? ` · รอบล่าสุด ${clock.min(s.lastRunAt)} สำเร็จ` : ''}`
                  : fails[0].job?.final
                    ? fails[0].job.maxAttempts === 1
                      ? 'job_final = 1 · job นี้ตั้ง attempts ไว้ 1 จึงไม่ได้ retry'
                      : `job_final = 1 · ครบ ${fails[0].job.attempt}/${fails[0].job.maxAttempts} attempt แล้ว`
                    : undefined
                parts.push(
                  <div key="fails" className="err-list">
                    {fails.slice(0, 3).map((r, i) => (
                      <LogErrorRow key={`${r.timestamp}-${i}`} row={r} keep={keep} order={order} note={i === 0 ? note : undefined} />
                    ))}
                  </div>,
                )
              }
              if (consumer.length) {
                const rb = rebalanceMs(consumer)
                parts.push(
                  <div key="consumer" className="jb-detail">
                    <LinesTable
                      caption={`บรรทัด consumer.* ของ ${s.queue}`}
                      clock={clock}
                      lines={consumer.map((row) => {
                        const partitions = partitionsOf(row)
                        return { row, kvs: [{ k: 'job', v: row.job?.queue || s.queue }, ...(partitions ? [{ k: 'partitions', v: partitions }] : [])] }
                      })}
                    />
                    {rb !== null ? (
                      <p className="hint">
                        rebalance ใช้ {fmtDuration(rb)} ระหว่างนั้น consumer หยุดอ่านชั่วคราว
                        {s.failed === 0 ? ' ไม่มี message ที่ล้มเหลว (failed 0)' : ` · ล้มเหลว ${fmtCount(s.failed)} message`}
                      </p>
                    ) : null}
                  </div>,
                )
              }
              if (redeliv.length) {
                parts.push(
                  <div key="redeliv" className="jb-detail">
                    <LinesTable
                      caption={`บรรทัด job.redelivered ของ ${s.queue}`}
                      clock={clock}
                      lines={redeliv.map((row) => ({ row, kvs: [{ k: 'job', v: row.job?.queue || s.queue }, ...(row.job?.id ? [{ k: 'id', v: row.job.id }] : [])] }))}
                    />
                    <p className="hint">
                      broker ส่ง message ซ้ำเพราะรอบแรกไม่ได้ ack
                      {s.failed === 0 ? ` ทั้ง ${fmtCount(redeliv.length)} ครั้งสำเร็จในรอบที่สอง (failed 0)` : ` · ล้มเหลว ${fmtCount(s.failed)} message`}
                    </p>
                  </div>,
                )
              }

              const retryCell = cronLike ? (
                <td className="jb-c-rt num t-muted" data-label="retry">
                  –
                </td>
              ) : s.module === 'rabbitmq' && s.retried > 0 ? (
                <td className="jb-c-rt num" data-label="retry">
                  <span className="t-warn">{fmtCount(s.retried)}</span>
                  <span className="cell-sub">redeliver</span>
                </td>
              ) : (
                <td className={`jb-c-rt num ${s.retried > 0 ? 't-warn' : 't-muted'}`} data-label="retry">
                  {fmtCount(s.retried)}
                </td>
              )
              const cells = (
                <>
                  <td className="jb-c-name">
                    <span className="jb-q">
                      <span className="queue-name">{cronLike ? s.type : s.queue}</span>
                      {cronLike ? (
                        <span className="queue-sub" title={schedule ? 'ประมาณจากจำนวนรอบในช่วงนี้ (library ไม่ได้ log cron expression)' : undefined}>
                          {schedule ?? (s.lastRunAt ? `รอบล่าสุด ${clock.min(s.lastRunAt)}` : s.queue)}
                        </span>
                      ) : s.type ? (
                        <span className="queue-sub mono">{s.type}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="jb-c-st num" data-label="เริ่ม">
                    {fmtCount(s.started)}
                  </td>
                  <td className="jb-c-fin num" data-label="สำเร็จ">
                    {fmtCount(s.finished)}
                    {startedBefore(s) ? <span className="cell-sub">{beforeText(s, startedBefore(s))}</span> : null}
                  </td>
                  {retryCell}
                  <td className={`jb-c-fl num ${s.failed > 0 ? 't-danger' : 't-muted'}`} data-label="ล้มเหลว">
                    {fmtCount(s.failed)}
                  </td>
                  <td className="jb-c-out">
                    <OutcomeBar s={s} />
                  </td>
                  <td className={s.p95Ms ? 'jb-c-p95 num' : 'jb-c-p95 num t-muted'} data-label="p95">
                    {s.p95Ms ? fmtDuration(s.p95Ms) : '–'}
                  </td>
                  <LastFailure s={s} row={last} clock={clock} />
                  {evs.length ? (
                    <td className="jb-c-ev">
                      <span className="jb-evs">{evs}</span>
                    </td>
                  ) : (
                    <td className="jb-c-ev t-muted">–</td>
                  )}
                </>
              )
              const rowKey = `${s.service}/${s.role}/${key}`
              return parts.length ? (
                <ExpandRow
                  key={rowKey}
                  label={`ขยาย ${statName(s)}`}
                  colSpan={9}
                  toggleCellClassName="jb-c-tog"
                  cells={cells}
                  detail={<div className="jb-detail">{parts}</div>}
                />
              ) : (
                <tr key={rowKey}>
                  <td className="jb-c-tog" />
                  {cells}
                </tr>
              )
            })}
          </tbody>
        ))}
      </table>
    </div>
  )
}
