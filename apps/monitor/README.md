# @skilllane/monitoring-monitor: skilllane monitor

The Next.js frontend of the approved design in `design/monitoring-ui/` (screens, tokens, components, Thai copy).
It reads the skilllane-monitoring engine query API (`SPEC.md` §8). Product name in the UI: **skilllane monitor**. Backend names
are skilllane-monitoring (`@skilllane/*`, ClickHouse db `skilllane_monitoring`).

Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript strict. No Tailwind, UI kit, chart library or state
library. Server components by default; client components only for interaction. `three@0.170.0` for the 3D views.

```bash
pnpm install                                  # from the repo root (apps/* is a workspace)
pnpm --filter @skilllane/monitoring-monitor sync-design       # copy design assets in (see "Design sync")
pnpm --filter @skilllane/monitoring-monitor build             # next build (type-checks)
pnpm --filter @skilllane/monitoring-monitor start             # next start -p 3300
scripts/live.sh monitor                       # (re)start the monitor of the live stack on :3300 (production by default)
```

`scripts/live.sh` runs the monitor in **production mode by default** (`MONITOR_MODE=start`, the way it is demoed):
`start`, `restart` and `monitor` first run `pnpm --filter @skilllane/monitoring-monitor build` when `.next` is missing or older than any
file under `apps/monitor` (app, components, lib, public, scripts, config; log `.demo/monitor-build.log`), then
`next start -p 3300`. `MONITOR_MODE=dev scripts/live.sh monitor` gives `next dev` (hot reload). `monitor` restarts only
the monitor and needs the stack running (else it says `stack is not running; use start`); `status` prints the mode and
whether the sources changed since the build. It never builds or starts over another process holding :3300.

`ENGINE_URL` (default `http://localhost:5100`): server code reads it per request. The browser goes through
`/engine/*` → `${ENGINE_URL}/api/*` (a rewrite fixed at **build** time). Port 3300 belongs to the live stack; for a
private check run `next start -p 3399` (or another free port) and stop it afterwards.

## What lives where

```
app/
  layout.tsx            shell: fonts, theme boot script, AppFrame > Sidebar + Topbar + <main>; fetches /api/meta + /api/health
  design-system.css     GENERATED from design/monitoring-ui/assets/styles.css: tokens + every component class. Do not edit.
  app.css               app-only additions (font wiring, custom range form, skeleton layouts); prefixes shell- / ui-
  page.tsx              / → /overview (next.config.ts redirect does it as a real 307)
  loading.tsx           page skeleton while a screen loads (a screen may add its own loading.tsx)
  error.tsx             last-resort boundary (Thai panel inside the shell)
  not-found.tsx
  overview/  logs/  traces/  traces/[traceId]/  errors/  errors/[fingerprint]/  jobs/  about/
      page.tsx + screen.css   one folder per screen; the screen's agent owns app/<route>/** only
  icon.svg              favicon (the brand mark)
  dev/components/       internal gallery: every shared component with demo data, motion demo, both 3D views (not in the nav)
components/             shared UI (documented at the top of each file)
  shell/                AppFrame (nav state, inert, live region, tooltips, MotionRoot), Sidebar, NavLinks, Topbar, names
  charts/               ChartFrame + Legend + ChartTable, TimeBars, TimeLine, KpiSpark, SparkBars, SparkLine
  Motion.tsx            the design's motion layer: MotionRoot, ChangedValue, LiveTbody, useNewKeys, reveal/replay/flash
  SystemMap3D.tsx  Pipeline3D.tsx   3D views (next/dynamic, ssr: false) · three/ = the mounted scenes + skeleton
  network/              the trace Network view (DevTools-like, see "Network view"): NetworkTable, SpanIoPanel,
                        BodyView, JsonTree, QueryView, Masked
lib/
  engine.ts             server-only typed engine calls        engine-client.ts  client calls via /engine/*
  types.ts              response + query types of every endpoint (from apps/engine/src/query/*.ts)
  params.ts             search params: parse/validate, scope (env + range), defaults per screen, hrefs
  format.ts             ICT times, durations, counts, percents, Thai relative time
  readable.ts           readable error rule (title, key=value chips, fix, actual) + Copy-for-AI template, event titles,
                        queue-system / dependency-type names (MODULE_LABEL, moduleName, systemLabel)
  stack.ts              error_stack: app frames first, short paths without the home directory, aiStack()
  services.ts           fixed service colour slots        chart.ts  chart geometry + tipAttrs()
  freshness.ts          newest line per env from /api/meta releases (latestByEnv, freshness, isActiveEnv): the sidebar
                        "ข้อมูลล่าสุด" / "สด" / "ไม่มีข้อมูลใหม่ …" and the top bar's env select (main options = envs
                        with data in the last hour on every screen; the others behind "env ที่ไม่มีข้อมูลใน 1 ชม. (n)…")
  topology.ts           GET /api/topology → SystemMap3D data (systemMapFromTopology), readable node labels
                        (topologyLabels), node ids (serviceNodeId, dependencyNodeFor), phoneMapData
  io.ts                 captured I/O of spans (pure): Network rows (netRowsOf, ioTypeOf), the span detail of
                        GET /api/traces/:id/spans/:spanId (normalizeSpanDetail, detailFromSpan, hasCapture), body
                        helpers (bodyKind, prettyText re-indent without parsing, parseJsonExact, multipartOf,
                        formPairs, fmtBytes), masked values (splitMasked, countRedacted), footer totals (ioTotals),
                        Copy as cURL (curlOf)
  sql/                  scan.ts (tokens: strings, quoted identifiers, comments, placeholders per dialect), format.ts
                        (formatSql, sqlHead), full-query.ts (buildFullQuery, sqlLiteral: the runnable FULL QUERY)
  motion.ts             data-motion boot script, REVEAL_SELECTOR, motionOn()
  theme.ts  announce.ts url.ts
  3d/                   GENERATED system-map.js + .css from the design (+ APP_PATCHES of scripts/sync-design.mjs);
                        system-map.d.ts is hand-written
public/DATA-DICTIONARY.md   GENERATED copy of docs/DATA-DICTIONARY.md (sidebar "พจนานุกรมข้อมูล")
scripts/sync-design.mjs
proxy.ts                a page request for an unknown /errors/<fingerprint> or /traces/<traceId> (none anywhere in the
                        engine's 90 days, or a malformed id) answers HTTP 404 with app/not-found.tsx (see the file)
```

## Building a screen

Each screen is a server component that reads its search params, calls the engine, and renders the mockup's markup
with the shared components. Start from your placeholder `app/<route>/page.tsx` and the mockup
`design/monitoring-ui/<screen>.html`. Copy markup and Thai copy from the mockup; replace the canonical demo numbers
with engine data.

```tsx
import type { Metadata } from 'next'
import { AutoRefresh } from '@/components/AutoRefresh'
import { PageHead } from '@/components/PageHead'
import { EngineErrorState, ParamProblems } from '@/components/states'
import { engine, getMeta } from '@/lib/engine'
import { Params, parseScope, scopeQuery, type RawSearchParams } from '@/lib/params'
import { serviceOrder } from '@/lib/services'
import './screen.css'

export const metadata: Metadata = { title: 'Log' }          // → "Log · skilllane monitor"

export default async function LogsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()                              // cached per request (the layout already asked)
  const scope = parseScope(sp, 'logs', { envs: meta.ok ? meta.data.envs : undefined })
  const p = new Params(sp)
  const level = p.levels()                                  // ?level=warn,error
  const q = p.str('q')
  const res = await engine.logs({ ...scopeQuery(scope), level: level?.join(','), q, limit: 100 })
  const order = serviceOrder(meta.ok ? meta.data : null)    // pass to ServiceChip / svcClass
  return (
    <>
      <PageHead scope={scope} title="Log" question="ทุกบรรทัด log ตามเวลา: …" actions={<AutoRefresh />} />
      <ParamProblems problems={[...scope.problems, ...p.problems]} />
      {res.ok ? <LogTable rows={res.data.rows} order={order} keep={scope.keep} /> : <EngineErrorState error={res.error} />}
    </>
  )
}
```

### Fetching

- **Server components call `engine.*`** from `lib/engine.ts` (`health, meta, overview, logs, traces, trace(id),
  errors, error(fp), jobs, dependencies, topology`; `engineGet<T>(path, query)` for anything new). Every call resolves to
  `{ ok: true, data, ms } | { ok: false, error }`, `no-store`, 8 s timeout. Run independent calls with `Promise.all`.
- **A failed call is a normal state**: render `<EngineErrorState error={res.error} />` (Thai, names the engine URL,
  retry button; 400 shows the engine's message, 404 says not found). Never throw for engine errors; `app/error.tsx`
  is only for bugs. For a block that can fail on its own, render the error state in that block only.
- `getMeta()` / `getHealth()` are React-`cache`d per request: call them freely.
- Client components that must fetch (load more, polling one block) use `clientGet<T>('/logs', query)` from
  `lib/engine-client.ts` (same result shape, goes through `/engine/*`).
- Refresh: `<AutoRefresh />` (page-head actions) calls `router.refresh()` every 30 s, keeps the old view meanwhile
  (no flash), pauses on hidden tabs, and has a pause toggle. Overview, Logs, Errors and Jobs should have it, except for
  a fixed past window (`isPastWindow(scope)`, an ISO `to` before now): its numbers never change, so no button and no
  timer (`{isPastWindow(scope) ? null : <AutoRefresh />}`).
- Field types: `lib/types.ts` (final engine API of 18 ต.ค.: traces `total` / `totalErrors` / `sample` / `job` /
  `httpRoute`, logs `httpStatus` / `requestDurationMs`, routes `method` / `path`, `ErrorGroup.spark` + `ErrorSpark`,
  dependency `degraded` + `outboundFailures`, `Topology`; later: traces `totalTraces` / `totalErrorTraces` /
  `totalSlow` + rows `downstream` (`entries=top`, the default, leaves downstream hops out), `ErrorGroup.roles`).
  When the engine adds fields, add them there (additive only). `errorRate` is a ratio. Series buckets start at
  `from` rounded down to the minute (`RangeInfo` doc); ErrorSpark buckets are laid back from `to` (`ErrorSpark` doc).

### Search params

- `parseScope(sp, screen, { envs })` → `Scope { env?, from, to?, fromMs, toMs, nowMs, preset, service?, role?, keep, problems }`.
  Defaults: env = `prod` when `/api/meta` lists it (`env=all` = every env, `scope.env` undefined); range = the
  screen's default: overview / logs / traces `now-1h`, errors / jobs (and their details) `now-24h`. `scopeQuery(scope)`
  gives `{ env, from, to, service, role }` for the engine.
- Screen params: `new Params(sp)` with `str(name, max)`, `name()`, `int()`, `number()`, `oneOf()` (case-insensitive,
  returns the allowed spelling: `durationMs`), `levels()`, `list()`, `event()` (code, `job.*` prefix or comma list),
  `traceId()`, `traceIdPrefix()` (4–32 hex, the traces filter), `fingerprint()`, `time()`, `flag()`, `step(rangeMs)`. Invalid values become `undefined` and land in `p.problems`; show them with
  `<ParamProblems problems={…} />` instead of sending them to the engine.
- Use the engine's names for params that map 1:1 (`level, q, event, traceId, userId, route, category, fingerprint,
  status, minMs, kind, sample, step, limit, before`; errors also `sort=count|lastSeen|firstSeen` and `sparkBuckets`,
  traces `sort=timestamp|durationMs`). `route` is `METHOD /path` (e.g. `GET /classes/:id/report`) or a job key
  (`report report:generate`). UI-only state uses short names: `tab`, `sort` (when it is not the engine's), and one
  drawer param per screen (`drawer=<key>` or a meaningful name like `log=<id>`).
- The top bar owns `env`, `from`, `to`: it keeps the screen and its other params, and drops `before` / `cursor`.
- A past window (`isPastWindow(scope)`) speaks about itself: "ล่าสุดในช่วงนี้" (ErrorGroup.lastSeen covers all retained
  data, so errors use the last occurrence inside the window, `lastInWindow` in `app/errors/_lib/errors.ts`), never
  "ยังเกิดอยู่", and the Copy-for-AI text says `last in window …` (plus `last overall …` when it happened again later).

### Links

- Never hand-build query strings. `buildHref(path, scope.keep, extra)` keeps env / from / to **only when they are in
  the URL** (so Errors keeps its 24 h default unless the user picked a range): `buildHref('/traces', scope.keep, { route: 'GET /me' })`.
- Same screen, change filters: `withParams(pathname, sp, { level: 'error', before: null })` (null / '' removes).
- Detail pages: `/traces/<32-hex traceId>` (`?span=<spanId>` selects a span; `?view=network` shows the Network table;
  `?io=<spanId>` opens that span's request / response panel in either view (a span without I/O opens its nearest
  ancestor that has; the page removes `io` when the panel closes, so a reload or a copied link shows what was on
  screen), `&tab=headers|payload|preview|response|timing|query|message` a tab of it; the default tab of the span's
  type is left out), `/errors/<fingerprint>`; logs of a user
  `/logs?userId=u_1029`, of a trace `/logs?traceId=…`, of a group `/logs?fingerprint=…`, of a job (every attempt)
  `/logs?jobId=2009&route=report report:generate`; jobs sections `/jobs#queues`, `#failures`, `#dependencies`, one
  dependency row `#${depAnchor(name)}` (lib/params.ts); `/about` (also the brand link) describes the system. Use `next/link` (`<Link>`), `scroll={false}` for in-page filter changes.
- Jump box (top bar): 32 hex → `/traces/<id>`, `u_…` → `/logs?userId=`, else `/logs?q=`. `/` focuses it.

### CSS

- `app/design-system.css` is generated: never edit it. Use its classes and tokens (`var(--…)`, never hex).
- Screen CSS = the mockup's `<style>` block, ported into **`app/<route>/screen.css`**, imported by that page only.
  Keep the mockup's prefix: overview `ov-`, logs `lg-`, traces `tr-`, trace detail `td-`, errors `eg-`,
  error detail `ed-`, jobs `jb-`. No unprefixed / global selectors, no `:root` tokens in screen CSS.
- A class two screens need belongs in the design (`design/monitoring-ui/assets/styles.css`, DESIGN.md §5b): ask the
  design owner, then `sync-design`. App-only shared CSS (not in the mockups) goes in `app/app.css` with `ui-`
  (the Network view: `ui-nw-*`, e.g. `ui-nw-masked` the masked-value chip, `ui-nw-warn`, `ui-nw-trunc`, `ui-nw-sheet`
  the panel; candidates for the design if another screen needs them).
- Layout rules from DESIGN.md: 400 px wide never scrolls sideways (`.table--reflow` with `data-label` / `rf-hide`,
  or `.table-wrap`), light and dark both first class, Thai line-height ≥ 1.4.

### Shared components (`components/`)

| Import | Signature (props) | Notes |
|---|---|---|
| `PageHead` | `{ scope, title, question?, when?, crumbs?: {label, href?, mono?, title?}[], meta?, metaClassName?, metaFirst?, actions?, copyLink? = true }` | crumbs start with "skilllane monitor"; subline = question · env · range (`when` replaces the range on detail pages) |
| `CopyButton`, `CopyLinkButton` | `{ text? \| targetId? \| currentUrl?, label?, ariaLabel?, variant?: default\|quiet\|primary\|cta\|icon\|icon-md, size?: 'sm', icon?: copy\|link }` | "คัดลอกแล้ว" for 1.6 s + live region (`.is-copied`; `.is-copy-manual` 4 s without clipboard); copy-link copies the real URL. `cta` = SkillLane orange `.btn--cta`, at most one per page (the page-head "คัดลอกให้ AI" in errors, error detail, trace detail; the drawer-foot CTA in logs and jobs) |
| `badges` | `LevelBadge {level}` · `Method {method}` · `HttpStatus {status}` · `CategoryChip {category}` · `NewBadge {since?}` · `EnvTag {env?}` · `Tag` · `StateChip {state: ok\|warn\|down\|unknown}` · `ServiceChip {service, role?, order?}` · `ServiceDots {services, order?}` · `Ts {value, format?: ms\|sec\|min\|date\|date-ms}` · `Live {children? = 'สด', title?}` | service colour = fixed slot (`lib/services.ts`); `Live` = `.live` pulsing dot |
| `Panel`, `Section` | `Section { id?, title, meta?, actions? }` · `Panel { title?, meta?, actions?, foot?, flush?, as? }` | `flush` for tables / lists edge to edge |
| `Kpis`, `Kpi` | `Kpis { cols?: 3\|4\|5, label? }` · `Kpi { label, icon?, value: number\|node, decimals?, unit?, foot?, delta?: {text, tone?: bad\|good}, spark?: number[], sparkBad?, tone?: alert\|warn, href?, linkLabel? }` | numbers count up (`AnimatedNumber`) |
| `AnimatedNumber` | `{ value, decimals?, duration? = 700 }` | client; SSR shows the final value; skips under reduced motion / `data-motion="off"` |
| `table` | `TableWrap { scroll?, label? }` · `Table { dense?, reflow?, caption? }` · `SortTh { label, href, dir?, num? }` · `NumCell { label? }` · `DurBar { start?, width, color?, tone? }` · `DurCell { ms, max, tone? }` | rows: `tr.is-bad / .is-slow / aria-current="true"` |
| `ExpandRow` | `{ cells, detail?, colSpan, label, className?, defaultOpen?, toggleCellClassName?, dataKey?, rowId?, current?, rowOpens?, detailClassName?, detailSpansToggle?, onToggle? }` | client; `button.row-toggle` + `tr.row-detail`; `rowOpens="a.lg-title"` = a click on the row clicks that element; `onToggle(open)` to lazy-load the detail; no `detail` = a plain row |
| `ErrorParts` | `KvList { items: Kv[], className? }` · `ErrorDetailText { text, label? }` · `ActualError { text }` · `IdChip { label, value, href?, copy? = true, display? }` | data from `lib/readable.ts`: `logTitle`, `logKvs`, `logDetail`, `actualError`, `groupTitle`, `groupKvs`, `groupDetail` |
| `states` | `EmptyState { title, text?, icon?, actions? }` · `EngineErrorState { error, inPanel? = true, onRetry?, actions? }` · `NotFoundState { title?, text?, links: {href, label}[], heading? }` · `ParamProblems { problems }` · `Skeleton { width?, height?, variant?: title\|text\|short\|kpi\|chart\|row }` · `SkeletonText` · `KpiSkeleton` · `TableSkeleton` · `PageSkeleton` | skeletons use the design's `.skel` (shimmer while motion is on). `onRetry`: a client block that fetched itself passes its refetch ("ลองใหม่" otherwise only runs `router.refresh()`, which never re-runs a client fetch); `actions`: links first (back to the list on a 404). `NotFoundState` = the one not-found state (unknown page, error group, trace): Thai title, why, links built with `buildHref(…, scope.keep)` |
| `Drawer`, `DrawerLink` | `Drawer { id, param? = 'drawer', value, title, sub?, foot?, wide?, children }` · `DrawerLink { param?, value, className?, ariaLabel? }` · `rememberDrawerOpener(el)` | open state in the URL; modal (inert app, Tab trap, Esc / scrim / ×), focus returns; render the Drawer only for the selected item, on the server |
| `Tabs`, `TabInk` | `{ items: {key, label, count?, title?, panel}[], label, param?, defaultKey?, className? }` · `TabInk {}` | client; arrow keys; `param` keeps the tab in the URL (instant switch, history.replaceState, no server round trip); the ink bar slides. Link tabs: `<div className="tabs"><Link className="tab" aria-current="page">…<TabInk /></div>` |
| `ParamControls` | `ParamSegmented { label, param, options }` · `ParamToggleChip { param, value, label, count?, multi?, all?, className? }` · `AppliedChip { param, label, value }` · `useParamNav(reset?) → { sp, go }` | URL filters (drop the paging: `before`, `cursor`, `limit`); `all` = no param means every value pressed; free text = plain `<form method="get">` |
| `Tooltip` | `data-tip` + `data-tip-keys` on any element (build with `tipAttrs()` from `lib/chart.ts`) · `Tip { title, lines }` | one `TooltipHost` lives in AppFrame; a tooltip shown for keyboard focus follows its element when the page scrolls (Tab to a mark below the fold) |
| `AutoRefresh` | `{ seconds? = 30 }` | client |
| `useInView` | `useInView<T>({ once? = true, rootMargin?, threshold? }) → [ref, inView]`; `motionAllowed()`, `prefersReducedMotion()` | client hooks |
| `Motion` | `MotionRoot` (in AppFrame) · `ChangedValue { value, children?, as?, className? }` · `LiveTbody { children, resetKey?, className?, id? }` · `useNewKeys(keys, resetKey?) → Set` · `reveal(el)` `replay(el)` `flash(el)` | see "Motion and 3D" |
| `SystemMap3D` | `{ data: SystemMapData, serviceOrder?, height? = 460, narrowHeight? = 520, compactLabels?, legend?, legendOpen?, controls?, autoRotate?, highlight?, ariaLabel?, motion?, forceFallback?, loadingText?, onSelect?, onHover?, className? }` | client; data from `systemMapFromTopology(topology, { href, thresholds, hideClients })` (`lib/topology.ts`) |
| `Pipeline3D` | `{ transport?: kafka\|rabbitmq\|bullmq, switcher? = true, links?: {app, queue, engine, clickhouse, monitor, ai}, here? = 'monitor', height? = 380, narrowHeight? = 620, legend?, legendOpen?, controls?, autoRotate?, ariaLabel?, motion?, forceFallback?, loadingText?, onTransportChange?, onSelect?, className? }` | client |
| `icons` | `Icon { name, size?: sm\|lg, className? }`, `BrandMark` | paths from components.html; add new ones there in the same style |
| `charts/ChartFrame` | `{ title, titleId, sub?, legend?: {label, className?, color?, shape?}[], bare?, timeAxis? = true, foot?, table?: {caption, columns, rows, textColumns?, rowHrefs?, rowLinkLabel?} }` | `figure.chart`; the plot scrolls inside itself on phones, starting at the newest bucket. Bucket links on the chart are mouse / touch only: pass the same hrefs as `table.rowHrefs` (in row order) so keyboard users open a bucket from the table's time cell |
| `charts/TimeCharts` | `TimeBars { buckets: {t, values[]}[], series: {key, label, className?, color?, tipKey?}[], stepSeconds, labelledBy?, frame?, formatValue?, formatTime?, events?, bands?, yTicks?, bucketTips?, bucketHrefs? }` · `TimeLine { buckets: t[], series: {…, values[], area?}[], … endLabel? }` | several series in TimeBars stack bottom-up; hover column per bucket; `bucketTips` = one tooltip per bucket with several measures; `bucketHrefs` + a `<BucketLinks>` wrapper (charts/BucketLinks) = click a bucket to open it (also give the table `rowHrefs`); counts (every value whole) get whole y ticks (`niceScale(max, n, { integer })` in lib/chart.ts; default: integer when `max` is whole) |
| `charts/Sparkline` | `KpiSpark { values, bad? }` · `SparkBars { values, label, maxLabel?, color?, highlight?, highlightColor?, tip? }` · `SparkLine { values, label, width?, height?, color?, tip? }` | `tip` = data-tip of the whole sparkline (`tipAttrs(…)['data-tip']`), makes it focusable |

Format helpers (`lib/format.ts`): `fmtTimeMs` `14:18:07.412`, `fmtTimeSec`, `fmtTime` `14:18`, `fmtDate` `17 ต.ค.`,
`fmtDateTime` `17 ต.ค. 14:18`, `fmtDateTimeMs`, `fmtRange` `17 ต.ค. 13:20–14:20 ICT`, `fmtDuration` `84 ms` / `1.8 s`,
`fmtMs` `1,842 ms` (waterfall, trace lists, kv chips), `fmtCount` `14,210`, `fmtNumber(n, digits)`, `fmtCompact` `1.5K`,
`fmtPercent(ratio)` `0.16 %`, `fmtRelative` `5 นาทีที่แล้ว`, `shortId`, `fmtAiTime` `2026-10-17 14:18:09.226 ICT` (Copy for AI;
`{ ms: false }` → `2026-10-17 14:18`), `fmtRate` / `fmtPct` (the 3D map's `< 0.1`, `0.1 %`, so a table prints what the map
prints). Never format times with `toLocaleString`.

### Charts

Follow DESIGN.md §7: one y axis, hairline grid, round ticks, a hover column per bucket and a `ChartTable`. Set the
viewBox width to the width the chart renders at in a 1440 px window (`frame={{ width: 360 }}` for a half-width chart;
the default 740 is the overview's main column). The svg gets `--chart-min` = 90 % of it, so a narrower container
scrolls the plot instead of shrinking the text. Series colour by job: service → `className: 'svc-N'` (from
`svcClass(service, order)`), log level → `c-lvl-dbg … c-lvl-ftl`, status → `color: 'var(--danger-solid)'`.

### Motion and 3D

- **Switch.** `<html data-motion="on|off">` is set in `<head>` before first paint (`lib/motion.ts`
  `MOTION_BOOT_SCRIPT`): off for `?motion=off`, prefers-reduced-motion, no IntersectionObserver or headless Chrome
  (CLI screenshots), `?motion=on` forces it on. Under off every `--dur-*` token is 0 ms and nothing waits for a
  reveal. If React has not started within 5 s, the boot script switches motion off so nothing stays hidden.
- **Reveal.** `MotionRoot` (in AppFrame) watches every `.chart, .kpi, .spark-inline, .wf, .dur, .badge-new,
  [data-mo]` (also ones that arrive later: client navigation, auto refresh) and adds `.is-in` the first time it
  scrolls into view, then dispatches `mo:in` on it. Screens get the entrances by using the shared components or
  these classes (the trace waterfall `.wf` with `--s` on its bars, `.dur` bars, a `[data-mo]` block of your own).
  It never touches markup before React has hydrated it, and puts `.is-in` back when React rewrites a className.
- **Charts** render their motion markup themselves (`svg[data-mo-ready]`: bar baselines + `--mo-x`, `pathLength=1`
  + `.mo-draw`, the end dot `.mo-now` with a `.mo-ring` that breathes 3 times). Other svgs inside a reveal target
  are prepared on reveal like app.js does.
- **Numbers.** `Kpi` / `AnimatedNumber` count up from 0 (600 ms, numbers ≥ 10 or with decimals) on first view; a
  later change (auto refresh) shows the new value and flashes it (`.is-changed`). Any other value:
  `<ChangedValue value={x}>…</ChangedValue>`. A plain number with `data-mo-count` in a reveal target counts up too.
- **Live data.** `<Live />` = the pulsing `.live` "สด"; the sidebar "ข้อมูลล่าสุด" time flashes on refresh. New rows:
  server tables use `<LiveTbody resetKey={filters}>` with `data-key` on each `<tr>` (rows not there before the last
  render get `tr.is-new` for 2 s); client lists use `useNewKeys(keys)`.
- **CSS-only** (nothing to do): tab panels fade, `details` open/close animates its height, expanded rows drop in
  (`.row-detail__body`), the copy check draws, drawers and the mobile nav slide, skeletons shimmer, the `.badge-new`
  glint. `[data-mo-replay="#id"]` buttons replay an entrance (`replay(el)` from code; `window.skMonitor` exists too).
- **3D.** `<SystemMap3D data={systemMapFromTopology(topo.data, { href })} serviceOrder={serviceOrder(meta)} />` and
  `<Pipeline3D transport=… links=… />` (both client, next/dynamic with `ssr: false`; `system-map.css` is imported
  by app/layout.tsx). They show a skeleton of the same height, mount when within 240 px of the viewport, update in
  place when `data` changes (auto refresh keeps the camera), keep a still frame when motion is off, follow app-path
  links with the router, and destroy renderer + context on unmount. Callbacks / `highlight` need a client parent.
  `/overview` (placeholder) and `/dev/components` show both with live data. Types: `lib/3d/system-map.d.ts`.

### Network view (captured request / response, SQL binds, messages)

The trace detail's section has a Waterfall | Network switch (`?view=network`). Data:
- Rows: `netRowsOf(wfSpans)` (`lib/io.ts`) keeps the spans with I/O (`ioTypeOf`: `http-in` SERVER, `http-out` CLIENT
  HTTP, `db`, `redis`, `queue` PRODUCER / CONSUMER / job) in waterfall order. Sizes come from `SpanRow.io` of
  `GET /api/traces/:id` (lengths only); an all-zero `io` = recorded before capture, shown as `–`, never `0 B`.
- Panel: `engine.span(traceId, spanId)` on the server for the span in the URL (so a link opens filled), then
  `clientGet('/traces/:id/spans/:spanId')` once per span (cached for the page, a 404 remembered); read either with
  `normalizeSpanDetail(raw, span)` → `SpanDetail { span, http, db, message, timing }`. While it loads, or when nothing
  was stored, `detailFromSpan(span, offsetMs)` shows what the trace knows ("ยังไม่ได้บันทึก" vs "ไม่มี").
- `components/network/`:

| Component | Props | Notes |
|---|---|---|
| `NetworkTable` | `{ rows: NetRow[], total, order, selectedId, openId, onPick(id, open) }` | DevTools columns Name · Method · Status · Type · Size · Time · Waterfall; filter chips per type; ↑ ↓ Home End select (an open panel follows), Enter opens; row ids `nw-row-<spanId>` (`rowDomId`); footer `request · response · message` totals of the shown rows from `ioTotals(rows)`: each exchange once (an incoming request whose calling `http-out` row is shown is that call; a consumer whose producer row is shown, and every attempt of one job / message id, is one message), `–` when no size is known |
| `SpanIoPanel` | `{ traceId, row, inner, total, order, initial?, initialMissing?, onClose, onOpen, headingRef? }` | DevTools tabs: HTTP Headers (General · Response · Request) / Payload / Preview / Response / Timing + Copy as cURL; DB / Redis Query; queue / job Message; a failed row says why under its title (exception type + message, else status message: `ORA-12899 …`, the job attempt's `GaxiosError …`); `?tab=` kept when another row opens; docked beside the list from 1280 px, a sheet (focus kept inside, Esc) below |
| `BodyView` | `{ body: IoBody \| null, mode: 'tree' \| 'raw', label, empty }` | content-type, real size, "แสดง 64 KB แรก (ขนาดจริง …)" when cut, [REDACTED] count, copy (always the stored text); `tree`: JSON tree (`parseJsonExact`: a number that would not print back as written, like a 64-bit id, stays its source text), form rows, multipart summary, `text/html` rendered in an `iframe sandbox=""` with a CSP that loads nothing (source toggle), text; `raw` (Response): the stored text, Raw by default, Pretty = `prettyText` re-indent without parsing (values, key order and repeated keys as written, also on a cut body); size-only bodies say binary, stream or not stored; renders 128 K characters at a time |
| `JsonTree` | `{ value, label, openDepth? = 2 }` | collapsible, 100 children at a time; draws a `RawNumber` as written |
| `QueryView` | `{ db: SpanDbIo, id, redis? }` | formatted statement (copy = original), bind table (key · column · type · value, a date also read in ICT), FULL QUERY (`buildFullQuery(statement, params, dialect)`; shown on the formatted statement, copy = on the original lines) with warnings that count the `[REDACTED]` values to replace before running, the values the SDK cut (`DbParam.truncated`) and the placeholders without a value; a date bind is written as its UTC instant converted to the session time zone when it runs (Oracle `CAST(FROM_TZ(TIMESTAMP '…', '+00:00') AT TIME ZONE SESSIONTIMEZONE AS TIMESTAMP)`, PostgreSQL `TIMESTAMPTZ '…+00'`, MySQL `CONVERT_TZ(…, '+00:00', @@session.time_zone)`, SQL Server `DATETIMEOFFSET`), as the driver binds a JS Date; Oracle `:n` binds of an array (keys 1..n) match by position, `:2` before `:1` included; an Oracle string over 4,000 bytes is `TO_CLOB('…') \|\| TO_CLOB('…')`; the tab count leaves out the SDK's `…` cut marker; Redis: the command with its arguments |
| `Masked` | `MaskedText { text }` · `Pairs { pairs, label, empty? }` · `MASKED_TITLE` | every `[REDACTED]` drawn as the `ui-nw-masked` chip (masked by the SDK in the app, or by the engine's fallback at ingest) |

- Links into it (`?view=network&span=<line span>&io=<span>`): every Logs drawer line with a span. An `http.request`
  line opens its request; a line about a failure (error / fatal level, an error or fingerprint) opens the failing I/O
  under its span, failed_step first (`ioSpanOf(wf, spanId, true)` in `app/traces/_lib/model.ts`: the INSERT behind
  ORA-12899, the 429 call of a job attempt); any other line its span or the nearest one above it with I/O. The button
  names what it opens (ดู request/response · ดู query · ดูคำสั่ง Redis · ดู message ของ job). The Jobs drawer ("ดู
  message") opens the attempt's Message tab. A waterfall click on a span with I/O opens the same panel.
- `curlOf(http)` → `{ text, redacted, partial, files }` leaves out host, content-length, hop headers, the trace
  context (`traceparent`, `tracestate`, `baggage`: a replay starts its own trace instead of joining this one) and,
  when it sends the stored (decoded) body, content-encoding. It adds `--globoff` when the URL has `[ ] { }` (`ids[]=`,
  a masked `token=[REDACTED]`; curl would read them as a glob and send nothing), `-I` for HEAD, `--compressed` for an
  accept-encoding header; a multipart body becomes `--form-string 'name=value'` per stored field and
  `-F 'name=@<filename>;type=…'` per file without the stored multipart content-type (curl writes its own boundary), a
  body stored as size only `--data-binary '@request-body.<ext>'`; `files` lists the local files to put next to it.
  Masked values stay `[REDACTED]` in the command.

### Copy for AI

`aiErrorMarkdown(fields)` in `lib/readable.ts` writes the one template of DESIGN.md §6b (keys in order, empty keys
dropped); `aiFieldsOfLog(row)` fills it from a log line (`when` with the year, the queue system by name with `→ retry /
failed`, the job as `where` of a job line, the stack through `lib/stack.ts`: app frames first, no home directory).
`logTitle(row)` is the §6 title on every screen: hint, else the event title (`http.request` → `request completed`), else
the message; the prefix is the event code (the logger on `app.log`). PII rule: never user id, organization, role, body, query
string, IP or headers. Put the Markdown in a `pre.code.code--wrap` with an id and a
`<CopyButton targetId=… label="คัดลอกให้ AI" variant="cta" />` (the orange CTA: the page-head one in errors, error
detail and trace detail, the drawer-foot one in logs and jobs; at most one per page, `primary` for any other).

### Overview rules (ต้องดู · เงียบ · ต้องดูตอนนี้)

The thresholds live in `app/overview/_lib/model.ts`; the health table hint and the callouts quote them.

- **ต้องดู** (health row and map node): error rate ≥ 1 %, a NEW error group after deploy, or a route with p95 ≥ 1 s.
- **เงียบ**: a service / role with no entry span (request, job or message) for 5 min or more up to the end of the range,
  after an average of at least 1 per minute while it had traffic (`quietInRange`); or a role of the env (meta
  releases, a line in the 24 h before the range end) with no entry span in the range whose last 20 entries came at
  ≥ 1 per minute (`quietBefore`, one `/api/traces?service&role&limit=20` per candidate). Its row reads "เงียบ", a volume
  of 0 and "ไม่มี request ตั้งแต่ HH:mm (… ) · ก่อนหน้านั้นเฉลี่ย …" (never green with the range average), and it stays
  in the table when the whole range is quiet. Rarer roles (a nightly batch, a few jobs an hour) are never flagged.
- **Route error สูง**: an HTTP route with error rate ≥ 5 % over ≥ 20 requests in the range (`failingRoutes`), ranked
  by impact (failed requests, then the rate); the callout names the group most of them belong to and opens it.
- **ต้องดูตอนนี้** shows at most three callouts: one per source first, by severity (dependency down · NEW group · route
  error · เงียบ · slow route · dependency degraded · dependency recovered), then the next NEW group, route error or
  dependency; a route error whose failures are the NEW group already shown is left out. Error callouts come first.
- **Outage length**: one value on every screen, `outageUnion` (the latest window and every process's window of the
  same outage, merged): from the engine's rows when they carry `lastRecoveredAt` (rows per host:port), else from the
  recovery lines in `/api/dependencies` events[] (latest 200). The 11:40 Redis outage seen by three processes is 45.3 s.

## Design sync

`pnpm --filter @skilllane/monitoring-monitor sync-design` (re-run after the design changes; commit the output):

| From | To |
|---|---|
| `design/monitoring-ui/assets/styles.css` | `app/design-system.css` ("generated, do not edit" header; Google Fonts `@import` dropped: next/font loads IBM Plex Sans Thai + IBM Plex Mono, wired to `--font-ui` / `--font-mono` in `app.css`) |
| `assets/system-map.js`, `system-map.css` (when present) | `lib/3d/` (three.js CDN URLs rewritten to the npm package `three@0.170.0`; bare `three` / `three/addons/…` resolve through its exports) |
| `docs/DATA-DICTIONARY.md` | `public/DATA-DICTIONARY.md` (served as UTF-8 text) |

`lib/3d/system-map.d.ts` is hand-written and kept; the script warns when the module exports something it does not
declare. Without a hand-written one it generates a loose placeholder. `assets/app.js` is not copied: its behaviours
are React components here (theme toggle, motion switch + reveal, nav, drawer, tabs + ink, copy, row expand,
tooltips, chart scroll, `/` key).

**App patches.** `APP_PATCHES` in `scripts/sync-design.mjs` are fixes to the 3D module the app needs before the design
has them; each is applied on every sync, skipped (with a note to delete it) once the design contains it, and a patch
that no longer matches stops the sync. Today:
- `compact-failing-labels`: in a box under 560 px or with `compactLabels`, a node that is not ok keeps a one-line
  label `name · error %`, so failing dependencies next to the overview callouts are not crowded out by multi-line
  service labels.
- `label-priority`: in that compact box healthy queues, databases and outside APIs get no label (name in the tooltip
  and the tables; a hovered row still shows it), and a node that is not ok that finds no room next to its shape takes
  the nearest free spot further out with a leader line, so every node that is not ok is labelled first.
- `phone-overlays-below`: under 600 px the map's legend summary and toolbar sit in a row under the canvas instead of
  over it (an open legend takes room from the canvas); the renderer is sized from `.smap__stage`.

Hand them to the design owner (fold them into `design/monitoring-ui/assets/system-map.js` / `.css` and the DESIGN.md
§7c label row).

## Checks before calling a screen done

`pnpm --filter @skilllane/monitoring-monitor build` passes; `next start -p <free port>`; the screen answers 200 with the live stack
and renders `EngineErrorState` with `ENGINE_URL=http://127.0.0.1:5199`; screenshots light + dark at 1440 and 400 px
(`?theme=light|dark`, a 400 px iframe wrapper for the narrow one) compared with the mockup; no sideways scroll at 400 px.
A `Drawer` mounts on the client (portal), so a plain `--screenshot` of `?drawer=…` shows the page without it: check
drawers with a CDP-driven headless Chrome. The 3D views mount at once when motion is off (headless), so they do show.
