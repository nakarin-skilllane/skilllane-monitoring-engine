/**
 * Empty, error and loading states (DESIGN.md §5 "Empty state": say why it is empty and
 * what to change). The engine being down is a normal state of this app: pages render
 * <EngineErrorState error={res.error} /> (Thai, names the engine URL), never a Next error page.
 * Not found (an unknown id, a 404 from the engine): <NotFoundState> with links back that keep env / from / to,
 * the same on every screen (app/not-found.tsx, error / trace detail).
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { EngineError } from '@/lib/engine'
import type { ClientEngineError } from '@/lib/engine-client'
import { buildHref, keepOf, type ParamProblem } from '@/lib/params'
import { Icon, type IconName } from './icons'
import { RetryButton } from './RetryButton'

export function EmptyState({ title, text, icon = 'panel', actions, className }: { title: ReactNode; text?: ReactNode; icon?: IconName; actions?: ReactNode; className?: string }) {
  return (
    <div className={className ? `empty ${className}` : 'empty'}>
      <Icon name={icon} className="empty__icon" />
      <p className="empty__title">{title}</p>
      {text ? <p className="empty__text">{text}</p> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  )
}

function describe(error: EngineError | ClientEngineError): { title: string; text: ReactNode } {
  const base = 'engineUrl' in error ? error.engineUrl : '/engine (ENGINE_URL)'
  const url = <code className="code-inline">{base}</code>
  switch (error.kind) {
    case 'unreachable':
      return {
        title: 'ติดต่อ engine ไม่ได้',
        text: (
          <>
            หน้านี้อ่านข้อมูลจาก skilllane-monitoring engine ที่ {url} แต่เชื่อมต่อไม่ได้ ({error.message}) · เปิด engine ก่อน (<code className="code-inline">scripts/live.sh start</code>) แล้วกดลองใหม่
          </>
        ),
      }
    case 'timeout':
      return { title: 'engine ตอบช้าเกินไป', text: <>skilllane-monitoring engine ที่ {url} ไม่ตอบภายใน 8 วินาที · ลองช่วงเวลาที่สั้นลง หรือดูว่า ClickHouse ทำงานหนักอยู่หรือไม่</> }
    case 'invalid':
      return { title: 'อ่านคำตอบของ engine ไม่ได้', text: <>skilllane-monitoring engine ที่ {url} ตอบกลับมาแต่ไม่ใช่ JSON ({error.message})</> }
    default:
      if (error.status === 400) return { title: 'ค่าที่ส่งไป engine ไม่ถูกต้อง', text: <>engine บอกว่า: <span className="code-inline">{error.message}</span> · แก้ตัวกรองหรือช่วงเวลาแล้วลองใหม่</> }
      // the engine's English message stays in the hint's title (GET … line), not in the Thai text
      if (error.status === 404) return { title: 'ไม่พบข้อมูลนี้', text: <>engine ไม่มีข้อมูลนี้ในช่วงที่เก็บไว้ · ลิงก์อาจเก่าหรือพิมพ์ผิด</> }
      if (error.status === 401) return { title: 'ต้องเข้าสู่ระบบใหม่', text: <>session หมดอายุหรือถูกยกเลิก · <a href="/login">เข้าสู่ระบบ</a></> }
      if (error.status === 403) return { title: 'ไม่มีสิทธิ์ดูส่วนนี้', text: <>{error.message} · ขอสิทธิ์เพิ่มจากผู้ดูแลระบบ</> }
      return { title: `engine ตอบกลับด้วยข้อผิดพลาด ${error.status ?? ''}`.trim(), text: <>skilllane-monitoring engine ที่ {url}: {error.message} · มักเกิดเมื่อ ClickHouse ติดต่อไม่ได้</> }
  }
}

/** A 404 of a detail call (`/api/errors/<fp>`, `/engine/traces/<id>`): back to its list, keeping the call's env / from / to. */
const LIST_OF: Record<string, { path: string; label: string }> = {
  errors: { path: '/errors', label: 'กลับไปที่รายการ error' },
  traces: { path: '/traces', label: 'กลับไปที่รายการ trace' },
}
function backLink(path: string): ReactNode {
  const m = /^\/(?:api|engine)\/(errors|traces)\/[^/?]+(\?.*)?$/.exec(path)
  if (!m) return null
  const list = LIST_OF[m[1]]
  return (
    <Link className="btn btn--sm btn--primary" href={buildHref(list.path, keepOf(new URLSearchParams(m[2] ?? '')))} prefetch={false}>
      {list.label}
    </Link>
  )
}

/**
 * Friendly panel for a failed engine call: what happened, where, how to fix, retry.
 * `onRetry`: a client component that fetched the block itself passes its refetch (a router refresh would not
 * re-run it). `actions`: links shown first (e.g. back to the list on a 404; without them a 404 of an error group
 * or a trace links back to its list).
 */
export function EngineErrorState({
  error,
  inPanel = true,
  onRetry,
  actions,
}: {
  error: EngineError | ClientEngineError
  inPanel?: boolean
  onRetry?: () => void | Promise<void>
  actions?: ReactNode
}) {
  const { title, text } = describe(error)
  const body = (
    <EmptyState
      icon={error.kind === 'http' && error.status === 404 ? 'search-none' : 'alert-triangle'}
      title={title}
      text={text}
      actions={
        <>
          {actions ?? (error.kind === 'http' && error.status === 404 ? backLink(error.path) : null)}
          {error.kind === 'http' && error.status !== null && error.status < 500 ? null : <RetryButton onRetry={onRetry} />}
          <span className="hint">
            <code className="code-inline" title={error.kind === 'http' ? error.message : undefined}>
              GET {error.path}
            </code>
          </span>
        </>
      }
    />
  )
  return inPanel ? (
    <div className="panel" role="alert">
      {body}
    </div>
  ) : (
    body
  )
}

export interface NotFoundLink {
  href: string
  label: string
}

/**
 * One not-found state for every screen: Thai title + why + links back (the first one primary). Build the hrefs
 * with buildHref(path, scope.keep) so env / from / to stay. Use it for an unknown page, error group or trace
 * (and call notFound() in the route so the answer is a 404).
 *
 *   <NotFoundState title="ไม่พบ error group นี้" text="…" links={[{ href: buildHref('/errors', keep), label: 'กลับไปที่รายการ error' }]} />
 */
export function NotFoundState({
  title = 'ไม่พบหน้านี้',
  text = 'ลิงก์อาจพิมพ์ผิด เก่าเกินช่วงที่เก็บข้อมูลไว้ หรือหน้านี้ถูกย้าย',
  links,
  heading = false,
}: {
  title?: string
  text?: ReactNode
  links: NotFoundLink[]
  /** Render the title as the page's h1 (a page with no page head, e.g. app/not-found.tsx). */
  heading?: boolean
}) {
  return (
    <div className="panel">
      <div className="empty">
        <Icon name="search-none" className="empty__icon" />
        {heading ? <h1 className="empty__title">{title}</h1> : <p className="empty__title">{title}</p>}
        <p className="empty__text">{text}</p>
        <div className="empty__actions">
          {links.map((l, i) => (
            <Link key={l.href + i} className={i === 0 ? 'btn btn--sm btn--primary' : 'btn btn--sm'} href={l.href} prefetch={false}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Callout listing URL params that were invalid and replaced by defaults. Renders nothing when there are none. */
export function ParamProblems({ problems }: { problems: ParamProblem[] }) {
  if (!problems.length) return null
  return (
    <div className="callouts ui-problems">
      <div className="callout callout--warn" role="status">
        <Icon name="alert-triangle" className="callout__icon" />
        <p className="callout__title">ค่าใน URL บางตัวใช้ไม่ได้ จึงใช้ค่าเริ่มต้นแทน</p>
        <p className="callout__text">
          {problems.map((p, i) => (
            <span key={p.name + i}>
              {i ? ' · ' : null}
              {p.message} (<code className="code-inline">{p.value}</code>)
            </span>
          ))}
        </p>
      </div>
    </div>
  )
}

export type SkeletonVariant = 'title' | 'text' | 'short' | 'kpi' | 'chart' | 'row'

/**
 * The design's `.skel` block (shimmers while motion is on); width/height in CSS units. `variant` uses the
 * design's sizes (`.skel--title|text|short|kpi|chart|row`); width/height then only override them.
 */
export function Skeleton({ width, height, variant, className }: { width?: number | string; height?: number | string; variant?: SkeletonVariant; className?: string }) {
  const cls = ['skel', variant ? `skel--${variant}` : '', className ?? ''].filter(Boolean).join(' ')
  const style = variant ? { width, height } : { width: width ?? '100%', height: height ?? 12 }
  return <span className={cls} style={style} aria-hidden="true" />
}

/** Lines of text placeholder. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ui-skel-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  )
}

/** KPI strip placeholder. */
export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="kpis" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="kpi" key={i}>
          <Skeleton width="50%" height={12} />
          <Skeleton width="40%" height={26} />
          <Skeleton width="70%" height={10} />
        </div>
      ))}
    </div>
  )
}

/** Table placeholder inside a panel. */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="ui-skel-table" aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div className="ui-skel-table__row" key={r} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? '80%' : '60%'} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Whole-page placeholder (app/loading.tsx): page head, KPI strip, one panel. */
export function PageSkeleton() {
  return (
    <div className="ui-page-skel" role="status" aria-label="กำลังโหลด">
      <div className="page-head">
        <div className="page-head__text">
          <Skeleton width={160} height={12} />
          <Skeleton width={220} height={24} />
          <Skeleton width="min(520px, 90%)" height={14} />
        </div>
      </div>
      <KpiSkeleton />
      <div className="panel mt-6">
        <TableSkeleton />
      </div>
      <span className="sr-only">กำลังโหลด…</span>
    </div>
  )
}
