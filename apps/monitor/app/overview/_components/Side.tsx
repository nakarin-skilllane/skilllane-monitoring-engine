/**
 * Right column "ทั้ง env …": top error groups and background jobs of the last 24 h (GET /api/errors, /api/jobs with
 * from=now-24h, whatever the page range), and the Dependency list (GET /api/dependencies of the page range:
 * state as of now, outages and failed calls in the range). Dependency items light their map node on hover.
 */
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { CategoryChip, LevelBadge, ServiceChip, StateChip, Tag, Ts } from '@/components/badges'
import { Panel } from '@/components/Panel'
import { EmptyState, EngineErrorState } from '@/components/states'
import type { EngineError } from '@/lib/engine'
import { fmtCount, fmtDuration, sameDay } from '@/lib/format'
import { buildHref, type Scope } from '@/lib/params'
import { groupTitle, MODULE_LABEL } from '@/lib/readable'
import type { ErrorGroup, JobStat } from '@/lib/types'
import type { DepRow } from '../_lib/model'
import { at, atSec, inRange } from '../_lib/text'
import { LinkedItem } from './MapLink'

type Res<T> = { ok: true; data: T } | { ok: false; error: EngineError }

export interface SideProps {
  scope: Scope
  order: string[]
  groups: Res<{ groups: ErrorGroup[] }>
  deps: Res<DepRow[]>
  jobs: Res<{ stats: JobStat[] }>
}

const TOP = 5

export function Side({ scope, order, groups, deps, jobs }: SideProps) {
  const keep = scope.keep
  return (
    <section className="section ov-side" aria-labelledby="ov-side-t">
      <div className="section__head">
        <h2 className="section__title" id="ov-side-t">
          ทั้ง env {scope.env ?? '(ทุก env)'}
        </h2>
        <span className="section__meta">24 ชั่วโมงล่าสุด · ไม่ขึ้นกับ service และช่วงเวลาที่เลือก</span>
      </div>
      <div className="stack ov-side__stack">
        {errorGroups(groups)}
        {dependencies(deps)}
        {backgroundJobs(jobs)}
      </div>
    </section>
  )

  function errorGroups(res: SideProps['groups']) {
    const all = res.ok ? res.data.groups : []
    const top = all.slice(0, TOP)
    const services = [...new Set(all.map((g) => g.service))]
    return (
      <Panel
        title="Error group อันดับต้น"
        meta="24 ชั่วโมงล่าสุด"
        actions={
          <Link className="btn btn--sm btn--quiet" href={buildHref('/errors', keep)}>
            ดูทั้งหมด
          </Link>
        }
        flush
        foot={
          res.ok && top.length ? (
            <>
              {top.length} จาก {all.length >= 100 ? '100+' : all.length} group · เรียงตามจำนวนครั้ง ·{' '}
              {services.length === 1 ? (
                <>
                  ทั้งหมดจาก <ServiceChip service={services[0]} order={order} />
                </>
              ) : (
                `จาก ${services.length} service`
              )}
            </>
          ) : undefined
        }
      >
        {!res.ok ? (
          <EngineErrorState error={res.error} inPanel={false} />
        ) : top.length ? (
          <div className="err-list">
            {top.map((g) => {
              const where = g.routes[0] ?? (g.jobType ? `job ${g.jobType}` : g.dependencyName ? `dependency ${g.dependencyName}` : '')
              // a job group's count is retries (warn) + real failures (error), as the mockup splits it
              const jobSplit = g.jobType && g.warnCount > 0 ? `${fmtCount(g.warnCount)} ${g.eventModule === 'rabbitmq' ? 'redeliver' : 'retry'} · ${fmtCount(g.errorCount)} ล้มเหลวจริง` : null
              return (
                <article className="err-row err-row--compact" key={g.fingerprint}>
                  <div className="err-row__main">
                    <div className="err-row__head">
                      <LevelBadge level={g.level} />
                      <h4 className="err-row__title">
                        <Link href={buildHref(`/errors/${g.fingerprint}`, keep)}>{groupTitle(g)}</Link>
                      </h4>
                      {g.isNew ? <span className="badge-new">NEW</span> : null}
                    </div>
                    <p className="err-row__ctx">
                      <CategoryChip category={g.category} />
                      {where ? <span className="mono">{where}</span> : null}
                    </p>
                  </div>
                  <p className="err-row__n">
                    <b>{fmtCount(g.count)}</b>
                    {jobSplit ? <span>{jobSplit}</span> : g.users ? <span>{fmtCount(g.users)} users</span> : <span>{g.service}/{g.role}</span>}
                  </p>
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState icon="check-circle" title="ไม่มี error ใน 24 ชั่วโมงล่าสุด" text={`ไม่มีบรรทัด warn หรือ error ที่มี error group ใน ${scope.env ?? 'ทุก env'}`} />
        )}
      </Panel>
    )
  }

  function dependencies(res: SideProps['deps']) {
    const rows = res.ok ? res.data : []
    const services = [...new Set(rows.flatMap((d) => d.users.map((u) => u.service)))]
    const span = scope.toMs - scope.fromMs
    return (
      <Panel
        id="ov-dep"
        title={<span id="ov-dep-t">Dependency</span>}
        meta="สถานะล่าสุด"
        actions={
          <Link className="btn btn--sm btn--quiet" href={`${buildHref('/jobs', keep)}#dependencies`}>
            ดูประวัติ
          </Link>
        }
        flush
        foot={
          rows.length ? (
            <>
              ที่มีปัญหาอยู่บนสุด · ใช้โดย{' '}
              {services.map((s, i) => (
                <span key={s}>
                  {i ? ' ' : null}
                  <ServiceChip service={s} order={order} />
                </span>
              ))}
            </>
          ) : undefined
        }
      >
        {!res.ok ? (
          <EngineErrorState error={res.error} inPanel={false} />
        ) : rows.length ? (
          <ul className="dep-list">
            {rows.map((d) => {
              const hostPort = d.port ? `${d.host}:${d.port}` : d.host
              const n = d.outboundFailures || d.attempts
              let chip
              let sub: string | null = null
              if (d.issue === 'down') {
                chip = <StateChip state="down">down ตั้งแต่ {d.since ? atSec(d.since, scope.nowMs) : '–'}</StateChip>
                sub = `${d.errorCode ? `${d.errorCode} ` : 'ล้มเหลว '}${fmtCount(d.attempts)} ครั้ง${inRange(scope)}`
              } else if (d.issue === 'degraded') {
                chip = <StateChip state="warn">{d.status ? `${d.status} ` : 'ล้มเหลว '}{fmtCount(n)} ครั้ง</StateChip>
                sub = `${d.status && d.status < 500 ? 'ปฏิเสธ request' : 'เรียกไม่สำเร็จ'} ${fmtCount(n)} ครั้ง${inRange(scope)}`
              } else if (d.issue === 'recovered' && d.downAtMs !== null) {
                chip = <StateChip state="ok">up ตั้งแต่ {atSec(d.upAtMs, scope.nowMs)}</StateChip>
                sub = `down ${fmtDuration(d.lastOutageMs)} เมื่อ ${atSec(d.downAtMs, scope.nowMs)}`
              } else {
                chip = <StateChip state="ok">up</StateChip>
              }
              const strip =
                d.issue === 'recovered' && d.downAtMs !== null && d.upAtMs !== null ? (
                  <div className="dep__strip" role="img" aria-label={`ช่วง down ${atSec(d.downAtMs, scope.nowMs)}–${atSec(d.upAtMs, scope.nowMs)} ในช่วง ${at(scope.fromMs, scope.nowMs)}–${at(scope.toMs, scope.nowMs)}`}>
                    <span className="dur dur--bad">
                      <i
                        style={
                          {
                            '--s': Math.max(0, ((d.downAtMs - scope.fromMs) / span) * 100).toFixed(1),
                            '--w': Math.max(0.6, ((d.upAtMs - d.downAtMs) / span) * 100).toFixed(1),
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className="mini-axis" aria-hidden="true">
                      <span className="mini-axis__start">{at(scope.fromMs, scope.nowMs)}</span>
                      <span className="mini-axis__end">{at(scope.toMs, scope.nowMs)}</span>
                    </span>
                  </div>
                ) : null
              return (
                <LinkedItem key={d.key} node={d.nodeId}>
                  <span className="dep">
                    <span className="dep__top">
                      <Tag>{d.type}</Tag>
                      <Link className="dep__name" href={`${buildHref('/jobs', keep)}#${d.anchor}`}>
                        {d.name}
                      </Link>
                    </span>
                    <span className="dep__host">{hostPort}</span>
                  </span>
                  {chip}
                  {sub ? <p className="dep__sub">{sub}</p> : null}
                  {strip}
                </LinkedItem>
              )
            })}
          </ul>
        ) : (
          <EmptyState title="ไม่มี dependency ที่ SDK เฝ้าดู" text={`ไม่มีบรรทัด dependency.* หรือ http.outbound_failed ใน ${scope.env ?? 'ทุก env'}`} />
        )}
      </Panel>
    )
  }

  function backgroundJobs(res: SideProps['jobs']) {
    const stats = res.ok ? res.data.stats : []
    const queues = stats.filter((j) => j.module !== 'cron').sort((a, b) => b.failed - a.failed || b.retried - a.retried || b.started - a.started)
    const crons = stats.filter((j) => j.module === 'cron')
    return (
      <Panel
        title="งานเบื้องหลัง"
        meta="24 ชั่วโมงล่าสุด"
        actions={
          <Link className="btn btn--sm btn--quiet" href={buildHref('/jobs', keep)}>
            ดูทั้งหมด
          </Link>
        }
        flush
      >
        {!res.ok ? (
          <EngineErrorState error={res.error} inPanel={false} />
        ) : stats.length ? (
          <>
            {queues.length ? (
              <div className="table-wrap">
                <table className="table table--dense ov-jobs">
                  <caption className="sr-only">สรุป queue ใน 24 ชั่วโมงล่าสุด</caption>
                  <thead>
                    <tr>
                      <th scope="col">Queue</th>
                      <th scope="col" className="num" title="บรรทัด job.started นับทุก attempt">
                        เริ่ม
                      </th>
                      <th scope="col" className="num">
                        ล้มเหลว
                      </th>
                      <th scope="col" className="num">
                        p95
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {queues.map((j) => (
                      <tr key={`${j.module}|${j.queue}|${j.type}`}>
                        <td>
                          <Link className="queue-name" href={`${buildHref('/jobs', keep)}#queues`} title={j.type}>
                            {j.queue}
                          </Link>
                          <span className="queue-sub">
                            <Tag>{MODULE_LABEL[j.module] ?? j.module}</Tag>
                            {j.retried ? <span>{j.module === 'bullmq' ? 'retry' : 'redeliver'} {fmtCount(j.retried)} ครั้ง</span> : null}
                          </span>
                        </td>
                        <td className="num">{fmtCount(j.started)}</td>
                        <td className="num">
                          <span className={j.failed ? 't-danger' : 't-muted'}>{fmtCount(j.failed)}</span>
                        </td>
                        <td className="num">{j.p95Ms ? fmtDuration(j.p95Ms) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {crons.length ? (
              <ul className="cron-list">
                {crons.map((c) => (
                  <li className="cron-line" key={c.type}>
                    <StateChip state={c.failed ? 'warn' : 'ok'}>
                      <Tag>cron</Tag>
                    </StateChip>
                    <span className="cron-line__name">{c.type}</span>
                    <span className="cron-line__when">
                      รัน {fmtCount(c.started)} ครั้ง ·{' '}
                      {c.failed && c.lastFailedAt ? (
                        <>
                          <span className="t-warn">ล้มเหลว {fmtCount(c.failed)} ครั้ง</span> <Ts value={c.lastFailedAt} format={sameDay(c.lastFailedAt, scope.nowMs) ? 'min' : 'date'} />
                        </>
                      ) : c.lastRunAt ? (
                        <>
                          ล่าสุด <Ts value={c.lastRunAt} format={sameDay(c.lastRunAt, scope.nowMs) ? 'min' : 'date'} /> ปกติ
                        </>
                      ) : (
                        'ปกติ'
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <EmptyState title="ไม่มีงานเบื้องหลังใน 24 ชั่วโมงล่าสุด" text="ไม่มีบรรทัด job.* ใน env นี้" />
        )}
      </Panel>
    )
  }
}

