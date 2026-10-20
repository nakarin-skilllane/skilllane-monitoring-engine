/**
 * The FULL QUERY of a DB span: its statement with every bind value written in as a literal of the span's
 * dialect, to copy and run for real. Placeholders inside string literals, quoted identifiers and comments
 * are left alone (lib/sql/scan.ts). Masked values stay `'[REDACTED]'` and are counted, so the screen can say
 * how many must be replaced by hand before running it; values the SDK cut are listed too.
 * A date bind is the instant the app bound (the SDK stores it as UTC ISO-8601): it is written as that UTC time and
 * converted to the session's time zone when the query runs, as the driver does with a JS Date (node-oracledb binds
 * TIMESTAMP WITH LOCAL TIME ZONE, so a DATE column gets the session's wall clock).
 *
 *   buildFullQuery('SELECT * FROM "SCORE" WHERE "ID" = :1', [{ key: '1', type: 'number', value: '3001' }], 'oracle')
 *   → { sql: 'SELECT * FROM "SCORE" WHERE "ID" = 3001', redacted: 0, missing: [], parts: [...] }
 */
import type { DbParam, SqlDialect } from '../types'
import { scanSql } from './scan'

export const REDACTED = '[REDACTED]'

export interface FullQueryPart {
  /** sql = the statement's own text; value = an inlined bind value; missing = a placeholder without a value (kept as written). */
  kind: 'sql' | 'value' | 'missing'
  text: string
  /** value parts: the bind key it came from. */
  key?: string
}

export interface FullQuery {
  sql: string
  /** `[REDACTED]` occurrences in `sql` (inlined values and the statement itself): replace them before running. */
  redacted: number
  /** Placeholders with no bind value, in statement order, each once (`:2`, `$3`, `?#4`). */
  missing: string[]
  /** Keys of inlined values the SDK cut (DbParam.truncated), each once: the query runs with part of the value. */
  truncated: string[]
  /** `sql` in pieces, to highlight the inlined values. */
  parts: FullQueryPart[]
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/**
 * A date bind as `2026-10-18 07:18:09.226` (always 3 fraction digits) and whether those digits are UTC: an
 * instant with a zone (`…Z`, `…+07:00`, what the SDK stores) is written in UTC; a zone-less value keeps its digits
 * (the driver sent them as they are). null when not a date.
 */
export function dateOf(value: string): { text: string; utc: boolean } | null {
  const v = value.trim()
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?)?$/.exec(v)
  if (local) return { text: `${local[1]} ${local[2] ?? '00:00:00'}.${(local[3] ?? '').padEnd(3, '0').slice(0, 3)}`, utc: false }
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return {
    text: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`,
    utc: true,
  }
}

/** Oracle's limit for a SQL string literal (ORA-01704), in bytes. */
const ORACLE_LITERAL_MAX = 4000

/** UTF-8 bytes of one code point. */
const cpBytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)

/** The value escaped in pieces of at most ORACLE_LITERAL_MAX UTF-8 bytes, never splitting a character or a ''. */
function oracleChunks(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of value) {
    const esc = ch === "'" ? "''" : ch
    const n = ch === "'" ? 2 : cpBytes(ch.codePointAt(0)!)
    if (bytes + n > ORACLE_LITERAL_MAX && cur) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += esc
    bytes += n
  }
  out.push(cur)
  return out
}

/**
 * A string literal of the dialect: '' escaping everywhere, backslashes doubled for MySQL, N'' for non-ASCII on SQL
 * Server; on Oracle a value over 4,000 bytes becomes `TO_CLOB('…') || TO_CLOB('…')` (one literal would be ORA-01704).
 */
export function stringLiteral(value: string, dialect: SqlDialect): string {
  if (dialect === 'oracle' && value.length > ORACLE_LITERAL_MAX / 4) {
    const parts = oracleChunks(value)
    if (parts.length > 1) return parts.map((p) => `TO_CLOB('${p}')`).join(' || ')
  }
  let v = value.replace(/'/g, "''")
  if (dialect === 'mysql') v = v.replace(/\\/g, '\\\\')
  // eslint-disable-next-line no-control-regex
  const unicode = dialect === 'mssql' && /[^\x00-\x7f]/.test(value)
  return `${unicode ? 'N' : ''}'${v}'`
}

/**
 * A date bind as a literal of the dialect. A UTC instant is converted to the session time zone when the query runs
 * (Oracle FROM_TZ … AT TIME ZONE SESSIONTIMEZONE, PostgreSQL TIMESTAMPTZ, MySQL CONVERT_TZ to @@session.time_zone,
 * SQL Server DATETIMEOFFSET); SQLite keeps dates as UTC text.
 */
function dateLiteral(d: { text: string; utc: boolean }, dialect: SqlDialect): string {
  const t = d.text
  if (!d.utc) {
    if (dialect === 'mssql') return `CAST('${t.replace(' ', 'T')}' AS DATETIME2)`
    if (dialect === 'sqlite') return `'${t}'`
    return `TIMESTAMP '${t}'`
  }
  switch (dialect) {
    case 'oracle':
      return `CAST(FROM_TZ(TIMESTAMP '${t}', '+00:00') AT TIME ZONE SESSIONTIMEZONE AS TIMESTAMP)`
    case 'postgres':
      return `TIMESTAMPTZ '${t}+00'`
    case 'mysql':
      return `CONVERT_TZ('${t}', '+00:00', @@session.time_zone)`
    case 'mssql':
      return `CAST('${t.replace(' ', 'T')}+00:00' AS DATETIMEOFFSET)`
    case 'sqlite':
      return `'${t}'`
    default:
      return `TIMESTAMP WITH TIME ZONE '${t}+00:00'`
  }
}

/** One bind value as a literal of `dialect`. */
export function sqlLiteral(p: Pick<DbParam, 'type' | 'value'>, dialect: SqlDialect): string {
  const v = p.value ?? ''
  switch (p.type) {
    case 'null':
      return 'NULL'
    case 'number':
    case 'bigint':
      return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim()) ? v.trim() : stringLiteral(v, dialect)
    case 'boolean': {
      const on = /^(true|1|t|yes)$/i.test(v.trim())
      if (dialect === 'oracle' || dialect === 'mssql' || dialect === 'sqlite') return on ? '1' : '0'
      return on ? 'TRUE' : 'FALSE'
    }
    case 'date': {
      const d = dateOf(v)
      return d ? dateLiteral(d, dialect) : stringLiteral(v, dialect)
    }
    case 'buffer': {
      const hex = v.trim().replace(/^(0x|\\x)/i, '')
      if (!/^[0-9a-f]*$/i.test(hex)) return stringLiteral(v, dialect)
      if (dialect === 'oracle') return `HEXTORAW('${hex}')`
      if (dialect === 'postgres') return `'\\x${hex}'::bytea`
      if (dialect === 'mssql') return `0x${hex}`
      return `X'${hex}'`
    }
    default:
      // string, object (JSON text) and anything new
      return stringLiteral(v, dialect)
  }
}

/** Placeholder as written, for the `missing` list (`?` gets its position: `?#3`). */
const label = (text: string, pos: number) => (text === '?' ? `?#${pos}` : text)

/**
 * Statement + bind values → the runnable query. Named binds match by name (case-insensitive). Positional ones:
 * on Oracle the n-th placeholder gets the n-th value whatever its name (node-oracledb binds an array by position,
 * so `SET A = :2 WHERE ID = :1` with ['first', 'second'] ran A = 'first'), elsewhere `$1`, `@p1`, `?2` by number
 * and `?` by position.
 */
export function buildFullQuery(statement: string, all: readonly DbParam[], dialect: SqlDialect): FullQuery {
  // the SDK's `{ key: '…', value: '<n> more' }` marks a cut list, not a bind value
  const params = all.filter((p) => p.key !== '…')
  const byKey = new Map<string, DbParam>()
  for (const p of params) byKey.set(p.key.toLowerCase(), p)
  const positional = params.length > 0 && params.every((p) => /^\d+$/.test(p.key))
  // keys 1..n = the index of an array of binds (the SDK's paramsFromBinds)
  const byIndex = positional && params.every((p, i) => p.key === String(i + 1))
  const parts: FullQueryPart[] = []
  const missing: string[] = []
  const truncated: string[] = []
  let pos = 0
  let sqlRun = ''
  const flush = () => {
    if (sqlRun) parts.push({ kind: 'sql', text: sqlRun })
    sqlRun = ''
  }
  for (const t of scanSql(statement, dialect)) {
    if (t.kind !== 'placeholder') {
      sqlRun += t.text
      continue
    }
    pos++
    const key = (t.key ?? '').toLowerCase()
    const num = /^p?(\d+)$/.exec(key)?.[1]
    const hit =
      // oracledb with an array of binds: by position, `:2` before `:1` included
      (dialect === 'oracle' && byIndex ? byKey.get(String(pos)) : undefined) ??
      (key ? byKey.get(key) : undefined) ??
      (num ? (byKey.get(num) ?? byKey.get(`p${num}`)) : undefined) ??
      // `?` binds, or names bound by position
      (!key || positional ? byKey.get(String(pos)) : undefined)
    flush()
    if (hit) {
      parts.push({ kind: 'value', text: sqlLiteral(hit, dialect), key: hit.key })
      if (hit.truncated && !truncated.includes(hit.key)) truncated.push(hit.key)
    } else {
      parts.push({ kind: 'missing', text: t.text })
      const l = label(t.text, pos)
      if (!missing.includes(l)) missing.push(l)
    }
  }
  flush()
  const sql = parts.map((p) => p.text).join('')
  const redacted = sql.split(REDACTED).length - 1
  return { sql, redacted, missing, truncated, parts }
}
