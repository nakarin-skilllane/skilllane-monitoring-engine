/**
 * Locates clickhouse/schema.sql and splits it into statements. The file's
 * rule: every statement ends with ";" at the end of a line.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const RELATIVE = join('clickhouse', 'schema.sql')

function searchUpward(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, RELATIVE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** ENGINE_SCHEMA_FILE, else the first clickhouse/schema.sql above __dirname, else above cwd. */
export function findSchemaFile(explicit?: string): string {
  if (explicit) {
    const path = resolve(explicit)
    if (!existsSync(path)) throw new Error(`ENGINE_SCHEMA_FILE not found: ${path}`)
    return path
  }
  const found = searchUpward(__dirname) ?? searchUpward(process.cwd())
  if (!found) {
    throw new Error(`clickhouse/schema.sql not found above ${__dirname} or ${process.cwd()}; set ENGINE_SCHEMA_FILE`)
  }
  return found
}

/**
 * Comment lines removed, split on ";" at line end. When the configured
 * database is not `skilllane_monitoring`, the `skilllane_monitoring` database name is replaced.
 */
export function schemaStatements(sql: string, database = 'skilllane_monitoring'): string[] {
  const body = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  return body
    .split(/;[ \t]*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) =>
      database === 'skilllane_monitoring'
        ? statement
        : statement
            .replace(/\bskilllane_monitoring\./g, `${database}.`)
            .replace(/DATABASE IF NOT EXISTS skilllane_monitoring\b/g, `DATABASE IF NOT EXISTS ${database}`),
    )
}

export function readSchema(explicit: string | undefined, database: string): { file: string; statements: string[] } {
  const file = findSchemaFile(explicit)
  return { file, statements: schemaStatements(readFileSync(file, 'utf8'), database) }
}
