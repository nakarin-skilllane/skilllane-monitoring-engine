/**
 * "ต้องดูตอนนี้": at most three callouts, most severe first, computed from the range's error groups (NEW after
 * deploy), HTTP routes (error ≥ 5 % over ≥ 20 requests: "Route error สูง"; p95 ≥ 1 s: "Route ช้า"), service / roles
 * that went quiet (เงียบ) and dependencies (down · degraded · recovered in range); the rules are in _lib/model.ts and
 * README "ต้องดูตอนนี้". One callout per source first, by severity: dependency down, NEW group, route error, เงียบ,
 * slow route, dependency degraded, dependency recovered; free slots take the next NEW group, route error or
 * dependency problem. A route error that the NEW callout already names is left out.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CategoryChip, NewBadge, ServiceChip, StateChip, Ts } from '@/components/badges'
import { Icon, type IconName } from '@/components/icons'
import { fmtCount, fmtDuration, fmtMs, fmtPct, fmtRate, sameDay, shortId } from '@/lib/format'
import { buildHref, type Scope } from '@/lib/params'
import { groupTitle, systemLabel } from '@/lib/readable'
import type { ErrorGroup, ErrorSpark, Meta, OverviewRoute, OverviewSeriesPoint, SpanRow, TraceListRow } from '@/lib/types'
import { type DepRow, deployOf, depTitle, topGroup } from '../_lib/model'
import { at, atSec, gap, inRange } from '../_lib/text'

type Tone = 'error' | 'warn' | 'info'
const RANK: Record<Tone, number> = { error: 0, warn: 1, info: 2 }
const ICON: Record<Tone | 'ok', IconName> = { error: 'alert-octagon', warn: 'alert-triangle', info: 'info', ok: 'check-circle' }
const DAY_MS = 86_400_000

interface Item {
  key: string
  tone: Tone
  title: ReactNode
  text: ReactNode
  actions?: ReactNode
}

/** Severity of a source (lower = shown first). */
const SOURCE_RANK = { depDown: 0, newGroup: 1, routeError: 2, silent: 3, slowRoute: 4, depDegraded: 5, depRecovered: 6 } as const
type Ranked = Item & { rank: number }

function Callout({ tone, title, text, actions }: { tone: Tone | 'ok'; title: ReactNode; text: ReactNode; actions?: ReactNode }) {
  return (
    <div className={tone === 'info' ? 'callout' : `callout callout--${tone}`}>
      <Icon name={ICON[tone]} className="callout__icon" />
      <p className="callout__title">{title}</p>
      <p className="callout__text">{text}</p>
      {actions ? <div className="callout__actions">{actions}</div> : null}
    </div>
  )
}

const Sep = () => <> · </>

export interface SlowTrace {
  row: TraceListRow
  span: Pick<SpanRow, 'name' | 'durationMs'> | null
}

/** A service / role that went quiet (เงียบ, _lib/model.ts). */
export interface SilentRole {
  service: string
  role: string
  /** request · job · message */
  what: string
  /** `req/นาที` … */
  unit: string
  /** Start of its last entry span (ms). */
  lastMs: number
  rpmBefore: number | null
}

export interface AttentionProps {
  scope: Scope
  meta: Meta | null
  order: string[]
  /** Error groups of the range (overview). */
  groups: ErrorGroup[]
  /** Buckets of their `spark` (the in-range last occurrence of a custom range). */
  spark: ErrorSpark
  /** Error groups of the last 24 h (counts since first seen), null when that call failed. */
  groups24: ErrorGroup[] | null
  /** Slow HTTP route to report (most requests among p95 ≥ 1 s), its slowest trace and its p95 before deploy. */
  slow: { route: OverviewRoute; trace: SlowTrace | null; baseP95: number | null } | null
  deps: DepRow[]
  /** HTTP routes of the "Route error สูง" rule (failingRoutes), most failed requests first. */
  failing: OverviewRoute[]
  silent: SilentRole[]
  /** Series of the selected service/role (the outage's effect on it). */
  series: { service: string; role: string; points: OverviewSeriesPoint[]; stepSeconds: number } | null
}

export function Attention({ scope, meta, order, groups, spark, groups24, slow, deps, failing, silent, series }: AttentionProps) {
  const keep = scope.keep
  const now = scope.nowMs
  const newGroups = groups.filter((g) => g.isNew).sort((a, b) => b.count - a.count)

  const groupItem = (g: ErrorGroup): Item => {
    const deploy = deployOf(meta, scope.env, g.service, g.role)
    const first = Date.parse(g.firstSeen)
    const g24 = first >= now - DAY_MS ? groups24?.find((x) => x.fingerprint === g.fingerprint) : undefined
    const where = g.routes[0] ?? (g.jobType ? `job ${g.jobType}` : '')
    // a custom (past) range leads with its own count and last time; the 24 h total is context
    const custom = scope.preset === 'custom'
    let lastIn: ReactNode = <Ts value={g.lastSeen} format={sameDay(g.lastSeen, now) ? 'min' : 'date'} />
    if (custom && Date.parse(g.lastSeen) > scope.toMs) {
      const i = g.spark.findLastIndex((n) => n > 0)
      const step = spark.stepSeconds * 1000
      const start = Date.parse(spark.from) + Math.max(0, i) * step
      lastIn = i < 0 ? '–' : <span className="ts">{at(start, now)}–{at(Math.min(start + step, scope.toMs), now)}</span>
    }
    return {
      key: `g${g.fingerprint}`,
      tone: 'error',
      title: (
        <>
          Error ใหม่หลัง deploy {g.firstSeenVersion}: {groupTitle(g)} <NewBadge /> <CategoryChip category={g.category} />
        </>
      ),
      text: custom ? (
        <>
          <b className="t-strong">{fmtCount(g.count)}</b> ครั้งในช่วงที่เลือก
          <Sep />
          {fmtCount(g.users)} users
          {where ? (
            <>
              <Sep />
              <span className="mono">{where}</span>
            </>
          ) : null}
          <Sep />
          <ServiceChip service={g.service} role={g.role} order={order} />
          <Sep />
          ครั้งแรก <Ts value={g.firstSeen} format={sameDay(first, now) ? 'min' : 'date'} />
          {deploy && first >= deploy.atMs ? ` (${gap(first - deploy.atMs)}หลัง deploy)` : null}
          <Sep />
          ล่าสุดในช่วงนี้ {lastIn}
          {g24 ? (
            <>
              <Sep />
              รวม {fmtCount(g24.count)} ครั้งตั้งแต่ {at(first, now)}
            </>
          ) : null}
        </>
      ) : (
        <>
          {g24 ? (
            <>
              <b className="t-strong">{fmtCount(g24.count)}</b> ครั้งตั้งแต่ {at(first, now)}
              <Sep />
              {fmtCount(g24.users)} users
            </>
          ) : (
            <>
              <b className="t-strong">{fmtCount(g.count)}</b> ครั้ง{inRange(scope)}
              <Sep />
              {fmtCount(g.users)} users
            </>
          )}
          {where ? (
            <>
              <Sep />
              <span className="mono">{where}</span>
            </>
          ) : null}
          <Sep />
          <ServiceChip service={g.service} role={g.role} order={order} />
          <Sep />
          ครั้งแรก <Ts value={g.firstSeen} format={sameDay(first, now) ? 'min' : 'date'} />
          {deploy && first >= deploy.atMs ? ` (${gap(first - deploy.atMs)}หลัง deploy)` : null}
          <Sep />
          ล่าสุด <Ts value={g.lastSeen} format={sameDay(g.lastSeen, now) ? 'min' : 'date'} />
          {g24 ? (
            <>
              <Sep />
              {fmtCount(g.count)} ครั้งอยู่{inRange(scope)}
            </>
          ) : null}
        </>
      ),
      actions: (
        <Link className="btn btn--sm" href={buildHref(`/errors/${g.fingerprint}`, keep)}>
          เปิด error
        </Link>
      ),
    }
  }

  const routeItem = (s: NonNullable<AttentionProps['slow']>): Item => {
    const r = s.route
    const t = s.trace
    return {
      key: `r${r.service}/${r.role} ${r.route}`,
      tone: 'warn',
      title: `Route ช้า: ${r.route} p95 ${fmtDuration(r.p95Ms)}`,
      text: (
        <>
          <ServiceChip service={r.service} role={r.role} order={order} />
          <Sep />
          {fmtCount(r.requests)} request
          <Sep />
          error {fmtPct(r.errorRate)}
          {s.baseP95 !== null ? (
            <>
              <Sep />
              ก่อน deploy p95 {fmtDuration(s.baseP95)}
            </>
          ) : null}
          {t ? (
            <>
              <Sep />
              trace ช้าสุด{' '}
              <Link href={buildHref(`/traces/${t.row.traceId}`, keep)} className="mono" title={t.row.traceId}>
                {shortId(t.row.traceId)}
              </Link>{' '}
              {fmtMs(t.row.durationMs)}
              {t.span ? (
                <>
                  {' '}
                  ใช้เวลาใน <span className="mono">{t.span.name}</span> {fmtMs(t.span.durationMs)}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ),
      actions: (
        <Link className="btn btn--sm" href={buildHref('/traces', keep, { route: r.route, minMs: 1000 })}>
          ดู trace ที่ช้า
        </Link>
      ),
    }
  }

  const routeErrorItem = (r: OverviewRoute): Item => {
    // the group most of its failures belong to (the one to open)
    const g = topGroup(groups, (x) => x.service === r.service && x.role === r.role && x.routes.includes(r.route))
    return {
      key: `e${r.service}/${r.role} ${r.route}`,
      tone: 'error',
      title: `Route error สูง: ${r.route} error ${fmtPct(r.errorRate)}`,
      text: (
        <>
          <ServiceChip service={r.service} role={r.role} order={order} />
          <Sep />
          error <b className="t-strong">{fmtCount(r.errors)}</b> จาก {fmtCount(r.requests)} request {inRange(scope)}
          <Sep />
          p95 {fmtDuration(r.p95Ms)}
          {g ? (
            <>
              <Sep />
              ส่วนใหญ่เป็น {groupTitle(g)} {fmtCount(g.count)} ครั้ง <CategoryChip category={g.category} />
            </>
          ) : null}
        </>
      ),
      actions: (
        <Link className="btn btn--sm" href={g ? buildHref(`/errors/${g.fingerprint}`, keep) : buildHref('/errors', keep, { service: r.service, role: r.role })}>
          เปิด error
        </Link>
      ),
    }
  }

  const silentItem = (list: SilentRole[]): Item => {
    const one = list.length === 1 ? list[0] : null
    const logsAround = (s: SilentRole) =>
      buildHref('/logs', keep, {
        service: s.service,
        role: s.role,
        from: new Date(s.lastMs - 10 * 60_000).toISOString(),
        to: new Date(Math.min(now, s.lastMs + 10 * 60_000)).toISOString(),
      })
    return {
      key: 'silent',
      tone: 'warn',
      title: one ? `${one.service}/${one.role} เงียบ: ไม่มี ${one.what} ตั้งแต่ ${at(one.lastMs, now)}` : `${list.length} service/role เงียบ: ไม่มี request, job หรือ message เข้ามา`,
      text: one ? (
        <>
          <ServiceChip service={one.service} role={one.role} order={order} />
          <Sep />
          เงียบมา {gap(scope.toMs - one.lastMs)}
          {one.rpmBefore !== null ? (
            <>
              <Sep />
              ก่อนหน้านั้นเฉลี่ย {fmtRate(one.rpmBefore)} {one.unit}
            </>
          ) : null}
        </>
      ) : (
        list.map((s, i) => (
          <span key={`${s.service}/${s.role}`}>
            {i ? <Sep /> : null}
            <ServiceChip service={s.service} role={s.role} order={order} /> ไม่มี {s.what} ตั้งแต่ {at(s.lastMs, now)}
          </span>
        ))
      ),
      actions: one ? (
        <Link className="btn btn--sm" href={logsAround(one)}>
          ดู log ก่อนเงียบ
        </Link>
      ) : (
        <a className="btn btn--sm" href="#ov-health-t">
          ดูสุขภาพ service
        </a>
      ),
    }
  }

  const depItem = (d: DepRow): Item | null => {
    const name = depTitle(d, systemLabel)
    const hostPort = d.port ? `${d.host}:${d.port}` : d.host
    const users = (
      <>
        ใช้โดย{' '}
        {[...new Map(d.users.map((u) => [`${u.service}/${u.role}`, u])).values()].map((u, i) => (
          <span key={`${u.service}/${u.role}`}>
            {i ? ' ' : null}
            <ServiceChip service={u.service} role={u.role} order={order} />
          </span>
        ))}
      </>
    )
    const action = (
      <Link className="btn btn--sm" href={`${buildHref('/jobs', keep)}#${d.anchor}`}>
        ดู dependency
      </Link>
    )
    if (d.issue === 'down') {
      return {
        key: `d${d.key}`,
        tone: 'error',
        title: `${name} down อยู่ ตั้งแต่ ${d.since ? at(d.since, now) : '–'}${d.since ? ` (${gap(now - Date.parse(d.since))})` : ''}`,
        text: (
          <>
            <span className="mono">{hostPort}</span>
            <Sep />
            {d.errorCode ? `${d.errorCode} ` : 'ล้มเหลว '}
            {fmtCount(d.attempts)} ครั้ง
            <Sep />
            {users}
          </>
        ),
        actions: action,
      }
    }
    if (d.issue === 'degraded') {
      const n = d.outboundFailures || d.attempts
      const refused = d.status !== null && d.status >= 400 && d.status < 500
      return {
        key: `d${d.key}`,
        tone: 'warn',
        title: `${name} ${refused ? 'ปฏิเสธ request' : 'เรียกไม่สำเร็จ'} ${fmtCount(n)} ครั้ง${inRange(scope)}`,
        text: (
          <>
            <span className="mono">{d.host}</span>
            {d.status ? (
              <>
                <Sep />
                HTTP {d.status} {fmtCount(n)} ครั้ง
              </>
            ) : null}
            {d.since ? (
              <>
                <Sep />
                ครั้งแรก <Ts value={d.since} format={sameDay(d.since, now) ? 'min' : 'date'} />
              </>
            ) : null}
            {d.lastEventAt ? (
              <>
                <Sep />
                ล่าสุด <Ts value={d.lastEventAt} format={sameDay(d.lastEventAt, now) ? 'min' : 'date'} />
              </>
            ) : null}
            <Sep />
            {users}
          </>
        ),
        actions: action,
      }
    }
    if (d.issue === 'recovered' && d.downAtMs !== null && d.upAtMs !== null) {
      // what it did to the selected service in those minutes
      let effect: ReactNode = null
      if (series && d.users.some((u) => u.service === series.service && u.role === series.role)) {
        const step = series.stepSeconds * 1000
        const hit = series.points.filter((p) => {
          const t = Date.parse(p.t)
          return t + step > (d.downAtMs as number) && t <= (d.upAtMs as number)
        })
        if (hit.length) {
          const errors = hit.reduce((a, p) => a + p.errors, 0)
          const p95 = Math.max(...hit.map((p) => p.p95Ms))
          effect = (
            <>
              <Sep />
              ช่วงนั้น <ServiceChip service={series.service} role={series.role} order={order} /> มี 5xx {fmtCount(errors)} ครั้ง p95 สูงสุด{' '}
              {fmtDuration(p95)}
            </>
          )
        }
      }
      return {
        key: `d${d.key}`,
        tone: 'info',
        title: `${name} down ${fmtDuration(d.lastOutageMs)} เมื่อ ${at(d.downAtMs, now)} กลับมาแล้ว`,
        text: (
          <>
            <span className="mono">{hostPort}</span>
            <Sep />
            {d.errorCode ? `${d.errorCode} ` : 'ล้มเหลว '}
            {fmtCount(d.attempts)} ครั้ง{' '}
            <span className="ts">
              {atSec(d.downAtMs, now)}–{atSec(d.upAtMs, now)}
            </span>
            <Sep />
            <StateChip state="ok">up ตั้งแต่ {atSec(d.upAtMs, now)}</StateChip>
            {effect}
          </>
        ),
        actions: action,
      }
    }
    return null
  }

  const ranked = (it: Item | null, rank: number): Ranked[] => (it ? [{ ...it, rank }] : [])
  const depRank = (d: DepRow) => (d.issue === 'down' ? SOURCE_RANK.depDown : d.issue === 'degraded' ? SOURCE_RANK.depDegraded : SOURCE_RANK.depRecovered)
  const depItems = deps.flatMap((d) => ranked(depItem(d), depRank(d)))
  const newItems = newGroups.flatMap((g) => ranked(groupItem(g), SOURCE_RANK.newGroup))
  // a route whose failures are the NEW group already shown is that callout's story
  const shownNew = newGroups[0]
  const covered = (r: OverviewRoute) => !!shownNew && shownNew.service === r.service && shownNew.role === r.role && shownNew.routes.includes(r.route)
  const failItems = failing.filter((r) => !covered(r)).flatMap((r) => ranked(routeErrorItem(r), SOURCE_RANK.routeError))
  const primary = [
    ...newItems.slice(0, 1),
    ...failItems.slice(0, 1),
    ...ranked(silent.length ? silentItem(silent) : null, SOURCE_RANK.silent),
    ...ranked(slow ? routeItem(slow) : null, SOURCE_RANK.slowRoute),
    ...depItems.slice(0, 1),
  ].sort((a, b) => a.rank - b.rank)
  const extra = [...newItems.slice(1), ...failItems.slice(1), ...depItems.slice(1)].sort((a, b) => a.rank - b.rank)
  const items = [...primary, ...extra].slice(0, 3).sort((a, b) => RANK[a.tone] - RANK[b.tone] || a.rank - b.rank)

  return (
    <section className="section ov-attn" aria-labelledby="ov-attn-t">
      <div className="section__head">
        <h2 className="section__title" id="ov-attn-t">
          ต้องดูตอนนี้
        </h2>
        <span className="section__meta">
          {items.length ? `${items.length} เรื่อง · เรียงจากรุนแรงไปเบา · ` : ''}สรุปจาก error group, route, service ที่เงียบ และ dependency
        </span>
      </div>
      <div className="callouts">
        {items.length ? (
          items.map((it) => <Callout key={it.key} tone={it.tone} title={it.title} text={it.text} actions={it.actions} />)
        ) : (
          <Callout
            tone="ok"
            title={`ไม่มีเรื่องที่ต้องดู${inRange(scope)}`}
            text="ไม่มี error group ใหม่หลัง deploy ไม่มี route ที่ error ≥ 5 % หรือ p95 ≥ 1 s ไม่มี service ที่เงียบ และทุก dependency ปกติ"
          />
        )}
      </div>
    </section>
  )
}
