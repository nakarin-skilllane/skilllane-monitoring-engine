'use client'

/**
 * Collapsible JSON tree (the Preview tab, a JSON payload or message): objects and arrays open to `openDepth`
 * levels, each node toggles with a button (Enter / Space), a node lists its first 100 children and a button
 * shows the next 100, so a 64 KB body never renders thousands of rows at once. Strings keep `[REDACTED]` masked;
 * a number parseJsonExact kept as written (RawNumber: a 64-bit id, `1.10`) is drawn as written.
 */
import { useState } from 'react'
import { Icon } from '@/components/icons'
import { fmtCount } from '@/lib/format'
import { RawNumber } from '@/lib/io'
import { MaskedText } from './Masked'

const PAGE = 100

type Json = null | boolean | number | string | RawNumber | Json[] | { [k: string]: Json }

function Scalar({ v }: { v: Json }) {
  if (v === null) return <span className="ui-nw-tree__null">null</span>
  if (v instanceof RawNumber) return <span className="ui-nw-tree__num">{v.raw}</span>
  if (typeof v === 'string')
    return (
      <span className="ui-nw-tree__str">
        &quot;
        <MaskedText text={v} />
        &quot;
      </span>
    )
  return <span className="ui-nw-tree__num">{String(v)}</span>
}

/** `{id, name, …}` / `Array(12)`: what a closed node holds. */
function preview(v: Json): string {
  if (Array.isArray(v)) return `Array(${fmtCount(v.length)})`
  const keys = Object.keys(v as object)
  const head = keys.slice(0, 4).join(', ')
  return `{${head}${keys.length > 4 ? ', …' : ''}}`
}

function Node({ name, v, depth, openDepth }: { name: string | null; v: Json; depth: number; openDepth: number }) {
  const branch = v !== null && typeof v === 'object' && !(v instanceof RawNumber)
  const [open, setOpen] = useState(depth < openDepth)
  const [limit, setLimit] = useState(PAGE)
  const key = name !== null ? <span className="ui-nw-tree__key">{name}</span> : null
  if (!branch)
    return (
      <li className="ui-nw-tree__leaf">
        {key}
        {key ? <span className="ui-nw-tree__colon">: </span> : null}
        <Scalar v={v} />
      </li>
    )
  const entries: Array<[string, Json]> = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v as Record<string, Json>)
  return (
    <li className="ui-nw-tree__branch">
      <button className="ui-nw-tree__toggle" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron-right" size="sm" className="ui-nw-tree__chev" />
        {key}
        {key ? <span className="ui-nw-tree__colon">: </span> : null}
        <span className="ui-nw-tree__sum">{open && !Array.isArray(v) ? '{…}' : preview(v)}</span>
      </button>
      {open ? (
        <ul className="ui-nw-tree__group">
          {entries.slice(0, limit).map(([k, x]) => (
            <Node key={k} name={k} v={x} depth={depth + 1} openDepth={openDepth} />
          ))}
          {entries.length > limit ? (
            <li>
              <button className="btn btn--sm btn--quiet" type="button" onClick={() => setLimit((l) => l + PAGE)}>
                แสดงอีก {fmtCount(Math.min(PAGE, entries.length - limit))} จาก {fmtCount(entries.length - limit)} ที่เหลือ
              </button>
            </li>
          ) : null}
          {!entries.length ? <li className="ui-nw-tree__null">{Array.isArray(v) ? 'ว่าง []' : 'ว่าง {}'}</li> : null}
        </ul>
      ) : null}
    </li>
  )
}

export function JsonTree({ value, label, openDepth = 2 }: { value: unknown; label: string; openDepth?: number }) {
  const [depth, setDepth] = useState(openDepth)
  const [gen, setGen] = useState(0)
  const branch = value !== null && typeof value === 'object' && !(value instanceof RawNumber)
  return (
    <div className="ui-nw-treebox">
      {branch ? (
        <div className="ui-nw-treebox__tools">
          <button
            className="btn btn--sm btn--quiet"
            type="button"
            onClick={() => {
              setDepth(64)
              setGen((g) => g + 1)
            }}
          >
            ขยายทั้งหมด
          </button>
          <button
            className="btn btn--sm btn--quiet"
            type="button"
            onClick={() => {
              setDepth(1)
              setGen((g) => g + 1)
            }}
          >
            ย่อ
          </button>
        </div>
      ) : null}
      <ul className="ui-nw-tree" aria-label={label} key={gen}>
        <Node name={null} v={value as Json} depth={0} openDepth={depth} />
      </ul>
    </div>
  )
}
