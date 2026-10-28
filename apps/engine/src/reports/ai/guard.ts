/**
 * What of the AI's answer a report may keep (pure). A note stays only when its target is one we
 * asked for, it cites evidence that exists, and every number in it appears in that evidence: the AI
 * words what SQL counted, it never brings a number of its own.
 */
import type { AiNote } from '../types'
import type { EvidencePack } from './evidence'

const NOTE_MAX = 140
const NAME_MAX = 24
/** Numbers of the report's own wording (7 วัน, 14 วัน, 24 ชม., 6 ช่วง, 5xx). */
const ALWAYS = new Set(['5', '6', '7', '14', '24'])
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/

export interface GuardResult {
  notes: AiNote[]
  /** featureId → Thai name. */
  names: Record<string, string>
  dropped: Array<{ target: string; why: string }>
}

/** `1,240` → `1240`, `2.50` → `2.5`, `09` → `9`: the same number however it is written. */
const norm = (n: string): string => String(Number.parseFloat(n.replace(/,/g, '')))
const numbersIn = (text: string): string[] => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm)

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function guardNotes(raw: unknown, pack: EvidencePack): GuardResult {
  const out: GuardResult = { notes: [], names: {}, dropped: [] }
  const list = (raw as { notes?: unknown })?.notes
  if (!Array.isArray(list)) return out
  const targets = new Map(pack.targets.map((t) => [t.id, t]))
  const items = new Map(pack.items.map((i) => [i.id, i]))
  const seen = new Set<string>()
  for (const n of list as Array<Record<string, unknown>>) {
    const target = typeof n?.target === 'string' ? n.target : ''
    const drop = (why: string) => out.dropped.push({ target, why })
    const t = targets.get(target)
    if (!t) {
      drop('target ที่ไม่ได้ขอ')
      continue
    }
    if (seen.has(target)) {
      drop('ซ้ำ')
      continue
    }
    const evidence = Array.isArray(n.evidence) ? n.evidence.filter((e): e is string => typeof e === 'string') : []
    if (!evidence.length) {
      drop('ไม่อ้างหลักฐาน')
      continue
    }
    if (evidence.some((e) => !items.has(e))) {
      drop('อ้างหลักฐานที่ไม่มี')
      continue
    }
    const text = typeof n.text === 'string' ? n.text.replace(/\s+/g, ' ').trim() : ''
    if (!text) {
      drop('ข้อความว่าง')
      continue
    }
    if (EMAIL.test(text)) {
      drop('มีอีเมล')
      continue
    }
    const allowed = new Set(ALWAYS)
    for (const id of new Set([...evidence, t.about])) {
      for (const v of Object.values(items.get(id)?.facts ?? {})) for (const x of numbersIn(v)) allowed.add(x)
    }
    const invented = numbersIn(text).filter((x) => !allowed.has(x))
    if (invented.length) {
      drop(`ตัวเลขที่ไม่อยู่ในหลักฐาน: ${invented.join(', ')}`)
      continue
    }
    seen.add(target)
    if (t.kind === 'featureName') out.names[target.slice('featureName:'.length)] = cut(text, NAME_MAX)
    else out.notes.push({ target, text: cut(text, NOTE_MAX) })
  }
  return out
}
