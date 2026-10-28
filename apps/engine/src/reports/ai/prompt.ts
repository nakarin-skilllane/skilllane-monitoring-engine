/** The instruction and the answer shape for the report's AI notes. */
import type { EvidencePack } from './evidence'

/** Strict JSON schema of the answer (OpenRouter response_format json_schema). */
export const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'text', 'evidence'],
        properties: {
          target: { type: 'string', description: 'One target id from the request.' },
          text: { type: 'string', description: 'One Thai sentence (a feature name for featureName targets).' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Ids of the evidence items the text is based on.' },
        },
      },
    },
  },
} as const

const SYSTEM = `คุณช่วยเขียนข้อความสั้นในรายงานประจำวันของระบบ (log, error, ความเร็ว, ระบบที่พึ่งพา) ของแพลตฟอร์มการศึกษา
ตัวเลขทุกตัวคำนวณมาแล้วจากฐานข้อมูล งานของคุณคือเรียบเรียงและเสนอสาเหตุที่น่าจะเป็น ไม่ใช่คำนวณ

กฎ (ห้ามละเมิด):
1. ตอบเฉพาะ target ที่ขอ target ละไม่เกิน 1 ข้อความ ถ้าไม่มีอะไรมีประโยชน์ให้ข้าม target นั้น
2. ภาษาไทย 1 ประโยค ไม่เกิน 100 ตัวอักษร (ชื่อ route, ชื่อ error, ชื่อ service ใช้ตามต้นฉบับได้)
3. ใช้เฉพาะข้อเท็จจริงใน evidence ห้ามคำนวณ ห้ามประมาณ ห้ามสร้างตัวเลขใหม่ ตัวเลขที่เขียนต้องคัดลอกจาก evidence ที่อ้างเท่านั้น
4. ใส่ id ของ evidence ที่ใช้ทุกตัวใน evidence[] อย่างน้อย 1 ตัว
5. สาเหตุเป็นข้อสันนิษฐาน ใช้คำว่า "น่าจะ" หรือ "อาจ" และโยงเฉพาะสิ่งที่มีหลักฐาน เช่น เวลาเริ่มใกล้ deploy หรือช่วงที่ระบบที่พึ่งพาล่ม
6. ห้ามใส่ข้อมูลส่วนบุคคล

แต่ละชนิดของ target:
- summaryOverview: ผลกระทบต่อผู้ใช้ในภาษาที่คนไม่ใช่สายเทคนิคเข้าใจ
- summaryDetail: สำหรับทีมพัฒนา เรื่องที่ควรดูก่อนและสาเหตุที่น่าจะเป็น
- error: สาเหตุที่น่าจะเป็นของ error นั้น และจุดที่ควรเช็ก
- incident: ผลกระทบและสาเหตุที่น่าจะเป็นของเหตุการณ์นั้น
- featureName: ชื่อฟีเจอร์ภาษาไทยสั้น ไม่เกิน 20 ตัวอักษร จาก routes ของฟีเจอร์ ไม่มีตัวเลข

ตอบเป็น JSON ตาม schema เท่านั้น`

export function promptMessages(pack: EvidencePack): Array<{ role: 'system' | 'user'; content: string }> {
  const request = {
    env: pack.env,
    reportDate: pack.reportDate,
    window: pack.window,
    targets: pack.targets.map((t) => ({ id: t.id, kind: t.kind, about: t.about })),
    evidence: pack.items,
  }
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify(request) },
  ]
}
