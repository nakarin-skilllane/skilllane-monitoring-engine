/**
 * The log table (logs.html `.lg-table`): newest first, every row opens the drawer (`?drawer=<line id>`),
 * error rows expand to ต้องแก้อะไร / error จริง / trace + user. Rows enter with the live highlight
 * (LiveTbody; resetKey = the filters, so new filters do not mark every row as new).
 */
import Link from 'next/link'
import { CategoryChip, LevelBadge, NewBadge, ServiceChip, Tag, Ts } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { DrawerLink } from '@/components/Drawer'
import { ActualError, ErrorDetailText, IdChip, KvList } from '@/components/ErrorParts'
import { LiveTbody } from '@/components/Motion'
import { fmtDuration, fmtTimeMs, fmtTimeSec } from '@/lib/format'
import { buildHref, depAnchor, type Keep } from '@/lib/params'
import { LEVEL_SHORT, logDetail, logTitle } from '@/lib/readable'
import type { LogRow } from '@/lib/types'
import { actualText, durationText, hasErrorDetail, isHintLine, jobContext, lineKvs, moduleLabel, type Outage, outageOf, prettyText } from '../_lib/lines'
import { LogLine } from './LogLine'

export interface Line {
  id: string
  row: LogRow
}

/** `เกิดนอก request: ไม่มี trace · down 45.2 s ถึง 13:43:20` of a dependency.* line (logs.html). */
function outageText(row: LogRow, outages: readonly Outage[]): string {
  const o = outageOf(row, outages)
  const where = row.traceId ? '' : 'เกิดนอก request: ไม่มี trace'
  const down = o ? (o.to === null ? `down ตั้งแต่ ${fmtTimeSec(o.from)} ยังไม่กลับมา` : `down ${fmtDuration(o.to - o.from)} ถึง ${fmtTimeSec(o.to)}`) : ''
  return [where, down].filter(Boolean).join(' · ')
}

function Detail({
  id,
  row,
  keep,
  order,
  context,
  depHref,
  cause,
}: {
  id: string
  row: LogRow
  keep: Keep
  order: readonly string[]
  context: string
  depHref?: string
  /** A failed http.request line: the error line of the same request on this page (its fix and error are shown). */
  cause?: Line
}) {
  const who = [row.userRoles.join(', '), row.organizationId].filter(Boolean).join(' · ')
  const src = cause?.row ?? row
  return (
    <div className="row-detail__body">
      {cause ? (
        <p className="err-row__detail">
          <span className="err-row__detail-label">error ของ request นี้</span>
          <DrawerLink value={cause.id}>{logTitle(cause.row).title}</DrawerLink>
          {cause.row.error?.category ? (
            <>
              {' '}
              <CategoryChip category={cause.row.error.category} />
            </>
          ) : null}
          <span className="t-muted"> · บรรทัด {fmtTimeMs(cause.row.timestamp)}</span>
        </p>
      ) : null}
      <ErrorDetailText text={logDetail(src)} />
      <ActualError text={actualText(src)} />
      <div className="err-row__meta">
        <ServiceChip service={row.service} role={row.role} order={order} />
        {row.traceId ? <IdChip label="trace" value={row.traceId} href={buildHref(`/traces/${row.traceId}`, keep)} /> : null}
        {context ? <span>{context}</span> : null}
        {row.userId ? <IdChip label="user" value={row.userId} href={buildHref('/logs', keep, { userId: row.userId })} copy={false} /> : null}
        {who ? <span>{who}</span> : null}
        {row.usecase ? (
          <span>
            usecase <span className="mono">{row.usecase}</span>
          </span>
        ) : null}
        <span className="row-detail__actions lg-acts">
          {depHref ? (
            <Link className="btn btn--sm" href={depHref}>
              ดูสถานะ dependency
            </Link>
          ) : null}
          <DrawerLink value={id} className={depHref ? 'btn btn--sm btn--quiet' : 'btn btn--sm'}>
            เปิดรายละเอียด
          </DrawerLink>
          {src.fingerprint ? (
            <Link className="btn btn--sm btn--quiet" href={buildHref(`/errors/${src.fingerprint}`, keep)}>
              ดู error group
            </Link>
          ) : null}
          <CopyButton text={prettyText(row)} label="คัดลอกแบบ terminal" variant="quiet" size="sm" />
        </span>
      </div>
    </div>
  )
}

export function LogTable({
  lines,
  order,
  keep,
  newFingerprints,
  selected,
  resetKey,
  caption,
  outages = [],
  withDate = false,
}: {
  lines: Line[]
  order: readonly string[]
  keep: Keep
  newFingerprints: ReadonlySet<string>
  /** Line id of the open drawer. */
  selected?: string
  resetKey: string
  caption: string
  /** Dependency outages of the range (the expanded dependency.* rows say how long it was down). */
  outages?: readonly Outage[]
  /** The range spans more than one day (ICT): row times carry the date. */
  withDate?: boolean
}) {
  const rows = lines.map((l) => l.row)
  // a failed http.request line (5xx, no error group): the error line of the same trace + service on this page
  const causeOf = (row: LogRow): Line | undefined => {
    if (row.eventCode !== 'http.request' || row.fingerprint || !row.traceId || (row.level !== 'error' && row.level !== 'fatal')) return undefined
    const same = lines.filter((l) => l.row.traceId === row.traceId && l.row.fingerprint && l.row.eventCode !== 'http.request' && l.row.service === row.service && l.row.role === row.role)
    return same.find((l) => l.row.level === 'error' || l.row.level === 'fatal') ?? same[0]
  }
  return (
    <div className="table-wrap">
      <table className="table table--dense table--reflow lg-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="col-tight">
              <span className="sr-only">ขยาย</span>
            </th>
            <th scope="col" className="col-tight" aria-sort="descending">
              เวลา
            </th>
            <th scope="col" className="col-tight">
              Level
            </th>
            <th scope="col" className="col-tight">
              Service / role
            </th>
            <th scope="col">
              ข้อความ <span className="t-muted lg-th-sub">· หัวข้อ แล้ว key=value</span>
            </th>
            <th scope="col" className="num">
              เวลาที่ใช้
            </th>
          </tr>
        </thead>
        <LiveTbody resetKey={resetKey}>
          {lines.map(({ id, row }) => {
            const { prefix, title } = logTitle(row)
            const short = (LEVEL_SHORT[row.level] ?? row.level.slice(0, 3)).toLowerCase()
            const mod = moduleLabel(row)
            const dur = durationText(row)
            const isDep = !!row.dependency && row.eventCode.startsWith('dependency.')
            const context = row.job ? jobContext(row, rows) : isDep ? outageText(row, outages) : ''
            const depHref = isDep ? `${buildHref('/jobs', keep)}#${depAnchor(row.dependency!.name || row.dependency!.type)}` : undefined
            const cause = causeOf(row)
            return (
              <LogLine
                key={id}
                rowKey={id}
                className={`lg-row--${short}${isHintLine(row) ? ' lg-row--hint' : ''}`}
                current={selected === id}
                toggleLabel={`ขยาย ${title} ${fmtTimeMs(row.timestamp)}`}
                colSpan={5}
                detail={hasErrorDetail(row) || cause ? <Detail id={id} row={row} keep={keep} order={order} context={context} depHref={depHref} cause={cause} /> : undefined}
                cells={
                  <>
                    <td className="lg-time">
                      <Ts value={row.timestamp} format={withDate ? 'date-ms' : 'ms'} />
                    </td>
                    <td className="lg-lvl">
                      <LevelBadge level={row.level} />
                    </td>
                    <td className="lg-svc">
                      <ServiceChip service={row.service} role={row.role} order={order} />
                    </td>
                    <td className="lg-msgcell">
                      <div className="lg-msg">
                        {prefix ? <span className="lg-src">{prefix}</span> : null}
                        <DrawerLink value={id} className="lg-title">
                          {title}
                        </DrawerLink>
                        {row.error?.category ? <CategoryChip category={row.error.category} /> : null}
                        {row.fingerprint && newFingerprints.has(row.fingerprint) ? <NewBadge /> : null}
                        {mod ? <Tag>{mod}</Tag> : null}
                        <KvList items={lineKvs(row)} />
                      </div>
                    </td>
                    <td className="num lg-dur">{dur || <span className="t-muted">–</span>}</td>
                  </>
                }
              />
            )
          })}
        </LiveTbody>
      </table>
    </div>
  )
}
