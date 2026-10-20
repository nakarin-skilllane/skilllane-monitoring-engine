/**
 * The readable error of one trace (DESIGN.md §6) as the expanded row of the trace list shows it:
 * title (hint → error group), category, NEW, chips, ต้องแก้อะไร, error จริง, where it broke, user,
 * then open waterfall / logs / jobs and "คัดลอกให้ AI". No hooks: rendered by the server for the row
 * that starts open and by TraceErrorRow on the client for the others.
 */
import Link from 'next/link'
import { ActualError, ErrorDetailText, KvList } from '@/components/ErrorParts'
import { CopyButton } from '@/components/CopyButton'
import { CategoryChip, LevelBadge, NewBadge, Tag, Ts } from '@/components/badges'
import { Icon } from '@/components/icons'
import { fmtTimeSec } from '@/lib/format'
import { buildHref, type Keep } from '@/lib/params'
import { actualError, logDetail, logKvs, logTitle } from '@/lib/readable'
import type { TraceDetail } from '@/lib/types'
import { aiListMarkdown, buildWaterfall, failedSpan, fmtOff, jobFollowUp, namedStep, pickEntryErrorLog, withRequest } from '../_lib/model'

export interface ErrorBlockContext {
  keep: Keep
  /** Error groups first seen since their service's deploy: fingerprint → version. */
  newSince: Record<string, string>
  /** Job system label of the row (BullMQ …), '' for requests. */
  moduleLabel: string
  /** aria-label of the article: `error ของ trace A`. */
  label: string
  /** id of the hidden Markdown (unique per row). */
  aiId: string
  /** The row's entry span (the request, or this attempt of the job): its own error line is shown. */
  entrySpanId?: string
}

export function TraceErrorBlock({ detail, ctx }: { detail: TraceDetail; ctx: ErrorBlockContext }) {
  const wf = buildWaterfall(detail)
  const raw = pickEntryErrorLog(wf, detail.logs, ctx.entrySpanId)
  const log = raw ? withRequest(raw, detail.logs) : null
  const failed = failedSpan(wf, log)
  // the waterfall opens on the span that failed in this entry (this attempt), else on the entry itself
  const pick = failed?.span.spanId ?? ctx.entrySpanId
  const traceHref = buildHref(`/traces/${detail.traceId}`, ctx.keep, pick ? { span: pick } : undefined)
  const aiId = ctx.aiId
  const newSince = log?.fingerprint ? ctx.newSince[log.fingerprint] : undefined
  const md = aiListMarkdown({ log, wf, detail, failed, newSince, moduleLabel: ctx.moduleLabel })
  const t = log ? logTitle(log) : null
  const title = t?.title ?? failed?.span.exception?.message ?? failed?.span.statusMessage ?? `${failed?.span.name ?? 'trace'} error`
  const follow = log ? jobFollowUp(log, detail.logs) : null
  const step = namedStep(failed, log)
  const logCount = detail.logs.length
  return (
    <article className="err-row" aria-label={ctx.label}>
      <div className="err-row__head">
        <LevelBadge level={log?.level ?? 'error'} />
        <h3 className="err-row__title">{log?.fingerprint ? <Link href={buildHref(`/errors/${log.fingerprint}`, ctx.keep)}>{title}</Link> : title}</h3>
        {log?.error?.category ? <CategoryChip category={log.error.category} /> : null}
        {newSince ? <NewBadge since={newSince} /> : null}
        <span className="err-row__count">
          <Ts value={log?.timestamp ?? failed?.span.startTime ?? detail.start} />
        </span>
      </div>
      {log ? (
        <>
          <KvList items={logKvs(log)} />
          <ErrorDetailText text={logDetail(log)} />
          <ActualError text={actualError(log.error)} />
        </>
      ) : failed?.span.exception ? (
        <ActualError text={actualError({ type: failed.span.exception.type, message: failed.span.exception.message })} />
      ) : null}
      <div className="err-row__meta">
        {step && !log?.job ? (
          <span>
            พังที่ span <span className="mono t-ink2">{step.span.name}</span> ({fmtOff(step.start)} → {fmtOff(step.end)} ms)
          </span>
        ) : null}
        {log?.job ? (
          <span>
            {ctx.moduleLabel ? <Tag>{ctx.moduleLabel}</Tag> : null} queue <span className="mono t-ink2">{log.job.queue}</span>
            {log.job.id ? (
              <>
                {' '}
                · job <span className="mono t-ink2">#{log.job.id}</span>
              </>
            ) : null}
            {log.job.attempt ? ` · attempt ${log.job.attempt}/${log.job.maxAttempts || '?'} ล้มเหลว` : null}
            {follow ? ` · attempt ${follow.attempt}${follow.startedAt ? ` เริ่ม ${fmtTimeSec(follow.startedAt)}` : ''}${follow.endedAt ? ` และ${follow.ok ? 'สำเร็จ' : 'ล้มเหลว'} ${fmtTimeSec(follow.endedAt)}` : ''}` : null}
          </span>
        ) : null}
        {log?.job && log.error?.code ? (
          <span>
            error code <span className="mono t-ink2">{log.error.code}</span>
          </span>
        ) : null}
        {log?.userId ? (
          <span className="idchip">
            <span className="idchip__k">user</span>
            <Link href={buildHref('/logs', ctx.keep, { userId: log.userId })}>{log.userId}</Link>
          </span>
        ) : null}
        {log && (log.userRoles.length || log.organizationId) ? <span>{[log.userRoles.join(', '), log.organizationId].filter(Boolean).join(' · ')} (ไม่ใส่ในข้อความให้ AI)</span> : null}
      </div>
      <div className="row tr-detail__actions">
        <Link className="btn btn--sm" href={traceHref}>
          เปิด waterfall
          <Icon name="arrow" />
        </Link>
        {log?.job ? (
          <Link className="btn btn--sm btn--quiet" href={`${buildHref('/jobs', ctx.keep)}#failures`}>
            ดูงานเบื้องหลัง
          </Link>
        ) : (
          <Link className="btn btn--sm btn--quiet" href={buildHref('/logs', ctx.keep, { traceId: detail.traceId })}>
            ดู log ของ trace นี้{logCount ? ` (${logCount})` : ''}
          </Link>
        )}
        <CopyButton targetId={aiId} label="คัดลอกให้ AI" variant="primary" size="sm" />
      </div>
      <pre className="code code--wrap" id={aiId} hidden>
        {md}
      </pre>
    </article>
  )
}
