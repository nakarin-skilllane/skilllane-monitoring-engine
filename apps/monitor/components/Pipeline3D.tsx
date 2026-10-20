'use client'

/**
 * 3D pipeline: how telemetry travels (NestJS app + skilllane-monitoring → Kafka / RabbitMQ / BullMQ → skilllane-monitoring engine
 * → ClickHouse → skilllane monitor + AI), with log / span / error envelopes moving in batches.
 * Same loading, motion and lifecycle rules as <SystemMap3D> (next/dynamic, ssr: false).
 *
 *   <Pipeline3D transport={health.transport} links={{ monitor: '/overview', clickhouse: '/DATA-DICTIONARY.md' }} />
 */
import dynamic from 'next/dynamic'
import type { CSSProperties } from 'react'
import { SceneSkeleton } from './three/SceneSkeleton'
import type { PipelineSceneProps } from './three/scenes'

const PipelineScene = dynamic(() => import('./three/scenes').then((m) => m.PipelineScene), { ssr: false, loading: () => <SceneSkeleton /> })

export interface Pipeline3DProps extends PipelineSceneProps {
  /** Height of the scene: px number or CSS length (default 380). */
  height?: number | string
  /** Height under 640 px (default 620: the stations stack top to bottom). */
  narrowHeight?: number | string
  className?: string
}

const css = (v: number | string) => (typeof v === 'number' ? `${v}px` : v)

export function Pipeline3D({ height = 380, narrowHeight = 620, className, ...scene }: Pipeline3DProps) {
  const style = { '--smap-h': css(height), '--smap-h-narrow': css(narrowHeight) } as CSSProperties
  return (
    // ui-smap--grow: without WebGL the six stations are listed at full height (no inner scroll)
    <div className={className ? `ui-smap ui-smap--grow ${className}` : 'ui-smap ui-smap--grow'} style={style} data-mo="">
      <PipelineScene {...scene} />
    </div>
  )
}
