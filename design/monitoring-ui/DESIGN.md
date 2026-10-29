# skilllane monitor: design system

Read with `BRIEF.md` (what each screen shows, the canonical dataset) and `components.html` (live markup to copy).
Everything here is already implemented in `assets/styles.css` and `assets/app.js`. Follow it literally; if a screen
needs something that is not here, add it to the page's own `<style>` with a page prefix, never a new global class.

## 1. Visual direction

**SkillLane's own tone: white, light grey and deep green, with one orange spark.** The product carries the look of
www.skilllane.com, measured from the live site on 18 ต.ค. 2026: a plain light-grey plane (`#f5f5f5`), white panels,
`#e0e0e0` hairlines, near-black ink, and SkillLane deep green `#00532a` as both the brand and the interactive accent
(primary buttons, current nav, links, pressed chips, focus ring, selected row). The neutrals are plain greys with no tint,
as on the site, so green reads as SkillLane and as "you can click this", nothing else. The site's promo orange `#f3542a`
is used the way the site uses it: rarely. It is the single most important call to action on a page (`คัดลอกให้ AI` in the
page head, `.btn--cta`) and the queue shapes in the 3D views, never a status; the bar in the logo mark is the site's lighter
orange `#f17f23` (`--brand-hi`), which still reads on the green (3.44:1). Colour is otherwise kept for meaning: red, amber, blue
and green are status only, and status green always comes with its dot, icon or word because it shares a family with the
brand; six fixed hues identify services, re-picked so that none of them is green or orange.

Why it fits: the people using this are on call, often at night, scanning for "what broke, since when, where".
So the layout stays dense tables and thin charts on flat white panels with hairline borders, no shadows except overlays,
small radii, IBM Plex Sans Thai for Thai + English labels, IBM Plex Mono for ids, times, routes and code (the site's
Heavent and Lanna are commercial display faces, too loose for a data table; Plex keeps Thai and Latin on one baseline).
Severity is carried by visual weight (outline → tint → solid), so an ERR row stands out from a page of INF without
everything shouting. Motion (§7b) only says what just arrived, what changed and in what order things happened. Dark theme
is designed, not inverted: neutral charcoal steps (`#141516` plane, `#1c1d1f` panels), no pure white text, no large bright
areas, and a lighter tint of the same green (`#51bd85`) for links and controls so the brand survives at night; the logo square
stays a deep green (`#005c32`) so its orange bar keeps 3:1.

Revision 2026-10-18 (review pass): numbers agree across screens by construction (one per-minute table and one hourly
table, §10), page CSS that repeated on two or more screens moved into `styles.css` (§5b), one Copy-for-AI template
with a PII rule (§6b), tables reflow below 600 px, drawers are modal, and the API additions the screens still need
are listed for the SPEC owner (§9).

Revision 2026-10-18 (look): renamed **skilllane monitor** (was ndlp monitor; backend names `skilllane-monitoring`, `@skilllane/monitoring-engine`
and the ClickHouse database `skilllane_monitoring` stay), skilllane.com palette measured in §3, motion system (§7b), 3D views (§7c).
Review of that pass: the system map shows only numbers its page shows (unknown = `null`, §7c), the newest-point ring
breathes three times instead of forever and sparkline end dots are grey, not green (§7b), the logo bar has its own
`--brand-hi`, and five tokens were nudged to pass the pairs the first check missed (§3).

## 2. Page contract

- Start every screen from `_shell.html`: copy it whole, change `<title>`, move `aria-current="page"` to your nav item
  (none on `index.html`), replace the page header and the content between the "screen content" comments, fill the
  `หมายเหตุการออกแบบ` block (purpose · data source per block · interactions · open questions).
- Keep the `<head>` as is: Google Fonts link, `assets/styles.css`, `assets/app.js` (in `<head>`, no `defer`, so the
  theme applies before first paint). Screen CSS goes in one `<style>` block after them.
- Top bar: env `prod` selected; range `1 ชั่วโมงล่าสุด` with `.range-abs` `17 ต.ค. 13:20–14:20 ICT`.
  Errors and Jobs select `24 ชั่วโมงล่าสุด` and show `16 ต.ค. 14:20 – 17 ต.ค. 14:20 ICT`.
- `?theme=dark|light` in the URL forces a theme (not saved). The toggle saves to `localStorage` (`skilllane-monitor-theme`).
- `?motion=off` shows every block in its final state with no animation (screenshots, demos); `?motion=on` forces motion
  even under reduced motion or headless Chrome (§7b).
- The sidebar and top bar are byte-identical on every page except `aria-current` and the selected range
  (generated from `_shell.html`; the sidebar has a close button shown below 900 px).
- A drawer `<aside class="drawer">` goes at the end of `<main>`; `app.js` moves it to `<body>` and makes it modal
  (`aria-modal="true"`, the rest of `.app` is `inert`, Tab stays inside). A page opens with every drawer closed;
  `?drawer=<key>` opens the drawer whose opener has `data-drawer-param="<key>"` without moving focus (for demos).
- Pages must not scroll sideways at 400 px. Check with a real 400 px viewport (an iframe in a wider window:
  headless Chrome will not go below 500 px). Wide tables use `.table--reflow` (rows become small grids below 600 px)
  or sit in `.table-wrap`; charts sit in `.chart__plot[data-time-axis]`, which starts scrolled to the newest minute.

## 3. Tokens

All on `:root`, dark values under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and
`:root[data-theme="dark"]`. Use the token, never the hex.

### Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f5f5f5` | `#141516` | content plane (`body`), as skilllane.com |
| `--surface` | `#ffffff` | `#1c1d1f` | panels, tables, top bar, sidebar (light), drawer, chart surface |
| `--surface-2` | `#f8f8f8` | `#212225` | table header, code head, applied chips |
| `--surface-3` | `#eeeeee` | `#2a2b2e` | segmented track, tags, hover fill, skeleton |
| `--sidebar-bg` | `#ffffff` | `#18191b` | sidebar |
| `--line` / `--line-soft` / `--line-strong` | `#e0e0e0` / `#ededed` / `#bdbdbd` | `#2f3033` / `#262729` / `#3f4145` | panel border / row divider / strong divider, chip border |
| `--control-line` | `#8c8c8c` | `#6f7277` | border of `.select`, `.search`, `.jump` |
| `--ink` | `#222222` | `#e7e7e5` | primary text |
| `--ink-2` | `#4f4f4f` | `#bebebc` | secondary text |
| `--muted` | `#696969` | `#9a9b9d` | meta, axis ticks, field names (AA on every surface) |
| `--accent` | `#00532a` | `#51bd85` | SkillLane green: links, primary button, selected tab, current nav, focus ring, NEW badge |
| `--accent-strong` / `--accent-ink` | `#174843` / `#ffffff` | `#74cf9e` / `#06291a` | hover of accent fills / text on accent |
| `--accent-bg` / `--sel-bg` / `--accent-line` | `#e3f1e7` / `#edf6f0` / `#92c6a5` | `#15301f` / `#17291f` / `#2e6a48` | current nav, pressed chip / selected row / underline, chip border |
| `--brand` / `--brand-2` / `--brand-ink` / `--brand-hi` | `#00532a` / `#1e8764` / `#ffffff` / `#f17f23` | `#005c32` / `#51bd85` / `#f2f2f0` / `#f97c3d` | logo mark square / secondary green / white bars in the mark / orange bar in the mark |
| `--highlight` `-strong` `-ink` | `#f3542a` `#f56b45` `#1f1f1f` | `#f97c3d` `#fb9260` `#1f1f1f` | SkillLane orange: `.btn--cta` and the 3D queue shapes only (dark text: white on `#f3542a` is 3.44:1) |
| `--danger` `-bg` `-line` `-solid` | `#b71727` `#fdecee` `#f2b8bf` `#d01a34` | `#f87584` `#3a1a1e` `#6e2a33` `#e54151` | ERR, FTL, 5xx, down, failed |
| `--warn` … | `#7a5000` `#fff4d9` `#efcd7c` `#a87300` | `#f0bf55` `#33280f` `#6a5118` `#d9a21b` | WRN, 4xx, slow, retry (amber, clearly not the orange highlight) |
| `--ok` … | `#2f751d` `#edf6e0` `#a9d39a` `#4f9a3a` | `#95db6c` `#1b2e14` `#3d6a2a` `#5fb046` | up, healthy, copied, สด; always with a dot, icon or word |
| `--info` … | `#1f5fae` `#e8f0fb` `#a8c3e8` `#5a89cb` | `#93b8ea` `#172636` `#2e4a6c` `#6f95cb` | INF, neutral notices |
| `--debug` … | `#696969` `#f2f2f2` `#d0d0d0` `#8a8a8a` | `#9a9b9d` `#232426` `#3f4145` `#6b6d70` | DBG |
| `--prod` `-bg` `-line` | `#a3245f` `#fbe9f1` `#e4a9c3` | `#f08ab4` `#3a1a28` `#7a3555` | env prod marker only |
| `--svc-1` … `--svc-6` | `#1f66c9` `#c963a2` `#2bb5d6` `#eda100` `#e87ba4` `#6250d6` | `#4771e3` `#9c3b96` `#19a9b0` `#a87c10` `#d55181` `#9085e9` | service identity |
| `--grid` `--axis` `--track` | `#ececec` `#bdbdbd` `#ececec` | `#26272a` `#45474b` `#2a2b2e` | chart furniture, bar tracks |
| `--bar-neutral` `--spark` | `#7a7a7a` `#757575` | `#7a7c80` `#8a8c90` | single-series bars, sparklines |
| `--flash-bg` `--skel` `--skel-hi` | `#e3f1e7` `#eeeeee` white 75 % | `#1a3524` `#2a2b2e` white 6 % | changed value / new row highlight (fades), skeleton block and shimmer |

Measured (script: WCAG 2 relative luminance; CIEDE2000 on sRGB → Lab D65), all passing:

| Pair | Light | Dark | Rule |
|---|---|---|---|
| `--ink` on surface · bg · surface-2 · sidebar (lowest) | 14.59:1 | 12.85:1 | ≥ 4.5:1 |
| `--ink-2` on the same + surface-3 (lowest) | 7.06:1 | 7.60:1 | ≥ 4.5:1 |
| `--muted` on the same + surface-3 (lowest) | 4.73:1 | 5.09:1 | ≥ 4.5:1 |
| `--accent` text on planes, `--accent-bg`, `--sel-bg` (lowest) | 7.93:1 | 6.08:1 | ≥ 4.5:1 |
| `--accent-ink` on `--accent` / `--accent-strong` | 9.25:1 | 6.69:1 | ≥ 4.5:1 |
| `--highlight-ink` on `--highlight` / `--highlight-strong` | 4.80:1 | 6.26:1 | ≥ 4.5:1 |
| `--danger` on planes and own `-bg` (lowest) | 5.82:1 | 5.84:1 | ≥ 4.5:1 |
| `--warn` on planes and own `-bg` (lowest) | 6.45:1 | 8.47:1 | ≥ 4.5:1 |
| `--ok` on planes and own `-bg` (lowest) | 5.12:1 | 8.72:1 | ≥ 4.5:1 |
| `--info` on planes and own `-bg` (lowest) | 5.53:1 | 7.52:1 | ≥ 4.5:1 |
| `--debug` on planes and own `-bg` (lowest) | 4.90:1 | 5.58:1 | ≥ 4.5:1 |
| `--prod` on planes and own `-bg` (lowest) | 6.06:1 | 6.63:1 | ≥ 4.5:1 |
| `--surface` on `--danger` (FTL badge) | 6.63:1 | 6.32:1 | ≥ 4.5:1 |
| `--danger-solid` · `--warn-solid` · `--ok-solid` · `--info-solid` · `--debug-solid` on surface / bg (lowest) | 3.17:1 | 3.25:1 | ≥ 3:1 |
| `--danger-solid` · `--warn-solid` · `--ok-solid` · `--info-solid` on own `-bg` (callout bar, lowest) | 3.11:1 | 3.87:1 | ≥ 3:1 |
| `--brand-hi` on `--brand` (logo bar) · `--brand-ink` on `--brand` | 3.44:1 · 9.25:1 | 3.10:1 · 7.27:1 | ≥ 3:1 |
| `--ink` · `--ink-2` · `--muted` · `--accent` on `--flash-bg` (lowest, during the flash) | 4.71:1 | 4.78:1 | ≥ 4.5:1 |
| `--bar-neutral` · `--spark` on surface (lowest) | 4.29:1 | 4.03:1 | ≥ 3:1 |
| `--control-line` on surface / surface-2 | 3.17:1 | 3.29:1 | ≥ 3:1 |
| `--focus` ring on surface / bg | 8.48:1 | 8.71:1 | ≥ 3:1 |
| `--ok` vs `--accent` | ΔE 14.3 | ΔE 14.6 | ΔE2000 ≥ 10 |
| `--ok-solid` vs `--accent` | ΔE 26.8 | ΔE 11.4 | ΔE2000 ≥ 10 |
| `--ok-bg` vs `--accent-bg` (copied tint vs pressed chip) | ΔE 4.9 | ΔE 4.5 | ΔE2000 ≥ 3 |
| `--accent` vs `--warn` / `--warn-solid` (lowest) | ΔE 33.1 | ΔE 34.7 | ΔE2000 ≥ 15 |
| `--accent` vs `--danger` / `--danger-solid` (lowest) | ΔE 60.5 | ΔE 65.5 | ΔE2000 ≥ 15 |
| `--accent` vs `--prod` | ΔE 63.9 | ΔE 65.2 | ΔE2000 ≥ 15 |
| `--accent` vs `--svc-1…6` (lowest) | ΔE 45.3 | ΔE 21.2 | ΔE2000 ≥ 15 |
| `--highlight` vs `--danger` / `--danger-solid` (lowest) | ΔE 17.0 | ΔE 21.5 | ΔE2000 ≥ 15 |
| `--highlight` vs `--warn` / `--warn-solid` (lowest) | ΔE 26.0 | ΔE 23.1 | ΔE2000 ≥ 15 |
| `--highlight` vs `--svc-1…6` (lowest) | ΔE 27.5 | ΔE 23.6 | ΔE2000 ≥ 15 |
| `--ok-solid` vs `--svc-1…6` (lowest) | ΔE 38.6 | ΔE 30.4 | ΔE2000 ≥ 15 |
| `--warn-solid` vs `--svc-4` (amber service vs amber status) | ΔE 17.1 | ΔE 13.2 | ΔE2000 ≥ 10 |

Suffixes: `--x` = text, `--x-bg` = tint fill, `--x-line` = border on tint, `--x-solid` = chart mark / bar / dot.

**Service colour is fixed per service, never by rank:** `school-core-api` = `--svc-1` (blue), `school-etl-api` =
`--svc-2` (orchid), `video-transcoder-api` = `--svc-3` (cyan), the next services take 4, 5, 6 in order of first
appearance in `/api/meta`. A 7th service is drawn in `--muted` and labelled "อื่น ๆ". Roles of one service share its
colour; role is written as text (`/api`, `/worker`, `/persister`). Slots 2 and 3 were re-picked on 18 ต.ค. because the old
orange collided with the SkillLane highlight and the old green with the accent and ok. The order passed the dataviz palette
validator in both modes (light on `#ffffff`: adjacent CVD ΔE ≥ 8.5, normal-vision ΔE ≥ 19.6, first three services
all-pairs CVD 8.5 / normal 22.1; dark on `#1c1d1f`: CVD ≥ 12.6, normal ≥ 19.3, first three all-pairs 12.6 / 19.0). Dark slot 4 was
re-picked from `#c98500` to `#a87c10` in the review pass so it is not mistaken for the amber warn mark (ΔE 9.1 → 13.2 from
`--warn-solid`); its simulated colour-blind separation from slots 3 and 5 went up (protan/deutan/tritan ΔE2000, lowest:
36.1 → 36.7 and 10.2 → 12.4). Slots 3–5 are under 3:1 on the light surface (dark slot 2 is 2.8:1), so a service colour is
always next to its name (legend, `.svc` tag, waterfall label).

### Type

Fonts: `--font-ui` = "IBM Plex Sans Thai", "Noto Sans Thai", "Sukhumvit Set", Thonburi, "Leelawadee UI", Tahoma,
system-ui… · `--font-mono` = "IBM Plex Mono", "IBM Plex Sans Thai", ui-monospace, "SF Mono", Menlo, Consolas… (Plex Mono
has no Thai glyphs, so Thai inside mono runs such as `17 ต.ค.` falls back to Plex Sans Thai, not a looped system face) Plex Sans Thai has
matching Thai and Latin, so mixed labels like "Route ที่ช้าที่สุด" sit on one baseline; Plex Mono pairs with it.

| Token | Size / weight | Use |
|---|---|---|
| `--fs-26` | 26 / 600, lh 1.2 | KPI value (`.kpi__value`) only |
| `--fs-20` | 20 / 600 | page title `h1.page-title` (18 below 600 px) |
| `--fs-16` | 16 / 600 | section title `h2.section__title` |
| 15 | 15 / 600 | error title `.err-row__title`, drawer title |
| `--fs-14` | 14 / 400, lh 1.6 | body, `.lead` paragraphs |
| `--fs-13` | 13 / 400–500 | table cells, controls, nav, panel titles |
| `--fs-12` | 12 / 400–500 | meta, badges, chips, legends, captions, `.fname` 11 |
| `--fs-11` | 11 / 400 | axis ticks, kbd, level badges. Nothing smaller. |
| mono 12.5 | 12.5 / 400 | ids, timestamps, routes, key=value, code |

Rules: Thai text gets line-height ≥ 1.4 (1.6 for paragraphs). Numbers in tables and axis ticks are tabular
(`table` sets it; `.num` elsewhere); big KPI numbers stay proportional. Thousands separators always (`14,210`);
durations `84 ms`, `1.8 s` (≥ 1,000 ms switch to seconds with one decimal except in waterfall/trace lists where
`1,842 ms` stays exact); percentages `0.42 %` with a space. Times ICT: `14:18:07.412` in lists, `17 ต.ค. 14:18` for dates.
Error hint/fix/actual stay in English as the library writes them.

### Space, radius, layers

Space (4 px base): `--sp-1` 4 · `--sp-1h` 6 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 · `--sp-12` 48.
Radius: `--r-1` 3 (badges, chips) · `--r-2` 6 (buttons, inputs, code, callouts) · `--r-3` 8 (panels, tables, charts) · `--r-pill`.
z-index: `--z-sticky` 5 (table head) · `--z-topbar` 20 · `--z-scrim` 40 · `--z-sidebar` 45 (mobile) · `--z-drawer` 50 · `--z-tip` 60 · `--z-toast` 70.
Shadow: `--shadow-overlay` on drawer, mobile sidebar and tooltip only. Panels never have shadows.

## 4. Layout

- Shell: `.app` grid = sidebar 216 px + `.main`. `.topbar` 52 px, sticky on desktop, 2 px `--prod` line on top when
  `data-env="prod"`. `.content` padding 24 px (16 px under 900 px), max width 1680 px.
- Under 900 px: sidebar becomes an off-canvas panel opened by `.topbar__menu` (`[data-nav-toggle]`), top bar
  becomes three rows (menu · brand · theme / env + range / jump box), top bar is not sticky.
- Page order: `.page-head` → optional `.callouts` (max 3) → filter row (`.filterbar`) → KPI strip → sections.
  Filters sit in one row above everything they scope, never inside a chart card.
- Grids: `.grid.grid--2`, `.grid--3` (2 cols < 1100, 1 col < 900), `.grid--main-side` (2fr + 1fr ≥ 280 px, stacks < 1100).
  Gap 16. Sections 32 apart (`.section`), section head 12 above its content.
- Panels: `.panel` > `.panel__head` (title 13/600, meta, actions right) + `.panel__body` (16) or a `.table-wrap`
  directly (flush). Do not nest panels. Do not put every block in a card: a table or chart can sit in the plane.
- Density: table rows 33 px (`.table`) or 29 px (`.table--dense`) for log lists; controls 32 px, small 26 px;
  chips 28 px; badges 18–22 px; the smallest hit targets (`.row-toggle`, `.fchip__x`, `.btn-icon--xs`) are 24 px.
  One primary button per area.
- Below 600 px a wide table reflows: `table.table--reflow` turns each row into a grid; the page sets
  `grid-template-areas` on `tr` and `grid-area` on cells, numbers get `data-label`, columns that do not matter on a
  phone get `.rf-hide`. The essential column (message, route, error rate, duration) is always on screen.

## 5. Components (class reference)

Live examples for every row are in `components.html`; copy markup from its source.

| Component | Markup / classes | Notes |
|---|---|---|
| App shell | `.app` > `aside.sidebar#sidebar` + `.main` > `header.topbar[data-env]` + `main.content#main` | copy from `_shell.html` |
| Sidebar | `.brand` (`.brand__mark` svg with `.bm-bg` green square, `.bm-bar` white bars, `.bm-hi` orange bar; `.brand__name` skilllane monitor, `.brand__sub`), `nav.nav` > `a.nav-item[aria-current=page]`, `.nav__label`, `.nav-item__ext`, `.nav-item__count`, `.sidebar__foot` | data dictionary link: `../../docs/DATA-DICTIONARY.md` |
| Top bar | `.topbar__menu`, `.topbar__brand`, `.topbar__scope`, `.topbar__end`, `.range-abs` | |
| Page header | `header.page-head` > `.page-head__text` (`nav.crumbs` > `a` + `.crumbs__sep`, `h1.page-title`, `p.page-sub`) + `.page-actions` | subtitle = question it answers · env · range |
| Section / panel | `.section` > `.section__head` (`h2.section__title`, `.section__meta`, `.section__actions`); `.panel`, `.panel__head`, `.panel__title`, `.panel__meta`, `.panel__actions`, `.panel__body(--flush)`, `.panel__foot`; `.lead` | |
| Buttons | `.btn`, `.btn--primary` (green), `.btn--cta` (orange, at most one per page: the most important action, e.g. page-head `คัดลอกให้ AI`), `.btn--quiet`, `.btn--sm`, `.btn-icon`, `.btn-icon--bordered`, `.btn-icon--xs`, `[disabled]` | icon buttons need `aria-label`; press = `scale: .97` |
| Theme toggle | `button.btn-icon.theme-toggle[data-theme-toggle]` with `.i--moon` + `.i--sun` svgs | |
| Segmented / env | `.seg[data-choice][role=group]` > `button.seg__btn[aria-pressed]`; env: `.seg--env`, prod button `.seg__btn--prod` with `span.seg__dot` | |
| Select / time range | `label.select(.select--lead)` > `svg.select__icon` + `.sr-only` label + `select.select__control` + `svg.select__chev` | range values `now-15m … now-7d`, `custom` |
| Jump box / search | `form.jump[role=search]` > svg + `input.jump__input` + `kbd.jump__kbd`; page search `.search` > svg + `input.search__input`; `kbd.kbd` | `/` focuses the jump box |
| Filter chips | `.chips` > `button.fchip[data-toggle][aria-pressed]` (+ `.fchip__n` count); applied: `.fchip.fchip--applied` > `.fchip__k` + `.fchip__v` + `button.fchip__x`; row: `.filterbar` | |
| Tabs | `.tabs[role=tablist]` > `button.tab[role=tab][aria-selected][aria-controls]` (+ `.tab__count`); `.tab-panel[role=tabpanel][hidden]`; link tabs: `a.tab[aria-current=page]`; app.js adds one sliding `.tabs__ink` (+ `.has-ink`) | arrow keys handled by app.js |
| KPI tile | `.kpis(.kpis--3|--4|--5)` > `.kpi(.kpi--alert|.kpi--warn)` > `.kpi__label`, `.kpi__value` (+ `.kpi__unit`), `.kpi__foot` > `.kpi__delta(--bad|--good)` + `svg.kpi__spark`; whole-tile link `a.kpi__link` | spark: `viewBox 0 0 96 28`, `.spark__area`, `.spark__line`, `.spark__dot` (r 3), `.spark--bad` |
| Data table | `.table-wrap(.table-wrap--scroll)` > `table.table(.table--dense)(.table--reflow)`; `th.num`/`td.num`, `th[aria-sort]`, `.col-tight`, `.nowrap`, `.mono`; selected `tr[aria-current=true]`; problem rows `tr.is-bad` / `tr.is-slow` (3 px marker); clickable `tr.is-clickable`; expand `button.row-toggle[data-expand][aria-controls]` + `tr.row-detail[hidden]` > `.row-detail__body` (sticky inside a scrolling table) | sticky header needs `.table-wrap--scroll` (max-height 480); `th[scope=row|rowgroup]` in tbody never sticks |
| Value tones | `.t-danger`, `.t-warn`, `.t-ok`, `.t-muted`, `.t-ink2` | only with the number or a word, never colour alone |
| Level badge | `.lvl.lvl--dbg|inf|wrn|err|ftl` text `DBG INF WRN ERR FTL` | outline → tint → solid |
| HTTP | `.method` (`GET`), `.http.http--2xx|3xx|4xx|5xx` | 2xx/3xx stay neutral |
| Category chip | `.cat.cat--bug|input|data|dependency|config` + its svg icon | Thai labels: ต้องแก้โค้ด · ข้อมูลที่ส่งมาผิด · ข้อมูลในระบบขัดกัน · ระบบที่เรียกใช้มีปัญหา · ตั้งค่าผิด; neutral colour, bug is bolder |
| NEW badge | `.badge-new` `NEW` + `.badge-new__since` `ตั้งแต่ 31.4.0` | accent fill: novelty, not severity; glints once when first seen |
| Service tag | `.svc.svc-N` > name + `span.svc__role` (`/api`) | text stays ink; the 8 px key carries colour |
| Env / tag | `.env(.env--prod)`, `.tag` (queue system, version, error code) | |
| State | `.state(.state--ok|--warn|--down)` + label | dot shape differs per state |
| Live | `span.live` `สด` (pulsing ok dot + word); sidebar foot `.sidebar__fresh` = `.live` + ข้อมูลล่าสุด + `.ts`; new rows `tr.is-new` | only while the range is relative (ล่าสุด) |
| Skeleton | container `[aria-busy=true]` + `.sr-only` กำลังโหลด… > `.skel(.skel--title|--text|--short|--kpi|--chart|--row)` | shapes match the content; shimmer only with motion on |
| Timestamp / id | `.ts`, `.mono`, `.num`; `.idchip` > `.idchip__k` + `a` + `button.btn-icon--xs.btn-copy` | full id in `title` when truncated |
| key=value chips | `ul.kv-list` > `li.kv(.kv--bad|.kv--warn)` > `span.kv__k` + `span.kv__v` | `=` is added by CSS |
| Readable error row | `.err-list` > `article.err-row` > `.err-row__head` (`.lvl`, `h3.err-row__title` with optional `.err-row__code` prefix, `.cat`, `.badge-new`, `.err-row__count`), `.kv-list`, `p.err-row__detail` (`.err-row__detail-label` ต้องแก้อะไร), `p.err-row__actual` (`.err-row__actual-label` error จริง), `.err-row__meta`; compact group list: `.err-row--compact` > `.err-row__main` (`.err-row__head`, `.err-row__ctx`) + `.err-row__n` | see §6 |
| Code / stack | `pre.code(.code--wrap|.code--tall)`; with head: `.code-block` > `.code-block__head` (`.code-block__title` + `.btn-copy`) + `pre.code`; stack: `pre.code.stacktrace` > `span.fr(.fr--head|.fr--app)` > `.fr__loc`, frames inline with a real newline between them (a copy keeps the line breaks), `.stacktrace__gap` for "… N more frames"; tones `.c-err .c-mute .c-key` | app frames ink, library frames muted |
| Copy button | `button.btn-copy[data-copy="text"]` or `[data-copy-target="#id"]` with `.i--copy` + `.i--check` svgs and optional `span.btn-copy__label` | `.is-copied`: check draws itself, filled buttons turn ok-tint, label คัดลอกแล้ว for 1.6 s; clipboard blocked → `.is-copy-manual` + select-and-press hint |
| Copy for AI | `.btn.btn--cta.btn-copy[data-copy-target]` in the page head (or the drawer foot when the page has none), `.btn--primary` elsewhere, label `คัดลอกให้ AI`, target = `pre.code.code--wrap` with the Markdown summary; on detail pages `.ai-box` > `.code-block` + `.panel.ai-box__notes` (ใส่ / ไม่ใส่) | template and PII rule in §6b |
| Drawer | `aside.drawer#id[role=dialog][aria-hidden=true][aria-labelledby]` (`.drawer--wide` 760 px) > `.drawer__head` (`.drawer__heading` > `.drawer__sub` + `h2.drawer__title`, close `[data-drawer-close]`) + `.drawer__body` + `.drawer__foot`; opener `[data-drawer-open=id][aria-controls][aria-expanded]` (+ `data-drawer-param` for `?drawer=`) | modal; Esc / scrim / close button close it, focus returns to opener |
| Field groups | `.field-group` > `h3.field-group__title` + `dl.fields` > `dt` (Thai label + `span.fname` stored column name) + `dd(.mono)`; a note under a value is `span.hint` (UI font, own line) | column names from `clickhouse/schema.sql` (`http_route`, `error_fix`, `trace_id`) |
| Callout | `.callouts` > `.callout(.callout--error|--warn|--ok)` (no modifier = info) > `svg.callout__icon` + `p.callout__title` + `p.callout__text` + `.callout__actions` | max 3, most severe first; every action is `.btn.btn--sm` (bordered) |
| Empty state | `.empty` > `svg.empty__icon` + `p.empty__title` + `p.empty__text` + `.empty__actions` | say why it is empty and what to change |
| Duration bar | `.dur(.dur--warn|.dur--bad|.is-error)` > `i[style="--s:START%;--w:WIDTH%"]`, colour `style="--c:var(--svc-N)"`; in a cell `.dur-cell` (value + 72 px bar) | numbers are % of the trace / column max, drawn to scale |
| Waterfall | `.wf` > `.wf__scale` (+ `.wf__ticks` > `span[style=--t:PCT]` round values + `.wf__tick-end`) + `.wf__row(.is-error|.is-selected)[style=--c]` > `.wf__name[style=--d:depth]` + `.wf__track` > `.dur` + `.wf__ms` | below 720 px each span is two lines (name + ms over a full-width bar), no sideways scroll; error span bar = `--danger-solid` + `.lvl--err` in its name |
| Chart frame | `figure.chart(.chart--bare)` > `.chart__head` (`h3.chart__title`, `.chart__sub`, `ul.legend` > `li.legend__item` > `span.legend__key(--line|--dot)[style=--c]`) + `.chart__plot` > `svg` + `.chart__foot` (`details.chart__table`) | see §7 |
| SVG marks | `.c-grid .c-axis .c-tick(.c-tick--end|--mid) .c-axis-title .c-line .c-area .c-bar .c-dot .c-label(.c-label--muted) .c-event .c-event-label .c-band .c-hit .c-halo` (surface halo behind labels over marks); series colour via `class="svc-N"` or `style="--c:…"`; level series `.c-lvl-dbg|inf|wrn|err|ftl` | |
| Tooltip | any element with `data-tip="title|value::name|value::name"` (+ `data-tip-keys="svc-1,svc-3"`); static markup `.tip` > `.tip__title` + `.tip__line` > `.tip__key` + `.tip__val` + `.tip__name` | value first, line key not box |
| Disclosure | `details.disclosure` > `summary` (+ `.disclosure__meta`) + `.disclosure__body`; borderless `summary.summary-line` | |
| Design notes | `details.design-notes` > `summary` (pencil svg + หมายเหตุการออกแบบ) + `.design-notes__body` > `section` > `h3` + `p`/`ul` | dashed border = annotation, not product UI |
| Utilities | `.sr-only .truncate .ml-auto .mt-2 .mt-3 .mt-4 .mt-6 .small .hint .row .stack .grid .unit .t-strong .code-inline` | `.stack` has a `minmax(0, 1fr)` column so wide children scroll inside instead of stretching it |

### 5b. Shared patterns promoted from screens (2026-10-18)

These started as page CSS on two or more screens and now live in `styles.css`. Use them; do not re-create them with a page prefix.

| Pattern | Classes | Used on | Replaces |
|---|---|---|---|
| Filter row | `.filterbar` > `.filterbar__group` + `.filter-label`, `.filterbar__end` (hint or clear button pushed right); compact search `.search.search--sm` | logs, traces, errors, jobs | `.lg-fgroup .lg-flabel .eg-flabel .eg-filters-hint .tr-filters__clear .lg-user/.tr-search` sizing |
| Page head meta | `.page-head__meta` (ids, level, code, svc under the h1) | trace-detail, error-detail ×2 | `.td-meta`, `.ed-head-meta` |
| Fixed KPI strips | `.kpis--3`, `.kpis--4`, `.kpis--5` (fewer columns when narrow); `.kpi--alert .kpi__label > .i` turns danger | errors, trace-detail, error-detail ×2, jobs, components | `.td-kpis`, `.eg-kpi-alert` |
| Row markers | `tr.is-bad`, `tr.is-slow` + `.legend__key--bar[style=--c]` for the key | overview, traces, components | `.ov-route--bad/--slow`, `.tr-row--err`, `.ov-key` |
| Expanded row content | `.row-detail__body` (+ `.row-detail__actions`) | overview, logs, traces | `.ov-rd` wrapper, `.lg-detail`, `.tr-detail` |
| List footer | `.list-foot` > `.list-foot__count`, `.list-foot__cursor`, `.btn` | logs, traces | `.lg-foot*`, `.tr-foot` layout |
| Compact error groups | `.err-list` in a panel + `.err-row--compact` | overview, components | `.ov-eg*` |
| Dependencies | `ul.dep-list > li` with `.dep` (`.dep__top`, `.dep__name`, `.dep__host`), `.dep__sub`, `.dep__strip`; time labels `.mini-axis` > `span[style=--x]`, `.mini-axis__start/__end` | overview, jobs, components | `.ov-dep*`, `.jb-dep*`, `.ov-dep__axis`, `.jb-axis` |
| Queue names | `.queue-name` + `.queue-sub`; small second line in any cell `.cell-sub` (jobs) | overview, jobs | `.ov-jobs__q/__sub`, `.jb-q__name/__type`, `.jb-sub` |
| Cron list | `ul.cron-list > li.cron-line` (`.cron-line__name`, `.cron-line__when`) | overview, components | `.ov-cron*` |
| Flow | `ol.flow > li.flow__node(.flow__node--lead)` + `.flow__text`; stacks below 900 px, `.flow--stack-lg` below 1280 px | index, jobs, components | `.flow*` (index), `.jb-flow*`, `.flow-note` |
| Inline sparkline | `.spark-inline` > `svg[width][height]` + `.spark-inline__max` | overview, errors, components | `.ov-spark-wrap/.ov-spark`, `.eg-trend__max`, svg sizing in `.eg-spark` |
| Service lists | `.svc-dots` (> `i[style=--c]` + `.svc-dots__n`), `.svc-list` (stacked `.svc` tags) | traces, jobs | `.tr-svcs*`, `.jb-svcs` |
| Copy for AI | `.ai-box` > code block + `.ai-box__notes` panel | trace-detail, error-detail ×2 | `.td-ai`, `.ed-ai-side` |
| Units and text | `.unit` (muted unit after a number), `.t-strong`, `.code-inline`, `.c-halo` | overview, errors, traces | `.ov-unit`, `.eg-unit`, `.ov-n`, `.tr-halo` |
| Design notes | `.design-notes__body > section { min-width: 0 }`, `code` wraps anywhere | all | `.ed-notes`, `.tr-notes code` |

Page CSS that stays page-only (one screen uses it): the overview layout widths, the logs query bar and histogram,
the traces scatter marks (`.tr-ok/.tr-slow/.tr-bad/.tr-ring/.tr-mark`), the trace-detail waterfall extensions
(tree guides, 250 ms gridlines, log lane), the error list grid (`.eg-row`), the error-detail blocks (`.ed-*`),
and the jobs timeline and outcome bar (`.jb-tl*`, `.jb-out`).

Icons: inline SVG `class="i"` (16 px, `.i--sm` 14, `.i--lg` 20), `viewBox="0 0 16 16"`, stroke `currentColor` 1.5,
`aria-hidden="true"`. Reuse the paths in `components.html` (nav, copy, check, close, chevrons, search, clock,
alert, info, category icons) instead of drawing new ones.

## 6. Readable error rule (do not change)

Title = `error_hint`, else the event title, else `message`; the event code or logger may sit before it as a small
mono prefix (`http.request` → title `request completed`). Then key=value chips in this order: `method`, `route`
(always `route=`, never `path=`), `status`, `source` (origin function) or `job` (+ `id`, `attempt`), `file`, `target`,
`duration` (skip missing ones). An exception-filter error line has no status or duration of its own; they come from
the `http.request` line of the same trace. The same line renders the same way on every screen. Then
"เกิดอะไรขึ้น" = `error_detail`, then "ต้องแก้อะไร" = `error_how_to_fix`. Then "error จริง" = `Type [CODE] message` in mono
danger colour. Then service/role, trace id (link + copy) and user id. Category chip after the title. In an error-group
list, `.err-row__count` shows count and users and the meta shows first/last seen instead of one timestamp.
An error group has one level badge on every screen: group 3 (Google API rate limited) is ERR with the sub-line
`38 retry · 3 ล้มเหลวจริง`; a single `job.retry` line of it is still WRN. "เกิดอะไรขึ้น" and "ต้องแก้อะไร" for a
group are the `error_detail` and `error_how_to_fix` of its latest occurrence.

## 6b. Copy for AI: one template, one PII rule

Every "คัดลอกให้ AI" button on every screen copies Markdown in this shape. Keys keep this order; a key with no value
is dropped, never renamed. Group pages and lists repeat the block per group.

```
### <error_hint> (<error_code>, category: <error_category>)[ · NEW since <version>]
- level: error | warn
- service: <service>/<role> [<version>]
- env: <env>
- when: <timestamp ICT>                               one occurrence only
- request: <METHOD> <route> → <status> in <duration>  or  job: <system> queue <q> · <job_type> #<id> · attempt n/m → <result>
- what: <error_detail>
- how_to_fix: <error_how_to_fix>
- where: <METHOD route | job type | dependency> · usecase <usecase>
- origin: <origin_function> · <origin_file>
- target: <error_target>
- failed_step: <failed_step>
- error: <Type [CODE] message>
- stack: (app frames first, at most 3)
- trace_id: <trace_id>
- fingerprint: <fingerprint>                          group pages
- spans / span_tree / logs: …                          trace pages
- counts: <n> times · <users> users · <range> · first … · last …
- fields: see docs/DATA-DICTIONARY.md
```

PII rule (same on every page): never `user_id`, `organization_id` or the user's role; no request body, query string,
SQL parameter values, IP, user agent or headers. Screens still show user and school next to the data; only the copied
text leaves them out, and detail pages say so in the `ใส่ / ไม่ใส่` panel.

## 7. Charts

- One y-axis per chart, always. Two measures of different scale = two charts.
- Draw the SVG `viewBox` at the width the chart renders at 1440 px, and set `style="--chart-min:Npx"` on the svg
  to about 90 % of that width so tick text never renders under 10 px; on phones the plot scrolls inside `.chart__plot`.
  Include the x-axis band in the viewBox height.
- Marks: lines 2 px round joins; area wash 10 % (`.c-area`); bars ≤ 24 px thick, 2 px surface gap between touching
  bars, square at the baseline; dots r ≥ 4 with a 2 px surface ring (`.c-dot`); scatter hit area ≥ 24 px.
- Gridlines and axis are solid hairlines (`.c-grid`, `.c-axis`), never dashed. Y ticks round and compact (0 · 500 · 1K · 1.5K);
  x ticks every 10 min for 1 h, every 4 h for 24 h. Ticks 11 px `--muted`.
- Colour by job: service identity → `--svc-N`; log level histogram → `.c-lvl-*` (stack bottom-up DBG, INF, WRN, ERR, FTL;
  FTL is drawn in `--ink` because `--danger` and `--danger-solid` are only 1.3:1 apart);
  status/thresholds → `--*-solid`; a single series → `--bar-neutral` or `--svc-N` of that service, no legend box.
  Highlight the one thing (slow route, error traces) and keep the rest neutral.
- Text never wears the series colour: labels and values use ink tokens; the coloured key beside them carries identity.
  Direct-label only the end value or the extreme; a legend is always present for 2+ series.
- Events: deploy or outage as `.c-event` (1 px solid line) + `.c-event-label`; a time window as `.c-band`.
- Every chart has a hover layer (`.c-hit[data-tip]`, one column per time bucket for lines/bars) and a
  `details.chart__table` table view. Tooltips never hold the only copy of a value.
- Per-minute values that the dataset does not list are drawn as plausible variation around the dataset's average;
  totals and averages must match the dataset (for example `1,180 req/min` × 60 = `70,800`). Say so in the design notes.
  Every per-minute or hourly value comes from the one shared table (§10), so two screens never disagree on a minute.
- Time-axis plots carry `data-time-axis` on `.chart__plot`; on a narrow screen `app.js` scrolls them to the newest minute.
- Durations: ≥ 1,000 ms switch to seconds with one decimal (`45.2 s`, `10.0 s`) everywhere except waterfall, trace
  lists and key=value chips, which keep exact ms (`1,842 ms`).

## 7b. Motion

Motion is information, not decoration: it says what just arrived, what changed, and in what order things happened, and
it is over within 0.7 s. Only two quiet loops exist, and each means "live" or "loading": the สด dot and the skeleton
shimmer (plus the particle flow of the 3D views, §7c, which has its own pause button). The ring on the newest point of a
time series breathes three times when the point arrives and then rests, so a page never carries endless peripheral motion
(WCAG 2.2.2: nothing moves for more than 5 s without a way to stop it).

**Switch.** `app.js` (in `<head>`) sets `:root[data-motion="on"|"off"]` before first paint. It is off for `?motion=off`,
for `prefers-reduced-motion: reduce`, without IntersectionObserver, and in headless Chrome (CLI screenshots render no frame
before the capture, so they would catch blocks that are waiting to be revealed); `?motion=on` forces it on. Every rule that
hides something before it is revealed is scoped to `[data-motion="on"]`, so a page without JS, or with motion off, always
shows the final state. Under reduced motion every `--dur-*` token is 0 and the old catch-all rule still stops the rest.

**Tokens.** `--dur-1` 120 ms hover, press, colour · `--dur-2` 200 ms drawer close, tab ink, details, row enter, one bar ·
`--dur-3` 400 ms drawer open, line draw · `--dur-4` 700 ms the longest sequence · `--dur-linger` 1,600 ms a highlight
fading · `--stagger` 300 ms left-to-right spread across one chart · `--ease-out` entering, `--ease-in` leaving,
`--ease-in-out` moving between two places. Use the tokens, never raw times.

**Reveal.** app.js watches `.chart, .kpi, .spark-inline, .wf, .dur, .badge-new, [data-mo]`; the first time one scrolls
into view (or first appears: a tab panel, a drawer, a details) it prepares its svgs (bar baseline = the nearest horizontal
`.c-axis` below each bar, `--mo-x` = 0–1 position across the plot, `pathLength="1"` + `.mo-draw` on lines, a `.mo-ring`
under the end dot of each line), adds `.is-in` to it and every target inside it, and fires a `mo:in` event on it.

| What moves | Why it makes the data easier to read | Hook | Time |
|---|---|---|---|
| Bars grow from their baseline, left to right | the eye follows time the way the axis runs; stacked bars grow as one stack | `.is-in .c-bar` (`--mo-x`, inline `transform-origin`) | 200 ms each, ≤ 500 ms |
| Lines draw left to right, then area and end label fade in | same direction as time; the end value lands last | `.is-in .mo-draw`, `.c-area`, `.c-label` | 400 ms (+200) |
| Scatter points pop in left to right; marked traces' rings and labels last | density first, then the three traces other screens refer to | `.is-in .c-dot`, traces page `.tr-ring` | ≤ 500 ms, rings at 700 ms |
| Newest point breathes, three times | marks "now" on a series when it arrives; replay or new data plays it again | `.mo-now` + `.mo-ring` (end dot of a sparkline: `--ink-2`, never the green accent; `.spark--bad`: `--danger-solid`) | 2.4 s × 3, then still |
| KPI numbers count up once | draws the eye to the headline numbers on arrival | `.kpi.is-in .kpi__value`, `[data-mo-count]` (plain numbers ≥ 10 or with decimals only) | 600 ms |
| A changed value flashes | shows which number just changed | `.is-changed`, `skMonitor.setValue(el, text)` | 1.6 s fade |
| สด dot pulses | data is still flowing in | `.live` | 2 s loop |
| A new row slides in with a fading tint | which lines just arrived | `tr.is-new`, `skMonitor.addRow(tbody, tr)` | 200 ms + 1.6 s |
| Trace waterfall spans grow in start-time order | the call sequence plays out (who called whom first) | `.wf.is-in .dur > i`, delay `--s` × 5 ms | ≤ 700 ms |
| The failed span pulses red once; log markers appear at their time | where it broke, and which log belongs to that moment | `.wf__row.is-error .dur > i` (`mo-alarm`), trace-detail `.td-log` | 900 ms once |
| Duration bars in cells grow from their start | length is the value | `.dur.is-in > i` | 400 ms |
| NEW badge glints once | a new error after deploy | `.badge-new.is-in::after` | 900 ms once |
| Drawer slides in, scrim fades | where the panel came from and where focus returns | `.drawer.is-open`, `.scrim.is-on` | 400 ms in, 200 ms out |
| Tab ink slides; tab panel fades in | which tab is now selected | `.tabs__ink`, `.tab-panel` | 200 ms |
| details and expanded rows open smoothly | the new content grows from where you clicked | `details::details-content`, `.row-detail__body` | 200 ms |
| Hover and press | the control responds | colour transitions, `scale: .97` on press | 120 ms |
| Copy morphs to a check | the copy happened | `.btn-copy.is-copied` | 400 ms |
| Skeleton shimmer | the block is loading, not empty | `.skel` | 1.4 s loop |

**Rules.** Animate only `scale`, `translate`, `opacity`, stroke offsets and background tints; never move content that is
already placed (no layout shift); never animate a status colour into another; one flash per changed value; nothing that
is not on screen animates (reveal waits for the view). Charts are always readable without motion: the hover layer and the
table view do not wait for the entrance.

**For the Next.js port and the 3D embed.** Keep the class names and tokens. `window.skMonitor` = `{ motion, reveal(el),
replay(el), setValue(el, text), addRow(tbody, tr) }`. Read `document.documentElement.dataset.motion` before animating and
do nothing when it is `"off"`; start your own entrance on the `mo:in` event of a `[data-mo]` wrapper; in React, toggle
`is-in` from an IntersectionObserver hook and `is-new` / `is-changed` on data arrival (remove them on `animationend`).
`components.html#motion` has a replay button for every row of the table above.

## 7c. 3D views

Two small three.js scenes explain the *shape* of things that tables list one row at a time: which system calls which,
and how a log line travels. They are never the place to read a number: every value in a scene is also in a table or
list on the same page, and the scene says so in its caption. Code: `assets/system-map.js` (ES module, three@0.170.0
from `cdn.jsdelivr.net/npm/` through an importmap; no globals) and `assets/system-map.css` (labels, tooltip, toolbar,
legend, fallback). `system-map-lab.html` is the test bench (`?motion=off`, `?webgl=off`, `?offscreen=1`, live data
from the engine on :5100); it is not a screen and is not published.

| Scene | Where | What it shows |
|---|---|---|
| System map, `mountSystemMap(el, data, options)` | overview.html "แผนที่ระบบ", next to "ต้องดูตอนนี้" from 1280 px (as tall as the callouts, health table stays above the fold at 1440 × 900), after the health table below 1280 px (340 px, 360 px under 640 px); "ขยาย" opens it full width at 540 px. components.html#views3d | prod in the selected range as a small city, tiers left → right: users → services → queues → workers → databases and outside APIs (top → bottom when the box is taller than wide) |
| Data path, `mountPipeline(el, options)` | index.html "ข้อมูลเดินทางอย่างไร" (full width, 400 px; 600 px tall and vertical under 640 px), components.html#views3d | NestJS app + `skilllane-monitoring` → Kafka / RabbitMQ / BullMQ → skilllane-monitoring engine → ClickHouse → skilllane monitor and AI, with a Kafka · RabbitMQ · BullMQ switch |

**Data mapping (system map).** `data = { nodes, edges }`, the same names as `/api/overview` (SPEC §8):

| Mark | Data | Rule |
|---|---|---|
| Block (service, role api) | `rpm`, service hue | height ∝ log10(1 + rpm) so 1,180 and 54 req/min both read; hue = `--svc-N` by `serviceOrder`, the same slot as every other screen; a 7th service is muted |
| Stacked slabs · orange conveyor · drum · dome · two figures | worker/consumer · queue · database/cache · outside API · incoming users | shape carries the kind (legend "อ่านภาพนี้อย่างไร"); queues are the only `--highlight` orange in the scene |
| Particles on an edge | edge `rpm`, `errorRate` | rate ∝ rpm^0.42, capped at 400 on screen; the failing share is red on its own compressed scale so 0.16 % is visible, the exact % is on the label; `rpm: null` = call exists, rate unknown (slow trickle, no number) |
| Unknown values | node `rpm: null`, `errorRate: null` | the shape is drawn (block height uses 0), but no number appears in the label, tooltip or fallback list: a scene never shows a value the page does not |
| Ground ring + halo | `state` | red = error / down, amber = warn / degraded; the label repeats it with the `.state` dot shapes (circle, diamond, square) and the tooltip in words, so colour is never alone |
| down | `state: 'down'` | block dimmed, sends nothing, every edge into it red |
| Label | name + role, `rpm` + unit, `errorRate`, `note` | under 560 px wide (`.smap--compact`), or with `compactLabels: true` (`.smap--names`, overview until "ขยาย"), healthy nodes show the name only; the tooltip always has every value and the top 4 outgoing calls |

`demoSystemMapData('now' | 'cache-down')` is the BRIEF dataset (13 nodes, 14 edges; core-api/api and core-api/worker are
`warn` = "ต้องดู" and ThaID `degraded`, as in the overview health table and Dependency list). Its only numbers are the
health table's (rate, error rate, p95 per service/role; a users → api edge and a queue → consumer edge carry that row's
numbers) and the Dependency list's notes (ThaID 401 4 ครั้ง, cache down 45.2 s); users, queues, oracle, Google Sheets API and
every call between systems are `null`, exactly what `systemMapFromApi` can fill today. Google Sheets API has no dependency
events, so it has no state of its own; its rate limit shows on the worker and in the error group. `systemMapFromApi(overview, { thresholds, clients, href })` builds the same shape from
`GET /api/overview` (role api → block, other roles and CONSUMER → worker, each dependency row → an edge with `rpm: null`,
each job queue → queue node). Call rates between systems need an endpoint (open question on overview).

**Interaction.** Drag to orbit (touch: a sideways drag orbits, a vertical swipe still scrolls the page); + − buttons
zoom, the wheel never does; reset and pause buttons; on the focused canvas arrows rotate, + − zoom, 0 resets. Hover or
focus a block or label: tooltip, neighbours and their edges highlighted, the rest dimmed (shapes to 50 %, their labels
`.is-dim` to 40 %). Click (touch: second tap)
opens `href` (overview: the node's screen). Pages link the scene to its table: `map.highlight(id)` from a hovered or
focused row (overview health rows and Dependency items carry `data-node`), and `onHover(node)` marks the row
`.is-linked`. `map.setCompactLabels(bool)` switches name-only labels at run time (overview: off while "ขยาย" is pressed). The pipeline switch calls `setTransport()`; station links go to overview and the data dictionary.

**Motion (§7b).** Pages import the module with `import()` (three.js never delays the page) and mount inside the
`[data-mo]` panel on its first `mo:in`, so blocks grow (0.7 s) when they come into view; with `data-motion="off"` they
mount at once and pass `motion: false`. Motion off or `prefers-reduced-motion`: one still frame, dashed edges instead of
particles, steady halos, three parked envelopes in the pipeline; the play button opts back in. The particle flow and
halo pulse are the scene's "live" loop (the same meaning as the สด dot), and the slow camera sway stops on the first
interaction.

**Fallback.** No WebGL2 (or `?webgl=off`): one line of explanation and the same data as an HTML list (nodes with state
and numbers, edges in a details; the pipeline as numbered steps). Before the module loads the box holds a placeholder
of the final height (index: the flat path list), and if it cannot load (file://, CDN down) the placeholder says why and
points to the table. No blank boxes.

**Performance.** One renderer per scene; ≤ 30 fps for the ambient loop (dragging runs at full rate); devicePixelRatio
≤ 2; ≤ 400 particles; the loop stops when the scene is off screen (IntersectionObserver, 80 px margin) or the tab is
hidden; shadows re-render only when shapes change; a ResizeObserver refits the camera; theme colours are re-read from
the tokens when `data-theme` or the OS scheme changes. `destroy()` frees geometries, materials, the GL context and every
listener (React: call it on unmount; `update(data)` on new data). At most one map and one pipeline per page.

## 8. Do and don't

Do
- Put service / role / env and an ICT time on every row and every title area.
- Lead with the number or the question; one sentence subtitle that says what the screen answers.
- Use the same dataset values everywhere (trace `4bf92f3577b34da6a3ce929d0e0e4736`, group counts, durations).
- Keep tables dense, numbers right-aligned, ids in mono with copy buttons.
- Give every colour a word or icon (ERR, `500`, ช้า, down) and every hover a keyboard-focus equivalent.
- Check light, dark and 400 px before calling a screen done.

Don't
- Don't use red, amber, green or blue for anything but status, or the accent for status; don't show status green without its dot, icon or word.
- Don't use the orange highlight for anything but one `.btn--cta` per page and the queue shapes in the 3D views (the logo bar is `--brand-hi`).
- Don't draw a data mark (sparkline end dot, chart point) in the green accent: next to a ● ปกติ dot it reads as "ok".
- Don't put a 3D view where a table or chart answers the question, or a number only in a 3D view; it explains the shape, the table beside it holds the values.
- Don't recolour a service by rank or by filter; don't invent a 7th hue.
- Don't add hero sections, illustrations, gradients, emoji, cream/serif styling, or shadows on panels.
- Don't animate for decoration: no motion that does not say "arrived", "changed" or "in this order", nothing over 0.7 s except the two live/loading loops, the three breaths of the newest-point ring and the 3D flow (which can be paused), nothing that hides content when motion is off.
- Don't wrap every block in a card; don't nest panels.
- Don't use dashed gridlines, dual axes, pie charts for close values, or a number on every point.
- Don't let anything push the page sideways at 400 px; don't shrink chart text below 10 px to make it fit.
- Don't hide the column that answers the question behind a sideways scroll on a phone; reflow the row instead.
- Don't keep a class in page CSS once a second screen needs it; promote it to `styles.css` and list it in §5b.

## 9. API additions the screens need (proposals for the SPEC owner, not yet in SPEC §12)

SPEC §12 (2026-10-18) already covers: overview `services[].kind`, `routes[].clientErrors/clientErrorRate`; LogRow
`fingerprint`, `version`, `userRoles`; ErrorGroup `failedStep`, `jobQueue`, `jobType`, `dependencyName`,
`firstSeenVersion`, `isNew`, firstSeen over all retained data; `/api/errors/:fingerprint` `versions`; `/api/meta`
`releases` and `deploys`; JobStat `service`, `role`, `lastRunAt`, `lastFailedAt`; `/api/jobs` `consumerEvents`;
Dependency `lastOutageMs`, `affects`, `dependency.up` reason connected/recovered; `/api/traces` `kind`;
`/api/errors` `limit`; ORA-12899 written at error when the response is 5xx. The screens use those names.

Still needed (each screen's design notes point here):

| # | Endpoint | Addition | Why / screen |
|---|---|---|---|
| 1 | `GET /api/traces` | `sample=errors,slow,spread` (errors first, then slowest, then N per minute) and `total` in the response | the 100-point scatter over 1 h; `limit` alone returns the last few seconds (traces, overview "trace ช้าสุด") |
| 2 | `GET /api/traces` | `sort=durationMs` | "เวลาที่ใช้" column sort, slowest trace of a route (overview `limit=1`) |
| 3 | `GET /api/traces` rows | `job: {queue, type, id, attempt, maxAttempts}` or `null`, from the entry span's attributes | `#88412 ล้มเหลว 2/3` in job rows (traces) |
| 4 | `GET /api/traces` | `traceId` (exact or prefix) | trace id box (traces) |
| 5 | `GET /api/logs` | `fingerprint` param | "ดู log ทั้งหมดของ error นี้" (error-detail ×2); until then link with `q=<code>&route=<METHOD /path>&level=error` |
| 6 | `GET /api/logs` rows, `/api/errors/:fingerprint` `recent[]` | for error lines: `http.status` and `durationMs` joined from the `http.request` line of the same trace | status/duration chips (logs), "ครั้งล่าสุด" table (error-detail ×2) |
| 7 | all `route` params, overview `routes[]` | `route` = `METHOD /path` for HTTP (or a separate `method` field in `routes[]`) | links from overview/error-detail to traces/logs use `route=GET%20%2Fme` |
| 8 | `GET /api/errors` | `level`, `sort` (count / lastSeen / firstSeen), and `spark` (24 hourly counts from `from`) per group | errors list sort and per-row bars without one call per group |
| 9 | series with 15-minute step | buckets start at `from` (or a `step` param) | hourly bars aligned at :20 on errors and error-detail |
| 10 | `Dependency.state` | `degraded` when only `http.outbound_failed` lines exist in range | ThaID 401 × 4 shown as "ต้องดู" (overview, jobs) |

## 10. One dataset, built once

All per-minute values for 13:20–14:19 (requests, 5xx split by route, 4xx, p95, job attempts, log lines per level) come
from one table, and all hourly values for the 24 h screens come from 24 buckets aligned to the range start
(16 ต.ค. 14:20, last bucket 13:20–14:20). The mockup build scripts read that table, so Overview's 5xx bars, the Log
histogram, the components KPI and the error-detail charts agree minute by minute and hour by hour. The decisions
behind the numbers (0.16 % instead of 0.42 %, 4 job/min, 1.1 % 4xx on submit, the Trace C timeline) are in the
BRIEF change log.
- Don't create global classes in page CSS; prefix page-only classes (e.g. `.ov-…` for overview).
