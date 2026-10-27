/** The กฎ / AI label of a card heading. */
export function SourceTag({ kind }: { kind: 'rule' | 'ai' }) {
  return kind === 'rule' ? (
    <span className="rp-src rp-src--rule" title="คำนวณจาก query ตามเกณฑ์ ผลเหมือนกันทุกครั้ง">กฎ</span>
  ) : (
    <span className="rp-src rp-src--ai" title="ข้อความวิเคราะห์โดย AI เป็นข้อสันนิษฐาน">AI</span>
  )
}
