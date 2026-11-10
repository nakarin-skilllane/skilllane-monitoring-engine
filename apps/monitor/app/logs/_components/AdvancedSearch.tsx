'use client'

/**
 * "ค้นหาขั้นสูง" of /logs: a <details> under the quick filters. Noise groups are hidden unless ticked, a text
 * hides the lines whose message has it, repeats collapse to their latest line. Main lines are never hidden
 * here (the level / event / route filters narrow them). State lives in the URL (_lib/noise).
 *
 *   <AdvancedSearch shown={[]} collapse exclude="" narrowed={false} hidden={res.data.hidden} />
 */
import { NoiseChecks } from '@/components/NoiseChecks'
import { useParamNav } from '@/components/ParamControls'
import { fmtCount } from '@/lib/format'
import type { LogsHidden } from '@/lib/types'
import { NOISE_GROUPS, NOISE_LABEL, type NoiseGroup, repeatsParam } from '../_lib/noise'

export function AdvancedSearch({
  shown,
  collapse,
  exclude,
  narrowed,
  hidden,
}: {
  /** Noise groups shown (ticked). */
  shown: readonly NoiseGroup[]
  collapse: boolean
  exclude: string
  /** The page is narrowed to one thing: its defaults show everything (_lib/noise). */
  narrowed: boolean
  /** Line counts per group (null while the engine answered an error). */
  hidden: LogsHidden | null
}) {
  const { go } = useParamNav({ drawer: null })
  const hiddenGroups = NOISE_GROUPS.length - shown.length
  const badge = [hiddenGroups ? `ซ่อน ${hiddenGroups}` : '', exclude ? 'ซ่อนคำ' : '', collapse ? 'ยุบ log ซ้ำ' : ''].filter(Boolean).join(' · ')
  return (
    <details className="disclosure adv">
      <summary>
        ค้นหาขั้นสูง
        {badge ? <span className="tag">{badge}</span> : null}
        <span className="disclosure__meta">log หลักแสดงเสมอ</span>
      </summary>
      <div className="disclosure__body adv__body">
        <fieldset className="adv__set">
          <legend className="filter-label">Noise · ติ๊กเพื่อแสดงกลุ่มนั้นด้วย (เฉพาะ DBG / INF)</legend>
          <NoiseChecks param="show" groups={NOISE_GROUPS} labels={NOISE_LABEL} counts={hidden} unit="แถว" shown={shown} narrowed={narrowed} reset={{ drawer: null }} />
          <form
            className="search search--sm adv__exclude"
            onSubmit={(e) => {
              e.preventDefault()
              const v = String(new FormData(e.currentTarget).get('exclude') ?? '').trim()
              go({ exclude: v || null })
            }}
          >
            <label className="sr-only" htmlFor="lg-exclude">
              ซ่อนบรรทัดที่ข้อความมีคำนี้
            </label>
            <input
              key={exclude}
              className="search__input"
              id="lg-exclude"
              type="search"
              name="exclude"
              defaultValue={exclude}
              placeholder="ซ่อนบรรทัดที่ข้อความมี… แล้วกด Enter"
              autoComplete="off"
              spellCheck={false}
            />
          </form>
          {exclude && hidden ? <span className="hint">ซ่อนไป {fmtCount(hidden.exclude)} แถว</span> : null}
        </fieldset>
        <fieldset className="adv__set">
          <legend className="filter-label">Log ซ้ำ</legend>
          <label className="adv__check">
            <input type="checkbox" checked={collapse} onChange={(e) => go({ repeats: repeatsParam(e.target.checked, narrowed) })} />
            <span className="adv__label">ยุบ log ซ้ำเหลือบรรทัดล่าสุด</span>
            <span className="t-muted">
              แพทเทิร์นเดียวกันเฉลี่ยตั้งแต่ 10 ครั้ง/นาที หรือ 60 ครั้งในนาทีเดียว และที่ซ้ำติดกันเกิน 3 บรรทัด (ห่างกันไม่เกิน 1 วิ) · ไม่ยุบ http.request และ job.* ·
              การเรียกตามตารางเวลา (route และ user agent เดียวกัน ได้ 2xx ไม่ได้ login ตั้งแต่ 5 ครั้ง ห่างเท่ากันแทบทุกครั้ง เช่น สคริปต์ uptime) เหลือครั้งล่าสุด
            </span>
          </label>
        </fieldset>
        <div>
          <button className="btn btn--sm btn--quiet" type="button" onClick={() => go({ show: null, repeats: null, exclude: null })}>
            กลับค่าเริ่มต้น
          </button>
        </div>
      </div>
    </details>
  )
}
