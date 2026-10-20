/**
 * Types of lib/3d/system-map.js, the three.js scenes copied from
 * design/monitoring-ui/assets/system-map.js by scripts/sync-design.mjs.
 * Hand-written from the module's doc comments (kept by sync-design; update it when the API changes).
 *
 * Browser only (window, document, WebGL at call time). Screens use the React wrappers
 * components/SystemMap3D.tsx and components/Pipeline3D.tsx (dynamic import, no SSR, mount /
 * update / destroy); `.smap*` overlay classes come from system-map.css (imported by app/layout.tsx).
 * Colours come from the container's CSS custom properties and follow theme changes.
 */

export type MapNodeKind = 'client' | 'service' | 'worker' | 'queue' | 'dependency' | 'external'
export type MapNodeState = 'ok' | 'warn' | 'degraded' | 'error' | 'down'

export interface SystemMapNode {
  id: string
  label: string
  /** Starting with '/' it is shown inline as the role ('/api'); otherwise tooltip only. */
  sublabel?: string
  kind: MapNodeKind
  /** Service name: picks the block's hue (with options.serviceOrder or `svc`). */
  service?: string
  /** Rate per minute (block height, log scale); null / absent = not known (no number shown). */
  rpm?: number | null
  /** Ratio (0.0016 = 0.16 %); null / absent = not known. */
  errorRate?: number | null
  p95Ms?: number | null
  state: MapNodeState
  /** Clicking the node follows it (or calls options.onSelect). javascript:/data:/vbscript: are dropped. */
  href?: string
  /** Unit of `rpm` in labels. Default req/min (service, client), job/min (worker), msg/min (queue), call/min (dependency, external). */
  rateUnit?: string
  /** Short line on the label. */
  note?: string
  /** Fixed position on the ground plane [x, z] in world units; laid out in tiers when absent. */
  pos?: [number, number]
  /** Service hue slot 1–6 (overrides `service`). */
  svc?: 1 | 2 | 3 | 4 | 5 | 6
}

export interface SystemMapEdge {
  from: string
  to: string
  /** Calls per minute (particle density ∝ rpm^0.42); null = the call exists, rate unknown (slow trickle, no number). */
  rpm: number | null
  /** Ratio of failing calls (red particles, own compressed scale). */
  errorRate?: number | null
  label?: string
}

export interface SystemMapData {
  nodes: SystemMapNode[]
  edges: SystemMapEdge[]
}

/** 'auto' = animate unless prefers-reduced-motion. ?motion=off|on in the URL wins. */
export type SceneMotion = 'auto' | boolean

interface SceneOptions {
  motion?: SceneMotion
  /** Gentle sway that stops on any interaction (default true). */
  autoRotate?: boolean
  /** Toolbar: zoom, reset view, pause (default true). */
  controls?: boolean
  legend?: boolean
  /** Default true; closed under 560 px. */
  legendOpen?: boolean
  /** Cap of the ambient animation (default 30); dragging runs at full rate. */
  fps?: number
  /** Prefix of the canvas aria-label summary. */
  ariaLabel?: string
  /** Render the non-WebGL fallback (list) even when WebGL works. */
  forceFallback?: boolean
}

export interface SystemMapOptions extends SceneOptions {
  /** Return false (or call event.preventDefault()) to stop the default of following `href`. */
  onSelect?: (node: SystemMapNode, event: Event) => boolean | void
  onHover?: (node: SystemMapNode | null) => void
  /** Fixed service order for hues (lib/services.ts serviceOrder()); a 7th service is drawn muted. */
  serviceOrder?: string[] | null
  /** Default and cap 400. */
  maxParticles?: number
  /** Healthy nodes are labelled with their name only (class .smap--names), like .smap--compact under 560 px. */
  compactLabels?: boolean
}

export interface SceneStats {
  frames: number
  running: boolean
  animating: boolean
  /** false = the fallback without WebGL is shown. */
  webgl: boolean
  dark?: boolean
  particles?: number
  envelopes?: number
  transport?: PipelineTransport
}

interface SceneHandle {
  /** Root element (.smap) the scene added to the container. */
  element: HTMLElement
  /** Disposes geometries, materials, renderer and context; removes observers and listeners. */
  destroy(): void
  resetView(): void
  setPaused(paused: boolean): void
  stats(): SceneStats
}

export interface SystemMapHandle extends SceneHandle {
  update(data: SystemMapData): void
  /** Same as hovering that node (neighbours lit, the rest dimmed; calls onHover); null clears. */
  highlight(id: string | null): void
  setCompactLabels(on: boolean): void
}

/**
 * The system as a small city in tiers (users → services → queues → workers → databases / outside APIs):
 * services are blocks (height = rpm), workers stacked slabs, queues conveyors, databases / caches drums,
 * outside APIs domes; calls flow along the edges as particles (red = failing share). The root dispatches
 * a bubbling 'smap:select' CustomEvent with detail { node }.
 */
export function mountSystemMap(container: HTMLElement, data: SystemMapData, options?: SystemMapOptions): SystemMapHandle

export type PipelineTransport = 'kafka' | 'rabbitmq' | 'bullmq'
export type PipelineStationId = 'app' | 'queue' | 'engine' | 'clickhouse' | 'monitor' | 'ai'

export interface PipelineStation {
  id: PipelineStationId
  label: string
  sub: string
}

export interface PipelineOptions extends SceneOptions {
  transport?: PipelineTransport
  /** Show the Kafka / RabbitMQ / BullMQ switcher (default true). */
  switcher?: boolean
  onTransportChange?: (transport: PipelineTransport) => void
  /** Return false (or preventDefault) to stop following `links[id]`. */
  onSelect?: (station: PipelineStation, event: Event) => boolean | void
  /** hrefs per station. */
  links?: Partial<Record<PipelineStationId, string>>
  /** The station that is "this screen" (accent border + "หน้าจอชุดนี้"; default 'monitor'). */
  here?: PipelineStationId
}

export interface PipelineHandle extends SceneHandle {
  readonly transport: PipelineTransport
  setTransport(transport: PipelineTransport): void
}

/** How telemetry travels: NestJS app + skilllane-monitoring → queue → skilllane-monitoring engine → ClickHouse → skilllane monitor + AI. */
export function mountPipeline(container: HTMLElement, options?: PipelineOptions): PipelineHandle

/** Canonical demo data (BRIEF.md, prod, 17 ต.ค. 14:20 ICT): 'now' or 'cache-down' (13:42:50). 13 nodes, 14 edges. */
export function demoSystemMapData(scenario?: 'now' | 'cache-down'): SystemMapData

export interface SystemMapFromApiOptions {
  /** errorRate → state (default { warn: 0.001, error: 0.01 }). */
  thresholds?: { warn?: number; error?: number }
  /** Add a "ผู้ใช้" node feeding every api role. */
  clients?: boolean
  href?: (kind: 'service' | 'dependency' | 'queue', row: unknown) => string | undefined
}

/**
 * Map data from GET /api/overview (services, dependencies, jobs, range). Dependency edges and nodes carry
 * rpm null (the overview has no call rates). With GET /api/topology use lib/topology.ts systemMapFromTopology.
 */
export function systemMapFromApi(overview: unknown, options?: SystemMapFromApiOptions): SystemMapData
