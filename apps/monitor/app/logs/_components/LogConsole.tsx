'use client'

/**
 * The log console (design/monitoring-ui/logs-console.html): logs read like a dev terminal (`LOG_PRETTY=true`), old
 * on top, new at the bottom, following the newest line until the reader scrolls up ("↓ N บรรทัดใหม่").
 *
 * - Scope row: Service and Pod dropdowns (several at once), the view switch (Timeline = one block per request with
 *   every line it wrote in every service and pod; บรรทัดดิบ = every line in order), follow.
 * - Bar: one grep box (`route:` `trace:` `user:` `job:` `-word` and free text, query.ts), the level keys with their
 *   counts, "แสดง noise", "ตัดบรรทัด".
 * - The minute strip, the stream, the status line, the shortcut help (`?`).
 *
 * Every filter lives in the URL (the page re-renders on the server, query.ts); the stream below is keyed by the
 * filters, so a new filter starts a fresh stream while a refresh of the same filters (top bar auto refresh) merges its
 * lines in: new lines arrive at the bottom, older pages load on top (`before`). A line opens its detail under itself.
 */
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react'
import { copyText } from '@/components/CopyButton'
import { announce } from '@/lib/announce'
import { type ClientResult, clientGet } from '@/lib/engine-client'
import { fmtCount, fmtTimeSec } from '@/lib/format'
import { buildHref, type Keep, withParams } from '@/lib/params'
import { PREF, writePref } from '@/lib/prefs'
import { aiErrorMarkdown, aiFieldsOfLog } from '@/lib/readable'
import type { Level, LogPod, LogRow, LogsHistogramBucket, LogsLevelCounts, LogsQuery, LogsResponse, LogTracesQuery, LogTracesResponse } from '@/lib/types'
import { type Item, type LineRec, mergeRecs, podShort, rankOf, recsOf, rawItems, type Separator, shortNamer, srcOf, timelineItems } from '../_lib/console'
import { type Outage, prettyText, rawRecord } from '../_lib/lines'
import { type ConsoleView, GREP_PARAMS, keysOf, LEVEL_KEY_LABEL, LEVEL_KEYS, type LevelKey, levelParam, parseGrep, quoteToken, serviceParam, type Source } from '../_lib/query'
import { detailRows, type ErrorInfo, type LineCtx, RawLine, RequestBlock, SepLine, Siblings, traceLinks } from './ConsoleLines'
import { MinuteStrip, PodDropdown, SourceDropdown, type SourceCounts } from './ConsoleControls'

/** What one engine answer gives the stream (the page's first page, or a refresh of it). */
export interface ConsoleData {
  /** Newest first, as /api/logs answers. */
  rows: LogRow[]
  nextBefore: string | null
  histogram: LogsHistogramBucket[]
  levelCounts: LogsLevelCounts
  /** Lines left out as noise plus lines folded into a ⟲ repeat. */
  hidden: number
  /** Timeline: every line of the requests on the page (GET /api/logs/traces). */
  traceRows: LogRow[]
  truncated: string[]
}

export interface LogConsoleProps {
  /** Identity of the filters: a new value starts a fresh stream. */
  filterKey: string
  view: ConsoleView
  data: ConsoleData
  /** /api/logs query of the stream (no limit / before): older pages. */
  query: LogsQuery
  /** /api/logs/traces query without traceIds: the lines of a request. */
  tracesQuery: Omit<LogTracesQuery, 'traceIds'>
  pageSize: number
  sources: Source[]
  selected: string[]
  all: boolean
  counts: Record<string, SourceCounts>
  /** Pods of every source (the dropdown shows those of the selected ones). */
  pods: LogPod[]
  podSel: string[] | null
  byTrace: boolean
  levels: Level[] | null
  grep: string
  /** Free words of the grep box, marked in the lines. */
  terms: string[]
  noise: boolean
  narrowed: boolean
  fromMs: number
  toMs: number
  stepMs: number
  /** The range ends now: lines keep coming. */
  live: boolean
  outages: Outage[]
  seps: Separator[]
  errors: Record<string, ErrorInfo>
  order: string[]
  keep: Keep
  withDate: boolean
  /** `service` value to remember for the next visit (the URL named one), else null. */
  remember: string | null
  /** The engine call failed: the error state instead of the stream. */
  failed: ReactNode
}

export function LogConsole(props: LogConsoleProps) {
  const router = useRouter()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [dd, setDd] = useState<'svc' | 'pod' | null>(null)
  const [text, setText] = useState(props.grep)
  const [problems, setProblems] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  /** The text typed in the grep box, applied after a pause in typing (or along with the next change). */
  const typing = useRef<{ timer: number; text: string } | null>(null)
  const applyLater = useRef<(value: string) => void>(() => {})
  const { sources, selected, all, pods, podSel, byTrace, view } = props

  // the grep box shows what the URL filters (a link, "log ทั้ง request"), unless the reader is typing in it
  useEffect(() => {
    if (document.activeElement !== input.current) setText(props.grep)
  }, [props.grep])

  useEffect(() => {
    if (props.remember) writePref(PREF.logSources, props.remember)
  }, [props.remember])

  // a new filter: follow the newest lines again
  useEffect(() => setFollow(true), [props.filterKey])

  /** Every pod unticked: nothing to show until one is ticked again ("ยังไม่ได้เลือก pod"); not kept in the URL. */
  const [noPods, setNoPods] = useState(false)
  useEffect(() => setNoPods(false), [props.filterKey])

  const go = useCallback(
    (changes: Record<string, string | null>, push = false) => {
      // a search still waiting for the pause in typing goes along (it can no longer fire later and undo this change)
      const typed = typing.current
      if (typed) window.clearTimeout(typed.timer)
      typing.current = null
      const all = typed ? { ...parseGrep(typed.text).params, ...changes } : changes
      start(() => {
        const href = withParams('/logs', sp, { ...all, pick: null })
        if (push) router.push(href, { scroll: false })
        else router.replace(href, { scroll: false })
      })
    },
    [router, sp],
  )
  // leaving the page: a pending search must not bring it back
  useEffect(
    () => () => {
      if (typing.current) window.clearTimeout(typing.current.timer)
    },
    [],
  )

  const shownIds = all ? sources.map((s) => s.id) : selected
  const groupIds = byTrace ? [] : shownIds
  const shownPods = useMemo(() => pods.filter((p) => shownIds.includes(`${p.service}/${p.role}`)), [pods, shownIds])

  const setSources = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      const service = serviceParam(ids, sources) ?? 'all'
      const valid = new Set(pods.filter((p) => ids.includes(`${p.service}/${p.role}`)).map((p) => p.host))
      const keepPods = podSel?.filter((h) => valid.has(h)) ?? []
      writePref(PREF.logSources, service)
      go({ service, role: null, pod: keepPods.length && keepPods.length < valid.size ? keepPods.join(',') : null })
    },
    [sources, pods, podSel, go],
  )
  const setPods = useCallback(
    (hosts: string[] | null) => {
      if (hosts && !hosts.length) return setNoPods(true)
      setNoPods(false)
      go({ pod: hosts?.length ? hosts.join(',') : null })
    },
    [go],
  )
  const setView = useCallback(
    (v: ConsoleView) => {
      writePref(PREF.logView, v)
      go({ view: v === 'raw' ? 'raw' : null })
    },
    [go],
  )
  const setLevels = useCallback((keys: Set<LevelKey>) => {
    if (keys.size) go({ level: levelParam(keys) })
  }, [go])
  const setNoise = useCallback(
    (show: boolean) =>
      go(show === props.narrowed ? { show: null, repeats: null } : show ? { show: 'all', repeats: 'all' } : { show: 'none', repeats: 'collapse' }),
    [go, props.narrowed],
  )
  const applyGrep = useCallback(
    (value: string) => {
      if (typing.current) window.clearTimeout(typing.current.timer)
      typing.current = null
      const g = parseGrep(value)
      setProblems(g.problems)
      go(g.params)
    },
    [go],
  )
  useEffect(() => {
    applyLater.current = applyGrep
  }, [applyGrep])
  const clearGrep = useCallback(() => {
    setText('')
    setProblems([])
    go(Object.fromEntries(GREP_PARAMS.map((k) => [k, null])))
  }, [go])
  /** Every line of one request as raw lines (`l`): the raw view filtered by its trace. */
  const rawTrace = useCallback(
    (trace: string) => {
      writePref(PREF.logView, 'raw')
      setText(`trace:${trace}`)
      go({ ...Object.fromEntries(GREP_PARAMS.map((k) => [k, null])), traceId: trace, view: 'raw' })
    },
    [go],
  )
  const setRange = useCallback((fromMs: number, toMs: number) => go({ from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }, true), [go])

  const keys = keysOf(props.levels ?? undefined)
  const lc = props.data.levelCounts
  const keyCount: Record<LevelKey, number> = { debug: lc.debug, info: lc.info, warn: lc.warn, error: lc.error + lc.fatal }

  return (
    <section className={`lc${pending ? ' is-pending' : ''}`} aria-label="Log console" aria-busy={pending}>
      <div className="lc-scope">
        <SourceDropdown sources={sources} selected={selected} all={all} counts={props.counts} order={props.order} open={dd === 'svc'} onOpen={(o) => setDd(o ? 'svc' : null)} onChange={setSources} />
        <PodDropdown
          pods={shownPods}
          groups={groupIds}
          selected={noPods ? [] : podSel}
          byTrace={byTrace}
          order={props.order}
          open={dd === 'pod'}
          onOpen={(o) => setDd(o ? 'pod' : null)}
          onChange={setPods}
        />
        <div className="lc-seg" role="group" aria-label="มุมมอง">
          <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
            Timeline<span>ทีละ request</span>
          </button>
          <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>
            บรรทัดดิบ<span>legacy</span>
          </button>
        </div>
        <span className="lc-scope__hint">
          <kbd>v</kbd> สลับมุมมอง
        </span>
        <div className="lc-bar__end">
          <button className="lc-tg" type="button" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
            ตามบรรทัดล่าสุด <kbd>F</kbd>
          </button>
        </div>
      </div>

      <div className="lc-bar">
        <label className="lc-grep">
          <span className="lc-grep__prompt" aria-hidden="true">
            ❯
          </span>
          <span className="sr-only">กรองบรรทัด</span>
          <input
            ref={input}
            id="lc-q"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={text}
            placeholder="กรอง… เช่น ORA-12899  route:/me  trace:…  -health"
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              if (typing.current) window.clearTimeout(typing.current.timer)
              typing.current = { text: v, timer: window.setTimeout(() => applyLater.current(v), 450) }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyGrep(text)
                document.getElementById('lc-body')?.focus()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                if (text) clearGrep()
                document.getElementById('lc-body')?.focus()
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
          <GrepHints
            rows={props.data.rows}
            onPick={(token) => {
              const v = `${text.trim() ? `${text.trim()} ` : ''}${token}`
              setText(v)
              // `route:` `trace:` … wait for a value; `-` for the word to leave out
              if (!token.endsWith(':') && token !== '-') applyGrep(v)
              input.current?.focus()
            }}
          />
        </label>
        <div className="lc-lv" role="group" aria-label="Level">
          {LEVEL_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              data-lv={k}
              aria-pressed={keys.has(k)}
              title={keys.has(k) ? `กดเพื่อซ่อน ${LEVEL_KEY_LABEL[k]}` : `กดเพื่อแสดง ${LEVEL_KEY_LABEL[k]} ด้วย`}
              onClick={() => {
                const next = new Set(keys)
                if (next.has(k)) next.delete(k)
                else next.add(k)
                setLevels(next)
              }}
            >
              {LEVEL_KEY_LABEL[k]}
              <b>{fmtCount(keyCount[k])}</b>
            </button>
          ))}
        </div>
        <div className="lc-bar__end">
          <button className="lc-tg" type="button" aria-pressed={props.noise} title="health check, preflight, cache และ log ที่ซ้ำตามรอบถูกซ่อน/ยุบไว้" onClick={() => setNoise(!props.noise)}>
            แสดง noise
          </button>
          <button className="lc-tg" type="button" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
            ตัดบรรทัด
          </button>
        </div>
        {problems.length ? (
          <p className="lc-bar__problem" role="status">
            {problems.join(' · ')}
          </p>
        ) : null}
      </div>

      {props.failed ? (
        <div className="lc-failed">{props.failed}</div>
      ) : (
        <Stream
          key={props.filterKey}
          p={props}
          noPods={noPods && !byTrace}
          follow={follow}
          setFollow={setFollow}
          wrap={wrap}
          pending={pending}
          actions={{
            focusGrep: () => {
              input.current?.focus()
              input.current?.select()
            },
            hasGrep: !!text,
            clearGrep,
            setView,
            setSources,
            setPods,
            setLevels,
            rawTrace,
            setRange,
            showNoise: () => setNoise(true),
            open: (href) => router.push(href),
            dropdownOpen: dd !== null,
          }}
        />
      )}
    </section>
  )
}

/** Hints under the grep box while it has focus: the tokens, with values from the lines on screen. */
function GrepHints({ rows, onPick }: { rows: readonly LogRow[]; onPick: (token: string) => void }) {
  const req = rows.find((r) => r.eventCode === 'http.request' && r.http?.route)?.http
  const user = rows.find((r) => r.userId)?.userId
  const job = rows.find((r) => r.job && (r.job.type || r.job.queue))?.job
  const route = req ? `${req.method} ${req.route}` : ''
  const hints: Array<[string, string, string]> = [
    route ? [`route:"${route}"`, `route:"${route}"`, 'เฉพาะ request ของ route นี้'] : ['route:', 'route:/path', 'เฉพาะ request ของ route นี้'],
    ['trace:', 'trace:<id>', 'ทุกบรรทัดของ request เดียว ข้ามทุก service'],
    user ? [`user:${user}`, `user:${user}`, 'ทุกบรรทัดของผู้ใช้คนนี้'] : ['user:', 'user:u_…', 'ทุกบรรทัดของผู้ใช้คนนี้'],
    job ? [`job:${quoteToken(job.type || job.queue)}`, `job:${quoteToken(job.type || job.queue)}`, 'ทุกครั้งที่รันของงานชื่อนี้'] : ['job:', 'job:<ชื่องาน>', 'งานเบื้องหลังชื่อนี้ (job:#<id> = job เดียว)'],
    ['-', '-คำ', 'ไม่เอาบรรทัดที่มีคำนี้'],
  ]
  return (
    // keep the box focused while a hint is clicked (the list shows only while it has focus)
    <span className="lc-grep__hints" onMouseDown={(e) => e.preventDefault()}>
      {hints.map(([token, code, what]) => (
        <button key={code} type="button" onClick={() => onPick(token)}>
          <code>{code}</code>
          <span>{what}</span>
        </button>
      ))}
    </span>
  )
}

interface StreamActions {
  focusGrep: () => void
  hasGrep: boolean
  clearGrep: () => void
  setView: (v: ConsoleView) => void
  setSources: (ids: string[]) => void
  setPods: (hosts: string[] | null) => void
  setLevels: (keys: Set<LevelKey>) => void
  rawTrace: (trace: string) => void
  setRange: (fromMs: number, toMs: number) => void
  showNoise: () => void
  /** Client navigation to another screen (`t`: the trace). */
  open: (href: string) => void
  dropdownOpen: boolean
}

const traceMap = (recs: readonly LineRec[]): Map<string, LineRec[]> => {
  const m = new Map<string, LineRec[]>()
  for (const r of recs) {
    if (!r.row.traceId) continue
    const list = m.get(r.row.traceId)
    if (list) list.push(r)
    else m.set(r.row.traceId, [r])
  }
  return m
}

/** Kept line of a collapsed repeat: a newer one replaces it. */
const repeatKey = (row: LogRow) => (row.repeat ? `${row.repeat.kind}:${row.repeat.pattern}` : '')

/** A copy button of the console: says "คัดลอกแล้ว" for a moment. */
function CopyAct({ text, children }: { text: () => string; children: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={done ? 'is-done' : undefined}
      onClick={async () => {
        const ok = await copyText(text())
        announce(ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้')
        setDone(ok)
        if (ok) window.setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'คัดลอกแล้ว' : children}
    </button>
  )
}

/** No separators (narrowed page, trace filter) and nothing on screen (no pod): shared arrays, so memos hold. */
const NO_SEPS: Separator[] = []
const NO_ITEMS: Item[] = []
const NO_RECS: LineRec[] = []

function Stream({
  p,
  noPods,
  follow,
  setFollow,
  wrap,
  pending,
  actions,
}: {
  p: LogConsoleProps
  /** Every pod unticked: the note instead of lines. */
  noPods: boolean
  follow: boolean
  setFollow: (v: boolean | ((f: boolean) => boolean)) => void
  wrap: boolean
  pending: boolean
  actions: StreamActions
}) {
  const { view, data } = p
  const sp = useSearchParams()
  const timeline = view === 'timeline'
  const [lines, setLines] = useState<LineRec[]>(() => recsOf(data.rows))
  const [extra, setExtra] = useState<Map<string, LineRec[]>>(() => traceMap(recsOf(data.traceRows)))
  const [trunc, setTrunc] = useState<ReadonlySet<string>>(() => new Set(data.truncated))
  const [cursor, setCursor] = useState(data.nextBefore)
  const [older, setOlder] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [sel, setSel] = useState<string | null>(null)
  const [openLines, setOpenLines] = useState<ReadonlySet<string>>(new Set())
  const [gOpen, setGOpen] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [newN, setNewN] = useState(0)
  const [visible, setVisible] = useState<[number, number] | null>(null)
  const [sibs, setSibs] = useState<ReadonlyMap<string, LineRec[] | 'loading' | 'error'>>(new Map())
  const [help, setHelp] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const linesRef = useRef(lines)
  linesRef.current = lines
  const first = useRef(true)
  /** Timeline while reading back: the newest answer, applied when following again. */
  const held = useRef<ConsoleData | null>(null)
  /** scrollHeight − scrollTop to keep after lines are added on top. */
  const anchor = useRef<number | null>(null)
  /** A minute to show once its lines are in. */
  const jumpTo = useRef<number | null>(null)

  const short = useMemo(() => shortNamer(p.sources.map((s) => s.service)), [p.sources])
  const shownCount = p.all ? p.sources.length : p.selected.length
  const merged = p.byTrace || shownCount > 1
  const ctx: LineCtx = useMemo(
    () => ({
      order: p.order,
      short,
      merged,
      withDate: p.withDate,
      view,
      keep: p.keep,
      errors: p.errors,
      href: (changes) => withParams('/logs', sp, { ...changes, pick: null }),
    }),
    [p.order, short, merged, p.withDate, view, p.keep, p.errors, sp],
  )

  const seps = p.narrowed || p.byTrace ? NO_SEPS : p.seps
  // separators only inside the loaded window (the range start once everything is loaded)
  const lo = cursor ? (lines[0]?.ms ?? p.toMs) : p.fromMs
  const inWin = useMemo(() => seps.filter((s) => s.t >= lo), [seps, lo])
  const items: Item[] = useMemo(() => (timeline ? timelineItems(lines, extra, inWin, trunc) : rawItems(lines, inWin)), [timeline, lines, extra, inWin, trunc])

  // ---------- new answers (refresh of the same filters) ----------

  const apply = useCallback(
    (d: ConsoleData, count: boolean) => {
      const incoming = recsOf(d.rows)
      const cur = linesRef.current
      const known = new Set(cur.map((r) => r.id))
      const add = incoming.filter((r) => !known.has(r.id))
      const newest = cur.length ? cur[cur.length - 1].ms : -Infinity
      let next: LineRec[]
      if (d.nextBefore && incoming.length && incoming[0].ms > newest && add.length === incoming.length) {
        // more new lines than one page: start again from the newest page
        next = incoming
        setCursor(d.nextBefore)
      } else {
        const reps = new Set(add.map((r) => repeatKey(r.row)).filter(Boolean))
        next = mergeRecs(reps.size ? cur.filter((r) => !reps.has(repeatKey(r.row))) : cur, add)
      }
      setLines(next)
      const tr = recsOf(d.traceRows)
      if (tr.length) {
        setExtra((prev) => {
          const m = new Map(prev)
          for (const [k, v] of traceMap(tr)) m.set(k, mergeRecs(m.get(k) ?? [], v))
          return m
        })
      }
      if (d.truncated.length) setTrunc((prev) => new Set([...prev, ...d.truncated]))
      setFresh(new Set(add.map((r) => r.id)))
      if (count) {
        const knownTraces = new Set(cur.map((r) => r.row.traceId).filter(Boolean))
        const n = timeline
          ? new Set(add.map((r) => (r.row.traceId && !r.row.repeat ? r.row.traceId : r.id)).values()).size -
            [...new Set(add.map((r) => r.row.traceId))].filter((t) => t && knownTraces.has(t)).length
          : add.filter((r) => !r.row.repeat).length
        if (n > 0) setNewN((x) => x + n)
      }
    },
    [timeline],
  )

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // the Timeline does not move under a reader: its new requests wait for "↓"
    if (timeline && !follow) {
      held.current = data
      const known = new Set(linesRef.current.map((r) => r.row.traceId || r.id))
      const n = new Set(recsOf(data.rows).map((r) => (r.row.traceId && !r.row.repeat ? r.row.traceId : r.id)).filter((k) => !known.has(k))).size
      setNewN(n)
      return
    }
    apply(data, !follow)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new answer only
  }, [data])

  useEffect(() => {
    if (!follow) return
    setNewN(0)
    if (held.current) {
      apply(held.current, false)
      held.current = null
    }
  }, [follow, apply])

  // ---------- scrolling ----------

  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current
      anchor.current = null
    } else if (follow) el.scrollTop = el.scrollHeight
    if (jumpTo.current !== null) {
      const at = jumpTo.current
      jumpTo.current = null
      const target = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-nav]')).find((x) => Number(x.dataset.t) >= at)
      if (target) {
        el.scrollTop = target.offsetTop - 8
        setSel(target.dataset.nav ?? null)
      }
    }
  }, [lines, extra, follow, timeline])

  /** The time span of the lines on screen (the frame on the minute strip), 80 ms after the last change. */
  const measureTimer = useRef<number | undefined>(undefined)
  const measure = useCallback(() => {
    window.clearTimeout(measureTimer.current)
    measureTimer.current = window.setTimeout(() => {
      const el = body.current
      if (!el) return
      const top = el.scrollTop
      const bottom = top + el.clientHeight
      let a: number | null = null
      let b: number | null = null
      for (const x of Array.from(el.children) as HTMLElement[]) {
        if (!x.dataset.t) continue
        if (a === null && x.offsetTop + x.offsetHeight >= top) a = Number(x.dataset.t)
        if (x.offsetTop <= bottom) b = Number(x.dataset.t)
      }
      const span: [number, number] | null = a === null || b === null ? null : [a, Math.max(a, b)]
      // the same span keeps the same state: no render
      setVisible((v) => (span && v && v[0] === span[0] && v[1] === span[1] ? v : span))
    }, 80)
  }, [])
  useEffect(() => () => window.clearTimeout(measureTimer.current), [])

  // only a real scroll decides following: reading back stops it, reaching the bottom starts it again (F and the
  // button set it themselves, so turning it off at the bottom stays off)
  const onScroll = useCallback(() => {
    const el = body.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
    measure()
  }, [follow, setFollow, measure])

  // new lines, a new view: measure again
  useEffect(() => measure(), [items, measure])

  /** Scroll the console only (never the page) so `el` is in view. */
  const reveal = useCallback((el: HTMLElement, where: 'start' | 'nearest' = 'nearest') => {
    const b = body.current
    if (!b) return
    const top = el.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop
    const h = el.offsetHeight
    if (where === 'start' || top < b.scrollTop) b.scrollTop = top - 8
    else if (top + h > b.scrollTop + b.clientHeight) b.scrollTop = top + Math.min(h, b.clientHeight - 16) - b.clientHeight + 8
  }, [])

  // ---------- older lines ----------

  const loadOlder = useCallback(
    async (until?: number): Promise<boolean> => {
      if (!cursor || older.loading) return false
      setOlder({ loading: true, error: null })
      let c: string | null = cursor
      let got: LineRec[] = []
      for (let page = 0; c && page < (until === undefined ? 1 : 3); page++) {
        const res: ClientResult<LogsResponse> = await clientGet<LogsResponse>('/logs', { ...p.query, limit: p.pageSize, before: c })
        if (!res.ok) {
          setOlder({ loading: false, error: res.error.message })
          return false
        }
        got = mergeRecs(recsOf(res.data.rows), got)
        c = res.data.nextBefore
        if (until === undefined || !got.length || got[0].ms <= until) break
      }
      if (timeline) {
        const have = new Set([...extra.keys()])
        const ids = [...new Set(got.map((r) => r.row.traceId).filter((t) => t && !have.has(t)))]
        const parts = await Promise.all(
          chunks(ids, 100).map((traceIds) => clientGet<LogTracesResponse>('/logs/traces', { ...p.tracesQuery, traceIds: traceIds.join(',') })),
        )
        const add = parts.flatMap((r) => (r.ok ? r.data.rows : []))
        const cut = parts.flatMap((r) => (r.ok ? r.data.truncated : []))
        if (add.length) {
          setExtra((prev) => {
            const m = new Map(prev)
            for (const [k, v] of traceMap(recsOf(add))) m.set(k, mergeRecs(m.get(k) ?? [], v))
            return m
          })
        }
        if (cut.length) setTrunc((prev) => new Set([...prev, ...cut]))
      }
      const el = body.current
      if (el && until === undefined) anchor.current = el.scrollHeight - el.scrollTop
      setLines((prev) => mergeRecs(got, prev))
      setCursor(c)
      setOlder({ loading: false, error: null })
      return !!got.length && (until === undefined || got[0].ms <= until)
    },
    [cursor, older.loading, p.query, p.pageSize, p.tracesQuery, timeline, extra],
  )

  /** A click on the minute strip: that bucket's first line (loading older pages for it), else that bucket as the range. */
  const jump = useCallback(
    async (from: number, to: number) => {
      setFollow(false)
      const loadedFrom = linesRef.current[0]?.ms ?? Infinity
      if (from >= loadedFrom || (!cursor && linesRef.current.length)) {
        const el = Array.from(body.current?.querySelectorAll<HTMLElement>(':scope > [data-nav]') ?? []).find((x) => Number(x.dataset.t) >= from)
        if (el) {
          reveal(el, 'start')
          setSel(el.dataset.nav ?? null)
        }
        return
      }
      jumpTo.current = from
      const ok = await loadOlder(from)
      if (!ok) {
        jumpTo.current = null
        actions.setRange(from, to)
      }
    },
    [cursor, loadOlder, reveal, setFollow, actions],
  )

  // ---------- open / select ----------

  const toggleLine = useCallback(
    (id: string) => {
      setOpenLines((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setFollow(false)
    },
    [setFollow],
  )
  const groupIsOpen = useCallback((g: { trace: string; level: string }) => gOpen.get(g.trace) ?? rankOf(g.level) >= 3, [gOpen])
  const toggleGroup = useCallback(
    (trace: string, level: string) => {
      setGOpen((prev) => new Map(prev).set(trace, !(prev.get(trace) ?? rankOf(level) >= 3)))
      setSel(`g:${trace}`)
      setFollow(false)
    },
    [setFollow],
  )

  // the lines of a request for the raw view's detail (fetched once per trace)
  const needSibs = useMemo(() => {
    if (timeline) return []
    const want = new Set<string>()
    for (const l of lines) if (openLines.has(l.id) && l.row.traceId && !sibs.has(l.row.traceId)) want.add(l.row.traceId)
    return [...want]
  }, [timeline, lines, openLines, sibs])
  useEffect(() => {
    if (!needSibs.length) return
    setSibs((prev) => {
      const m = new Map(prev)
      for (const t of needSibs) m.set(t, 'loading')
      return m
    })
    for (const t of needSibs) {
      void clientGet<LogTracesResponse>('/logs/traces', { ...p.tracesQuery, traceIds: t }).then((res) =>
        setSibs((prev) => new Map(prev).set(t, res.ok ? recsOf(res.data.rows) : 'error')),
      )
    }
  }, [needSibs, p.tracesQuery])

  const linesOfTrace = useCallback(
    (trace: string): LineRec[] => {
      const s = sibs.get(trace)
      return mergeRecs(
        lines.filter((l) => l.row.traceId === trace),
        [...(extra.get(trace) ?? []), ...(Array.isArray(s) ? s : [])],
      )
    },
    [lines, extra, sibs],
  )

  const detailOf = useCallback(
    (line: LineRec): ReactNode => {
      const row = line.row
      const trace = row.traceId
      const same = trace ? linesOfTrace(trace) : []
      const request = row.eventCode === 'http.request' ? row : (same.find((l) => l.row.eventCode === 'http.request' && srcOf(l.row) === srcOf(row))?.row ?? null)
      const links = traceLinks(row, p.keep)
      const s = trace ? sibs.get(trace) : undefined
      const ai = !!row.error || rankOf(row.level) >= 2
      const g = row.fingerprint ? p.errors[row.fingerprint] : undefined
      return (
        <div className="ln-x" data-for={line.id}>
          <dl>
            {detailRows(row, ctx, request).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
          {!timeline && trace ? (
            s === 'loading' ? (
              <p className="ln-x__sibs-note">กำลังโหลดบรรทัดอื่นใน request เดียวกัน…</p>
            ) : s === 'error' ? (
              <p className="ln-x__sibs-note">โหลดบรรทัดอื่นใน request เดียวกันไม่ได้</p>
            ) : same.length > 1 ? (
              <Siblings lines={same} me={line.id} ctx={ctx} />
            ) : null
          ) : null}
          <div className="ln-x__acts">
            {links ? (
              <Link href={links.trace}>
                เปิด trace <kbd>t</kbd>
              </Link>
            ) : null}
            {links?.io ? <Link href={links.io}>{links.ioLabel}</Link> : null}
            {!timeline && trace ? (
              <button type="button" onClick={() => actions.rawTrace(trace)}>
                log ทั้ง request <kbd>l</kbd>
              </button>
            ) : null}
            {row.fingerprint ? <Link href={buildHref(`/errors/${row.fingerprint}`, p.keep)}>ดู error group</Link> : null}
            <CopyAct text={() => prettyText(row)}>
              คัดลอกแบบ terminal <kbd>y</kbd>
            </CopyAct>
            <CopyAct text={() => JSON.stringify(rawRecord(row))}>คัดลอก JSON</CopyAct>
            {ai ? (
              <CopyAct
                text={() =>
                  aiErrorMarkdown({
                    ...aiFieldsOfLog(row),
                    newSince: g?.isNew ? g.since || undefined : undefined,
                    counts: g ? `group ${fmtCount(g.count)} times${g.users ? ` · ${fmtCount(g.users)} users` : ''} in range` : undefined,
                  })
                }
              >
                คัดลอกให้ AI
              </CopyAct>
            ) : null}
          </div>
        </div>
      )
    },
    [linesOfTrace, sibs, ctx, timeline, p.keep, p.errors, actions],
  )

  const groupText = useCallback((trace: string) => linesOfTrace(trace).map((l) => prettyText(l.row)).join('\n'), [linesOfTrace])
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines])
  /** The line or request a nav key names (any line of an open block too). */
  const target = useCallback(
    (key: string | null): { line?: LineRec; trace?: string } | null => {
      if (!key) return null
      if (key.startsWith('g:')) return { trace: key.slice(2) }
      const id = key.slice(2)
      const line = lineById.get(id) ?? [...extra.values()].flat().find((l) => l.id === id)
      return line ? { line, trace: line.row.traceId || undefined } : null
    },
    [lineById, extra],
  )

  // ---------- keys ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const a = document.activeElement as HTMLElement | null
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) && (a as HTMLInputElement).type !== 'checkbox') return
      if (actions.dropdownOpen) return
      const el = body.current
      // the menu (phone) or a dialog is open over the console: its keys are theirs (Esc closes the menu)
      if (!el || el.closest('[inert]')) return
      const k = e.key
      const stop = () => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      const t = target(sel)
      if (k === '/') {
        stop()
        actions.focusGrep()
      } else if (k === 'j' || k === 'k' || k === 'ArrowDown' || k === 'ArrowUp') {
        if ((k === 'ArrowDown' || k === 'ArrowUp') && a !== el) return
        stop()
        const down = k === 'j' || k === 'ArrowDown'
        if (!down) setFollow(false)
        const list = timeline ? (Array.from(el.children) as HTMLElement[]).filter((x) => x.dataset.nav) : Array.from(el.querySelectorAll<HTMLElement>('.ln[data-nav]'))
        if (!list.length) return
        let i = list.findIndex((x) => x.dataset.nav === sel)
        if (i < 0) i = list.length
        i = down ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1)
        setSel(list[i].dataset.nav ?? null)
        reveal(list[i])
      } else if (k === 'Enter' || k === 'o') {
        // Enter on a focused link or button (เปิด trace, คัดลอก, โหลดเก่ากว่า …) is that control's own
        if (k === 'Enter' && a && a !== el && a.closest('a, button, summary, [role="button"]')) return
        if (!t) return
        stop()
        if (sel?.startsWith('g:')) {
          const g = items.find((x) => x.kind === 'group' && x.trace === t.trace)
          if (g && g.kind === 'group') toggleGroup(g.trace, g.level)
        } else if (t.line) toggleLine(t.line.id)
      } else if (k === 'Escape') {
        if (!help && !actions.hasGrep && !sel) return
        stop()
        if (help) setHelp(false)
        else if (actions.hasGrep) actions.clearGrep()
        else setSel(null)
      } else if (k === 'v') {
        stop()
        actions.setView(timeline ? 'raw' : 'timeline')
      } else if (k === 'f' || k === 'F') {
        stop()
        setFollow((f) => !f)
      } else if (k === 'G' || k === 'End') {
        stop()
        setFollow(true)
      } else if (k === 'e') {
        stop()
        const keys = keysOf(p.levels ?? undefined)
        const quiet = keys.has('debug') || keys.has('info')
        actions.setLevels(new Set<LevelKey>(quiet ? ['warn', 'error'] : LEVEL_KEYS))
      } else if (k === 't' && t?.trace) {
        stop()
        actions.open(buildHref(`/traces/${t.trace}`, p.keep, t.line?.row.spanId ? { span: t.line.row.spanId } : undefined))
      } else if (k === 'l' && t?.trace) {
        stop()
        actions.rawTrace(t.trace)
      } else if (k === 'y' && t) {
        stop()
        void copyText(t.line && !sel?.startsWith('g:') ? prettyText(t.line.row) : groupText(t.trace!)).then((ok) => announce(ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้'))
      } else if (k === '?') {
        stop()
        setHelp((h) => !h)
      } else if (/^[0-9]$/.test(k)) {
        const n = Number(k)
        if (n === 0) {
          stop()
          actions.setSources(p.sources.map((s) => s.id))
        } else if (p.sources[n - 1]) {
          stop()
          actions.setSources([p.sources[n - 1].id])
        }
      } else if (k === 'p' && !p.byTrace) {
        const hosts = [...new Set(p.pods.filter((x) => (p.all ? true : p.selected.includes(`${x.service}/${x.role}`))).map((x) => x.host))]
        if (hosts.length < 2) return
        stop()
        const cur = noPods ? undefined : !p.podSel ? null : p.podSel.length === 1 ? p.podSel[0] : undefined
        const cycle: Array<string | null> = [null, ...hosts]
        const next = cycle[(cycle.indexOf(cur === undefined ? null : cur) + 1) % cycle.length]
        actions.setPods(next ? [next] : null)
      }
    }
    // before the top bar's own `/`
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [sel, target, items, timeline, help, actions, p, reveal, toggleGroup, toggleLine, groupText, setFollow])

  // ---------- clicks in the stream ----------

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    const head = t.closest<HTMLElement>('[data-g]')
    if (head) {
      const trace = head.dataset.g!
      const g = items.find((x) => x.kind === 'group' && x.trace === trace)
      if (g && g.kind === 'group') toggleGroup(trace, g.level)
      return
    }
    if (t.closest('a, button, .ln-x') || String(window.getSelection() ?? '')) return
    const ev = t.closest<HTMLElement>('.tg__ev[data-id]')
    if (ev) {
      setSel(`l:${ev.dataset.id}`)
      toggleLine(ev.dataset.id!)
      return
    }
    const ln = t.closest<HTMLElement>('.ln[data-id]')
    if (ln) {
      setSel(`l:${ln.dataset.id}`)
      toggleLine(ln.dataset.id!)
    }
  }
  // the other lines of the hovered line's request light up (raw view)
  const onOver = (e: React.MouseEvent) => {
    if (timeline || !body.current) return
    const trace = (e.target as HTMLElement).closest<HTMLElement>('.ln')?.dataset.trace
    for (const x of Array.from(body.current.querySelectorAll<HTMLElement>('.ln.is-sib'))) if (x.dataset.trace !== trace) x.classList.remove('is-sib')
    if (trace) for (const x of Array.from(body.current.querySelectorAll<HTMLElement>(`.ln[data-trace="${trace}"]`))) x.classList.add('is-sib')
  }
  const onLeave = () => body.current?.querySelectorAll('.ln.is-sib').forEach((x) => x.classList.remove('is-sib'))

  // ---------- render ----------

  const unit = timeline ? 'request' : 'บรรทัด'
  // every pod unticked: nothing on screen, nothing counted
  const onScreen = noPods ? NO_ITEMS : items
  const recs = noPods ? NO_RECS : lines
  const groups = onScreen.filter((x): x is Extract<Item, { kind: 'group' }> => x.kind === 'group')
  const single = onScreen.filter((x) => x.kind === 'line').length
  const shownLines = timeline ? groups.reduce((a, g) => a + g.lines.length, 0) + single : recs.length
  const total = data.histogram.reduce((a, b) => a + b.debug + b.info + b.warn + b.error + b.fatal, 0)
  const errN = recs.filter((l) => rankOf(l.row.level) >= 3).length
  const wrnN = recs.filter((l) => l.row.level === 'warn').length
  const srcText = p.byTrace ? 'trace ' + (lines.find((l) => l.row.traceId)?.row.traceId.slice(0, 8) ?? '') + '…' : p.all ? 'ทุก service' : p.selected.length === 1 ? p.selected[0] : `${p.selected.length} service`
  const podText = p.byTrace ? 'ทุก pod' : noPods ? 'ยังไม่ได้เลือก pod' : !p.podSel ? 'ทุก pod' : p.podSel.length === 1 ? `pod ${podShort(p.podSel[0])}` : `${p.podSel.length} pod`
  const head = cursor ? (
    <div className="ln-more">
      <button type="button" onClick={() => void loadOlder()} disabled={older.loading}>
        {older.loading ? 'กำลังโหลด…' : `↑ โหลดเก่ากว่า ${fmtCount(p.pageSize)} บรรทัด`}
        {!timeline && total > lines.length ? ` (ยังมีอีกราว ${fmtCount(Math.max(0, total - lines.length))} ในช่วงนี้)` : ''}
      </button>
      {older.error ? <span className="ln-more__err">โหลดไม่ได้: {older.error}</span> : null}
    </div>
  ) : (
    <div className="ln-note">
      <div>── เริ่มช่วงเวลา {fmtTimeSec(p.fromMs)} ICT ──</div>
    </div>
  )

  return (
    <>
      <MinuteStrip buckets={data.histogram} stepMs={p.stepMs} fromMs={p.fromMs} toMs={p.toMs} outages={p.byTrace ? [] : p.outages} visible={visible} onJump={(a, b) => void jump(a, b)} />
      <div
        className={['lc-body', merged ? 'is-merged' : '', wrap ? '' : 'is-nowrap', timeline ? 'is-timeline' : '', pending ? 'is-pending' : ''].filter(Boolean).join(' ')}
        id="lc-body"
        ref={body}
        role="log"
        aria-live="off"
        tabIndex={0}
        aria-label="บรรทัด log เก่าอยู่บน ใหม่อยู่ล่าง"
        onScroll={onScroll}
        onClick={onClick}
        onMouseOver={onOver}
        onMouseLeave={onLeave}
      >
        {noPods ? (
          <div className="ln-note">
            <div>ยังไม่ได้เลือก pod · เลือกจากปุ่ม Pod ด้านบน</div>
          </div>
        ) : (
          head
        )}
        {p.byTrace ? (
          <div className="ln-note">
            <div>
              แสดงทุก service และทุก pod เพราะกรองตาม trace: เห็นเส้นทางของ request นี้ครบ ·{' '}
              <button type="button" onClick={actions.clearGrep}>
                ล้างตัวกรอง
              </button>
            </div>
          </div>
        ) : null}
        {onScreen.map((it) =>
          it.kind === 'sep' ? (
            <SepLine key={it.key} sep={it.sep} />
          ) : it.kind === 'line' ? (
            <RawLine
              key={it.key}
              line={it.line}
              ctx={ctx}
              terms={p.terms}
              selected={sel === it.key}
              open={openLines.has(it.line.id)}
              fresh={fresh.has(it.line.id)}
              detail={openLines.has(it.line.id) ? detailOf(it.line) : null}
            />
          ) : (
            <RequestBlock
              key={it.key}
              g={it}
              ctx={ctx}
              terms={p.terms}
              open={groupIsOpen(it)}
              selected={sel === it.key}
              openLines={openLines}
              detailOf={detailOf}
              actions={
                <>
                  <Link href={buildHref(`/traces/${it.trace}`, p.keep)}>
                    เปิด trace (timeline) <kbd>t</kbd>
                  </Link>
                  <button type="button" onClick={() => actions.rawTrace(it.trace)}>
                    ดูเป็นบรรทัดดิบ <kbd>l</kbd>
                  </button>
                  {it.errLine?.row.fingerprint ? <Link href={buildHref(`/errors/${it.errLine.row.fingerprint}`, p.keep)}>ดู error group</Link> : null}
                  <CopyAct text={() => groupText(it.trace)}>
                    คัดลอกแบบ terminal <kbd>y</kbd>
                  </CopyAct>
                </>
              }
            />
          ),
        )}
        {!recs.length && !noPods ? (
          <div className="ln-note">
            <div>
              {actions.hasGrep ? (
                <>
                  ไม่มี{unit}ที่ตรงกับตัวกรองในช่วงนี้ ·{' '}
                  <button type="button" onClick={actions.clearGrep}>
                    ล้างตัวกรอง
                  </button>
                </>
              ) : (
                `ไม่มี log ในช่วงนี้`
              )}
            </div>
          </div>
        ) : null}
      </div>

      <button className={newN > 0 && !follow ? 'lc-pill is-on' : 'lc-pill'} type="button" onClick={() => setFollow(true)} hidden={!(newN > 0 && !follow)}>
        ↓ {fmtCount(newN)} {timeline ? 'request ใหม่' : 'บรรทัดใหม่'}
      </button>

      <div className="lc-help" hidden={!help}>
        <dl>
          {HELP.map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <div className="lc-status">
        <span className={follow ? 'lc-status__live' : 'lc-status__live is-paused'}>{follow ? (p.live ? 'สด · ตามล่าสุด' : 'ตามล่าสุด') : 'หยุดตาม · กำลังอ่านย้อนหลัง'}</span>
        <span>
          <b>{srcText}</b> · {podText}
        </span>
        {timeline ? (
          <span>
            <b>{fmtCount(groups.length)}</b> request · <span className="t-danger">{fmtCount(groups.filter((g) => rankOf(g.level) >= 3).length)} มี error</span> · {fmtCount(shownLines)} บรรทัด
          </span>
        ) : (
          <span>
            <b>{fmtCount(recs.length)}</b> บรรทัด · <span className="t-danger">{fmtCount(errN)} ERR</span> · <span className="t-warn">{fmtCount(wrnN)} WRN</span>
          </span>
        )}
        {data.hidden && !p.noise ? (
          <span>
            ซ่อน noise {fmtCount(data.hidden)} บรรทัด{' '}
            <button type="button" onClick={actions.showNoise}>
              แสดง
            </button>
          </span>
        ) : null}
        {pending ? <span>กำลังโหลด…</span> : null}
        <span className="lc-status__keys">
          <span>
            <kbd>/</kbd> กรอง
          </span>
          <span>
            <kbd>j k</kbd> เลื่อน
          </span>
          <span>
            <kbd>↵</kbd> เปิด
          </span>
          <span>
            <kbd>v</kbd> มุมมอง
          </span>
          <button type="button" onClick={() => setHelp((h) => !h)}>
            <kbd>?</kbd> คีย์ลัดทั้งหมด
          </button>
        </span>
      </div>
    </>
  )
}

const HELP: Array<[string, string]> = [
  ['/', 'กรองบรรทัด'],
  ['j  k', 'request / บรรทัดถัดไป, ก่อนหน้า'],
  ['Enter', 'เปิด/ปิด request หรือรายละเอียดบรรทัด'],
  ['v', 'สลับ Timeline / บรรทัดดิบ'],
  ['t', 'เปิด trace (timeline)'],
  ['l', 'ดู request นี้เป็นบรรทัดดิบ (ทุก service)'],
  ['y', 'คัดลอกแบบ terminal'],
  ['e', 'เฉพาะ WRN + ERR / ทั้งหมด'],
  ['f', 'ตามบรรทัดล่าสุด เปิด/ปิด'],
  ['1–9  0', 'เฉพาะ service นั้น / ทุก service'],
  ['p', 'วน pod (ทุก pod → ทีละตัว)'],
  ['Esc', 'ปิดรายละเอียด ล้างตัวกรอง'],
]

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
