import Link from 'next/link'
import { type ReportView, reportHref } from '../_lib/model'

const VIEWS: Array<{ key: ReportView; label: string; title: string }> = [
  { key: 'data', label: 'ข้อมูล', title: 'ตาราง กราฟ และรายละเอียดครบ' },
  { key: 'infographic', label: 'Infographic', title: 'รูปสรุป 1 ภาพ สำหรับ export เป็น PNG / PDF แล้วส่งต่อ · ตัวเลขชุดเดียวกับมุมมองข้อมูล' },
]

/** ข้อมูล | Infographic: links, so the view is in the URL like the tab and the date. */
export function ViewSwitch({ env, date, tab, view }: { env: string; date: string; tab: string; view: ReportView }) {
  return (
    <div className="seg" role="group" aria-label="มุมมอง">
      {VIEWS.map((v) => (
        <Link key={v.key} className="seg__btn" href={reportHref({ env, date, tab, view: v.key })} aria-current={v.key === view ? 'true' : undefined} title={v.title} scroll={false}>
          {v.label}
        </Link>
      ))}
    </div>
  )
}
