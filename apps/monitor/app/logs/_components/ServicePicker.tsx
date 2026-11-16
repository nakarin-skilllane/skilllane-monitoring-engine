'use client'

/**
 * First visit of the Log page (no service in the URL, none remembered; `?pick=1` shows it again): one card per
 * service / role with its ERR, WRN, lines and pods in the range, lines per bucket (ERR in red) and its latest line;
 * keys 1–9 open one, 0 every service. The choice is remembered (lib/prefs.ts) for the next visit.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { type CSSProperties, useEffect, useRef } from 'react'
import { fmtCount, fmtTimeSec } from '@/lib/format'
import { withParams } from '@/lib/params'
import { PREF, writePref } from '@/lib/prefs'
import { svcColor } from '@/lib/services'

export interface PickerCard {
  id: string
  service: string
  role: string
  errors: number
  warns: number
  lines: number
  pods: number
  /** Lines per bucket and the error lines of each, oldest first. */
  spark: number[]
  sparkErr: number[]
  /** The latest error (preferred) or line of the range. */
  last: { at: string; text: string; error: boolean } | null
}

export function ServicePicker({ cards, order }: { cards: PickerCard[]; order: string[] }) {
  const router = useRouter()
  const sp = useSearchParams()
  const grid = useRef<HTMLDivElement>(null)
  const open = (service: string) => {
    writePref(PREF.logSources, service)
    router.push(withParams('/logs', sp, { service, role: null, pick: null }), { scroll: false })
  }
  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>('.lp-card')?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[0-9]$/.test(e.key)) return
      const a = document.activeElement as HTMLElement | null
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return
      // the menu (phone) or a dialog is open over the page
      if (grid.current?.closest('[inert]')) return
      const n = Number(e.key)
      const target = n === 0 ? 'all' : cards[n - 1]?.id
      if (!target) return
      e.preventDefault()
      open(target)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per list of cards
  }, [cards])
  return (
    <section className="lp" aria-labelledby="lp-title">
      <h2 className="lp__title" id="lp-title">
        จะดู log ของ service ไหน
      </h2>
      <p className="lp__sub">เปิดทีละ service เหมือนเปิด terminal ของ process นั้นตอน dev · ครั้งต่อไปจะเข้า service ที่ดูล่าสุดให้เลย</p>
      <div className="lp-grid" ref={grid}>
        {cards.map((c, i) => {
          const max = Math.max(1, ...c.spark)
          const w = 100 / Math.max(1, c.spark.length)
          return (
            <button key={c.id} className="lp-card" type="button" style={{ '--c': svcColor(c.service, order) } as CSSProperties} onClick={() => open(c.id)}>
              <span className="lp-card__head">
                <span className="lp-card__dot" />
                <span className="lp-card__name">{c.service}</span>
                <span className="lp-card__role">/{c.role}</span>
                {i < 9 ? <kbd className="kbd">{i + 1}</kbd> : null}
              </span>
              <span className="lp-card__nums">
                <span className="is-err">
                  <b>{fmtCount(c.errors)}</b>ERR
                </span>
                <span className="is-wrn">
                  <b>{fmtCount(c.warns)}</b>WRN
                </span>
                <span>
                  <b>{fmtCount(c.lines)}</b>บรรทัด
                </span>
                <span>
                  <b>{fmtCount(c.pods)}</b>pod
                </span>
              </span>
              <svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
                {c.spark.map((v, j) => {
                  const bh = (v / max) * 34
                  const eh = c.sparkErr[j] ? Math.max(4, (c.sparkErr[j] / max) * 34) : 0
                  return (
                    <g key={j}>
                      <rect className="lp-card__spark" x={j * w + 0.15} y={36 - bh} width={Math.max(0.1, w - 0.3)} height={bh} />
                      {eh ? <rect className="lp-card__spark-e" x={j * w + 0.15} y={36 - eh} width={Math.max(0.1, w - 0.3)} height={eh} /> : null}
                    </g>
                  )
                })}
              </svg>
              <span className="lp-card__foot">
                {c.last ? (
                  <>
                    <span>
                      {c.last.error ? <span className="t-danger">error ล่าสุด</span> : 'ล่าสุด'} {fmtTimeSec(c.last.at)}
                    </span>
                    <span className="lp-card__last">{c.last.text}</span>
                  </>
                ) : (
                  <span>ไม่มี log ในช่วงนี้</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <button className="lp-all" type="button" onClick={() => open('all')}>
        <span>
          <b>รวมทุก service</b>
          <small>
            เหมือน <span className="mono">docker compose logs</span>: ทุกบรรทัดมีชื่อ service นำหน้า ใช้ดูภาพรวมสั้น ๆ ไม่เหมาะกับการไล่ปัญหา
          </small>
        </span>
        <kbd className="kbd">0</kbd>
      </button>
    </section>
  )
}
