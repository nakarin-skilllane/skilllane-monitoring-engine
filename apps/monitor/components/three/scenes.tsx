'use client'

/**
 * The mounted three.js scenes behind <SystemMap3D> and <Pipeline3D> (loaded by next/dynamic, ssr: false:
 * this file and three.js never run on the server). One scene per component instance: it is mounted when
 * the box comes within 240 px of the viewport (at once when motion is off: reduced motion, headless
 * screenshots, as the mockups do), updated in place when the data changes, and destroyed
 * (renderer, context, observers) on unmount. Node and station links that are app paths go through the
 * Next router; modified clicks (new tab) keep the browser default.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  mountPipeline,
  mountSystemMap,
  type PipelineHandle,
  type PipelineOptions,
  type PipelineStation,
  type PipelineTransport,
  type SceneMotion,
  type SystemMapData,
  type SystemMapHandle,
  type SystemMapNode,
} from '@/lib/3d/system-map'
import { useInView } from '../useInView'
import { SceneSkeleton } from './SceneSkeleton'

interface CommonSceneProps {
  legend?: boolean
  /** Default open; closed under 560 px. */
  legendOpen?: boolean
  /** Toolbar: zoom, reset, pause (default true). */
  controls?: boolean
  /** Gentle sway until the first interaction (default true). */
  autoRotate?: boolean
  /** Prefix of the canvas summary (aria-label). */
  ariaLabel?: string
  /** Default: off when <html data-motion="off"> (reduced motion, ?motion=off, headless), else on. */
  motion?: SceneMotion
  /** The no-WebGL list instead of the scene. */
  forceFallback?: boolean
  /** Text under the skeleton while loading. */
  loadingText?: string
}

export interface MapSceneProps extends CommonSceneProps {
  data: SystemMapData
  /** Service hue order (lib/services.ts serviceOrder(meta)); read at mount. */
  serviceOrder?: string[]
  /** Healthy nodes labelled with their name only (numbers stay in the tooltip). */
  compactLabels?: boolean
  /** Node id lit as if hovered (e.g. the hovered table row); null clears. */
  highlight?: string | null
  /** Return false (or preventDefault) to stop the default: follow node.href (app paths via the router). */
  onSelect?: (node: SystemMapNode, event: Event) => boolean | void
  onHover?: (node: SystemMapNode | null) => void
}

export interface PipelineSceneProps extends CommonSceneProps {
  transport?: PipelineTransport
  /** Built-in Kafka / RabbitMQ / BullMQ switch (default true). */
  switcher?: boolean
  links?: PipelineOptions['links']
  /** Station marked "หน้าจอชุดนี้" (default 'monitor'). */
  here?: PipelineOptions['here']
  onTransportChange?: (transport: PipelineTransport) => void
  onSelect?: (station: PipelineStation, event: Event) => boolean | void
}

function motionDefault(m: SceneMotion | undefined): SceneMotion {
  return m ?? document.documentElement.dataset.motion !== 'off'
}

/** Mount without waiting for the viewport when motion is off (a still frame costs little; CLI screenshots need it). */
function useEager(): boolean {
  return useMemo(() => document.documentElement.dataset.motion === 'off', [])
}

/** Options without undefined values: the module merges them over its defaults (legend: true …) with Object.assign. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** Follow an app path with the router; false = leave it to the module / browser. */
function useFollow() {
  const router = useRouter()
  return useMemo(
    () =>
      (href: string | undefined, e: Event): boolean => {
        if (!href || !href.startsWith('/') || href.startsWith('//')) return false
        // a file (/DATA-DICTIONARY.md) is not a route: the browser opens it
        if (/\.[a-z0-9]+$/i.test(href.split(/[?#]/)[0])) return false
        if (e instanceof MouseEvent && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1)) return false
        e.preventDefault()
        router.push(href)
        return true
      },
    [router],
  )
}

function useLatest<T>(value: T) {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

export function MapScene(props: MapSceneProps) {
  const [frame, inView] = useInView<HTMLDivElement>({ rootMargin: '240px 0px' })
  const near = useEager() || inView
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<SystemMapHandle | null>(null)
  const [ready, setReady] = useState(false)
  const latest = useLatest(props)
  const follow = useFollow()
  const { legend, legendOpen, controls, autoRotate, ariaLabel, motion, forceFallback, compactLabels, highlight } = props
  const orderKey = (props.serviceOrder ?? []).join(',')
  const dataKey = useMemo(() => JSON.stringify(props.data), [props.data])

  useEffect(() => {
    const el = host.current
    if (!near || !el) return
    const p = latest.current
    const h = mountSystemMap(
      el,
      p.data,
      defined({
        serviceOrder: orderKey ? orderKey.split(',') : null,
        compactLabels: p.compactLabels,
        legend,
        legendOpen,
        controls,
        autoRotate,
        ariaLabel,
        forceFallback,
        motion: motionDefault(motion),
        onSelect: (node: SystemMapNode, e: Event) => {
          const r = latest.current.onSelect?.(node, e)
          if (r === false || e.defaultPrevented) return false
          if (follow(node.href, e)) return false
        },
        onHover: (node: SystemMapNode | null) => latest.current.onHover?.(node),
      }),
    )
    handle.current = h
    setReady(true)
    return () => {
      h.destroy()
      handle.current = null
      setReady(false)
    }
  }, [near, orderKey, legend, legendOpen, controls, autoRotate, ariaLabel, motion, forceFallback, follow, latest])

  // new data (auto refresh): update in place, the camera and the animation keep going
  const shownKey = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !handle.current) return
    if (shownKey.current !== null && shownKey.current !== dataKey) handle.current.update(latest.current.data)
    shownKey.current = dataKey
  }, [ready, dataKey, latest])

  useEffect(() => {
    if (ready) handle.current?.setCompactLabels(!!compactLabels)
  }, [ready, compactLabels])

  useEffect(() => {
    if (ready) handle.current?.highlight(highlight ?? null)
  }, [ready, highlight])

  return (
    <div ref={frame} className="ui-smap__frame">
      <div ref={host} className="ui-smap__host" />
      {ready ? null : <SceneSkeleton text={props.loadingText} />}
    </div>
  )
}

export function PipelineScene(props: PipelineSceneProps) {
  const [frame, inView] = useInView<HTMLDivElement>({ rootMargin: '240px 0px' })
  const near = useEager() || inView
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<PipelineHandle | null>(null)
  const [ready, setReady] = useState(false)
  const latest = useLatest(props)
  const follow = useFollow()
  const { switcher, here, legend, legendOpen, controls, autoRotate, ariaLabel, motion, forceFallback, transport } = props
  const linksKey = JSON.stringify(props.links ?? {})

  useEffect(() => {
    const el = host.current
    if (!near || !el) return
    const p = latest.current
    const links = JSON.parse(linksKey) as PipelineOptions['links']
    const h = mountPipeline(
      el,
      defined({
        transport: p.transport,
        switcher,
        links,
        here,
        legend,
        legendOpen,
        controls,
        autoRotate,
        ariaLabel,
        forceFallback,
        motion: motionDefault(motion),
        onTransportChange: (t: PipelineTransport) => latest.current.onTransportChange?.(t),
        onSelect: (station: PipelineStation, e: Event) => {
          const r = latest.current.onSelect?.(station, e)
          if (r === false || e.defaultPrevented) return false
          if (follow(links?.[station.id], e)) return false
        },
      }),
    )
    handle.current = h
    setReady(true)
    return () => {
      h.destroy()
      handle.current = null
      setReady(false)
    }
  }, [near, linksKey, switcher, here, legend, legendOpen, controls, autoRotate, ariaLabel, motion, forceFallback, follow, latest])

  useEffect(() => {
    const h = handle.current
    if (ready && h && transport && h.transport !== transport) h.setTransport(transport)
  }, [ready, transport])

  return (
    <div ref={frame} className="ui-smap__frame">
      <div ref={host} className="ui-smap__host" />
      {ready ? null : <SceneSkeleton text={props.loadingText} />}
    </div>
  )
}
