/**
 * Light SQL formatter for reading a statement on screen (not for running it: copy the original).
 * One clause per line (SELECT, FROM, WHERE, JOIN …), AND / OR of a WHERE on their own indented lines,
 * select / set / order lists one item per line, a sub-query indented one step from the line that opened it and
 * closed at that line's indent. Literals, quoted identifiers and comments are kept byte for byte; runs of whitespace
 * outside them become one space, so the placeholders and their order never change. Case is kept.
 */
import type { SqlDialect } from '../types'
import { type SqlToken, scanSql } from './scan'

/** Clause keywords that start a line (longest first, so `LEFT OUTER JOIN` wins over `LEFT JOIN`). */
const CLAUSES = [
  'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'INSERT INTO', 'DELETE FROM', 'MERGE INTO', 'GROUP BY', 'ORDER BY',
  'PARTITION BY', 'UNION ALL', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'FULL JOIN', 'ON CONFLICT', 'WHEN MATCHED',
  'WHEN NOT', 'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'VALUES', 'SET', 'RETURNING', 'UNION', 'INTERSECT',
  'EXCEPT', 'MINUS', 'UPDATE', 'JOIN', 'WITH', 'USING',
].map((c) => c.split(' '))

/** Clauses whose comma lists go one item per line. */
const LISTS = new Set(['SELECT', 'SET', 'GROUP BY', 'ORDER BY', 'RETURNING'])

/** The clause starting at token `i` (words joined by single spaces), with the index after it; null when none. */
function clauseAt(tokens: SqlToken[], i: number): { name: string; end: number } | null {
  for (const words of CLAUSES) {
    let j = i
    let ok = true
    for (let w = 0; w < words.length; w++) {
      if (w > 0) {
        if (tokens[j]?.kind !== 'space') {
          ok = false
          break
        }
        j++
      }
      const t = tokens[j]
      if (!t || t.kind !== 'word' || t.text.toUpperCase() !== words[w]) {
        ok = false
        break
      }
      j++
    }
    if (ok) return { name: words.join(' '), end: j }
  }
  return null
}

export function formatSql(statement: string, dialect: SqlDialect = 'other'): string {
  const tokens = scanSql(statement.trim(), dialect)
  let out = ''
  let depth = 0
  // per paren depth: the clause in force, whether the parens hold a query (a sub-query, not `EXTRACT(YEAR FROM d)`),
  // and the indent of its lines (one step in from the line with the `(`, which the `)` goes back to)
  const clause: string[] = ['']
  const query: boolean[] = [true]
  const level: number[] = [0]
  const opens: Array<{ at: number; line: number }> = []
  let between = false
  const indent = (extra = 0) => '  '.repeat(Math.max(0, (level[depth] ?? 0) + extra))
  const lineIndent = () => (/^ */.exec(out.slice(out.lastIndexOf('\n') + 1))?.[0].length ?? 0) / 2
  const newline = (extra = 0) => {
    out = out.replace(/[ \t]+$/, '')
    // a line comment already ended the line: indent the new one, no empty line
    if (out.endsWith('\n')) out += indent(extra)
    else if (out) out += `\n${indent(extra)}`
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'space') {
      if (out && !out.endsWith(' ') && !out.endsWith('\n') && !out.endsWith('(')) out += ' '
      continue
    }
    if (t.kind === 'comment') {
      out += t.text
      // a line comment keeps its line break
      if (t.text.startsWith('--') || t.text.startsWith('#')) newline()
      continue
    }
    if (t.kind === 'word') {
      const c = clauseAt(tokens, i)
      if (c && (query[depth] || c.name === 'SELECT' || c.name === 'WITH')) {
        query[depth] = true
        newline()
        out += tokens.slice(i, c.end).map((x) => (x.kind === 'space' ? ' ' : x.text)).join('')
        clause[depth] = c.name
        i = c.end - 1
        if (LISTS.has(c.name)) newline(1)
        continue
      }
      const up = t.text.toUpperCase()
      if (up === 'BETWEEN') between = true
      if ((up === 'AND' || up === 'OR') && query[depth] && ['WHERE', 'HAVING', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON CONFLICT'].includes(clause[depth] ?? '')) {
        if (up === 'AND' && between) between = false
        else {
          newline(1)
          out += t.text
          continue
        }
      }
      out += t.text
      continue
    }
    if (t.kind === 'punct' && t.text === '(') {
      const line = Math.floor(lineIndent())
      out += '('
      opens.push({ at: out.length, line })
      depth++
      clause[depth] = ''
      query[depth] = false
      level[depth] = line + 1
      continue
    }
    if (t.kind === 'punct' && t.text === ')') {
      // a sub-query that took lines closes on its own line, at the indent of the line that opened it
      const open = opens.pop()
      const multi = out.slice(open?.at ?? out.length).includes('\n')
      depth = Math.max(0, depth - 1)
      out = out.replace(multi ? /[ \t]+$/ : / $/, '')
      if (multi) out += `${out.endsWith('\n') ? '' : '\n'}${'  '.repeat(open?.line ?? 0)}`
      out += ')'
      continue
    }
    if (t.kind === 'punct' && t.text === ',') {
      out = out.replace(/ $/, '')
      out += ','
      if (query[depth] && LISTS.has(clause[depth] ?? '')) newline(1)
      continue
    }
    out += t.text
  }
  return out.replace(/[ \t]+$/gm, '').trim()
}

/** One line for a table cell: whitespace collapsed, at most `max` characters (`SELECT * FROM "SCORE" WHERE …`). */
export function sqlHead(statement: string, max = 90): string {
  const one = statement.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}
