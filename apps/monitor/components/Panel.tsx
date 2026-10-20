/**
 * Layout blocks (DESIGN.md §4): Section (h2 + meta + actions, 32 px apart) and Panel
 * (flat surface with hairline border; never nested, never every block). `flush` drops
 * the body padding (a table or list sits edge to edge).
 *
 *   <Section id="ov-routes" title="Route" meta="8 route ที่มี request มากสุด" actions={…}>…</Section>
 *   <Panel title="Dependency" meta="สถานะล่าสุด" actions={<Link className="btn btn--sm btn--quiet" …>ดูประวัติ</Link>} flush>…</Panel>
 */
import type { ReactNode } from 'react'

export function Section({
  id,
  title,
  meta,
  actions,
  children,
  className,
}: {
  /** Used for the heading id (`${id}-t`) and as the anchor. */
  id?: string
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  const headingId = id ? `${id}-t` : undefined
  return (
    <section id={id} className={className ? `section ${className}` : 'section'} aria-labelledby={headingId}>
      <div className="section__head">
        <h2 className="section__title" id={headingId}>
          {title}
        </h2>
        {meta ? <span className="section__meta">{meta}</span> : null}
        {actions ? <div className="section__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function Panel({
  title,
  meta,
  actions,
  foot,
  flush,
  children,
  className,
  id,
  as: Tag = 'div',
}: {
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  foot?: ReactNode
  /** Children sit directly in the panel (tables, lists) instead of a padded body. */
  flush?: boolean
  children?: ReactNode
  className?: string
  id?: string
  as?: 'div' | 'section' | 'article'
}) {
  return (
    <Tag id={id} className={className ? `panel ${className}` : 'panel'}>
      {title || meta || actions ? (
        <div className="panel__head">
          {title ? <h3 className="panel__title">{title}</h3> : null}
          {meta ? <span className="panel__meta">{meta}</span> : null}
          {actions ? <div className="panel__actions">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className="panel__body">{children}</div>}
      {foot ? <div className="panel__foot">{foot}</div> : null}
    </Tag>
  )
}
