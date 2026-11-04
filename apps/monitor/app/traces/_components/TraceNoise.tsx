'use client'

/**
 * "ค้นหาขั้นสูง" of /traces: the noise groups left out of the scatter, the table and the totals unless ticked
 * (`noise` param, lib/noise). A failed entry is never left out.
 */
import { NoiseChecks } from '@/components/NoiseChecks'
import type { TracesHidden } from '@/lib/types'
import { TRACE_NOISE_GROUPS, TRACE_NOISE_LABEL, type TraceNoiseGroup } from '../_lib/noise'

export function TraceNoise({ shown, narrowed, hidden }: { shown: readonly TraceNoiseGroup[]; narrowed: boolean; hidden: TracesHidden | null }) {
  const off = TRACE_NOISE_GROUPS.length - shown.length
  return (
    <details className="disclosure adv">
      <summary>
        ค้นหาขั้นสูง
        {off ? <span className="tag">ซ่อน {off}</span> : null}
        <span className="disclosure__meta">trace ที่ error แสดงเสมอ</span>
      </summary>
      <div className="disclosure__body adv__body">
        <fieldset className="adv__set">
          <legend className="filter-label">Noise · ติ๊กเพื่อแสดงกลุ่มนั้นด้วย</legend>
          <NoiseChecks param="noise" groups={TRACE_NOISE_GROUPS} labels={TRACE_NOISE_LABEL} counts={hidden} unit="trace" shown={shown} narrowed={narrowed} reset={{ show: null }} />
        </fieldset>
      </div>
    </details>
  )
}
