'use client'

/**
 * 3D system map (DESIGN.md §7c; lib/3d/system-map.js): services as blocks (height = req/min), workers,
 * queues, databases and outside APIs, with calls flowing along the edges (red = failing share).
 * three.js is loaded on the client only (next/dynamic, ssr: false); until the scene is mounted the box
 * shows a skeleton of the same height. The scene starts when it comes near the viewport, follows the
 * theme, keeps a still frame when motion is off, and is destroyed on unmount.
 *
 *   const topo = await engine.topology(scopeQuery(scope))                        // server component
 *   {topo.ok ? <SystemMap3D data={systemMapFromTopology(topo.data, { href })} serviceOrder={order} /> : …}
 *
 * Callbacks (onSelect, onHover) and `highlight` need a client parent; from a server page pass data only.
 * Node links that are app paths ('/traces?…') are followed with the Next router.
 */
import dynamic from 'next/dynamic'
import type { CSSProperties } from 'react'
import { SceneSkeleton } from './three/SceneSkeleton'
import type { MapSceneProps } from './three/scenes'

const MapScene = dynamic(() => import('./three/scenes').then((m) => m.MapScene), { ssr: false, loading: () => <SceneSkeleton /> })

export interface SystemMap3DProps extends MapSceneProps {
  /** Height of the scene: px number or CSS length (default 460); '100%' fills a box with a definite height. */
  height?: number | string
  /** Height under 640 px (default 520). */
  narrowHeight?: number | string
  className?: string
}

const css = (v: number | string) => (typeof v === 'number' ? `${v}px` : v)

export function SystemMap3D({ height = 460, narrowHeight = 520, className, ...scene }: SystemMap3DProps) {
  const style = { '--smap-h': css(height), '--smap-h-narrow': css(narrowHeight) } as CSSProperties
  return (
    <div className={className ? `ui-smap ${className}` : 'ui-smap'} style={style} data-mo="">
      <MapScene {...scene} />
    </div>
  )
}
