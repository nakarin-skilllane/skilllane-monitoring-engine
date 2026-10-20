/**
 * Page header (DESIGN.md §5): crumbs "skilllane monitor / <screen>", h1, one-line subline
 * "<question> · <env> · <range>", optional meta row under the title, actions on the
 * right (copy-link first, then your buttons; one primary at most).
 *
 *   <PageHead scope={scope} title="Log" question="ทุกบรรทัด log ตามเวลา: …"
 *     actions={<><AutoRefresh /><Link className="btn" href=…>เปิด Trace</Link></>} />
 *   Detail: crumbs={[{ label: 'Trace', href: buildHref('/traces', scope.keep) }, { label: shortId(id), mono: true, title: id }]}
 *           when={<><Ts value={start} format="date-ms" /> ICT</>}
 */
import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { buildHref, rangeText, SCREENS, type Scope } from '@/lib/params'
import { EnvTag } from './badges'
import { CopyLinkButton } from './CopyButton'
import { PRODUCT_NAME } from './shell/names'

export interface Crumb {
  label: ReactNode
  href?: string
  mono?: boolean
  /** Full value when the label is shortened. */
  title?: string
}

export interface PageHeadProps {
  scope: Scope
  title: ReactNode
  /** First part of the subline: the question the screen answers, in one sentence. */
  question?: ReactNode
  /** Replaces the range part of the subline (detail pages: the event time). */
  when?: ReactNode
  /** Crumbs after the product name; default = the screen label. */
  crumbs?: Crumb[]
  /** `.page-head__meta` row under the title (ids, level, code, service). */
  meta?: ReactNode
  /** Extra class on the meta row (trace detail `td-meta`: wider gaps between groups). */
  metaClassName?: string
  /** Meta row between the title and the subline (error-detail mockups). */
  metaFirst?: boolean
  /** Buttons after the copy-link button. */
  actions?: ReactNode
  /** Show "คัดลอกลิงก์" (default true). */
  copyLink?: boolean
}

export function PageHead({ scope, title, question, when, crumbs, meta, metaClassName, metaFirst, actions, copyLink = true }: PageHeadProps) {
  const trail = crumbs ?? [{ label: SCREENS[scope.screen].label }]
  const metaCls = metaClassName ? `page-head__meta ${metaClassName}` : 'page-head__meta'
  return (
    <header className="page-head">
      <div className="page-head__text">
        <nav className="crumbs" aria-label="ตำแหน่ง">
          {/* no prefetch (see NavLinks): shell links on every page */}
          <Link href={buildHref('/overview', scope.keep)} prefetch={false}>
            {PRODUCT_NAME}
          </Link>
          {trail.map((c, i) => (
            <Fragment key={i}>
              <span className="crumbs__sep" aria-hidden="true">
                /
              </span>
              {c.href ? (
                <Link href={c.href} className={c.mono ? 'mono' : undefined} title={c.title} prefetch={false}>
                  {c.label}
                </Link>
              ) : (
                <span className={c.mono ? 'mono' : undefined} title={c.title} aria-current="page">
                  {c.label}
                </span>
              )}
            </Fragment>
          ))}
        </nav>
        <h1 className="page-title">{title}</h1>
        {meta && metaFirst ? <div className={metaCls}>{meta}</div> : null}
        <p className={meta && metaFirst ? 'page-sub mt-2' : 'page-sub'}>
          {question ? <>{question} · </> : null}
          <EnvTag env={scope.env} /> · {when ?? rangeText(scope)}
        </p>
        {meta && !metaFirst ? <div className={metaCls}>{meta}</div> : null}
      </div>
      {copyLink || actions ? (
        <div className="page-actions">
          {copyLink ? <CopyLinkButton /> : null}
          {actions}
        </div>
      ) : null}
    </header>
  )
}
