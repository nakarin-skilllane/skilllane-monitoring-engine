/**
 * The Timeline view of a trace (trace-detail.html `.td-tl`): the rows of `buildTimeline` (app/traces/_lib/timeline.ts)
 * top to bottom, the summary line above and the legend below. A row of a span picks it like the waterfall does
 * (its button: click or Enter); both edge rows of a span light up while it is selected.
 */
import Link from 'next/link'
import { type CSSProperties, Fragment } from 'react'
import { ActualError, ErrorDetailText } from '@/components/ErrorParts'
import { HttpStatus, LevelBadge, ServiceChip } from '@/components/badges'
import { fmtMs, fmtNumber, shortId } from '@/lib/format'
import { svcColor } from '@/lib/services'
import type { Timeline, TlPart, TlRow } from '../../_lib/timeline'

export function TraceTimeline({
  tl,
  traceId,
  order,
  selId,
  withIo,
  onPick,
}: {
  tl: Timeline
  traceId: string
  order: string[]
  /** The selected span (`?span=`); a hidden wrapper selects the row of its nearest shown ancestor. */
  selId: string
  /** Spans with an I/O panel (their buttons control it too). */
  withIo: (spanId: string) => boolean
  onPick: (spanId: string) => void
}) {
  const sum = tl.summary
  const sel = tl.alias[selId] ?? selId
  const events = tl.rows.filter((r) => r.type !== 'gap').length
  const rootColor = svcColor(tl.rows.find((r) => r.first)?.service ?? '', order)

  const part = (r: TlRow, p: TlPart, i: number) => {
    switch (p.t) {
      case 'verb':
        return (
          <span key={i} className="td-tl__verb">
            {p.text}
          </span>
        )
      case 'pick':
        return (
          <button
            key={i}
            className={p.verb ? 'td-pick td-tl__verb' : 'td-pick td-tl__name'}
            type="button"
            id={r.first ? `tl-pick-${r.spanId}` : undefined}
            aria-controls={r.spanId && withIo(r.spanId) ? 'span-detail nw-panel' : 'span-detail'}
            aria-current={r.spanId === sel ? 'true' : undefined}
            onClick={() => r.spanId && onPick(r.spanId)}
          >
            {p.text}
          </button>
        )
      case 'name':
        return (
          <span key={i} className="td-tl__name">
            {p.text}
          </span>
        )
      case 'svc':
        return <ServiceChip key={i} service={p.service} role={p.role} order={order} />
      case 'log':
        return (
          <a key={i} className={p.name ? 'td-tl__name' : undefined} href={`#${p.anchor}`}>
            {p.text}
            {p.mono ? <span className="mono">{p.mono}</span> : null}
          </a>
        )
      case 'link':
        return (
          <Link key={i} href={p.href}>
            {p.text}
          </Link>
        )
      case 'lvl':
        return <LevelBadge key={i} level={p.level} />
      case 'status':
        return <HttpStatus key={i} status={p.status} />
      case 'kv':
        return (
          <span key={i} className="kv">
            <span className="kv__k">{p.k}</span>
            <span className="kv__v">{p.v}</span>
          </span>
        )
      case 'flag':
        return (
          <span key={i} className="td-tl__flag">
            {p.text}
          </span>
        )
      case 'danger':
        return (
          <span key={i} className="t-danger">
            {p.text}
          </span>
        )
      case 'text':
        return (
          <span key={i}>
            {p.text}
            {p.mono ? <span className="mono">{p.mono}</span> : null}
          </span>
        )
      case 'user':
        return (
          <span key={i} className="idchip">
            <span className="idchip__k">user</span>
            <Link href={p.href}>{p.id}</Link>
          </span>
        )
    }
  }

  return (
    <div className="panel">
      <p className="td-tl-sum">
        ใช้เวลา <b>{fmtMs(sum.total)}</b>
        {sum.hop ? (
          <>
            {' '}
            · <b>{fmtNumber(sum.hop.pct, 0)} %</b> อยู่ใน <ServiceChip service={sum.hop.service} role={sum.hop.role} order={order} />
            {sum.hop.slowest ? (
              <>
                {' '}
                (<span className="mono">{sum.hop.slowest.name}</span> {fmtMs(sum.hop.slowest.ms)} ช้าที่สุด)
              </>
            ) : null}
          </>
        ) : sum.slowest ? (
          <>
            {' '}
            · <b>{fmtNumber(sum.slowest.pct, 0)} %</b> อยู่ที่ <span className="mono">{sum.slowest.name}</span> (ช้าที่สุด)
          </>
        ) : null}
        {sum.failed ? (
          <>
            {' '}
            ·{' '}
            <span className={sum.recovered ? undefined : 't-danger'}>
              พังที่ <span className="mono">{sum.failed.name}</span> +{fmtMs(sum.failed.off)}
            </span>
            {sum.ending ? ` แล้ว${sum.ending}` : null}
          </>
        ) : sum.ending ? (
          ` · ${sum.ending}`
        ) : null}
      </p>
      <ol className="td-tl" aria-label={`Timeline ของ trace ${shortId(traceId)}: ${events} เหตุการณ์ตามลำดับเวลา`}>
        {tl.rows.map((r) => {
          const cls = [
            'td-tl__row',
            r.remote ? 'td-tl__row--remote' : '',
            r.type === 'edge' ? 'td-tl__row--edge' : '',
            r.type === 'log' ? 'td-tl__row--log' : '',
            r.type === 'gap' ? 'td-tl__row--gap' : '',
            r.tone ? `td-tl__row--${r.tone}` : '',
            r.error ? 'td-tl__row--error' : '',
            r.spanId && r.spanId === sel ? 'is-selected' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <li key={r.key} className={cls} style={{ '--c': svcColor(r.service, order) } as CSSProperties} data-span={r.spanId ?? undefined} aria-hidden={r.type === 'gap' ? true : undefined}>
              <span className="td-tl__off">{r.off === null ? '' : `${r.off < 0 ? '−' : '+'}${fmtMs(Math.abs(r.off))}`}</span>
              <span className="td-tl__node" />
              <div className="td-tl__main">
                {r.type === 'gap' ? (
                  <span className="td-tl__gap">{r.gap}</span>
                ) : (
                  <>
                    <div className="td-tl__title">{r.title.map((p, i) => part(r, p, i))}</div>
                    {r.meta.length ? <div className="td-tl__meta">{r.meta.map((p, i) => part(r, p, i))}</div> : null}
                    {r.fix ? (
                      <div className="td-tl__fix">
                        <ErrorDetailText text={r.fix.fix} />
                        <ActualError text={r.fix.actual} />
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <span className={r.error && r.type === 'span' ? 'td-tl__dur t-danger' : 'td-tl__dur'}>{r.dur === null ? '' : fmtMs(r.dur)}</span>
              {r.bar === null ? null : (
                <span className="td-tl__bar">
                  <i className={r.error ? 'is-error' : undefined} style={{ '--w': fmtNumber(r.bar, 3) } as CSSProperties} />
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <div className="panel__foot">
        <ul className="legend">
          <li className="legend__item">
            <span className="td-key-node td-key-node--fill" style={{ '--c': rootColor } as CSSProperties} aria-hidden="true" />
            {tl.entry === 'request' ? 'request เข้า / ตอบกลับ' : tl.entry === 'job' ? 'job เริ่ม / จบ' : 'เริ่ม / จบ'}
          </li>
          <li className="legend__item">
            <span className="td-key-node" style={{ '--c': rootColor } as CSSProperties} aria-hidden="true" />
            ขั้นตอน (span)
          </li>
          <li className="legend__item">
            <span className="td-key-log" aria-hidden="true" />
            log
          </li>
          {tl.hasError ? (
            <li className="legend__item">
              <span className="td-key-node td-key-node--err" aria-hidden="true" />
              error
            </li>
          ) : null}
          {tl.remotes.map((s) => (
            <li className="legend__item" key={`${s.service}/${s.role}`}>
              <span className="td-key-rail" style={{ '--td-rail': svcColor(s.service, order) } as CSSProperties} aria-hidden="true" />
              ช่วงที่อยู่ใน {s.service}/{s.role}
            </li>
          ))}
          <li className="legend__item td-tl-note">
            <span>
              แถบขวา = เวลาที่ขั้นนั้นใช้ เทียบกับทั้ง trace
              {tl.hidden.count ? (
                <>
                  {' '}
                  · ซ่อน span ห่อของ Nest / Express (
                  {tl.hidden.labels.map((l, i) => (
                    <Fragment key={l}>
                      {i ? ', ' : ''}
                      <span className="mono">{l}</span>
                    </Fragment>
                  ))}
                  ) {tl.hidden.count} ตัว ดูได้ใน Waterfall
                </>
              ) : null}
            </span>
          </li>
        </ul>
      </div>
    </div>
  )
}
