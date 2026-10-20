/**
 * KPI strip (DESIGN.md §5): `.kpis` joined tiles; value counts up (AnimatedNumber) when
 * it first scrolls into view. `cols` fixes 3 / 4 / 5 columns (fewer when narrow).
 *
 *   <Kpis cols={4} label="สรุปชั่วโมงล่าสุด">
 *     <Kpi label="Request" value={1180} unit="req/min" foot="รวม 70,800 request" spark={series} />
 *     <Kpi label="Error rate (5xx)" value={0.16} decimals={2} unit="%" tone="alert" sparkBad
 *          delta={{ text: '112 ครั้ง', tone: 'bad' }} href="/errors" linkLabel="เปิด Error" />
 *   </Kpis>
 */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AnimatedNumber } from './AnimatedNumber'
import { KpiSpark } from './charts/Sparkline'

export function Kpis({ cols, label, children, className }: { cols?: 3 | 4 | 5; label?: string; children: ReactNode; className?: string }) {
  const cls = ['kpis', cols ? `kpis--${cols}` : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <div className={cls} role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

export interface KpiProps {
  label: ReactNode
  /** Icon (or any node) before the label; `.kpi--alert .kpi__label > .i` turns danger. */
  icon?: ReactNode
  /** A number animates; a string / node is shown as is. */
  value: number | string | ReactNode
  decimals?: number
  unit?: string
  /** Free foot text (left of the spark). */
  foot?: ReactNode
  /** Foot text with a tone (`kpi__delta--bad|--good`); replaces `foot`. */
  delta?: { text: ReactNode; tone?: 'bad' | 'good' }
  /** Values for the 96×28 sparkline, oldest first. */
  spark?: number[]
  sparkBad?: boolean
  /** 3 px marker: alert = danger, warn = warning. */
  tone?: 'alert' | 'warn'
  /** Whole tile is a link (needs linkLabel for screen readers). */
  href?: string
  linkLabel?: string
  animate?: boolean
}

export function Kpi({ label, icon, value, decimals = 0, unit, foot, delta, spark, sparkBad, tone, href, linkLabel, animate = true }: KpiProps) {
  const cls = ['kpi', tone ? `kpi--${tone}` : ''].filter(Boolean).join(' ')
  const footText = delta ? <span className={delta.tone ? `kpi__delta kpi__delta--${delta.tone}` : 'kpi__delta'}>{delta.text}</span> : foot ? <span className="kpi__delta">{foot}</span> : null
  return (
    <div className={cls}>
      <span className="kpi__label">
        {icon}
        {label}
      </span>
      <span className="kpi__value">
        {typeof value === 'number' && animate ? <AnimatedNumber value={value} decimals={decimals} /> : typeof value === 'number' ? value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : value}
        {unit ? <span className="kpi__unit">{unit}</span> : null}
      </span>
      {footText || spark ? (
        <div className="kpi__foot">
          {footText ?? <span />}
          {spark && spark.length > 1 ? <KpiSpark values={spark} bad={sparkBad} /> : null}
        </div>
      ) : null}
      {href ? (
        <Link className="kpi__link sr-only" href={href}>
          {linkLabel ?? 'เปิด'}
        </Link>
      ) : null}
    </div>
  )
}
