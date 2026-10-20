import type { Metadata } from 'next'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { AutoRefresh } from '@/components/AutoRefresh'
import { Icon } from '@/components/icons'
import { PageHead } from '@/components/PageHead'
import { Section } from '@/components/Panel'
import { ParamSegmented } from '@/components/ParamControls'
import { EmptyState, EngineErrorState, ParamProblems } from '@/components/states'
import { engine, getMeta } from '@/lib/engine'
import { fmtCount } from '@/lib/format'
import { buildHref, inRange, isPastWindow, Params, parseScope, type RawSearchParams, scopeQuery } from '@/lib/params'
import { serviceOrder } from '@/lib/services'
import type { JobStat, LogRow } from '@/lib/types'
import { Dependencies } from './_components/Dependencies'
import { Failures, isDrawerLine, JobDrawer, lineKey } from './_components/Failures'
import { clockOf } from './_components/parts'
import { QueueTable } from './_components/QueueTable'
import { Summary } from './_components/Summary'
import { depRows, featuredStat, jobKey, MODULE_ORDER, moduleLabel, queueGroups, rangeLabelOf, rangeShortOf } from './_data'
import './screen.css'

export const metadata: Metadata = { title: 'งานเบื้องหลัง' }

const sameOwner = (s: JobStat) => (r: LogRow) => r.service === s.service && r.role === s.role

/**
 * งานเบื้องหลัง (design/monitoring-ui/jobs.html): queues, topics and cron of the apps (GET /api/jobs), the
 * failures of the worst queue with its error groups (GET /api/errors) and lines (GET /api/logs), and the
 * dependencies with their outages (GET /api/dependencies). URL: env / from / to, `source` (queue system
 * filter), `job=<id>.<attempt>` (drawer).
 */
export default async function JobsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const sp = await searchParams
  const meta = await getMeta()
  const scope = parseScope(sp, 'jobs', { envs: meta.ok ? meta.data.envs : undefined, limited: meta.ok && meta.data.envsLimited })
  const p = new Params(sp)
  const jobParam = p.str('job', 80)
  // ?job=<id>.<attempt>: every line of that job in the range (any queue), so the drawer finds a line that is not
  // among the latest failures and can say how the next attempt ended
  const drawerJobId = jobParam?.split('.')[0] || undefined
  const q = scopeQuery(scope)
  const order = serviceOrder(meta.ok ? meta.data : null)
  const clock = clockOf(scope.fromMs, scope.toMs)
  const rangeLabel = rangeLabelOf(scope)
  const rangeShort = rangeShortOf(scope)
  const rangeMs = scope.toMs - scope.fromMs
  // Log keeps its own 1 h default: links that carry a count pass this screen's range
  const logsHref = (extra: Record<string, string>) => buildHref('/logs', scope.keep, { from: scope.from, to: scope.to, ...extra })

  const [jobsRes, depsRes, errorsRes] = await Promise.all([engine.jobs(q), engine.dependencies(q), engine.errors({ ...q, limit: 200, sparkBuckets: 1 })])
  const stats = jobsRes.ok ? jobsRes.data.stats : []
  const featured = featuredStat(stats)
  const failing = stats.filter((s) => s.failed > 0)
  const redeliveredStats = stats.filter((s) => s.module === 'rabbitmq' && s.retried > 0)

  // the lines behind the numbers: real failures per queue, redeliveries, the featured queue's retry / failed lines
  const [finalRes, redelivRes, featRes, jobLinesRes] = await Promise.all([
    Promise.all(failing.map((s) => engine.logs({ ...q, route: jobKey(s), level: 'error,fatal', limit: 5 }))),
    Promise.all(redeliveredStats.map((s) => engine.logs({ ...q, route: jobKey(s), event: 'job.redelivered', limit: 20 }))),
    featured ? engine.logs({ ...q, route: jobKey(featured), level: 'warn,error,fatal', limit: 10 }) : Promise.resolve(null),
    drawerJobId ? engine.logs({ ...q, jobId: drawerJobId, limit: 50 }) : Promise.resolve(null),
  ])
  const recent = jobsRes.ok ? jobsRes.data.recentFailures : []
  const finals = new Map<string, LogRow[]>()
  failing.forEach((s, i) => {
    const res = finalRes[i]
    const rows = res.ok ? res.data.rows : recent.filter((r) => r.job?.queue === s.queue && r.job?.type === s.type && r.level !== 'warn')
    finals.set(jobKey(s), rows.filter(sameOwner(s)))
  })
  const redelivered = new Map<string, LogRow[]>()
  redeliveredStats.forEach((s, i) => {
    const res = redelivRes[i]
    if (res.ok) redelivered.set(jobKey(s), res.data.rows.filter(sameOwner(s)))
  })
  const featRows = featured
    ? (featRes?.ok ? featRes.data.rows : recent.filter((r) => r.job?.queue === featured.queue && r.job?.type === featured.type).slice(0, 10)).filter(sameOwner(featured))
    : []
  const featGroups = featured && errorsRes.ok ? errorsRes.data.groups.filter((g) => g.jobQueue === featured.queue && g.jobType === featured.type) : []

  const deps = depsRes.ok ? depRows(depsRes.data.dependencies, depsRes.data.events, scope.fromMs) : null

  // queue system filter (?source=)
  const present = [...new Set(stats.map((s) => s.module))]
  const systems = [...MODULE_ORDER.slice(0, 4), ...present.filter((m) => !MODULE_ORDER.slice(0, 4).includes(m))]
  const source = p.oneOf('source', systems)
  const groups = queueGroups(stats).filter((g) => !source || g.module === source)
  const sums = stats.find((s) => s.module === 'bullmq' && s.retried + s.failed > 0 && s.started === s.finished + s.retried + s.failed)

  // drawer: the retry / failed line of ?job=<id>.<attempt>, from the job's own lines (the featured queue first when
  // two queues use the same id), else from the lists above when that call failed
  const jobLines = jobLinesRes?.ok ? jobLinesRes.data.rows : null
  const candidates = jobParam ? (jobLines ?? [...featRows, ...recent, ...[...finals.values()].flat()]).filter((r) => lineKey(r) === jobParam && isDrawerLine(r)) : []
  const drawerRow = candidates.find((r) => featured && r.job?.queue === featured.queue && r.job?.type === featured.type) ?? candidates[0]
  const drawerStat = drawerRow?.job ? (stats.find((s) => s.queue === drawerRow.job?.queue && s.type === drawerRow.job?.type) ?? null) : featured
  const drawerJobLines = drawerRow?.job
    ? (jobLines ?? [...featRows, ...recent]).filter((r) => r.job?.id === drawerRow.job?.id && r.job?.queue === drawerRow.job?.queue && r.job?.type === drawerRow.job?.type)
    : []

  return (
    <>
      <PageHead
        scope={scope}
        title="งานเบื้องหลัง"
        question="Queue, cron และ consumer ทำงานครบไหม อะไรล้มเหลวจริง อะไรแค่ retry และระบบที่เรียกใช้ล่มช่วงไหน"
        actions={
          <>
            {isPastWindow(scope) ? null : <AutoRefresh />}
            <Link className="btn" href={logsHref({ event: 'job.failed' })}>
              เปิด Log ของ job ที่ล้มเหลว
              <Icon name="arrow" />
            </Link>
          </>
        }
      />
      <ParamProblems problems={[...scope.problems, ...p.problems]} />

      <Summary
        stats={jobsRes.ok ? stats : null}
        featured={featured}
        finals={finals}
        deps={deps}
        fromMs={scope.fromMs}
        toMs={scope.toMs}
        rangeLabel={rangeLabel}
        rangeShort={rangeShort}
        clock={clock}
      />

      <Section id="queues" title="Queue, topic และ cron" meta={jobsRes.ok ? `${fmtCount(stats.length)} รายการ · นับจากบรรทัด job.* ที่ library เขียน${inRange(rangeLabel)}` : undefined}>
        {!jobsRes.ok ? (
          <EngineErrorState error={jobsRes.error} />
        ) : !stats.length ? (
          <div className="panel">
            <EmptyState
              icon="jobs"
              title={`ไม่มีงานเบื้องหลัง${inRange(rangeLabel)}`}
              text="ไม่มีบรรทัด job.* ของ env และช่วงเวลาที่เลือก · ลองขยายช่วงเวลา หรือเลือก env อื่นที่แถบด้านบน"
            />
          </div>
        ) : (
          <>
            <div className="filterbar">
              <div className="jb-filter">
                <ParamSegmented
                  label="กรองตามระบบ queue"
                  param="source"
                  options={[{ value: '', label: 'ทั้งหมด' }, ...systems.map((m) => ({ value: m, label: moduleLabel(m) }))]}
                />
              </div>
              <span className="hint">queue ของแอปเอง ไม่ใช่ queue ที่ส่ง log มาให้ skilllane monitor</span>
            </div>
            {groups.length ? (
              <QueueTable
                groups={groups}
                finals={finals}
                redelivered={redelivered}
                consumerEvents={jobsRes.data.consumerEvents}
                featured={featured}
                deps={deps ?? []}
                env={scope.env}
                rangeLabel={rangeLabel}
                rangeMs={rangeMs}
                keep={scope.keep}
                order={order}
                clock={clock}
              />
            ) : (
              <div className="panel">
                <EmptyState icon="filter" title={`ไม่มี ${moduleLabel(source ?? '')} ${inRange(rangeLabel)}`} text="ระบบ queue นี้ไม่มีบรรทัด job.* ในช่วงที่เลือก · กด ทั้งหมด เพื่อดูทุกระบบ" />
              </div>
            )}
            <ul className="legend jb-legend">
              <li className="legend__item">
                <span className="legend__key" style={{ '--c': 'var(--bar-neutral)' } as CSSProperties} />
                สำเร็จ
              </li>
              <li className="legend__item">
                <span className="legend__key" style={{ '--c': 'var(--warn-solid)' } as CSSProperties} />
                retry / redeliver
              </li>
              <li className="legend__item">
                <span className="legend__key" style={{ '--c': 'var(--danger-solid)' } as CSSProperties} />
                ล้มเหลวจริง
              </li>
              <li className="legend__item t-muted">ผลลัพธ์ยาวตามสัดส่วนจริง ส่วนที่ไม่ใช่ศูนย์กว้างอย่างน้อย 2 px</li>
            </ul>
            <p className="hint jb-foot">
              BullMQ: เริ่ม = สำเร็จ + retry + ล้มเหลว
              {sums ? ` (${fmtCount(sums.started)} = ${fmtCount(sums.finished)} + ${fmtCount(sums.retried)} + ${fmtCount(sums.failed)})` : ''} · p95 คิดจากทุก attempt ที่จบแล้ว (สำเร็จ,
              retry และล้มเหลว) · cron ไม่มี retry จึงแสดง –
            </p>
          </>
        )}
      </Section>

      {jobsRes.ok && stats.length ? (
        featured ? (
          <section className="section jb-anchor" id="failures" aria-labelledby="h-failures">
            <Failures
              stat={featured}
              groups={featGroups}
              rows={featRows}
              finals={finals.get(jobKey(featured)) ?? []}
              logsHref={logsHref({ route: jobKey(featured), level: 'warn,error,fatal' })}
              keep={scope.keep}
              order={order}
              clock={clock}
              env={scope.env}
              rangeMs={rangeMs}
            />
          </section>
        ) : (
          <Section id="failures" className="jb-anchor" title="Job ที่ล้มเหลว">
            <div className="panel">
              <EmptyState icon="check-circle" title={`ไม่มี job ที่ล้มเหลวหรือ retry ${inRange(rangeLabel)}`} text="ทุก job, message และรอบของ cron ในช่วงนี้จบด้วย job.finished" />
            </div>
          </Section>
        )
      ) : null}

      {depsRes.ok && deps ? (
        deps.length ? (
          <Dependencies
            rows={deps}
            env={scope.env}
            fromMs={scope.fromMs}
            toMs={scope.toMs}
            rangeLabel={rangeLabel}
            rangeShort={rangeShort}
            keep={scope.keep}
            order={order}
            clock={clock}
            outboundLogsHref={(host) => logsHref({ event: 'http.outbound_failed', q: host })}
          />
        ) : (
          <Section id="dependencies" className="jb-anchor" title="ระบบที่เรียกใช้ (dependency)">
            <div className="panel">
              <EmptyState
                icon="panel"
                title="ยังไม่มี dependency ที่ library เฝ้าดู"
                text="ไม่มีบรรทัด dependency.* หรือ http.outbound_failed ของ env นี้ใน 7 วัน · library เขียนเมื่อเชื่อมต่อ Redis, Kafka, RabbitMQ หรือ API ภายนอกครั้งแรก"
              />
            </div>
          </Section>
        )
      ) : !depsRes.ok ? (
        <Section id="dependencies" className="jb-anchor" title="ระบบที่เรียกใช้ (dependency)">
          <EngineErrorState error={depsRes.error} />
        </Section>
      ) : null}

      {jobParam ? (
        <JobDrawer
          value={jobParam}
          row={drawerRow}
          rows={drawerJobLines}
          complete={!!jobLines}
          stat={drawerStat}
          keep={scope.keep}
          order={order}
          clock={clock}
          rangeMs={rangeMs}
          logsHrefOf={(row) => logsHref(row.job?.id ? { jobId: row.job.id, route: jobKey(row.job) } : { traceId: row.traceId })}
          missingLogsHref={drawerJobId ? logsHref({ jobId: drawerJobId }) : undefined}
        />
      ) : null}
    </>
  )
}
