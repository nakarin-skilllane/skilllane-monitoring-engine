/**
 * Query tab of a DB or Redis span: the statement formatted for reading (copy gives the original), its bind
 * values in bind order, and the FULL QUERY with every value written in for the span's dialect (lib/sql) to copy
 * and run for real (shown formatted like the statement, copied on the statement's own lines). Values the SDK masked
 * stay `'[REDACTED]'`: a warning counts them, because the query only runs as intended after they are replaced by
 * hand; values the SDK cut and placeholders without a value are flagged too. A date bind is the instant the app
 * bound (stored as UTC): the bind table also reads it in ICT, the query converts it to the session's time zone.
 */
import { CopyButton } from '@/components/CopyButton'
import { Tag } from '@/components/badges'
import { fmtCount } from '@/lib/format'
import { countRedacted } from '@/lib/io'
import { buildFullQuery, dateOf, formatSql, scanSql } from '@/lib/sql'
import type { SpanDbIo, SqlDialect } from '@/lib/types'
import { MASKED_TITLE, MaskedText } from './Masked'

const DIALECT_LABEL: Record<SqlDialect, string> = { oracle: 'Oracle', postgres: 'PostgreSQL', mysql: 'MySQL', mssql: 'SQL Server', sqlite: 'SQLite', other: 'SQL' }

/** How the full query writes a date bind, per dialect (the hint under it). */
const DATE_NOTE: Record<SqlDialect, string> = {
  oracle: 'ค่าวันเวลาเขียนเป็นเวลา UTC ที่ library เก็บ แล้วให้ Oracle แปลงเป็น time zone ของ session ตอนรัน (FROM_TZ … AT TIME ZONE SESSIONTIMEZONE) เหมือนที่ node-oracledb bind ค่า Date · รันใน session ที่ time zone ไม่ใช่ของแอป (เช่น UTC) ค่าที่ได้จะเลื่อนตาม',
  postgres: 'ค่าวันเวลาเขียนเป็น TIMESTAMPTZ เวลา UTC ที่ library เก็บ · คอลัมน์ timestamp (ไม่มี zone) ได้เวลาตาม TimeZone ของ session ตอนรัน',
  mysql: 'ค่าวันเวลาเขียนเป็นเวลา UTC ที่ library เก็บ แล้วแปลงเป็น time zone ของ session ตอนรัน (CONVERT_TZ)',
  mssql: 'ค่าวันเวลาเขียนเป็น DATETIMEOFFSET เวลา UTC ที่ library เก็บ · คอลัมน์ datetime2 ได้เวลา UTC เหมือนที่ driver (useUTC) ส่ง',
  sqlite: 'ค่าวันเวลาเขียนเป็นข้อความเวลา UTC ที่ library เก็บ',
  other: 'ค่าวันเวลาเขียนเป็นเวลา UTC ที่ library เก็บ (TIMESTAMP WITH TIME ZONE)',
}

/** `2011-01-10 00:00:00.000 ICT` of a stored date bind with a zone; '' when it has none. */
function ictOf(value: string): string {
  const d = dateOf(value)
  if (!d?.utc) return ''
  const t = new Date(Date.parse(value) + 7 * 3600_000).toISOString()
  return `${t.slice(0, 10)} ${t.slice(11, 23)} ICT`
}

/** The formatted statement with its placeholders marked. */
function Statement({ text, dialect }: { text: string; dialect: SqlDialect }) {
  return (
    <>
      {scanSql(text, dialect).map((t, i) =>
        t.kind === 'placeholder' ? (
          <span key={i} className="c-key">
            {t.text}
          </span>
        ) : t.kind === 'comment' ? (
          <span key={i} className="c-mute">
            {t.text}
          </span>
        ) : (
          <MaskedText key={i} text={t.text} />
        ),
      )}
    </>
  )
}

/** Tooltip of a bind the SDK masked by `masked: 'unresolved'`. */
const UNRESOLVED_TITLE =
  'statement นี้มีชื่อที่เป็นความลับ (เช่น password, token) แต่ library บอกไม่ได้ว่า placeholder นี้เป็นค่าของ column ไหน จึงปิดค่าไว้ก่อนเพื่อความปลอดภัย'

export function QueryView({ db, id, redis }: { db: SpanDbIo; id: string; redis?: boolean }) {
  if (!db.statement) return <p className="hint ui-nw-none">span นี้ไม่มีคำสั่งที่บันทึกไว้ (db.statement ว่าง)</p>
  if (redis)
    return (
      <div className="stack ui-nw-query">
        <div className="ui-nw-facts">
          <Tag>redis</Tag>
          {db.name ? <span className="mono">db {db.name}</span> : null}
        </div>
        <div className="code-block">
          <div className="code-block__head">
            <span className="code-block__title">คำสั่งพร้อม argument</span>
            <CopyButton text={db.statement} label="คัดลอก" variant="quiet" size="sm" ariaLabel="คัดลอกคำสั่ง Redis" />
          </div>
          <pre className="code code--wrap ui-nw-pre">
            <MaskedText text={db.statement} />
          </pre>
        </div>
      </div>
    )
  const pretty = formatSql(db.statement, db.dialect)
  const full = buildFullQuery(db.statement, db.params, db.dialect)
  // the same values on the formatted statement (formatSql keeps every placeholder and its order)
  const shownFull = buildFullQuery(pretty, db.params, db.dialect)
  const withColumn = db.params.some((p) => p.column)
  // the SDK ends a list it cut at LOG_BODY_MAX_BYTES with { key: '…', value: '<n> more' }
  const binds = db.params.filter((p) => p.key !== '…')
  const cut = db.params.find((p) => p.key === '…')
  const hasDate = db.params.some((p) => p.type === 'date' && dateOf(p.value)?.utc)
  const maskedIn = countRedacted(db.statement)
  return (
    <div className="stack ui-nw-query">
      <div className="ui-nw-facts">
        <Tag title="dialect ที่ใช้เขียนค่าใน full query">{DIALECT_LABEL[db.dialect]}</Tag>
        <span className="mono">{db.system}</span>
        {db.name ? <span className="mono">· {db.name}</span> : null}
        {db.operation || db.table ? <span className="mono">· {[db.operation, db.table].filter(Boolean).join(' ')}</span> : null}
        <span>· bind {fmtCount(binds.length)} ค่า{cut ? ' (รายการถูกตัด)' : ''}</span>
      </div>

      <div className="code-block">
        <div className="code-block__head">
          <span className="code-block__title">
            Statement <span className="t-muted">· จัดบรรทัดให้อ่านง่าย ปุ่มคัดลอกได้ตัวเดิม</span>
          </span>
          <CopyButton text={db.statement} label="คัดลอก" variant="quiet" size="sm" ariaLabel="คัดลอก statement ตัวเดิม" />
        </div>
        <pre className="code code--wrap ui-nw-pre ui-nw-sql">
          <Statement text={pretty} dialect={db.dialect} />
        </pre>
      </div>

      <div className="field-group">
        <h4 className="field-group__title">
          Bind values<span className="fname ui-nw-fname">skilllane.monitoring.db.parameters · ตามลำดับที่ bind</span>
        </h4>
        {db.params.length ? (
          <div className="table-wrap ui-nw-params">
            <table className="table table--dense">
              <thead>
                <tr>
                  <th scope="col">key</th>
                  {withColumn ? <th scope="col">column</th> : null}
                  <th scope="col">type</th>
                  <th scope="col">value</th>
                </tr>
              </thead>
              <tbody>
                {binds.map((p, i) => (
                  <tr key={`${p.key}-${i}`}>
                    <td className="mono nowrap">{/^\d+$/.test(p.key) ? `#${p.key}` : `:${p.key}`}</td>
                    {withColumn ? <td className="mono t-muted nowrap">{p.column || ''}</td> : null}
                    <td className="mono t-muted">{p.type}</td>
                    <td className="mono ui-nw-val">
                      {p.type === 'null' ? <span className="t-muted">NULL</span> : <MaskedText text={p.value} />}
                      {p.type === 'date' && ictOf(p.value) ? <span className="t-muted ui-nw-ict">{ictOf(p.value)}</span> : null}
                      {p.truncated ? <span className="ui-nw-trunc">ค่าถูกตัด</span> : null}
                      {p.masked === 'unresolved' ? (
                        <span className="ui-nw-trunc" title={UNRESOLVED_TITLE}>
                          ปิดไว้ก่อน
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {cut ? (
                  <tr>
                    <td className="hint" colSpan={withColumn ? 4 : 3}>
                      รายการยาวเกินขนาดสูงสุด library ตัดไว้ · ไม่ได้เก็บอีก {cut.value.replace(/\s*more$/, '')} ค่า
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint ui-nw-none">ไม่มีค่า bind ที่บันทึกไว้{/[?:$@]\w*/.test(db.statement) ? ' · statement มี placeholder แต่ span นี้ไม่ได้เก็บค่ามา' : ''}</p>
        )}
      </div>

      <div className="code-block">
        <div className="code-block__head">
          <span className="code-block__title">
            Full query <span className="t-muted">· ใส่ค่า bind แล้ว พร้อมรัน ปุ่มคัดลอกได้ตามบรรทัดของ statement เดิม</span>
            {full.truncated.length ? (
              <span className="ui-nw-warn" title={`ค่าที่ library ตัดไว้: ${full.truncated.map((k) => (/^\d+$/.test(k) ? `#${k}` : `:${k}`)).join(', ')}`}>
                ค่าถูกตัด {fmtCount(full.truncated.length)} ค่า ไม่ครบตามที่แอปส่ง
              </span>
            ) : null}
            {full.redacted ? (
              <span className="ui-nw-warn" title={MASKED_TITLE}>
                [REDACTED] {fmtCount(full.redacted)} ค่า ต้องแทนค่าจริงก่อนรัน
              </span>
            ) : null}
            {full.missing.length ? (
              <span className="ui-nw-warn" title={full.missing.join(', ')}>
                ไม่มีค่าของ {full.missing.length > 3 ? `${fmtCount(full.missing.length)} placeholder` : full.missing.join(', ')}
              </span>
            ) : null}
          </span>
          <CopyButton text={full.sql} label="คัดลอก full query" variant="primary" size="sm" />
        </div>
        <pre className="code code--wrap ui-nw-pre ui-nw-sql">
          {shownFull.parts.map((p, i) =>
            p.kind === 'value' ? (
              <span key={i} className="ui-nw-sqlval" title={`ค่าของ ${p.key}`}>
                <MaskedText text={p.text} />
              </span>
            ) : p.kind === 'missing' ? (
              <span key={i} className="ui-nw-sqlmiss" title="ไม่มีค่าของ placeholder นี้">
                {p.text}
              </span>
            ) : (
              <MaskedText key={i} text={p.text} />
            ),
          )}
        </pre>
      </div>
      {hasDate || maskedIn ? (
        <p className="hint" id={`${id}-notes`}>
          {[
            hasDate ? DATE_NOTE[db.dialect] : '',
            maskedIn ? `statement เองมี [REDACTED] ${fmtCount(maskedIn)} จุด (ค่าที่เขียนตรงใน SQL ถูก mask ด้วย)` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </div>
  )
}
