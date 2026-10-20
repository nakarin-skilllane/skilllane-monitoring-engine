/**
 * Motion switch (DESIGN.md §7b, port of app.js §1c): `<html data-motion="on|off">` is set in <head>
 * before first paint. Off for ?motion=off, prefers-reduced-motion, no IntersectionObserver, or headless
 * Chrome (CLI screenshots capture before any frame runs, so they would catch the not-yet-revealed
 * state); ?motion=on forces it on. Under motion off every --dur-* token is 0 ms and nothing waits for a
 * reveal. Everything the CSS hides before a reveal is scoped to [data-motion="on"]; components/Motion.tsx
 * (MotionRoot, in AppFrame) adds `.is-in` to the REVEAL targets as they scroll into view.
 */

/** Reveal targets: `.is-in` on first view (the element and every target inside it), then a 'mo:in' event. */
export const REVEAL_SELECTOR = '.chart, .kpi, .spark-inline, .wf, .dur, .badge-new, [data-mo]'

/** A new table row keeps `tr.is-new` this long (the highlight fades over --dur-linger). */
export const NEW_ROW_MS = 2000

/**
 * Inline <head> script, ES5. If the React side (MotionRoot) has not started within 5 s (script error,
 * very slow dev compile), motion is switched off so nothing stays hidden waiting for a reveal.
 */
export const MOTION_BOOT_SCRIPT = `(function(){var d=document.documentElement,p=null;try{p=new URLSearchParams(location.search).get('motion')}catch(e){}var r=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches),h=/HeadlessChrome/.test(navigator.userAgent),on='IntersectionObserver' in window&&(p==='on'||(p!=='off'&&!r&&!h));d.setAttribute('data-motion',on?'on':'off');if(on)setTimeout(function(){if(!window.__skMotion)d.setAttribute('data-motion','off')},5000)})()`

/** Is the motion layer on for this page? Client only (false on the server and before the boot script ran). */
export function motionOn(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.motion === 'on'
}
