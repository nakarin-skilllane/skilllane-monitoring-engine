/**
 * "<job type> ที่ล้มเหลว" (server): the error groups of the queue with the most real failures, its latest
 * job.retry / job.failed lines (job id opens the drawer, ?job=<id>.<attempt>), and the drawer with every field
 * of that line and the Copy-for-AI Markdown (DESIGN.md §6b, no PII).
 */
import Link from 'next/link'
import { CategoryChip, EnvTag, LevelBadge, ServiceChip } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { Drawer, DrawerLink } from '@/components/Drawer'
import { ErrorWhatFix, KvList } from '@/components/ErrorParts'
import { LiveTbody } from '@/components/Motion'
import { EmptyState } from '@/components/states'
import { fmtCount, fmtDateTimeMs, fmtDuration, fmtMs } from '@/lib/format'
import { buildHref, type Keep } from '@/lib/params'
import { actualError, aiErrorMarkdown, aiFieldsOfLog, logKvs, logTitle, logWhatFix } from '@/lib/readable'
import type { ErrorGroup, JobStat, LogRow } from '@/lib/types'
import { moduleLabel, rangeEnglish } from '../_data'
import { type Clock, GroupErrorRow, T, TraceChip } from './parts'

/** Drawer key of a line: `<job id>.<attempt>`. */
export const lineKey = (r: LogRow): string => `${r.job?.id ?? ''}.${r.job?.attempt ?? 0}`

const isFinal = (r: LogRow) => !!r.job?.final || r.eventCode === 'job.failed' || r.eventCode === 'job.stalled' || r.eventCode === 'message.dead_lettered'

const DRAWER_EVENTS = new Set(['job.retry', 'job.redelivered', 'job.failed', 'job.stalled', 'message.dead_lettered'])

/** A line the drawer opens (?job=<id>.<attempt>): a retry or a real failure. */
export const isDrawerLine = (r: LogRow): boolean => DRAWER_EVENTS.has(r.eventCode)

interface AttemptEnd {
  attempt: number
  max: number
  /** สำเร็จ · ล้มเหลวจริง · retry ต่อ · ยังไม่จบ */
  word: string
  cls: string
  at: string
}

/** How one attempt ended, from its lines: job.finished, a real failure, a retry, or only job.started (still running). */
function attemptEnd(lines: LogRow[]): AttemptEnd {
  const done = lines.find((r) => r.eventCode === 'job.finished')
  const failed = lines.find((r) => isFinal(r) && r.eventCode !== 'job.finished')
  const retry = lines.find((r) => r.eventCode === 'job.retry' || r.eventCode === 'job.redelivered')
  const end = done ?? failed ?? retry ?? lines[0]
  const j = end.job
  const base = { attempt: j?.attempt ?? 0, max: j?.maxAttempts ?? 0, at: end.timestamp }
  if (done) return { ...base, word: 'สำเร็จ', cls: 't-ok' }
  if (failed) return { ...base, word: 'ล้มเหลวจริง', cls: 't-danger' }
  if (retry) return { ...base, word: 'retry ต่อ', cls: 't-warn' }
  return { ...base, word: 'ยังไม่จบ', cls: 't-muted' }
}

/** Later attempts of the drawer's job, lowest first, each with how it ended. */
function laterAttempts(rows: LogRow[], attempt: number): AttemptEnd[] {
  const by = new Map<number, LogRow[]>()
  for (const r of rows) {
    const a = r.job?.attempt ?? 0
    if (a > attempt) by.set(a, [...(by.get(a) ?? []), r])
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, lines]) => attemptEnd(lines))
}

export interface FailuresProps {
  stat: JobStat
  groups: ErrorGroup[]
  /** Latest job.retry / job.failed lines of the queue + type, newest first. */
  rows: LogRow[]
  /** Latest real failures, newest first. */
  finals: LogRow[]
  logsHref: string
  keep: Keep
  order: readonly string[]
  clock: Clock
  env?: string
  rangeMs: number
}

export function Failures({ stat, groups, rows, finals, logsHref, keep, order, clock, env }: FailuresProps) {
  const total = stat.retried + stat.failed
  const retryCode = stat.module === 'rabbitmq' ? 'job.redelivered' : 'job.retry'
  const max = finals.find((r) => r.job?.maxAttempts)?.job?.maxAttempts ?? 0
  return (
    <>
      <div className="section__head">
        <h2 className="section__title" id="h-failures">
          {stat.type || stat.queue} ที่ล้มเหลว
        </h2>
        <span className="section__meta">
          {moduleLabel(stat.module)} queue <span className="mono">{stat.queue}</span> · {fmtCount(total)} บรรทัด = {retryCode} {fmtCount(stat.retried)} + job.failed{' '}
          {fmtCount(stat.failed)} · ใหม่สุดก่อน
        </span>
        <div className="section__actions">
          <Link className="btn btn--sm" href={logsHref}>
            ดูทั้ง {fmtCount(total)} บรรทัดใน Log
          </Link>
        </div>
      </div>
      {groups.length ? (
        <div className="err-list">
          {groups.map((g) => (
            <GroupErrorRow key={g.fingerprint} group={g} keep={keep} order={order} split={groups.length === 1 ? { retry: stat.retried, failed: stat.failed } : undefined} />
          ))}
        </div>
      ) : null}
      {rows.length ? (
        <>
          <div className="table-wrap mt-3">
            <table className="table table--dense table--reflow jb-fail">
              <caption className="sr-only">
                บรรทัด {retryCode} และ job.failed ล่าสุด {rows.length} จาก {fmtCount(total)} บรรทัดของ {stat.type || stat.queue}
              </caption>
              <thead>
                <tr>
                  <th scope="col">เวลา</th>
                  <th scope="col">ระดับ</th>
                  <th scope="col">Service</th>
                  <th scope="col">Job id</th>
                  <th scope="col" className="num">
                    Attempt
                  </th>
                  <th scope="col">ผล</th>
                  <th scope="col">สาเหตุ (error_hint)</th>
                  <th scope="col" className="num">
                    เวลาที่ใช้
                  </th>
                  <th scope="col">Trace</th>
                </tr>
              </thead>
              <LiveTbody resetKey={`${env}|${stat.queue}|${stat.type}`}>
                {rows.map((r, i) => {
                  const k = `${r.timestamp}|${lineKey(r)}`
                  const final = isFinal(r)
                  const j = r.job
                  return (
                    <tr key={`${k}-${i}`} data-key={k}>
                      <td className="ts jb-c-time">
                        <T value={r.timestamp} text={clock.ms(r.timestamp)} />
                      </td>
                      <td className="jb-c-lvl">
                        <LevelBadge level={r.level} />
                      </td>
                      <td className="jb-c-svc">
                        <ServiceChip service={r.service} role={r.role} order={order} />
                      </td>
                      <td className="jb-c-id">
                        {j?.id ? (
                          <DrawerLink param="job" value={lineKey(r)} className="jb-open" ariaLabel={`เปิดรายละเอียด job ${j.id} attempt ${j.attempt} จาก ${j.maxAttempts || '?'}`}>
                            #{j.id}
                          </DrawerLink>
                        ) : (
                          <span className="t-muted">–</span>
                        )}
                      </td>
                      <td className="num jb-c-att" data-label="attempt">
                        {j?.attempt ? `${j.attempt}/${j.maxAttempts || '?'}` : '–'}
                      </td>
                      <td className="jb-c-res">{final ? <span className="t-danger">ล้มเหลวจริง</span> : <span className="t-warn">retry ต่อ</span>}</td>
                      <td className="jb-c-cause">{r.error?.hint || r.message}</td>
                      <td className="num jb-c-dur">{fmtDuration(r.durationMs)}</td>
                      <td className="jb-c-tr">
                        <TraceChip traceId={r.traceId} keep={keep} bare />
                      </td>
                    </tr>
                  )
                })}
              </LiveTbody>
            </table>
          </div>
          <p className="hint mt-2">
            แสดง {rows.length} จาก {fmtCount(total)} บรรทัด
            {finals.length ? (
              <>
                {' '}
                · ล้มเหลวจริง{max > 1 ? ` (ครบ ${max}/${max})` : ''} {fmtCount(stat.failed)} job:{' '}
                {finals.slice(0, 3).map((r, i) => (
                  <span key={`${r.timestamp}-${i}`}>
                    {i ? ' · ' : null}#{r.job?.id ?? '?'} <T value={r.timestamp} text={clock.sec(r.timestamp)} />
                  </span>
                ))}
                {stat.failed > 3 ? ' · …' : null}
              </>
            ) : null}{' '}
            · กดเลข job เพื่อเปิดรายละเอียด
          </p>
        </>
      ) : (
        <div className="panel mt-3">
          <EmptyState icon="search-none" title="ไม่พบบรรทัดของ queue นี้ในช่วงนี้" text="ตัวเลขมาจากสรุปของ engine แต่ยังอ่านบรรทัดไม่ได้ ลองกดลองใหม่หรือเปิดใน Log" />
        </div>
      )}
    </>
  )
}

/** Drawer of one job.retry / job.failed line (?job=<id>.<attempt>). */
export function JobDrawer({ value, row, rows, complete, stat, keep, order, clock, rangeMs, logsHrefOf, missingLogsHref }: {
  value: string
  row: LogRow | undefined
  /** Lines of the same job (queue + type + id): every line in the range when `complete`, else the fetched failures only. */
  rows: LogRow[]
  complete: boolean
  stat: JobStat | null
  keep: Keep
  order: readonly string[]
  clock: Clock
  rangeMs: number
  /** Log of every attempt of the line's job (jobId), else of its trace. */
  logsHrefOf: (row: LogRow) => string
  /** Log of the job id of the URL, for the not-found state. */
  missingLogsHref?: string
}) {
  if (!row) {
    const [id, attempt] = value.split('.')
    return (
      <Drawer id="drawer-job" param="job" value={value} title={`ไม่พบ job #${id}`}>
        <EmptyState
          icon="search-none"
          title={`ไม่พบ job #${id} ในช่วงเวลาที่เลือก`}
          text={`ไม่มีบรรทัด job.retry หรือ job.failed ของ job #${id}${attempt ? ` attempt ${attempt}` : ''} ในช่วงนี้ บรรทัดอาจเก่ากว่าช่วงที่เลือก ลองขยายช่วงเวลา หรือเปิดทุกบรรทัดของ job นี้ใน Log`}
          actions={
            missingLogsHref ? (
              <Link className="btn btn--sm" href={missingLogsHref}>
                log ของ job #{id}
              </Link>
            ) : undefined
          }
        />
      </Drawer>
    )
  }
  const j = row.job
  const e = row.error
  const final = isFinal(row)
  const target = e?.target || row.http?.domain || ''
  const system = row.eventModule || stat?.module || ''
  const later = j ? laterAttempts(rows, j.attempt) : []
  const next = later[0]
  const last = later.length > 1 ? later[later.length - 1] : undefined
  const startMs = row.durationMs !== null ? Date.parse(row.timestamp) - row.durationMs : null
  const fields = aiFieldsOfLog(row)
  const md = aiErrorMarkdown({
    ...fields,
    target: target || undefined,
    // the queue system of the stat when the line has no event_module
    where: j ? `job ${j.type || j.queue} (${moduleLabel(system)} queue ${j.queue})` : fields.where?.trim() || undefined,
    job: j ? `${system ? moduleLabel(system) : 'job'} queue ${j.queue} · ${j.type}${j.id ? ` #${j.id}` : ''}${j.attempt ? ` · attempt ${j.attempt}/${j.maxAttempts || '?'}` : ''} → ${final ? 'failed' : 'retry'}` : fields.job,
    counts: stat
      ? `queue ${stat.queue}: ${stat.started} attempts, ${stat.finished} finished, ${stat.retried} retry, ${stat.failed} failed in ${rangeEnglish(rangeMs)}`
      : undefined,
  })
  const kvs = logKvs(row)
  if (!e?.target && target) kvs.push({ k: 'target', v: target })
  return (
    <Drawer
      id="drawer-job"
      param="job"
      value={value}
      title={logTitle(row).title}
      sub={
        <>
          <LevelBadge level={row.level} />
          <T value={row.timestamp} text={fmtDateTimeMs(row.timestamp)} />
          <ServiceChip service={row.service} role={row.role} order={order} />
          <EnvTag env={row.env} />
        </>
      }
      foot={
        <>
          {row.traceId ? (
            <Link className="btn" href={buildHref(`/traces/${row.traceId}`, keep)}>
              เปิด trace
            </Link>
          ) : null}
          {row.traceId && row.spanId ? (
            // the job span's Message tab in the trace's Network view: payload and headers of this attempt
            <Link className="btn" href={buildHref(`/traces/${row.traceId}`, keep, { view: 'network', span: row.spanId, io: row.spanId, tab: 'message' })} title="payload และ header ของ message ของ attempt นี้">
              ดู message
            </Link>
          ) : null}
          {j?.id ? (
            <Link className="btn btn--quiet" href={logsHrefOf(row)}>
              log ของ job #{j.id}
            </Link>
          ) : null}
          <CopyButton targetId="ai-md-job" label="คัดลอกให้ AI" variant="cta" className="ml-auto" />
        </>
      }
    >
      <div className="stack">
        <KvList items={kvs} />
        <ErrorWhatFix {...logWhatFix(row)} />
      </div>
      <div>
        {j ? (
          <div className="field-group">
            <h3 className="field-group__title">Job</h3>
            <dl className="fields">
              <dt>
                Queue<span className="fname">job_queue · event_module</span>
              </dt>
              <dd className="mono">{[j.queue, row.eventModule].filter(Boolean).join(' · ')}</dd>
              <dt>
                Job type<span className="fname">job_type</span>
              </dt>
              <dd className="mono">{j.type || '–'}</dd>
              <dt>
                Job id<span className="fname">job_id</span>
              </dt>
              <dd className="mono">{j.id || '–'}</dd>
              <dt>
                Attempt<span className="fname">job_attempt · job_max_attempts</span>
              </dt>
              <dd className="mono">{j.attempt ? `${j.attempt} / ${j.maxAttempts || '?'}` : '–'}</dd>
              <dt>
                ครั้งสุดท้ายไหม<span className="fname">job_final</span>
              </dt>
              <dd>
                {final ? (
                  <>1 · ครบ attempt แล้ว {moduleLabel(system)} ไม่ลองอีก</>
                ) : next ? (
                  <>
                    0 · {moduleLabel(system)} ลองอีกครั้ง: attempt {next.attempt}/{next.max || '?'} <span className={next.cls}>{next.word}</span>{' '}
                    <T value={next.at} text={clock.ms(next.at)} />
                    {last ? (
                      <>
                        {' '}
                        · จบที่ attempt {last.attempt}/{last.max || '?'} <span className={last.cls}>{last.word}</span> <T value={last.at} text={clock.ms(last.at)} />
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    0 · {moduleLabel(system)} จะลองอีกครั้ง{j.maxAttempts ? ` (attempt ${j.attempt + 1}/${j.maxAttempts})` : ''}
                    {complete ? ' · ยังไม่มีบรรทัดของ attempt ถัดไปในช่วงที่เลือก' : ''}
                  </>
                )}
              </dd>
              <dt>
                Event<span className="fname">event_code</span>
              </dt>
              <dd className="mono">{row.eventCode}</dd>
              <dt>
                เวลาที่ใช้<span className="fname">duration_ms</span>
              </dt>
              <dd>
                {row.durationMs !== null ? (
                  <>
                    {row.durationMs >= 1000 ? `${fmtDuration(row.durationMs)} · ` : ''}
                    {fmtMs(row.durationMs)}
                    {startMs !== null ? (
                      <>
                        {' '}
                        (เริ่ม <T value={startMs} text={clock.ms(startMs)} />)
                      </>
                    ) : null}
                  </>
                ) : (
                  '–'
                )}
              </dd>
            </dl>
          </div>
        ) : null}
        {e ? (
          <div className="field-group">
            <h3 className="field-group__title">Error</h3>
            <dl className="fields">
              <dt>
                หมวด<span className="fname">error_category</span>
              </dt>
              <dd>{e.category ? <CategoryChip category={e.category} /> : '–'}</dd>
              <dt>
                เกิดอะไรขึ้น<span className="fname">error_detail</span>
              </dt>
              <dd>{e.detail || '–'}</dd>
              <dt>
                ต้องแก้อะไร<span className="fname">error_how_to_fix</span>
              </dt>
              <dd>{e.howToFix || '–'}</dd>
              <dt>
                ประเภท · code<span className="fname">error_type · error_code</span>
              </dt>
              <dd className="mono">{[e.type, e.code].filter(Boolean).join(' · ') || '–'}</dd>
              <dt>
                เป้าหมาย<span className="fname">error_target</span>
              </dt>
              <dd className="mono">{target || '–'}</dd>
              <dt>
                Function<span className="fname">origin_function</span>
              </dt>
              <dd className="mono">{e.originFunction || '–'}</dd>
              <dt>
                ไฟล์<span className="fname">origin_file</span>
              </dt>
              <dd className="mono">{e.originFile || '–'}</dd>
            </dl>
          </div>
        ) : null}
        <div className="field-group">
          <h3 className="field-group__title">ที่ไหน และ trace ไหน</h3>
          <dl className="fields">
            <dt>
              Trace<span className="fname">trace_id</span>
            </dt>
            <dd>{row.traceId ? <TraceChip traceId={row.traceId} keep={keep} bare /> : '–'}</dd>
            <dt>
              Service<span className="fname">service · role</span>
            </dt>
            <dd>
              <ServiceChip service={row.service} role={row.role} order={order} />
            </dd>
            <dt>
              Version<span className="fname">version</span>
            </dt>
            <dd className="mono">{row.version || '–'}</dd>
            <dt>
              Env<span className="fname">env</span>
            </dt>
            <dd>
              <EnvTag env={row.env} />
            </dd>
          </dl>
        </div>
      </div>
      {e ? (
        <details className="disclosure">
          <summary>error จริง</summary>
          <div className="disclosure__body">
            <p className="err-row__actual">{actualError(e)}</p>
          </div>
        </details>
      ) : null}
      <div className="code-block">
        <div className="code-block__head">
          <span className="code-block__title">สรุป Markdown สำหรับ AI</span>
          <CopyButton targetId="ai-md-job" label="คัดลอก" variant="quiet" size="sm" />
        </div>
        <pre className="code code--wrap" id="ai-md-job">
          {md}
        </pre>
      </div>
    </Drawer>
  )
}
