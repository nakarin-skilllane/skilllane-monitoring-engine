'use client'

/**
 * The overview's top band and its link to the 3D system map (overview.html script block):
 * - MapLinkProvider: which node a row points at (row hover/focus → map.highlight) and which node the map
 *   points at (node hover → row `.is-linked`). It wraps the whole screen: the Dependency list sits further down.
 * - LinkedRow / LinkedItem: a `<tr>` / `<li>` carrying `data-node`; a health row also selects its service on click.
 * - OverviewTop: `.ov-top` grid (ต้องดูตอนนี้ · สุขภาพ service · แผนที่ระบบ); "ขยาย" puts the map full width at
 *   540 px with every label's numbers and opens "ดูเป็นตาราง": every node ("ระบบในแผนที่") and every call
 *   ("การเรียกระหว่างระบบ"), so each number of the map is also in a table.
 *   Phones (≤ 600 px) get "จุดที่มีปัญหา" above the box (the nodes that are not ok, worst first) and a map of those
 *   nodes and the services on their edges, with one-line labels.
 */
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { StateChip } from '@/components/badges'
import { SystemMap3D } from '@/components/SystemMap3D'
import type { MapNodeState, SystemMapData, SystemMapNode } from '@/lib/3d/system-map'
import { fmtCount } from '@/lib/format'

interface LinkState {
  /** Node a row points at (lit in the map). */
  highlight: string | null
  /** Node the map points at (its rows get .is-linked). */
  linked: string | null
  setHighlight: (id: string | null) => void
  setLinked: (id: string | null) => void
}

const LinkCtx = createContext<LinkState | null>(null)

export function MapLinkProvider({ children }: { children: ReactNode }) {
  const [highlight, setHighlight] = useState<string | null>(null)
  const [linked, setLinked] = useState<string | null>(null)
  const value = useMemo(() => ({ highlight, linked, setHighlight, setLinked }), [highlight, linked])
  return <LinkCtx.Provider value={value}>{children}</LinkCtx.Provider>
}

function useLink(node: string | undefined) {
  const ctx = useContext(LinkCtx)
  const set = ctx?.setHighlight
  const on = useCallback(() => {
    if (node && set) set(node)
  }, [node, set])
  const off = useCallback(() => set?.(null), [set])
  return {
    isLinked: !!node && ctx?.linked === node,
    handlers: node ? { onMouseEnter: on, onMouseLeave: off, onFocus: on, onBlur: off } : {},
  }
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ') || undefined

/** A table row linked to a map node; `href` = where a click on the row (not on a link inside it) goes. */
export function LinkedRow({
  node,
  href,
  current,
  className,
  children,
}: {
  node?: string
  href?: string
  current?: boolean
  className?: string
  children: ReactNode
}) {
  const router = useRouter()
  const { isLinked, handlers } = useLink(node)
  const onClick = href
    ? (e: MouseEvent<HTMLTableRowElement>) => {
        const t = e.target as Element
        if (t.closest('a, button, input, select, label')) return
        if (window.getSelection()?.toString()) return
        router.push(href, { scroll: false })
      }
    : undefined
  return (
    <tr className={cx(className, isLinked && 'is-linked')} data-node={node} aria-current={current ? 'true' : undefined} onClick={onClick} {...handlers}>
      {children}
    </tr>
  )
}

/** A list item linked to a map node (Dependency list). */
export function LinkedItem({ node, className, children }: { node?: string; className?: string; children: ReactNode }) {
  const { isLinked, handlers } = useLink(node)
  return (
    <li className={cx(className, isLinked && 'is-linked')} data-node={node} {...handlers}>
      {children}
    </li>
  )
}

const NARROW = '(max-width: 600px)'

function subscribeNarrow(cb: () => void) {
  const m = window.matchMedia(NARROW)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false)
}

export interface CallRow {
  id: string
  /** Map node the row points at (the callee). */
  node: string
  from: ReactNode
  to: ReactNode
  /** `fmtRate` text, or null when the call exists without spans. */
  rate: string | null
  /** `fmtPct` text, or null. */
  err: string | null
  bad: boolean
  calls: number
}

/** One map node as a table row: the numbers its label and tooltip print. */
export interface NodeRow {
  id: string
  href?: string
  /** ServiceChip or the label. */
  name: ReactNode
  /** Plain name (problem list). */
  title: string
  kind: string
  /** `113 call/min`, null when the rate is not known. */
  rate: string | null
  /** `4.5 %`, null when not known. */
  err: string | null
  /** Error rate ≥ 1 % (red, as in the health table). */
  errBad: boolean
  p95: string | null
  state: MapNodeState
  /** ปกติ · ต้องดู · มี error · down … (+ the node's note). */
  stateText: string
}

const chipOf = (s: MapNodeState): 'ok' | 'warn' | 'down' => (s === 'down' || s === 'error' ? 'down' : s === 'ok' ? 'ok' : 'warn')

export interface MapProps {
  /** Map data (friendly labels); null when the topology failed or is empty (`state` is shown instead). */
  data: SystemMapData | null
  /** Same without the users node, for phones. */
  dataNarrow: SystemMapData | null
  serviceOrder: string[]
  ariaLabel: string
  meta: ReactNode
  caption: ReactNode
  /** EngineErrorState / EmptyState in place of the scene. */
  state?: ReactNode
  calls: CallRow[]
  callsCaption: string
  /** Every node of the map (table "ระบบในแผนที่"). */
  nodes: NodeRow[]
  /** Nodes that are not ok, worst first (phones: "จุดที่มีปัญหา" above the box). */
  issues: NodeRow[]
  nodesCaption: string
}

export function OverviewTop({ attn, health, map }: { attn: ReactNode; health: ReactNode; map: MapProps }) {
  const ctx = useContext(LinkCtx)
  const [wide, setWide] = useState(false)
  const [tableOpen, setTableOpen] = useState(false)
  const narrow = useNarrow()
  const setLinked = ctx?.setLinked
  const onHover = useCallback((node: SystemMapNode | null) => setLinked?.(node ? node.id : null), [setLinked])

  const toggleWide = () => {
    const next = !wide
    setWide(next)
    setTableOpen(next)
  }

  const data = narrow ? map.dataNarrow : map.data
  return (
    <div className={cx('ov-top', wide && 'is-map-wide')}>
      {attn}
      {health}
      <section className="section ov-map" aria-labelledby="ov-map-t">
        <div className="section__head">
          <h2 className="section__title" id="ov-map-t">
            แผนที่ระบบ
          </h2>
          <span className="section__meta">{map.meta}</span>
          <div className="section__actions">
            <button className="btn btn--sm btn--quiet" type="button" id="ov-map-size" aria-pressed={wide} aria-controls="ov-map" onClick={toggleWide}>
              <svg className="i i--sm" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
              </svg>
              <span>{wide ? 'ย่อ' : 'ขยาย'}</span>
            </button>
          </div>
        </div>
        {data && map.issues.length ? (
          <div className="panel ov-issues">
            <p className="ov-issues__t">จุดที่มีปัญหา {map.issues.length} · หนักสุดก่อน</p>
            <ul className="ov-issues__list">
              {map.issues.map((i) => (
                <LinkedItem key={i.id} node={i.id} className="ov-issue">
                  <span className="ov-issue__name">{i.href ? <Link href={i.href}>{i.title}</Link> : i.title}</span>
                  <StateChip state={chipOf(i.state)}>{i.stateText}</StateChip>
                  {i.err || i.rate ? (
                    <span className="ov-issue__num">
                      {i.err ? <span className={i.errBad ? 't-danger' : undefined}>error {i.err}</span> : null}
                      {i.err && i.rate ? ' · ' : null}
                      {i.rate}
                    </span>
                  ) : null}
                </LinkedItem>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="panel ov-map__panel">
          <div className={cx('ov-map__box', !data && 'ov-map__box--state')} id="ov-map">
            {data ? (
              <SystemMap3D
                data={data}
                serviceOrder={map.serviceOrder}
                height="var(--ov-map-h)"
                narrowHeight="var(--ov-map-h-narrow)"
                compactLabels={narrow || !wide}
                legendOpen={false}
                ariaLabel={map.ariaLabel}
                highlight={ctx?.highlight ?? null}
                onHover={onHover}
                loadingText="กำลังโหลดภาพ 3 มิติ…"
              />
            ) : (
              map.state
            )}
          </div>
        </div>
        <p className="hint ov-map__cap">{map.caption}</p>
        {map.calls.length || map.nodes.length ? (
          <details className="chart__table ov-calls" id="ov-calls" open={tableOpen} onToggle={(e) => setTableOpen(e.currentTarget.open)}>
            <summary className="summary-line">
              ดูเป็นตาราง · ระบบในแผนที่ {map.nodes.length} · การเรียกระหว่างระบบ {map.calls.length} เส้น
            </summary>
            {map.nodes.length ? (
              <>
                <h3 className="ov-calls__h">ระบบในแผนที่</h3>
                <div className="table-wrap">
                  <table className="table table--dense table--reflow ov-nodes__table">
                    <caption className="sr-only">{map.nodesCaption}</caption>
                    <thead>
                      <tr>
                        <th scope="col">ระบบ</th>
                        <th scope="col">ประเภท</th>
                        <th scope="col" className="num">
                          ครั้ง/นาที
                        </th>
                        <th scope="col" className="num">
                          Error
                        </th>
                        <th scope="col" className="num">
                          p95
                        </th>
                        <th scope="col">สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {map.nodes.map((n) => (
                        <LinkedRow key={n.id} node={n.id}>
                          <td className="ov-n-name">{n.href ? <Link className="link-quiet" href={n.href}>{n.name}</Link> : n.name}</td>
                          <td className="t-ink2 rf-hide">{n.kind}</td>
                          <td className="num ov-n-rate">
                            {n.rate ?? <span className="t-muted">–</span>}
                          </td>
                          <td className={cx('num ov-n-err', n.errBad ? 't-danger' : n.err === '0 %' && 't-muted')} data-label="error">
                            {n.err ?? <span className="t-muted">–</span>}
                          </td>
                          <td className="num ov-n-p95" data-label="p95">
                            {n.p95 ?? <span className="t-muted">–</span>}
                          </td>
                          <td className="ov-n-state">
                            <StateChip state={chipOf(n.state)}>{n.stateText}</StateChip>
                          </td>
                        </LinkedRow>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            {map.calls.length ? <h3 className="ov-calls__h">การเรียกระหว่างระบบ</h3> : null}
            <div className="table-wrap" hidden={!map.calls.length}>
              <table className="table table--dense table--reflow ov-calls__table">
                <caption className="sr-only">{map.callsCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">จาก</th>
                    <th scope="col">ไป</th>
                    <th scope="col" className="num">
                      ครั้ง/นาที
                    </th>
                    <th scope="col" className="num">
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {map.calls.map((c) => (
                    <LinkedRow key={c.id} node={c.node}>
                      <td className="ov-c-from">{c.from}</td>
                      <td className="ov-c-to">{c.to}</td>
                      <td className="num ov-c-rate" data-label="ครั้ง/นาที" title={c.rate === null ? 'เฝ้าดูอยู่ ยังไม่มีการเรียกในช่วงนี้' : `${fmtCount(c.calls)} ครั้งในช่วงนี้`}>
                        {c.rate ?? <span className="t-muted">–</span>}
                      </td>
                      <td className={cx('num ov-c-err', c.bad ? 't-danger' : c.err === '0 %' && 't-muted')} data-label="error">
                        {c.err ?? <span className="t-muted">–</span>}
                      </td>
                    </LinkedRow>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </section>
    </div>
  )
}
