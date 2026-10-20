/** Placeholder of a 3D view while three.js loads and until the scene is mounted (same box, shimmering .skel). */
export function SceneSkeleton({ text = 'กำลังโหลดภาพ 3 มิติ…' }: { text?: string }) {
  return (
    <div className="ui-smap__skel" role="status">
      <span className="skel ui-smap__skel-block" aria-hidden="true" />
      <span className="ui-smap__skel-text">{text}</span>
    </div>
  )
}
