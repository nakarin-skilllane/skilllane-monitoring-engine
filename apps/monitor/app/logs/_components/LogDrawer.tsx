/**
 * Detail of one log line (logs.html `#lg-drawer`, `?drawer=<line id>`): the readable error block first
 * (สรุป · แก้ที่ไหน · Error จริง with the stack), then request / job / dependency / trace fields, each with its
 * ClickHouse column name, Raw JSON, and the Copy-for-AI Markdown (DESIGN.md §6b, no PII).
 * Every line with a span links to the trace's Network view (`?view=network&io=`): an http.request line to its
 * request (headers, body, query string), a job line to its job span's message, a line about a failure to the failing
 * I/O under its span (the INSERT behind ORA-12899, the 429 call of a job attempt), any other line to the nearest span
 * with I/O above it. The button names what it opens. Rendered on the server for the selected line only.
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CategoryChip, EnvTag, HttpStatus, LevelBadge, NewBadge, ServiceChip, Tag, Ts } from '@/components/badges'
import { CopyButton } from '@/components/CopyButton'
import { Drawer, DrawerLink } from '@/components/Drawer'
import { Icon } from '@/components/icons'
import { EmptyState, EngineErrorState } from '@/components/states'
import type { EngineError } from '@/lib/engine'
import { fmtCount, fmtDateTime, fmtDuration, fmtMs, fmtTime, fmtTimeMs } from '@/lib/format'
import { type IoType, ioTypeOf } from '@/lib/io'
import { buildHref, type Keep } from '@/lib/params'
import { aiErrorMarkdown, aiFieldsOfLog, eventTitle, logTitle } from '@/lib/readable'
import type { ErrorDetail, LogRow, TraceDetail } from '@/lib/types'
import { buildWaterfall, ioSpanOf, stepOf } from '../../traces/_lib/model'
import { actualText, affectsOf, causeText, moduleLabel, parseStack, rawRecord, statusFromRequest } from '../_lib/lines'

/** The error line behind a failed http.request line (lines.ts requestCause), its line id and its error group. */
export interface RequestCause {
  id: string
  line: LogRow
  group: ErrorDetail | null
  isNew: boolean
}

/** The Network button of a line, by what it opens: label and title. */
const IO_LINK: Record<IoType | 'job' | 'any', [string, string]> = {
  'http-in': ['ดู request/response', 'header, body และ query string ใน Network ของ trace'],
  'http-out': ['ดู request/response', 'header และ body ของการเรียกออกใน Network ของ trace'],
  db: ['ดู query', 'statement, ค่า bind และ full query ใน Network ของ trace'],
  redis: ['ดูคำสั่ง Redis', 'คำสั่งพร้อม argument ใน Network ของ trace'],
  queue: ['ดู message', 'payload และ header ของ message ใน Network ของ trace'],
  job: ['ดู message ของ job', 'payload และ header ของ message ใน Network ของ trace'],
  any: ['ดูใน Network', 'request, query และ message ของ span นี้ใน Network ของ trace'],
}

/** `576 ครั้ง · 52 users ใน 24 ชั่วโมง` of an error group (the drawer always counts the last 24 h). */
const groupCounts = (g: ErrorDetail['group']) => `${fmtCount(g.count)} ครั้ง · ${fmtCount(g.users)} users ใน 24 ชั่วโมง`

interface Field {
  label: string
  /** ClickHouse column(s). */
  name: string
  value: ReactNode
  className?: string
  hint?: ReactNode
}

function Group({ title, fields, children }: { title: string; fields: Field[]; children?: ReactNode }) {
  const list = fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== '' && f.value !== false)
  if (!list.length && !children) return null
  return (
    <div className="field-group">
      <h3 className="field-group__title">{title}</h3>
      {list.length ? (
        <dl className="fields">
          {list.map((f) => (
            <FieldRow key={f.label + f.name} f={f} />
          ))}
        </dl>
      ) : null}
      {children}
    </div>
  )
}

function FieldRow({ f }: { f: Field }) {
  return (
    <>
      <dt>
        {f.label}
        <span className="fname">{f.name}</span>
      </dt>
      <dd className={f.className}>
        {f.value}
        {f.hint ? <span className="hint">{f.hint}</span> : null}
      </dd>
    </>
  )
}

/** Head + app frames, then the whole stack in a disclosure (copy = the original text). */
function Stack({ stack }: { stack: string }) {
  const { head, frames } = parseStack(stack)
  const app = frames.filter((f) => f.app).slice(0, 5)
  const line = (f: (typeof frames)[number], i: number) => (
    <span key={i} className={f.app ? 'fr fr--app' : 'fr'}>
      {f.loc ? (
        <>
          {f.loc.before}
          <span className="fr__loc">{f.loc.loc}</span>
          {f.loc.after}
        </>
      ) : (
        f.text
      )}
      {'\n'}
    </span>
  )
  return (
    <>
      <div className="code-block lg-frames-title">
        <div className="code-block__head">
          <span className="code-block__title">
            Stack · frame ในโค้ดแอปก่อน · <span className="mono">error_stack</span>
          </span>
          <CopyButton text={stack} label="คัดลอก stack" variant="quiet" size="sm" />
        </div>
        <pre className="code stacktrace">
          <span className="fr fr--head">
            {head}
            {'\n'}
          </span>
          {(app.length ? app : frames.slice(0, 3)).map(line)}
        </pre>
      </div>
      <details className="disclosure mt-2">
        <summary>
          Stack เต็ม
          <span className="disclosure__meta">
            {fmtCount(frames.length + 1)} บรรทัด · {fmtCount(frames.filter((f) => f.app).length)} frame ในแอป
          </span>
        </summary>
        <div className="disclosure__body">
          <pre className="code stacktrace" id="lg-stack-full">
            <span className="fr fr--head">
              {head}
              {'\n'}
            </span>
            {frames.map(line)}
          </pre>
        </div>
      </details>
    </>
  )
}

/** `?drawer=` names a line that is not there (or the engine did not answer). */
export function LogDrawerNotFound({ id, error }: { id: string; error: EngineError | null }) {
  return (
    <Drawer id="lg-drawer" value={id} wide className="lg-drawer" title={error ? 'เปิดรายละเอียดไม่ได้' : 'รายละเอียดบรรทัด log'}>
      {error ? (
        <EngineErrorState error={error} inPanel={false} />
      ) : (
        <EmptyState
          icon="search-none"
          title="ไม่พบบรรทัด log นี้"
          text="ลิงก์อาจไม่ครบ หรือบรรทัดนี้เก่ากว่าข้อมูลที่เก็บไว้ ปิดแล้วเลือกบรรทัดจากตารางอีกครั้ง"
        />
      )}
    </Drawer>
  )
}

export function LogDrawer({
  id,
  row,
  keep,
  order,
  isNew,
  trace,
  group,
  cause = null,
}: {
  id: string
  row: LogRow
  keep: Keep
  order: readonly string[]
  isNew: boolean
  /** The line's trace (span position of failed_step, the http.request line, trace summary); null when not fetched. */
  trace: TraceDetail | null
  /** Its error group over the last 24 h; null when not an error line or not available. */
  group: ErrorDetail | null
  /** A failed http.request line: the error line of the same request (shown on top, and the AI text describes it). */
  cause?: RequestCause | null
}) {
  const { title } = logTitle(row)
  const e = row.error
  const rec = rawRecord(row)
  const json = JSON.stringify(rec)
  const showAi = !!e || ['warn', 'error', 'fatal'].includes(row.level)
  const g = group?.group
  // The AI text of a failed request is its error line (DESIGN.md §6: the request line and the error line are one failure).
  const aiLine = cause?.line ?? row
  const aiGroup = cause ? cause.group?.group : g
  const aiNew = cause ? cause.isNew || !!aiGroup?.isNew : isNew || !!g?.isNew
  const ai = showAi
    ? aiErrorMarkdown({
        ...aiFieldsOfLog(aiLine),
        newSince: aiNew ? aiGroup?.firstSeenVersion || undefined : undefined,
        counts: aiGroup ? `group ${fmtCount(aiGroup.count)} times · ${fmtCount(aiGroup.users)} users in 24 h` : undefined,
      })
    : ''
  // the group link opens the same 24 h its numbers count (the page's own range may be shorter)
  const groupHref = (fp: string, env: string) => buildHref(`/errors/${fp}`, keep, { ...(env ? { env } : {}), from: 'now-24h', to: null })

  // trace facts: where failed_step sits (the span # of the trace page, inside this line's own attempt), which
  // http.request line gave status / duration
  const wf = trace ? buildWaterfall(trace) : null
  const step = wf && row.failedStep ? stepOf(wf, row) : null
  const joined = statusFromRequest(row)
  const reqLine = joined && trace ? trace.logs.find((l) => l.eventCode === 'http.request' && l.service === row.service && l.role === row.role) : undefined
  const fromReq = joined ? <>จากบรรทัด http.request {reqLine ? fmtTimeMs(reqLine.timestamp) : ''} ของ trace เดียวกัน</> : null

  const http = row.http
  // a job's (or any) outbound call carries only domain + status: that is not the request of this line
  const outbound = !!http?.domain || row.eventCode === 'http.outbound_failed'
  const routeText = http && (http.method || http.route || http.path) ? `${http.method} ${http.route || http.path}`.trim() : null
  const status = row.httpStatus ?? http?.status ?? 0
  const dur = row.durationMs
  const user = row.userId ? (
    <>
      <Link href={buildHref('/logs', keep, { userId: row.userId })}>{row.userId}</Link>
      {row.userRoles.length ? ` · ${row.userRoles.join(', ')}` : ''}
    </>
  ) : null
  const affects = affectsOf(row)
  // the span panel of the trace's Network view (its default tab): a line about a failure opens the failing I/O under
  // its span (failed_step first), any other line its own span or the nearest one above it with I/O
  const failure = row.eventCode !== 'http.request' && (!!e || !!row.fingerprint || ['error', 'fatal'].includes(row.level))
  const ioSpan = wf && row.spanId ? ioSpanOf(wf, step?.span.spanId ?? row.spanId, failure) : null
  const ioType = ioSpan ? ioTypeOf(ioSpan.span) : null
  // without the trace (not fetched, or the span not in it yet) the page walks up from the line's span itself
  const ioHref =
    row.traceId && row.spanId && (ioSpan || !wf?.byId.has(row.spanId))
      ? buildHref(`/traces/${row.traceId}`, keep, { view: 'network', span: row.spanId, io: ioSpan?.span.spanId ?? row.spanId })
      : null
  const [ioLabel, ioTitle] = IO_LINK[ioType === 'queue' && row.job ? 'job' : (ioType ?? (row.job ? 'job' : row.eventCode === 'http.request' ? 'http-in' : 'any'))]
  const durText = dur === null ? null : fmtDuration(dur) === fmtMs(dur) ? fmtMs(dur) : `${fmtDuration(dur)} · ${fmtMs(dur)}`

  return (
    <Drawer
      id="lg-drawer"
      value={id}
      wide
      className="lg-drawer"
      title={title}
      sub={
        <>
          <LevelBadge level={row.level} />
          <Ts value={row.timestamp} format="date-ms" />
          <ServiceChip service={row.service} role={row.role} order={order} />
          <EnvTag env={row.env} />
          {row.version ? <Tag>{row.version}</Tag> : null}
          {row.eventCode ? <span className="mono">{row.eventCode}</span> : null}
        </>
      }
      foot={
        <>
          {row.traceId ? (
            <Link className="btn" href={buildHref(`/traces/${row.traceId}`, keep)}>
              <Icon name="traces" />
              เปิด trace
            </Link>
          ) : null}
          {ioHref ? (
            <Link className="btn" href={ioHref} title={ioTitle}>
              <Icon name="panel" />
              {ioLabel}
            </Link>
          ) : null}
          {row.traceId ? (
            <Link className="btn" href={buildHref('/logs', keep, { traceId: row.traceId })}>
              <Icon name="filter" />
              ดู log ทั้ง trace
            </Link>
          ) : null}
          <CopyButton text={json} label="คัดลอก JSON" />
          {showAi ? <CopyButton targetId="lg-ai-md" label="คัดลอกให้ AI" variant="cta" /> : null}
        </>
      }
    >
      {cause ? (
        <Group
          title="Error ของ request นี้"
          fields={[
            {
              label: 'หัวข้อ',
              name: cause.line.error?.hint ? 'error_hint' : 'message',
              value: (
                <>
                  <DrawerLink value={cause.id} title="เปิดบรรทัด error นี้">
                    {logTitle(cause.line).title}
                  </DrawerLink>
                  {cause.line.error?.category ? (
                    <>
                      {' '}
                      <CategoryChip category={cause.line.error.category} />
                    </>
                  ) : null}
                  {cause.isNew || cause.group?.group.isNew ? (
                    <span className="lg-new">
                      <NewBadge since={cause.group?.group.firstSeenVersion || undefined} />
                    </span>
                  ) : null}
                </>
              ),
              hint: (
                <>
                  จากบรรทัด {logTitle(cause.line).prefix || cause.line.eventCode} {fmtTimeMs(cause.line.timestamp)} ของ trace เดียวกัน
                  {cause.line.service !== row.service || cause.line.role !== row.role ? ` (${cause.line.service}/${cause.line.role})` : ''}
                </>
              ),
            },
            { label: 'ต้องแก้อะไร', name: cause.line.error?.fix ? 'error_fix' : 'error_hint_detail', value: cause.line.error?.fix || cause.line.error?.hintDetail },
            { label: 'Error จริง', name: 'error_type · error_code · error_message', value: actualText(cause.line), className: 'err-row__actual' },
            { label: 'Function ต้นทาง', name: 'origin_function', value: cause.line.error?.originFunction, className: 'mono' },
            {
              label: 'Error group',
              name: 'error_fingerprint',
              value: cause.line.fingerprint ? (
                <Link href={groupHref(cause.line.fingerprint, cause.line.env)}>{cause.group ? groupCounts(cause.group.group) : 'เปิด error group'}</Link>
              ) : null,
            },
          ]}
        />
      ) : null}
      <Group
        title="สรุป"
        fields={[
          { label: 'หัวข้อ', name: e?.hint ? 'error_hint' : eventTitle(row) ? 'event_code' : 'message', value: title },
          { label: 'ข้อความ', name: 'message', value: !e && row.message && row.message !== title ? row.message : null, className: 'lg-pre' },
          { label: 'ต้องแก้อะไร', name: 'error_fix', value: e?.fix },
          { label: 'อธิบายทั่วไป', name: 'error_hint_detail', value: e?.hintDetail },
          { label: 'หมวด', name: 'error_category', value: e?.category ? <CategoryChip category={e.category} /> : null },
          {
            label: 'Error group',
            name: 'error_fingerprint',
            value: row.fingerprint ? (
              <>
                <Link href={groupHref(row.fingerprint, row.env)}>{g ? groupCounts(g) : 'เปิด error group'}</Link>
                {isNew || g?.isNew ? (
                  <span className="lg-new">
                    <NewBadge since={g?.firstSeenVersion || undefined} />
                  </span>
                ) : null}
              </>
            ) : null,
            hint: row.fingerprint ? (
              <>
                {g ? `ครั้งแรก ${fmtDateTime(g.firstSeen)} · ล่าสุด ${fmtTime(g.lastSeen)} · ` : ''}fingerprint {row.fingerprint}
              </>
            ) : null,
          },
          { label: 'Event', name: 'event_code · event_module', value: row.eventCode && row.eventCode !== 'app.log' ? [row.eventCode, row.eventModule].filter(Boolean).join(' · ') : null, className: 'mono' },
          { label: 'Logger', name: 'logger', value: row.logger, className: 'mono' },
        ]}
      />
      <Group
        title="แก้ที่ไหน"
        fields={
          e || row.usecase || row.failedStep
            ? [
                { label: 'Route', name: 'http_method · http_route', value: outbound ? null : routeText, className: 'mono' },
                { label: 'Usecase', name: 'usecase', value: row.usecase, className: 'mono' },
                { label: 'Function ต้นทาง', name: 'origin_function', value: e?.originFunction, className: 'mono' },
                { label: 'ไฟล์', name: 'origin_file', value: e?.originFile, className: 'mono' },
                { label: 'จุดที่ผิด', name: 'error_target', value: e?.target, className: 'mono' },
                {
                  label: 'ขั้นที่พัง',
                  name: 'failed_step',
                  value: row.failedStep,
                  className: 'mono',
                  hint: step ? `span #${step.n} ของ trace · ${fmtCount(Math.round(step.start))} → ${fmtCount(Math.round(step.end))} ms` : null,
                },
                { label: 'SQL', name: 'db_statement', value: row.dbStatement, className: 'mono lg-pre' },
              ]
            : []
        }
      />
      {e ? (
        <Group
          title="Error จริง"
          fields={[
            { label: 'ประเภท', name: 'error_type', value: e.type, className: 'mono' },
            { label: 'Code', name: 'error_code', value: e.code ? <Tag>{e.code}</Tag> : null },
            { label: 'ข้อความ', name: 'error_message', value: e.message, className: 'err-row__actual' },
            { label: 'สาเหตุ', name: 'error_cause', value: causeText(e.cause), className: 'mono lg-pre' },
          ]}
        >
          {e.stack ? <Stack stack={e.stack} /> : null}
        </Group>
      ) : null}
      {http && outbound ? (
        <>
          <Group
            title="เรียกระบบภายนอก"
            fields={[
              { label: 'Method', name: 'http_method', value: http.method, className: 'mono' },
              { label: 'Path', name: 'url_path', value: http.path, className: 'mono' },
              { label: 'Domain', name: 'url_domain', value: http.domain, className: 'mono' },
              { label: 'ระบบนั้นตอบ', name: 'http_status', value: http.status ? <HttpStatus status={http.status} /> : null },
              // the call ran inside a request: how that request answered (engine join from its http.request line)
              {
                label: 'Request ตอบ',
                name: 'http_status (http.request)',
                value: !row.job && row.httpStatus && row.httpStatus !== http.status ? <HttpStatus status={row.httpStatus} /> : null,
                hint: 'จากบรรทัด http.request ของ trace เดียวกัน',
              },
              // a job line: its duration is in the Job group
              { label: 'เวลาที่ใช้', name: 'duration_ms', value: row.job ? null : durText },
            ]}
          />
          <Group
            title="ผู้ใช้"
            fields={[
              { label: 'User', name: 'user_id · user_roles', value: user, className: 'mono', hint: row.userId ? 'ไม่ถูกใส่ในข้อความที่คัดลอกให้ AI' : null },
              { label: 'โรงเรียน', name: 'organization_id', value: row.organizationId, className: 'mono' },
            ]}
          />
        </>
      ) : http ? (
        <Group
          title="Request"
          fields={[
            { label: 'Method', name: 'http_method', value: http.method, className: 'mono' },
            { label: 'Route', name: 'http_route', value: http.route, className: 'mono' },
            { label: 'Path', name: 'url_path', value: http.path, className: 'mono' },
            { label: 'Domain', name: 'url_domain', value: http.domain, className: 'mono' },
            { label: 'Status', name: 'http_status', value: status ? <HttpStatus status={status} /> : null, hint: fromReq },
            {
              label: 'เวลาที่ใช้',
              name: 'duration_ms',
              value: durText,
              hint: joined && reqLine ? `จากบรรทัด http.request ${fmtTimeMs(reqLine.timestamp)}` : null,
            },
            { label: 'User', name: 'user_id · user_roles', value: user, className: 'mono', hint: row.userId ? 'ไม่ถูกใส่ในข้อความที่คัดลอกให้ AI' : null },
            { label: 'โรงเรียน', name: 'organization_id', value: row.organizationId, className: 'mono' },
          ]}
        />
      ) : (
        <Group
          title="ผู้ใช้"
          fields={[
            { label: 'User', name: 'user_id · user_roles', value: user, className: 'mono', hint: row.userId ? 'ไม่ถูกใส่ในข้อความที่คัดลอกให้ AI' : null },
            { label: 'โรงเรียน', name: 'organization_id', value: row.organizationId, className: 'mono' },
          ]}
        />
      )}
      {row.job ? (
        <Group
          title="Job"
          fields={[
            {
              label: 'Queue',
              name: 'job_queue · event_module',
              value: (
                <>
                  <span className="mono">{row.job.queue}</span> {moduleLabel(row) ? <Tag>{moduleLabel(row)}</Tag> : null}
                </>
              ),
            },
            { label: 'Type', name: 'job_type', value: row.job.type, className: 'mono' },
            { label: 'Job id', name: 'job_id', value: row.job.id, className: 'mono' },
            {
              label: 'Attempt',
              name: 'job_attempt · job_max_attempts',
              value: row.job.attempt ? `${row.job.attempt}${row.job.maxAttempts ? `/${row.job.maxAttempts}` : ''}${row.job.final ? ' · ครั้งสุดท้าย' : ''}` : null,
              className: 'mono',
            },
            { label: 'เวลาที่ใช้', name: 'duration_ms', value: durText },
            { label: 'งานที่ค้างอยู่', name: 'job_inflight', value: row.job.inflight.length ? row.job.inflight.join(', ') : null, className: 'mono' },
          ]}
        />
      ) : null}
      {row.dependency && (row.dependency.name || row.dependency.host) ? (
        <Group
          title="Dependency"
          fields={[
            { label: 'ประเภท', name: 'dependency_type', value: row.dependency.type, className: 'mono' },
            { label: 'ชื่อ', name: 'dependency_name', value: row.dependency.name, className: 'mono' },
            { label: 'Host', name: 'dependency_host · dependency_port', value: row.dependency.host ? `${row.dependency.host}${row.dependency.port ? `:${row.dependency.port}` : ''}` : null, className: 'mono' },
            { label: 'กระทบ', name: 'fields[dependency.affects]', value: affects.length ? affects.join(', ') : null, className: 'mono' },
            { label: 'ครั้งที่ลอง', name: 'fields[dependency.attempt]', value: row.fields['dependency.attempt'], className: 'mono' },
            { label: 'เหตุผล', name: 'reason', value: row.reason, className: 'mono' },
            { label: 'เวลาที่ใช้', name: 'duration_ms', value: !row.job && !http ? durText : null },
          ]}
        />
      ) : null}
      <Group
        title="Trace"
        fields={[
          {
            label: 'Trace id',
            name: 'trace_id',
            value: row.traceId ? (
              <span className="idchip">
                <Link href={buildHref(`/traces/${row.traceId}`, keep)} title={row.traceId}>
                  {row.traceId}
                </Link>
                <CopyButton text={row.traceId} variant="icon" ariaLabel="คัดลอก trace id" />
              </span>
            ) : (
              <span className="t-muted">ไม่มี · บรรทัดนี้เกิดนอก request</span>
            ),
            hint: trace
              ? `${fmtCount(trace.spanCount)} span · ${fmtCount(trace.services.length)} service · ${fmtMs(trace.durationMs)} · ${fmtCount(trace.errorCount)} error`
              : null,
          },
          { label: 'Span id', name: 'span_id', value: row.spanId, className: 'mono' },
          { label: 'Correlation id', name: 'correlation_id', value: row.correlationId, className: 'mono' },
          { label: 'Host', name: 'host', value: row.host, className: 'mono' },
        ]}
      />
      <details className="disclosure">
        <summary>
          Raw JSON<span className="disclosure__meta">ECS record ตามที่ skilllane-monitoring เขียน · {fmtCount(Object.keys(rec).length)} key</span>
        </summary>
        <div className="disclosure__body">
          <p className="hint lg-json-note">จัดย่อหน้าเพื่ออ่าน ปุ่ม &quot;คัดลอก JSON&quot; คัดลอกเป็นบรรทัดเดียวแบบที่ library เขียนลง stdout และส่งเข้า queue</p>
          <pre className="code code--tall" id="lg-raw-json">
            {JSON.stringify(rec, null, 2)}
          </pre>
        </div>
      </details>
      {showAi ? (
        <details className="disclosure">
          <summary>
            ข้อความที่ส่งให้ AI<span className="disclosure__meta">Markdown · ชื่อ key ชุดเดียวกับทุกหน้า · ไม่มี user id</span>
          </summary>
          <div className="disclosure__body">
            <pre className="code code--wrap" id="lg-ai-md">
              {ai}
            </pre>
          </div>
        </details>
      ) : null}
    </Drawer>
  )
}
