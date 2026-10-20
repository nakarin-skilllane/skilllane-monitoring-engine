/**
 * SQL tokenizer shared by buildFullQuery and formatSql: splits a statement into code, string literals,
 * quoted identifiers, comments and bind placeholders, so nothing inside a literal, an identifier or a
 * comment is ever read as a placeholder (`TO_CHAR(d, 'HH24:MI')`, `"a:b"`, `-- ?`). Pure, server and client.
 */
import type { SqlDialect } from '../types'

export type SqlTokenKind = 'word' | 'number' | 'string' | 'ident' | 'comment' | 'space' | 'placeholder' | 'punct'

export interface SqlToken {
  kind: SqlTokenKind
  text: string
  /** placeholder: the bind name without its sigil (`1` for `:1` / `$1`, `name` for `:name` / `@name`); '' for `?`. */
  key?: string
}

/** Placeholder styles a dialect writes; `other` accepts all of them. */
const STYLES: Record<SqlDialect, { colon: boolean; dollar: boolean; question: boolean; at: boolean }> = {
  oracle: { colon: true, dollar: false, question: false, at: false },
  postgres: { colon: false, dollar: true, question: false, at: false },
  mysql: { colon: false, dollar: false, question: true, at: false },
  sqlite: { colon: true, dollar: true, question: true, at: true },
  mssql: { colon: false, dollar: false, question: false, at: true },
  other: { colon: true, dollar: true, question: true, at: true },
}

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT = /[\w$#\u0080-￿]/
const CLOSE: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' }

/** Index after a quoted run starting at `i` (quote `q`, doubled quote escapes; `backslash` also escapes). */
function quoted(sql: string, i: number, q: string, backslash: boolean): number {
  let j = i + 1
  while (j < sql.length) {
    const c = sql[j]
    if (backslash && c === '\\') {
      j += 2
      continue
    }
    if (c === q) {
      if (sql[j + 1] === q) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return sql.length
}

/** Tokens of `sql`; concatenating every token's text gives `sql` back exactly. */
export function scanSql(sql: string, dialect: SqlDialect = 'other'): SqlToken[] {
  const st = STYLES[dialect] ?? STYLES.other
  const out: SqlToken[] = []
  let i = 0
  const push = (kind: SqlTokenKind, end: number, key?: string) => {
    out.push(key === undefined ? { kind, text: sql.slice(i, end) } : { kind, text: sql.slice(i, end), key })
    i = end
  }
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1] ?? ''
    const prev = i > 0 ? sql[i - 1] : ''
    // whitespace
    if (/\s/.test(c)) {
      let j = i + 1
      while (j < sql.length && /\s/.test(sql[j])) j++
      push('space', j)
      continue
    }
    // comments: -- line, /* block */, # line (mysql)
    if ((c === '-' && n === '-') || (c === '#' && dialect === 'mysql')) {
      const j = sql.indexOf('\n', i)
      push('comment', j === -1 ? sql.length : j)
      continue
    }
    if (c === '/' && n === '*') {
      const j = sql.indexOf('*/', i + 2)
      push('comment', j === -1 ? sql.length : j + 2)
      continue
    }
    // oracle q-quote: q'[ … ]' (any delimiter; brackets close with their pair)
    if ((c === 'q' || c === 'Q') && n === "'" && !IDENT.test(prev) && (dialect === 'oracle' || dialect === 'other')) {
      const open = sql[i + 2] ?? ''
      const close = CLOSE[open] ?? open
      const j = open ? sql.indexOf(`${close}'`, i + 3) : -1
      push('string', j === -1 ? sql.length : j + 2)
      continue
    }
    // postgres E'…' (backslash escapes) and N'…' / X'…' prefixes
    if (/[EeNnXxBb]/.test(c) && n === "'" && !IDENT.test(prev)) {
      const backslash = (c === 'E' || c === 'e') && (dialect === 'postgres' || dialect === 'other')
      push('string', quoted(sql, i + 1, "'", backslash))
      continue
    }
    if (c === "'") {
      push('string', quoted(sql, i, "'", dialect === 'mysql'))
      continue
    }
    // postgres dollar-quoted strings $$…$$ / $tag$…$tag$
    if (c === '$' && st.dollar && (n === '$' || IDENT_START.test(n))) {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(sql.slice(i, i + 64))
      if (m && (dialect === 'postgres' || dialect === 'other' || n === '$')) {
        const j = sql.indexOf(m[0], i + m[0].length)
        push('string', j === -1 ? sql.length : j + m[0].length)
        continue
      }
    }
    // quoted identifiers: "x" (standard; mysql strings), `x` (mysql, sqlite), [x] (mssql, sqlite)
    if (c === '"') {
      push(dialect === 'mysql' ? 'string' : 'ident', quoted(sql, i, '"', dialect === 'mysql'))
      continue
    }
    if (c === '`') {
      push('ident', quoted(sql, i, '`', false))
      continue
    }
    if (c === '[' && (dialect === 'mssql' || dialect === 'sqlite' || dialect === 'other')) {
      const j = sql.indexOf(']', i + 1)
      push('ident', j === -1 ? sql.length : j + 1)
      continue
    }
    // placeholders
    if (c === '?' && st.question) {
      // sqlite ?NNN
      const m = /^\?(\d+)/.exec(sql.slice(i, i + 12))
      if (m && dialect !== 'mysql') push('placeholder', i + m[0].length, m[1])
      else push('placeholder', i + 1, '')
      continue
    }
    if (c === '$' && st.dollar && /\d/.test(n)) {
      const m = /^\$(\d+)/.exec(sql.slice(i, i + 12))!
      push('placeholder', i + m[0].length, m[1])
      continue
    }
    if (c === ':' && st.colon && n !== ':' && n !== '=' && prev !== ':' && (IDENT.test(n) || /\d/.test(n)) && !IDENT.test(prev)) {
      let j = i + 1
      while (j < sql.length && IDENT.test(sql[j])) j++
      push('placeholder', j, sql.slice(i + 1, j))
      continue
    }
    if ((c === '@' || (c === '$' && dialect === 'sqlite')) && st.at && n !== '@' && prev !== '@' && IDENT.test(n)) {
      let j = i + 1
      while (j < sql.length && IDENT.test(sql[j])) j++
      push('placeholder', j, sql.slice(i + 1, j))
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < sql.length && IDENT.test(sql[j])) j++
      push('word', j)
      continue
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(n))) {
      const m = /^(\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.)/.exec(sql.slice(i))
      push('number', i + (m ? m[0].length : 1))
      continue
    }
    const two = c + n
    push('punct', i + (['<=', '>=', '<>', '!=', '||', '::', ':=', '=>', '->'].includes(two) ? 2 : 1))
  }
  return out
}

/** Dialect of a db.system value (OTel semconv names and the usual short ones). */
export function dialectOf(system: string): SqlDialect {
  const s = system.toLowerCase()
  if (s.includes('oracle')) return 'oracle'
  if (s.includes('postgres') || s === 'pg' || s.includes('cockroach') || s.includes('redshift')) return 'postgres'
  if (s.includes('mysql') || s.includes('mariadb')) return 'mysql'
  if (s.includes('mssql') || s.includes('sqlserver') || s.includes('sql_server')) return 'mssql'
  if (s.includes('sqlite')) return 'sqlite'
  return 'other'
}
