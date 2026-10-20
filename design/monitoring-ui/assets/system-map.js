/* skilllane monitor · 3D views
   - mountSystemMap(container, data, options): the system as a small isometric "city". Services are blocks in their
     service hue (height = requests/min, log scale), workers are stacked slabs, queues are conveyors, databases and
     caches are drums, outside APIs are domes. Calls flow along the edges as particles (red = the failing share).
   - mountPipeline(container, options): how telemetry travels: NestJS app + skilllane-monitoring → queue (Kafka, RabbitMQ
     or BullMQ) → skilllane-monitoring engine → ClickHouse → skilllane monitor + AI.
   three@0.170.0 as an ES module, imported by bare specifier ('three', 'three/addons/…'): the mockups map them with an
   importmap, the Next.js app resolves them from npm. No globals. Colours are the page's CSS custom properties, read
   from the container at runtime and re-read when <html> data-theme/class or the OS colour scheme changes.
   Overlay markup (labels, tooltip, toolbar, legend, fallback) uses the .smap* classes in system-map.css. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ---------- 1. Theme tokens ---------- */

// Light values of styles.css (DESIGN.md §3), used only when the page does not define the token.
const TOKEN_FALLBACK = {
  '--ink': '#222222', '--ink-2': '#4f4f4f', '--muted': '#696969',
  '--surface': '#ffffff', '--surface-2': '#f8f8f8', '--line': '#e0e0e0', '--line-strong': '#bdbdbd',
  '--accent': '#00532a', '--ok': '#2f751d', '--warn': '#7a5000', '--danger': '#b71727',
  '--ok-solid': '#4f9a3a', '--warn-solid': '#a87300', '--danger-solid': '#d01a34', '--info-solid': '#5a89cb',
  '--svc-1': '#1f66c9', '--svc-2': '#c963a2', '--svc-3': '#2bb5d6', '--svc-4': '#eda100', '--svc-5': '#e87ba4', '--svc-6': '#6250d6',
};
// The queue / brand highlight: the first of these the page defines wins.
const HIGHLIGHT_TOKENS = ['--highlight', '--brand-highlight', '--brand-orange', '--orange', '--brand-amber'];
const HIGHLIGHT_FALLBACK = '#f3542a';   // SkillLane orange

let colorProbe = null;
const colorCache = new Map();

/** Any CSS colour (hex, rgb(), hsl(), oklch(), color-mix() …) → '#rrggbb', or null. A 1×1 canvas does the parsing. */
function cssToHex(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (colorCache.has(v)) return colorCache.get(v);
  let out = null;
  try {
    if (!colorProbe) {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      colorProbe = c.getContext('2d', { willReadFrequently: true });
    }
    colorProbe.fillStyle = '#010203';
    colorProbe.fillStyle = v;
    if (colorProbe.fillStyle !== '#010203' || /^#010203$/i.test(v)) {
      colorProbe.clearRect(0, 0, 1, 1);
      colorProbe.fillRect(0, 0, 1, 1);
      const d = colorProbe.getImageData(0, 0, 1, 1).data;
      if (d[3] > 0) out = '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { out = null; }
  colorCache.set(v, out);
  return out;
}

function readTheme(el) {
  const cs = getComputedStyle(el);
  const get = (name) => cssToHex(cs.getPropertyValue(name));
  const t = {};
  for (const name of Object.keys(TOKEN_FALLBACK)) t[name] = get(name) || TOKEN_FALLBACK[name];
  t.highlight = HIGHLIGHT_TOKENS.map(get).find(Boolean) || HIGHLIGHT_FALLBACK;
  const s = new THREE.Color(t['--surface']);
  t.dark = 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b < 0.2;
  return t;
}

function col(hex) { return new THREE.Color(hex); }
function mix(a, b, k) { return new THREE.Color(a).lerp(new THREE.Color(b), k); }

/* ---------- 2. Formatting (DESIGN.md §3: thousands separators, "0.16 %", "84 ms", "1.8 s") ---------- */

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function fmtRate(v) {
  if (!(v > 0)) return '0';
  if (v >= 10) return nf0.format(Math.round(v));
  if (v < 0.1) return '< 0.1';
  return String(Math.round(v * 10) / 10);
}
function fmtPct(ratio) {
  const p = (ratio || 0) * 100;
  if (p <= 0) return '0 %';
  if (p < 0.01) return '< 0.01 %';
  if (p < 1) return parseFloat(p.toFixed(2)) + ' %';
  if (p >= 100) return '100 %';
  return parseFloat(p.toFixed(1)) + ' %';
}
function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : nf0.format(Math.round(ms)) + ' ms';
}

/* ---------- 3. Environment ---------- */

function urlParam(name) {
  try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
}
function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
/** option: 'auto' (follow prefers-reduced-motion) | true | false. ?motion=off|on in the URL wins (screenshots, demos). */
function motionWanted(option) {
  const p = urlParam('motion');
  if (p === 'off' || p === '0' || p === 'false') return false;
  if (p === 'on' || p === '1') return true;
  if (option === true || option === false) return option;
  return !reducedMotion();
}
function createContext(canvas, forceFallback) {
  if (forceFallback || urlParam('webgl') === 'off') return null;
  try {
    return canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  } catch (e) { return null; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(paths, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls || 'smap__icon');
  s.innerHTML = paths;
  return s;
}
const ICON = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  reset: '<path d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4"/><path d="M3.2 2.8v2.6h2.6"/>',
  pause: '<path d="M5.75 3.75v8.5M10.25 3.75v8.5"/>',
  play: '<path d="M5.25 3.5 12 8l-6.75 4.5z"/>',
};

/** A page may put a .smap-placeholder in the container until the module loads; mounting replaces it. */
function clearPlaceholder(container) {
  Array.prototype.forEach.call(container.querySelectorAll(':scope > .smap-placeholder'), (n) => n.remove());
}

function disposeTree(obj) {
  const seen = new Set();
  obj.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { if (!seen.has(x)) { seen.add(x); x.dispose(); } });
  });
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Links come from data: keep relative and http(s) URLs only. */
const safeHref = (h) => { const v = h == null ? '' : String(h).trim(); return /^(javascript|data|vbscript):/i.test(v.replace(/[\s\u0000-\u001f]/g, '')) ? '' : v; };
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/* ---------- 4. Shared materials ---------- */

function bodyMaterial() {
  return new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, color: 0x888888 });
}

/** Ground grid: hairlines that fade out at the edge of the city, so the panel shows through. */
function makeGrid() {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(0x999999) }, uOpacity: { value: 0.5 }, uCell: { value: 1.1 }, uCenter: { value: new THREE.Vector2() }, uRadius: { value: 10 } },
    vertexShader: 'varying vec2 vXZ; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vXZ = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uOpacity; uniform float uCell; uniform vec2 uCenter; uniform float uRadius; varying vec2 vXZ;',
      'void main() {',
      '  vec2 c = (vXZ - uCenter) / uCell;',
      '  vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);',
      '  float line = 1.0 - min(min(g.x, g.y), 1.0);',
      '  float d = length(vXZ - uCenter);',
      '  float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius, d);',
      '  float a = line * uOpacity * fade;',
      '  if (a < 0.004) discard;',
      '  gl_FragColor = vec4(uColor, a);',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.003;
  mesh.renderOrder = -1;
  return mesh;
}

/** Edge / path line: a thin tube; solid with soft ends while moving, dashed in a still frame. */
function lineMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color(0x888888) }, uOpacity: { value: 0.5 }, uDash: { value: 0 }, uDashCount: { value: 12 } },
    vertexShader: 'varying float vU; void main() { vU = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform vec3 uColor; uniform float uOpacity; uniform float uDash; uniform float uDashCount; varying float vU;',
      'void main() {',
      '  if (uDash > 0.5 && fract(vU * uDashCount) > 0.56) discard;',
      '  float ends = smoothstep(0.0, 0.05, vU) * smoothstep(1.0, 0.92, vU);',
      '  gl_FragColor = vec4(uColor, uOpacity * (0.4 + 0.6 * ends));',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  });
}

/* ---------- 5. Stage: renderer, camera, controls, loop, labels, tooltip, toolbar, theme ---------- */

let uid = 0;

/**
 * cfg = { kind, options, view: { azimuth, polar, sway, swayPeriod }, legend: Node|null, top: Node|null,
 *         tipFor(id) → Node|null, onHover(id|null), onSelect(id, event), isClickable(id) }
 * Returns null when WebGL2 is not available (the caller renders the fallback).
 */
function createStage(container, cfg) {
  const opts = cfg.options;
  const canvas = document.createElement('canvas');
  const gl = createContext(canvas, opts.forceFallback);
  if (!gl) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
  } catch (e) { return null; }

  const id = 'smap-' + (++uid);
  const root = el('div', 'smap smap--' + cfg.kind);
  root.dataset.motion = 'on';
  const stageEl = el('div', 'smap__stage');
  const labelsEl = el('div', 'smap__labels');
  const tip = el('div', 'smap__tip');
  tip.id = id + '-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  canvas.className = 'smap__canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  stageEl.appendChild(canvas);
  root.append(stageEl, labelsEl);
  clearPlaceholder(container);
  container.appendChild(root);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;   // shapes rarely move: the scenes ask for a new shadow map when they do

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1.3);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.radius = 3;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(hemi, sun, sun.target);
  const shadowGround = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.1, depthWrite: false }));
  shadowGround.rotation.x = -Math.PI / 2;
  shadowGround.receiveShadow = true;
  scene.add(shadowGround);
  const grid = makeGrid();
  scene.add(grid);

  const controls = new OrbitControls(camera, canvas);
  controls.enableZoom = false;          // no wheel hijack: zoom is the + / − buttons
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.55;
  controls.minPolarAngle = 0.32;
  controls.maxPolarAngle = 1.28;
  if (cfg.view.minAzimuth != null) { controls.minAzimuthAngle = cfg.view.minAzimuth; controls.maxAzimuthAngle = cfg.view.maxAzimuth; }
  canvas.style.touchAction = 'pan-y';   // a vertical swipe still scrolls the page on phones; sideways drag orbits

  const view = Object.assign({ azimuth: 0.6, polar: 0.98, sway: 0.3, swayPeriod: 26 }, cfg.view);
  const size = { w: 0, h: 0 };
  let bounds = { center: new THREE.Vector3(), radius: 8, height: 2, points: [] };
  let userZoom = 1;
  let theme = readTheme(root);
  let themeKey = JSON.stringify(theme);

  const hooks = { tick: [], theme: [], motion: [], resize: [] };
  let destroyed = false;
  let raf = 0;
  let dirty = true;
  let visible = true;
  let hidden = typeof document !== 'undefined' && document.hidden;
  let lastTick = 0;
  let clock = 0;
  let frames = 0;
  let busy = 0;               // > 0 while a tween needs frames even when motion is off
  let paused = false;
  let motionPref = motionWanted(opts.motion);
  let swaying = opts.autoRotate !== false && view.sway > 0;
  let swayClock = 0;
  const minInterval = 1000 / clamp(num(opts.fps) || 30, 10, 60);

  const isAnimating = () => motionPref && !paused;

  /* --- camera --- */
  const sph = new THREE.Spherical();
  const offset = new THREE.Vector3();
  function setAngles(az, pol) {
    offset.copy(camera.position).sub(controls.target);
    sph.setFromVector3(offset);
    if (az != null) sph.theta = az;
    if (pol != null) sph.phi = clamp(pol, controls.minPolarAngle, controls.maxPolarAngle);
    sph.makeSafe();
    offset.setFromSpherical(sph);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  }
  /* Fit: project the scene's key points on the default view plane, then choose the scale (px per world unit) and the
     orbit target so the content fills the box inside pixel margins (room for labels above, overlays below). */
  let fitScale = 40;
  const fitTarget = new THREE.Vector3();
  function margins() {
    const compact = size.w < 560;
    const base = compact ? { l: 14, r: 14, t: 52, b: 48 } : { l: 64, r: 64, t: 58, b: 48 };
    return Object.assign(base, compact ? view.marginsCompact : view.margins);
  }
  function computeFit() {
    if (!size.w || !size.h) return;
    const th = view.azimuth, ph = view.polar;
    const right = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
    const back = new THREE.Vector3(Math.sin(ph) * Math.sin(th), Math.cos(ph), Math.sin(ph) * Math.cos(th));
    const up = new THREE.Vector3().crossVectors(back, right);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of bounds.points) {
      const x = p.dot(right), y = p.dot(up);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) { minX = -bounds.radius; maxX = bounds.radius; minY = -bounds.radius * 0.6; maxY = bounds.radius * 0.6; }
    const m = margins();
    const availW = Math.max(40, size.w - m.l - m.r), availH = Math.max(40, size.h - m.t - m.b);
    const s = Math.min(availW / Math.max(0.5, maxX - minX), availH / Math.max(0.5, maxY - minY)) * (view.fill || 0.96);
    const cx = (minX + maxX) / 2 - (m.l - m.r) / 2 / s;
    const cy = (minY + maxY) / 2 + (m.t - m.b) / 2 / s;
    fitTarget.copy(right).multiplyScalar(cx).addScaledVector(up, cy);
    const wantY = bounds.center.y + bounds.height * (view.targetY != null ? view.targetY : 0.3);
    fitTarget.addScaledVector(back, (wantY - fitTarget.y) / back.y);
    fitScale = s;
  }
  function applyZoom() {
    if (!size.h) return;
    camera.zoom = (fitScale * userZoom) / (size.h / 2);
    camera.updateProjectionMatrix();
  }
  function placeCamera() {
    controls.target.copy(fitTarget);
    sph.set(120, view.polar, view.azimuth);
    camera.position.setFromSpherical(sph).add(controls.target);
    camera.lookAt(controls.target);
    controls.update();
  }
  function setBounds(b) {
    bounds = { center: b.center.clone(), radius: Math.max(2, b.radius), height: Math.max(0.5, b.height), points: b.points || [] };
    const R = bounds.radius;
    const d = (R + 6) * 2;
    shadowGround.scale.set(d, d, 1);
    shadowGround.position.set(bounds.center.x, 0, bounds.center.z);
    grid.scale.set(d, d, 1);
    grid.position.set(bounds.center.x, 0.003, bounds.center.z);
    grid.material.uniforms.uCenter.value.set(bounds.center.x, bounds.center.z);
    grid.material.uniforms.uRadius.value = R + 3.5;
    sun.position.set(bounds.center.x + R * 0.55, R * 1.6 + 8, bounds.center.z + R * 0.85);
    sun.target.position.copy(bounds.center);
    const sc = sun.shadow.camera;
    sc.left = -R - 4; sc.right = R + 4; sc.top = R + 4; sc.bottom = -R - 4; sc.near = 0.5; sc.far = R * 6 + 40;
    sc.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
    computeFit();
    if (b.keepView) applyZoom(); else { placeCamera(); applyZoom(); }
    requestRender();
  }
  function resetView() {
    userZoom = 1;
    computeFit();
    placeCamera();
    applyZoom();
    swaying = opts.autoRotate !== false && view.sway > 0;
    swayClock = 0;
    requestRender();
  }
  function stopSway() { swaying = false; }
  function zoomBy(f) {
    userZoom = clamp(userZoom * f, 0.6, 4);
    applyZoom();
    stopSway();
    requestRender();
  }
  function rotateBy(dAz, dPol) {
    offset.copy(camera.position).sub(controls.target);
    sph.setFromVector3(offset);
    let az = sph.theta + dAz;
    if (isFinite(controls.minAzimuthAngle)) az = clamp(az, controls.minAzimuthAngle, controls.maxAzimuthAngle);
    setAngles(az, sph.phi + dPol);
    stopSway();
    requestRender();
  }

  /* --- theme --- */
  function applyLights() {
    const t = theme;
    if (t.dark) {
      hemi.color.set(mix('#ffffff', t['--surface'], 0.25)); hemi.groundColor.set(t['--surface']); hemi.intensity = 1.55;
      sun.intensity = 1.9;
      shadowGround.material.opacity = 0.3;
      grid.material.uniforms.uColor.value.set(t['--line-strong']);
      grid.material.uniforms.uOpacity.value = 0.8;
    } else {
      hemi.color.set('#ffffff'); hemi.groundColor.set(mix(t['--surface-2'], t['--ink'], 0.12)); hemi.intensity = 1.45;
      sun.intensity = 2.1;
      shadowGround.material.opacity = 0.11;
      grid.material.uniforms.uColor.value.set(t['--line-strong']);
      grid.material.uniforms.uOpacity.value = 0.75;
    }
  }
  function refreshTheme(force) {
    if (destroyed) return;
    const t = readTheme(root);
    const key = JSON.stringify(t);
    if (!force && key === themeKey) return;
    theme = t; themeKey = key;
    applyLights();
    hooks.theme.forEach((fn) => fn(theme));
    requestRender();
  }
  let themeTimer = 0;
  let themeRaf = 0;
  const mo = new MutationObserver(() => {
    if (!themeRaf) themeRaf = requestAnimationFrame(() => { themeRaf = 0; refreshTheme(); });
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => refreshTheme(), 450);   // again after any colour transition settles
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const mqMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onScheme = () => refreshTheme();
  const onMotionPref = () => { const want = motionWanted(opts.motion); if (want !== motionPref) { motionPref = want; motionChanged(); } };
  if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', onScheme);
  if (mqMotion && mqMotion.addEventListener) mqMotion.addEventListener('change', onMotionPref);

  /* --- motion state --- */
  function motionChanged() {
    const on = isAnimating();
    root.dataset.motion = on ? 'on' : 'off';
    lastTick = 0;
    hooks.motion.forEach((fn) => fn(on));
    syncPauseButton();
    requestRender();
  }
  function setPaused(p) {
    paused = !!p;
    if (!paused && !motionPref) motionPref = true;   // "play" opts in even under reduced motion
    motionChanged();
  }

  /* --- loop --- */
  function wantFrames() { return !destroyed && visible && !hidden && size.w > 0; }
  function kick() { if (!raf && wantFrames()) raf = requestAnimationFrame(frame); }
  function requestRender() { dirty = true; kick(); }
  function frame(now) {
    raf = 0;
    if (!wantFrames()) { lastTick = 0; return; }
    const animate = isAnimating();
    const moved = controls.update();
    let draw = dirty || moved;
    if ((animate || busy > 0) && (draw || !lastTick || now - lastTick >= minInterval - 1)) {
      const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 1 / 60;
      lastTick = now;
      if (animate) {
        clock += dt;
        if (swaying) {
          swayClock += dt;
          const sway = view.sway * Math.sin((swayClock / view.swayPeriod) * Math.PI * 2);
          setAngles(view.azimuth + sway, null);
        }
      }
      hooks.tick.forEach((fn) => fn(dt, clock, animate));
      draw = true;
    }
    if (draw) {
      dirty = false;
      projectLabels();
      renderer.render(scene, camera);
      frames++;
    }
    if (animate || moved || busy > 0) kick();
  }
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', () => { stopSway(); hideTip(); });

  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      visible = e.isIntersecting;
      if (visible) requestRender(); else if (raf) { cancelAnimationFrame(raf); raf = 0; lastTick = 0; }
    }, { rootMargin: '80px' })
    : null;
  if (io) io.observe(root);
  const onVisibility = () => {
    hidden = document.hidden;
    if (hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } lastTick = 0; } else requestRender();
  };
  document.addEventListener('visibilitychange', onVisibility);

  /* --- size --- */
  function resize() {
    const w = Math.round(root.clientWidth), h = Math.round(root.clientHeight);
    if (!w || !h || (w === size.w && h === size.h)) return;
    size.w = w; size.h = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -aspect; camera.right = aspect; camera.top = 1; camera.bottom = -1;
    if (root.classList.contains('smap--compact') !== (w < 560)) { root.classList.toggle('smap--compact', w < 560); remeasure(); }
    hooks.resize.forEach((fn) => fn(w, h, aspect));
    measureOverlays();
    computeFit();
    offset.copy(camera.position).sub(controls.target);
    controls.target.copy(fitTarget);
    camera.position.copy(fitTarget).add(offset);
    camera.lookAt(controls.target);
    applyZoom();
    requestRender();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(root); else window.addEventListener('resize', resize);

  /* --- labels: HTML overlays projected from 3D, greedy de-overlap by priority --- */
  const labels = [];
  const leaders = document.createElementNS(SVG_NS, 'svg');   // thin lines from a moved label back to its shape
  leaders.setAttribute('class', 'smap__leaders');
  leaders.setAttribute('aria-hidden', 'true');
  const leaderPath = document.createElementNS(SVG_NS, 'path');
  leaders.appendChild(leaderPath);
  labelsEl.appendChild(leaders);
  let leaderD = '';
  let sortedLabels = [];
  let labelsDirty = false;
  let blocked = [];
  const v3 = new THREE.Vector3();
  function addLabel(rec) {
    rec.w = 0; rec.h = 0; rec.x = NaN; rec.y = NaN; rec.hidden = null; rec.pinned = false;
    labelsEl.appendChild(rec.el);
    labels.push(rec);
    labelsDirty = true;
    requestRender();
    return rec;
  }
  function removeLabel(rec) {
    const i = labels.indexOf(rec);
    if (i >= 0) labels.splice(i, 1);
    rec.el.remove();
    labelsDirty = true;
  }
  function remeasure(rec) { if (rec) { rec.w = 0; rec.h = 0; } else labels.forEach((l) => { l.w = 0; l.h = 0; }); labelsDirty = true; requestRender(); }
  function projectLabels() {
    if (!size.w) return;
    if (labelsDirty) { sortedLabels = labels.slice().sort((a, b) => b.priority - a.priority); labelsDirty = false; }
    const placed = blocked.slice();
    const W = size.w, H = size.h;
    let d = '';
    for (const l of sortedLabels) {
      if (!l.w) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }
      if (l.getWorld) l.getWorld(l.world);
      v3.copy(l.world).project(camera);
      const px = ((v3.x + 1) / 2) * W, py = ((1 - v3.y) / 2) * H;
      let bx = px, by = py;
      if (l.getBase) { l.getBase(v3); v3.project(camera); bx = ((v3.x + 1) / 2) * W; by = ((1 - v3.y) / 2) * H; }
      const off = px < -40 || px > W + 40 || py < -40 || py > H + 40;
      // candidate spots: the preferred side first, then the last spot that fitted (less jumping while the view turns)
      const cands = l.align === 'above' ? ['above', 'right', 'left', 'below'] : l.align === 'right' ? ['right', 'left', 'above'] : [l.align];
      if (l.cand && cands.indexOf(l.cand) > 0) { cands.splice(cands.indexOf(l.cand), 1); cands.unshift(l.cand); }
      let x = 0, y = 0, r = null, hide = true;
      for (let c = 0; c < cands.length; c++) {
        const cand = cands[c];
        let cx, cy;
        if (cand === 'center') { cx = px - l.w / 2; cy = py - l.h / 2; }
        else if (cand === 'right') { cx = px + (l.gap || 12); cy = py - l.h / 2 + (l.align === 'right' ? 0 : 8); }
        else if (cand === 'left') { cx = px - l.w - (l.gap || 12); cy = py - l.h / 2 + (l.align === 'right' ? 0 : 8); }
        else if (cand === 'below') { cx = bx - l.w / 2; cy = by + 10; }
        else { cx = px - l.w / 2; cy = py - l.h - (l.gap || 6); }
        cx = clamp(cx, 4, Math.max(4, W - l.w - 4));
        cy = clamp(cy, 4, Math.max(4, H - l.h - 4));
        const cr = [cx - 3, cy - 2, cx + l.w + 3, cy + l.h + 2];
        let hit = false;
        if (!l.pinned) {
          for (let i = 0; i < placed.length; i++) {
            const p = placed[i];
            if (cr[0] < p[2] && cr[2] > p[0] && cr[1] < p[3] && cr[3] > p[1]) { hit = true; break; }
          }
        }
        if (c === 0 || !hit) { x = cx; y = cy; r = cr; }
        if (!hit) { hide = false; l.cand = cand; break; }
      }
      if (off || l.suppressed === true) hide = true;
      if (!hide) placed.push(r);
      if (!hide && l.align === 'above' && l.cand && l.cand !== 'above') {
        const lx = l.cand === 'right' ? x : l.cand === 'left' ? x + l.w : x + l.w / 2;
        const ly = l.cand === 'below' ? y : y + l.h / 2;
        const tx = l.cand === 'below' ? bx : px, ty = l.cand === 'below' ? by : py;
        d += 'M' + Math.round(lx) + ' ' + Math.round(ly) + 'L' + Math.round(tx) + ' ' + Math.round(ty);
      }
      const rx = Math.round(x), ry = Math.round(y);
      if (rx !== l.x || ry !== l.y) { l.el.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)'; l.x = rx; l.y = ry; }
      if (hide !== l.hidden) { l.el.classList.toggle('is-hidden', hide); l.hidden = hide; }
    }
    if (d !== leaderD) { leaderPath.setAttribute('d', d); leaderD = d; }
  }
  /** Overlays (toolbar, legend, top bar) are kept free of labels. */
  function measureOverlays() {
    const rr = root.getBoundingClientRect();
    blocked = [];
    root.querySelectorAll('.smap__toolbar, .smap__legend, .smap__top').forEach((o) => {
      if (o.hidden) return;
      const b = o.getBoundingClientRect();
      if (b.width && b.height) blocked.push([b.left - rr.left - 4, b.top - rr.top - 4, b.right - rr.left + 4, b.bottom - rr.top + 4]);
    });
  }

  /* --- tooltip --- */
  function showTipAt(content, clientX, clientY) {
    if (!content) { hideTip(); return; }
    tip.replaceChildren(content);
    tip.hidden = false;
    const rr = root.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = clientX - rr.left + 14, y = clientY - rr.top + 14;
    if (x + w > rr.width - 6) x = Math.max(6, clientX - rr.left - w - 14);
    if (y + h > rr.height - 6) y = Math.max(6, clientY - rr.top - h - 14);
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  function hideTip() { if (!tip.hidden) { tip.hidden = true; tip.replaceChildren(); } }

  /* --- picking and pointer --- */
  let pickables = [];
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hoverId = null;
  let downAt = null;
  let lastPointer = null;
  let hoverRaf = 0;
  let touchTipId = null;
  function pickAt(cx, cy) {
    if (!pickables.length) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o && o.userData.pickId == null) o = o.parent;
      if (o) return o.userData.pickId;
    }
    return null;
  }
  function setHover(pid, cx, cy) {
    if (pid !== hoverId) {
      hoverId = pid;
      if (cfg.onHover) cfg.onHover(pid);
      canvas.style.cursor = pid != null && cfg.isClickable && cfg.isClickable(pid) ? 'pointer' : '';
      requestRender();
    }
    if (pid != null && cfg.tipFor) showTipAt(cfg.tipFor(pid), cx, cy); else hideTip();
  }
  function onPointerMove(e) {
    lastPointer = e;
    if (!hoverRaf) {
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const p = lastPointer;
        if (!p || destroyed) return;
        if (p.buttons && p.pointerType !== 'touch') { hideTip(); return; }   // dragging
        if (p.pointerType === 'touch') return;
        setHover(pickAt(p.clientX, p.clientY), p.clientX, p.clientY);
      });
    }
  }
  function onPointerDown(e) { downAt = { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType }; }
  function onPointerUp(e) {
    if (!downAt) return;
    const d = downAt; downAt = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 700) return;
    const pid = pickAt(e.clientX, e.clientY);
    if (d.type === 'touch') {
      // first tap shows the details, a second tap on the same thing opens it
      if (pid == null) { touchTipId = null; setHover(null); return; }
      if (touchTipId !== pid) { touchTipId = pid; setHover(pid, e.clientX, e.clientY); return; }
    }
    if (pid != null && cfg.onSelect) cfg.onSelect(pid, e);
  }
  function onPointerLeave() { lastPointer = null; if (hoverId != null) setHover(null); }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') rotateBy(-0.2, 0);
    else if (k === 'ArrowRight') rotateBy(0.2, 0);
    else if (k === 'ArrowUp') rotateBy(0, -0.1);
    else if (k === 'ArrowDown') rotateBy(0, 0.1);
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === '0' || k === 'Home') resetView();
    else if (k === 'Escape') hideTip();
    else return;
    e.preventDefault();
  });

  /* --- overlay: top bar slot, legend, toolbar --- */
  if (cfg.top) {
    const top = el('div', 'smap__top');
    top.appendChild(cfg.top);
    root.appendChild(top);
  }
  if (cfg.legend) {
    const lg = el('details', 'smap__legend');
    const sum = el('summary', 'smap__legend-sum', 'อ่านภาพนี้อย่างไร');
    lg.append(sum, cfg.legend);
    lg.open = (container.clientWidth || 0) >= 560 && opts.legendOpen !== false;
    lg.addEventListener('toggle', () => { measureOverlays(); requestRender(); });
    root.appendChild(lg);
  }
  let pauseBtn = null;
  if (opts.controls !== false) {
    const bar = el('div', 'smap__toolbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'ควบคุมภาพ 3 มิติ');
    const btn = (icon, label, fn) => {
      const b = el('button', 'smap__btn');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.appendChild(svgIcon(icon));
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    btn(ICON.plus, 'ซูมเข้า', () => zoomBy(1.25));
    btn(ICON.minus, 'ซูมออก', () => zoomBy(0.8));
    btn(ICON.reset, 'รีเซ็ตมุมมอง', () => resetView());
    pauseBtn = btn(ICON.pause, 'หยุดการเคลื่อนไหว', () => setPaused(isAnimating()));
    root.appendChild(bar);
  }
  function syncPauseButton() {
    if (!pauseBtn) return;
    const on = isAnimating();
    const label = on ? 'หยุดการเคลื่อนไหว' : 'เล่นการเคลื่อนไหว';
    pauseBtn.setAttribute('aria-label', label);
    pauseBtn.title = label;
    pauseBtn.replaceChildren(svgIcon(on ? ICON.pause : ICON.play));
  }
  root.appendChild(tip);

  const onFonts = () => { remeasure(); measureOverlays(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed) onFonts(); });

  applyLights();
  resize();
  placeCamera();
  root.dataset.motion = isAnimating() ? 'on' : 'off';
  syncPauseButton();

  return {
    root, canvas, scene, camera, renderer, controls, labelsEl,
    get theme() { return theme; },
    get animating() { return isAnimating(); },
    get hoverId() { return hoverId; },
    get size() { return size; },
    get frames() { return frames; },
    get running() { return raf !== 0; },
    onTick(fn) { hooks.tick.push(fn); },
    onTheme(fn) { hooks.theme.push(fn); },
    onMotion(fn) { hooks.motion.push(fn); },
    onResize(fn) { hooks.resize.push(fn); },
    setBounds, requestRender, resetView, zoomBy, setPaused, stopSway,
    setView(v) { Object.assign(view, v); },
    shadowsChanged() { renderer.shadowMap.needsUpdate = true; },
    busy(delta) { busy = Math.max(0, busy + delta); if (busy) kick(); },
    addLabel, removeLabel, remeasure,
    setPickables(list) { pickables = list; },
    setHover, showTipAt, hideTip,
    setSummary(text) { canvas.setAttribute('aria-label', text); root.dataset.summary = text; },
    refreshTheme,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      if (themeRaf) cancelAnimationFrame(themeRaf);
      clearTimeout(themeTimer);
      mo.disconnect();
      if (io) io.disconnect();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (mqDark && mqDark.removeEventListener) mqDark.removeEventListener('change', onScheme);
      if (mqMotion && mqMotion.removeEventListener) mqMotion.removeEventListener('change', onMotionPref);
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}

/* ---------- 6. System map ---------- */

const KINDS = ['service', 'worker', 'queue', 'dependency', 'external', 'client'];
const STATES = ['ok', 'warn', 'degraded', 'error', 'down'];
const DEFAULT_UNIT = { service: 'req/min', worker: 'job/min', queue: 'msg/min', dependency: 'call/min', external: 'call/min', client: 'req/min' };
const KIND_TEXT = { service: 'service', worker: 'worker', queue: 'queue', dependency: 'ระบบที่เรียกใช้', external: 'ระบบภายนอก', client: 'ผู้ใช้' };
const STATE_TEXT = { ok: 'ปกติ', warn: 'ต้องดู', degraded: 'ทำงานไม่เต็มที่', error: 'มี error', down: 'down' };
const STATE_RANK = { down: 4, error: 3, degraded: 2, warn: 2, ok: 0 };
const FOOT = { service: 1.2, worker: 1.1, queue: 1.45, dependency: 0.86, external: 1.05, client: 1.0 };

function normaliseMap(data, opts) {
  const src = data || {};
  const nodes = [];
  const byId = new Map();
  for (const raw of src.nodes || []) {
    if (!raw || raw.id == null || byId.has(String(raw.id))) continue;
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'service';
    const n = {
      id: String(raw.id),
      label: String(raw.label != null ? raw.label : raw.id),
      sublabel: raw.sublabel ? String(raw.sublabel) : '',
      kind,
      service: raw.service ? String(raw.service) : '',
      // rpm / errorRate null = not known (the API has no number for it): the shape is drawn, no number appears in text
      rpm: Math.max(0, num(raw.rpm)),
      rpmKnown: raw.rpm != null,
      errorRate: clamp(num(raw.errorRate), 0, 1),
      errKnown: raw.errorRate != null,
      p95Ms: raw.p95Ms == null ? null : num(raw.p95Ms),
      state: STATES.includes(raw.state) ? raw.state : 'ok',
      href: safeHref(raw.href),
      rateUnit: raw.rateUnit ? String(raw.rateUnit) : DEFAULT_UNIT[kind],
      note: raw.note ? String(raw.note) : '',
      pos: Array.isArray(raw.pos) && raw.pos.length >= 2 ? [num(raw.pos[0]), num(raw.pos[1])] : null,
      slot: 0,
      raw,
    };
    nodes.push(n);
    byId.set(n.id, n);
  }
  const edges = [];
  const seen = new Set();
  for (const raw of src.edges || []) {
    if (!raw) continue;
    const from = String(raw.from), to = String(raw.to), key = from + '→' + to;
    if (!byId.has(from) || !byId.has(to) || from === to || seen.has(key)) continue;
    seen.add(key);
    // rpm null = the call exists but its rate is unknown (drawn as a slow trickle, no number in text)
    edges.push({ key, from, to, rpm: raw.rpm == null ? null : Math.max(0, num(raw.rpm)), errorRate: clamp(num(raw.errorRate), 0, 1), label: raw.label ? String(raw.label) : '' });
  }
  // Service hue is fixed per service in order of first appearance (DESIGN.md §3), never by rank; a 7th service is muted.
  const order = Array.isArray(opts.serviceOrder) ? opts.serviceOrder.slice() : [];
  for (const n of nodes) if (n.service && !order.includes(n.service)) order.push(n.service);
  for (const n of nodes) {
    const explicit = num(n.raw.svc);
    const i = n.service ? order.indexOf(n.service) : -1;
    n.slot = explicit >= 1 && explicit <= 6 ? explicit : (i >= 0 && i < 6 ? i + 1 : 0);
  }
  return { nodes, edges, byId };
}

function nodeHeight(n) {
  if (n.kind === 'service') return clamp(0.75 + 0.85 * Math.log10(1 + n.rpm), 0.75, 4.6);
  if (n.kind === 'worker') return clamp(0.8 + 0.75 * Math.log10(1 + n.rpm), 0.9, 4.2);
  if (n.kind === 'queue') return 0.78;
  if (n.kind === 'dependency') return 1.16;
  if (n.kind === 'external') return 0.88;
  return 0.62;
}

/** Tiered layout, read left → right: users → services → queues → workers → databases and outside APIs.
    Empty tiers collapse; inside a tier nodes are ordered by their neighbours (barycentre), then z relaxes toward them. */
const TIER = { client: 0, service: 1, queue: 2, worker: 3, dependency: 4, external: 4 };
function layoutMap(model) {
  const { nodes, edges } = model;
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inn = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) { out.get(e.from).push(e.to); inn.get(e.to).push(e.from); }
  const layer = new Map(nodes.map((n) => [n.id, TIER[n.kind]]));
  const byLayer = [];
  for (const n of nodes) { const L = layer.get(n.id); (byLayer[L] = byLayer[L] || []).push(n.id); }
  const layers = byLayer.filter(Boolean);
  layers.forEach((ids, L) => ids.forEach((id) => layer.set(id, L)));
  const nb = (id) => out.get(id).concat(inn.get(id)).filter((x) => layer.get(x) !== layer.get(id));
  const idx = new Map();
  const norm = (id) => idx.get(id) - (layers[layer.get(id)].length - 1) / 2;
  layers.forEach((ids) => ids.forEach((id, i) => idx.set(id, i)));
  for (let it = 0; it < 6; it++) {
    for (const ids of (it % 2 ? layers.slice().reverse() : layers)) {
      const bc = new Map(ids.map((id) => { const ns = nb(id); return [id, ns.length ? ns.reduce((s, x) => s + norm(x), 0) / ns.length : norm(id)]; }));
      ids.sort((a, b) => bc.get(a) - bc.get(b));
      ids.forEach((id, i) => idx.set(id, i));
    }
  }
  const DX = 4.6, DZ = 3.6;
  const z = new Map();
  layers.forEach((ids) => ids.forEach((id, i) => z.set(id, (i - (ids.length - 1) / 2) * DZ)));
  for (let it = 0; it < 14; it++) {
    for (const ids of layers) {
      const want = ids.map((id) => { const ns = nb(id); return ns.length ? ns.reduce((s, x) => s + z.get(x), 0) / ns.length : z.get(id); });
      const cur = ids.map((id, i) => z.get(id) * 0.5 + want[i] * 0.5);
      for (let i = 1; i < cur.length; i++) cur[i] = Math.max(cur[i], cur[i - 1] + DZ);
      const shift = want.reduce((s, x) => s + x, 0) / want.length - cur.reduce((s, x) => s + x, 0) / cur.length;
      ids.forEach((id, i) => z.set(id, cur[i] + shift));
    }
  }
  const pos = new Map();
  let mz = 0;
  nodes.forEach((n) => { mz += z.get(n.id); });
  mz /= Math.max(1, nodes.length);
  for (const n of nodes) {
    const L = layer.get(n.id);
    pos.set(n.id, n.pos ? { x: n.pos[0], z: n.pos[1] } : { x: (L - (layers.length - 1) / 2) * DX, z: z.get(n.id) - mz });
  }
  // queues lie along their flow
  const angle = new Map();
  for (const n of nodes) {
    if (n.kind !== 'queue') continue;
    const p = pos.get(n.id);
    const avg = (ids, fb) => { if (!ids.length) return fb; let x = 0, zz = 0; ids.forEach((i) => { x += pos.get(i).x; zz += pos.get(i).z; }); return { x: x / ids.length, z: zz / ids.length }; };
    const a = avg(inn.get(n.id), { x: p.x - 1, z: p.z });
    const b = avg(out.get(n.id), { x: p.x + 1, z: p.z });
    angle.set(n.id, Math.atan2(-(b.z - a.z), b.x - a.x));
  }
  return { pos, angle };
}

function svgGlyph(paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 20 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'smap__glyph');
  s.innerHTML = paths;
  return s;
}

function mapLegend() {
  const ul = el('ul', 'smap__legend-list');
  const item = (glyph, text) => { const li = el('li', 'smap__legend-item'); li.append(glyph, el('span', null, text)); ul.appendChild(li); };
  item(svgGlyph('<path class="g-svc" d="M5 4.5 10 2l5 2.5v8L10 15l-5-2.5z"/><path class="g-edge" d="M5 4.5 10 7l5-2.5M10 7v8"/>'), 'อาคาร = service · สูง = req/min (log)');
  item(svgGlyph('<path class="g-svc" d="M5 11.5 10 14l5-2.5M5 8.5 10 11l5-2.5M5 5.5 10 8l5-2.5L10 3z"/>'), 'ชั้นซ้อน = worker / consumer');
  item(svgGlyph('<path class="g-queue" d="M2 7.5 7 5l11 3.5-5 2.5z"/><path class="g-edge" d="M2 7.5v2l11 3.5 5-2.5v-2"/>'), 'แท่งยาว = queue');
  item(svgGlyph('<ellipse class="g-dep" cx="10" cy="4" rx="5" ry="2"/><path class="g-edge" d="M5 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M5 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>'), 'ถังซ้อน = database / cache');
  item(svgGlyph('<path class="g-dep" d="M4 12a6 6 0 0 1 12 0z"/><path class="g-edge" d="M2.5 12h15"/>'), 'โดม = ระบบภายนอก (API)');
  item(svgGlyph('<circle class="g-dot" cx="5" cy="8" r="2"/><circle class="g-dot" cx="11" cy="8" r="2"/><circle class="g-bad" cx="17" cy="8" r="2.4"/>'), 'จุดวิ่ง = การเรียก · สีแดง = ส่วนที่ล้มเหลว');
  item(svgGlyph('<ellipse class="g-ring-bad" cx="10" cy="8" rx="7.5" ry="4"/><ellipse class="g-ring-warn" cx="10" cy="8" rx="4" ry="2"/>'), 'วงแดง = error / down · วงเหลือง = ต้องดู');
  return ul;
}

function summariseMap(model) {
  const svc = model.nodes.filter((n) => n.kind === 'service' || n.kind === 'worker').length;
  const qn = model.nodes.filter((n) => n.kind === 'queue').length;
  const dep = model.nodes.filter((n) => n.kind === 'dependency' || n.kind === 'external').length;
  const name = (n) => n.label + (n.sublabel && n.sublabel.charAt(0) === '/' ? n.sublabel : '');
  const of = (states) => model.nodes.filter((n) => states.includes(n.state));
  const parts = ['แผนผังระบบ 3 มิติ: ' + svc + ' service, ' + qn + ' queue, ' + dep + ' ระบบที่เรียกใช้'];
  const down = of(['down']), err = of(['error']), warn = of(['warn', 'degraded']);
  if (down.length) parts.push('down ' + down.length + ': ' + down.map(name).join(', '));
  if (err.length) parts.push('มี error ' + err.length + ': ' + err.map((n) => name(n) + (n.errKnown ? ' ' + fmtPct(n.errorRate) : '')).join(', '));
  if (warn.length) parts.push('ต้องดู ' + warn.length + ': ' + warn.map(name).join(', '));
  if (!down.length && !err.length && !warn.length) parts.push('ทุกส่วนปกติ');
  return parts.join(' · ');
}

function tipNode(title, sub, rows, foot) {
  const box = el('div', 'smap__tip-body');
  const t = el('div', 'smap__tip-title', title);
  if (sub) t.appendChild(el('span', 'smap__tip-sub', ' ' + sub));
  box.appendChild(t);
  for (const r of rows) {
    if (!r) continue;
    const line = el('div', 'smap__tip-line');
    if (r.tone) line.dataset.tone = r.tone;
    line.append(el('span', 'smap__tip-val', r.value), el('span', 'smap__tip-name', r.name || ''));
    box.appendChild(line);
  }
  if (foot) box.appendChild(el('div', 'smap__tip-foot', foot));
  return box;
}

/**
 * mountSystemMap(container, data, options) → { update(data), highlight(id|null), setCompactLabels(bool), destroy(), resetView(), setPaused(bool), element, stats() }
 * data    = { nodes: [{ id, label, sublabel?, kind, service?, rpm, errorRate (ratio), p95Ms?, state, href?, rateUnit?, note?, pos?: [x, z], svc?: 1..6 }],
 *             edges: [{ from, to, rpm, errorRate (ratio), label? }] }
 *           rpm / errorRate null (or left out) = not known: no number for it in labels, tooltip or fallback list.
 * options = { onSelect(node, event), onHover(node|null), serviceOrder: string[], motion: 'auto'|true|false, autoRotate: true,
 *             controls: true, legend: true, legendOpen: true, compactLabels: false, maxParticles: 400, fps: 30, ariaLabel?: string,
 *             forceFallback: false }
 * The root also dispatches a bubbling 'smap:select' CustomEvent with detail { node }.
 */
export function mountSystemMap(container, data, options) {
  const opts = Object.assign({ motion: 'auto', autoRotate: true, controls: true, legend: true, maxParticles: 400, fps: 30, serviceOrder: null }, options || {});
  let model = normaliseMap(data, opts);
  const recs = new Map();
  let edgeRecs = [];
  let lastIds = '';

  const stage = createStage(container, {
    kind: 'map', options: opts,
    view: { azimuth: 0.3, polar: 0.9, sway: 0.3, swayPeriod: 28 },
    legend: opts.legend ? mapLegend() : null,
    tipFor: (id) => nodeTip(id),
    onHover: (id) => hover(id),
    onSelect: (id, e) => select(id, e, null),
    isClickable: (id) => { const r = recs.get(id); return !!(r && (r.n.href || opts.onSelect)); },
  });
  if (!stage) return mountMapFallback(container, model, opts);
  // compactLabels: healthy nodes are labelled with their name only, as below 560 px; their numbers stay in the tooltip
  stage.root.classList.toggle('smap--names', !!opts.compactLabels);

  const { scene } = stage;
  const world = new THREE.Group();
  const edgeGroup = new THREE.Group();
  scene.add(world, edgeGroup);
  const MAXP = clamp(Math.floor(num(opts.maxParticles) || 400), 0, 400);
  const pGeo = new THREE.SphereGeometry(1, 12, 8);
  const pMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const particlesMesh = new THREE.InstancedMesh(pGeo, pMat, Math.max(1, MAXP));
  particlesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particlesMesh.frustumCulled = false;
  particlesMesh.count = 0;
  for (let i = 0; i < Math.max(1, MAXP); i++) particlesMesh.setColorAt(i, new THREE.Color(1, 1, 1));
  scene.add(particlesMesh);
  let particles = [];
  const dummy = new THREE.Object3D();
  const badColor = new THREE.Color();

  /* --- node bodies --- */
  function addMesh(group, geo, role, list, y, x, z) {
    const m = new THREE.Mesh(geo, bodyMaterial());
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.role = role;
    group.add(m);
    list.push(m);
    return m;
  }
  function buildBody(n, h) {
    const g = new THREE.Group();
    const meshes = [];
    if (n.kind === 'service') {
      const geo = new RoundedBoxGeometry(1.7, h, 1.7, 4, 0.14); geo.translate(0, h / 2, 0);
      addMesh(g, geo, 'base', meshes);
      const cap = new RoundedBoxGeometry(1.2, 0.08, 1.2, 2, 0.035); cap.translate(0, 0.04, 0);
      addMesh(g, cap, 'top', meshes, h - 0.01);
    } else if (n.kind === 'worker') {
      const gap = 0.12, slabs = 3, sh = (h - gap * (slabs - 1)) / slabs;
      for (let i = 0; i < slabs; i++) {
        const geo = new RoundedBoxGeometry(1.55, sh, 1.55, 3, Math.min(0.12, sh / 3)); geo.translate(0, sh / 2, 0);
        addMesh(g, geo, i === slabs - 1 ? 'base' : 'base2', meshes, i * (sh + gap));
      }
    } else if (n.kind === 'queue') {
      const geo = new RoundedBoxGeometry(2.7, 0.42, 1.05, 3, 0.12); geo.translate(0, 0.21, 0);
      addMesh(g, geo, 'base', meshes);
      for (let i = 0; i < 4; i++) {
        const c = new RoundedBoxGeometry(0.4, 0.3, 0.66, 2, 0.06); c.translate(0, 0.15, 0);
        addMesh(g, c, 'msg', meshes, 0.42, -0.93 + i * 0.62);
      }
    } else if (n.kind === 'dependency') {
      for (let i = 0; i < 3; i++) {
        const c = new THREE.CylinderGeometry(0.84, 0.84, 0.32, 40); c.translate(0, 0.16, 0);
        addMesh(g, c, i === 2 ? 'base' : 'base2', meshes, i * 0.42);
      }
    } else if (n.kind === 'external') {
      const disc = new THREE.CylinderGeometry(1.0, 1.06, 0.14, 48); disc.translate(0, 0.07, 0);
      addMesh(g, disc, 'plate', meshes);
      const dome = new THREE.SphereGeometry(0.74, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      addMesh(g, dome, 'base', meshes, 0.14);
      const eq = new THREE.TorusGeometry(0.62, 0.028, 8, 48); eq.rotateX(Math.PI / 2);
      addMesh(g, eq, 'line', meshes, 0.14 + 0.4);
      const mer = new THREE.TorusGeometry(0.75, 0.026, 8, 40, Math.PI);
      addMesh(g, mer, 'line', meshes, 0.14);
    } else {
      const disc = new THREE.CylinderGeometry(1.0, 1.0, 0.1, 48); disc.translate(0, 0.05, 0);
      addMesh(g, disc, 'plate', meshes);
      [[-0.4, -0.15], [0.38, -0.25], [0.02, 0.38]].forEach(([x, z]) => {
        const body = new THREE.CylinderGeometry(0.12, 0.2, 0.42, 16); body.translate(0, 0.21, 0);
        addMesh(g, body, 'base', meshes, 0.1, x, z);
        const head = new THREE.SphereGeometry(0.13, 16, 12);
        addMesh(g, head, 'base', meshes, 0.66, x, z);
      });
    }
    return { group: g, meshes };
  }
  function makeRings(r) {
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.9 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.075, 64), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; ring.renderOrder = 1;
    const pulseMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
    // the pulse sits at roof level so a building at the back of the city still shows its state
    const pulse = new THREE.Mesh(new THREE.RingGeometry(r * 0.82, r * 0.82 + 0.14, 64), pulseMat);
    pulse.rotation.x = -Math.PI / 2; pulse.renderOrder = 3;
    return { ring, pulse };
  }

  function createRec(n) {
    const h = nodeHeight(n);
    const group = new THREE.Group();
    group.userData.pickId = n.id;
    const body = buildBody(n, h);
    group.add(body.group);
    const r = FOOT[n.kind] + 0.28;
    const rings = makeRings(r);
    group.add(rings.ring, rings.pulse);
    world.add(group);
    const rec = { n, group, body: body.group, meshes: body.meshes, h, ring: rings.ring, pulse: rings.pulse, ringR: r, foot: FOOT[n.kind], grow: 1, phase: Math.random(), label: null };
    rec.label = stage.addLabel(makeNodeLabel(rec));
    recs.set(n.id, rec);
    return rec;
  }
  function rebuildBody(rec) {
    const old = rec.body;
    const body = buildBody(rec.n, rec.h);
    rec.group.remove(old);
    disposeTree(old);
    rec.group.add(body.group);
    rec.body = body.group;
    rec.meshes = body.meshes;
  }
  function removeRec(rec) {
    world.remove(rec.group);
    disposeTree(rec.group);
    stage.removeLabel(rec.label);
    recs.delete(rec.n.id);
  }

  /* --- labels --- */
  function nodeName(n) { return n.label + (n.sublabel && n.sublabel.charAt(0) === '/' ? n.sublabel : ''); }
  function errTone(n) { return n.state === 'down' || n.state === 'error' ? 'danger' : (n.state === 'warn' || n.state === 'degraded') ? 'warn' : ''; }
  function fillNodeLabel(rec) {
    const n = rec.n;
    const a = rec.label ? rec.label.el : null;
    const tag = n.href ? 'a' : 'button';
    let node = a;
    if (!node || node.tagName.toLowerCase() !== tag) {
      node = document.createElement(tag);
      node.className = 'smap__label';
      if (tag === 'button') node.type = 'button';
      node.addEventListener('click', (e) => select(rec.n.id, e, node));
      node.addEventListener('mouseenter', () => labelHover(rec, true));
      node.addEventListener('mouseleave', () => labelHover(rec, false));
      node.addEventListener('focus', () => labelHover(rec, true));
      node.addEventListener('blur', () => labelHover(rec, false));
      if (a) a.replaceWith(node);
      if (rec.label) { rec.label.el = node; rec.label.w = 0; }
    }
    if (n.href) node.setAttribute('href', n.href); else node.removeAttribute('href');
    node.dataset.state = n.state;
    node.dataset.kind = n.kind;
    const nameEl = el('span', 'smap__label-name');
    const dot = el('i', 'smap__dot'); dot.setAttribute('aria-hidden', 'true');
    nameEl.append(dot, document.createTextNode(n.label));
    if (n.sublabel && n.sublabel.charAt(0) === '/') nameEl.appendChild(el('span', 'smap__label-role', n.sublabel));
    const meta = el('span', 'smap__label-meta');
    const bits = [];
    // healthy infrastructure (queues, databases, outside APIs) gets a name-only label; numbers are in the tooltip
    const quiet = n.state === 'ok' && !n.note && (n.kind === 'queue' || n.kind === 'dependency' || n.kind === 'external');
    if (!quiet && n.rpmKnown && (n.rpm > 0 || n.kind === 'service' || n.kind === 'worker')) bits.push(el('span', null, fmtRate(n.rpm) + ' ' + n.rateUnit));
    const errShown = n.errKnown && (n.errorRate > 0 || n.state === 'error');
    if (errShown) { const s = el('span', 'smap__label-err', 'error ' + fmtPct(n.errorRate)); const tone = errTone(n); if (tone) s.dataset.tone = tone; bits.push(s); }
    if (n.state === 'down' || n.state === 'degraded' || ((n.state === 'warn' || n.state === 'error') && !errShown)) { const s = el('span', 'smap__label-state', n.note && n.state !== 'down' ? n.note : STATE_TEXT[n.state]); s.dataset.tone = errTone(n); bits.push(s); }
    else if (n.note && n.state === 'ok') bits.push(el('span', 'smap__label-note', n.note));
    bits.forEach((b, i) => { if (i) meta.appendChild(document.createTextNode(' · ')); meta.appendChild(b); });
    node.replaceChildren(nameEl);
    if (bits.length) node.appendChild(meta);
    const aria = [nodeName(n), KIND_TEXT[n.kind], STATE_TEXT[n.state]];
    if (n.rpmKnown && n.rpm > 0) aria.push(fmtRate(n.rpm) + ' ' + n.rateUnit);
    if (n.errKnown && n.errorRate > 0) aria.push('error ' + fmtPct(n.errorRate));
    if (n.p95Ms != null) aria.push('p95 ' + fmtMs(n.p95Ms));
    if (n.note) aria.push(n.note);
    node.setAttribute('aria-label', aria.join(' · '));
    return node;
  }
  function makeNodeLabel(rec) {
    const node = fillNodeLabel(rec);
    const pr = (STATE_RANK[rec.n.state] || 0) * 10 + ({ service: 6, worker: 5, queue: 4, client: 3, dependency: 3, external: 3 }[rec.n.kind] || 0) + Math.log10(1 + rec.n.rpm) * 0.3;
    return {
      el: node, priority: pr, align: 'above', world: new THREE.Vector3(),
      getWorld: (v) => v.set(rec.group.position.x, rec.h * rec.grow + 0.3, rec.group.position.z),
      getBase: (v) => v.set(rec.group.position.x, 0, rec.group.position.z),
    };
  }
  function labelHover(rec, on) {
    rec.label.pinned = on;
    if (on) {
      const b = rec.label.el.getBoundingClientRect();
      stage.setHover(rec.n.id, b.right, b.top);
    } else if (stage.hoverId === rec.n.id) stage.setHover(null);
    stage.requestRender();
  }

  /* --- tooltip --- */
  function nodeTip(id) {
    const rec = recs.get(id);
    if (!rec) return null;
    const n = rec.n;
    const rows = [];
    rows.push({ value: STATE_TEXT[n.state], name: KIND_TEXT[n.kind], tone: errTone(n) });
    if (n.rpmKnown && (n.rpm > 0 || n.kind === 'service' || n.kind === 'worker')) rows.push({ value: fmtRate(n.rpm), name: n.rateUnit });
    if (n.errKnown) rows.push({ value: fmtPct(n.errorRate), name: 'error', tone: n.errorRate > 0 ? (errTone(n) || 'warn') : '' });
    if (n.p95Ms != null) rows.push({ value: fmtMs(n.p95Ms), name: 'p95' });
    if (n.note) rows.push({ value: n.note, name: '' });
    const outs = model.edges.filter((e) => e.from === n.id).sort((a, b) => (b.rpm || 0) - (a.rpm || 0)).slice(0, 4);
    for (const e of outs) {
      const t = model.byId.get(e.to);
      const rate = e.rpm == null ? '' : fmtRate(e.rpm) + '/min';
      const err = e.errorRate > 0 ? fmtPct(e.errorRate) : '';
      rows.push({ value: '→ ' + nodeName(t), name: [rate, err].filter(Boolean).join(' · '), tone: e.errorRate >= 0.01 || t.state === 'down' ? 'danger' : '' });
    }
    const clickable = n.href || opts.onSelect;
    const sub = n.sublabel && n.sublabel.charAt(0) !== '/' ? n.sublabel : '';
    return tipNode(nodeName(n), sub, rows, clickable ? 'คลิกเพื่อเปิดรายละเอียด' : '');
  }

  /* --- select / hover --- */
  function select(id, e, labelEl) {
    const rec = recs.get(id);
    if (!rec) return;
    const n = rec.n;
    let prevented = false;
    if (opts.onSelect) prevented = opts.onSelect(n.raw, e) === false || (e && e.defaultPrevented);
    stage.root.dispatchEvent(new CustomEvent('smap:select', { bubbles: true, detail: { node: n.raw } }));
    if (labelEl) { if (prevented && e) e.preventDefault(); return; }   // a label link navigates by itself
    if (!prevented && n.href) window.location.assign(n.href);
  }
  let hovered = null;
  function hover(id) {
    hovered = id;
    paintAll();
    if (opts.onHover) { const r = id != null ? recs.get(id) : null; opts.onHover(r ? r.n.raw : null); }
  }

  /* --- paint (theme + state) --- */
  function baseColor(n, t) {
    if (n.kind === 'service' || n.kind === 'worker') return col(n.slot ? t['--svc-' + n.slot] : t['--muted']);
    if (n.kind === 'queue') return col(t.highlight);
    if (n.kind === 'dependency') return mix(t['--line-strong'], t['--muted'], t.dark ? 0.55 : 0.45);
    if (n.kind === 'external') return mix(t['--line-strong'], t['--muted'], t.dark ? 0.35 : 0.2);
    return col(t['--ink-2']);
  }
  function paintRec(rec) {
    const t = stage.theme;
    const n = rec.n;
    const down = n.state === 'down';
    let base = baseColor(n, t);
    if (down) base = mix(base, t['--surface'], 0.55);
    const hov = hovered === n.id;
    const dim = hovered != null && !hov && !isNeighbour(hovered, n.id);
    if (rec.label) rec.label.el.classList.toggle('is-dim', dim);
    for (const m of rec.meshes) {
      const role = m.userData.role;
      let c = base.clone();
      if (role === 'top') c = mix(base, '#ffffff', t.dark ? 0.22 : 0.3);
      else if (role === 'base2') c = mix(base, t['--ink'], 0.08);
      else if (role === 'msg') c = mix(base, t['--surface'], 0.42);
      else if (role === 'plate') c = mix(t['--line-strong'], t['--surface'], t.dark ? 0.1 : 0.25);
      else if (role === 'line') c = mix(base, t['--ink'], 0.35);
      m.material.color.copy(c);
      m.material.emissive.copy(c).multiplyScalar(hov ? 0.22 : (t.dark ? 0.08 : 0));
      const op = down ? 0.55 : dim ? 0.5 : 1;
      if (m.material.transparent !== op < 1) { m.material.transparent = op < 1; m.material.depthWrite = op >= 1; m.material.needsUpdate = true; }
      m.material.opacity = op;
      m.castShadow = !down;
    }
    const tone = n.state === 'down' || n.state === 'error' ? t['--danger-solid'] : (n.state === 'warn' || n.state === 'degraded') ? t['--warn-solid'] : null;
    rec.ring.visible = !!tone;
    rec.pulse.visible = !!tone;
    rec.pulse.position.y = rec.h * rec.grow + 0.05;
    if (tone) { rec.ring.material.color.set(tone); rec.pulse.material.color.set(tone); }
    rec.ring.material.opacity = stage.animating ? 0.75 : 0.95;
    if (!stage.animating) { rec.pulse.scale.setScalar(1.12); rec.pulse.material.opacity = 0.6; }   // still frame: a steady halo
  }
  function isNeighbour(a, b) { return model.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a)); }
  function paintEdges() {
    const t = stage.theme;
    for (const er of edgeRecs) {
      const target = recs.get(er.e.to), source = recs.get(er.e.from);
      const bad = (target && target.n.state === 'down') || er.e.errorRate >= 0.05;
      const u = er.mesh.material.uniforms;
      u.uColor.value.set(bad ? t['--danger-solid'] : mix(t['--muted'], t['--line-strong'], t.dark ? 0.2 : 0.35));
      let op = bad ? 0.75 : (t.dark ? 0.7 : 0.6);
      if (source && source.n.state === 'down') op *= 0.4;
      if (hovered != null) op *= (er.e.from === hovered || er.e.to === hovered) ? 1.25 : 0.28;
      u.uOpacity.value = Math.min(1, op);
      u.uDash.value = stage.animating ? 0 : 1;
      er.color = source ? particleColor(source.n, t) : col(t['--muted']);
      if (er.label) er.label.el.classList.toggle('is-dim', hovered != null && er.e.from !== hovered && er.e.to !== hovered);
    }
    badColor.set(t['--danger-solid']);
  }
  function particleColor(n, t) {
    if (n.kind === 'service' || n.kind === 'worker') return mix(baseColor(n, t), t.dark ? '#ffffff' : t['--ink'], t.dark ? 0.15 : 0.12);
    if (n.kind === 'queue') return mix(t.highlight, t['--ink'], t.dark ? 0 : 0.12);
    return mix(t['--ink-2'], t['--surface'], t.dark ? 0.1 : 0);
  }
  function paintAll() {
    recs.forEach(paintRec);
    paintEdges();
    stage.requestRender();
  }

  /* --- edges --- */
  function buildEdges() {
    for (const er of edgeRecs) {
      edgeGroup.remove(er.mesh);
      er.mesh.geometry.dispose();
      er.mesh.material.dispose();
      if (er.label) stage.removeLabel(er.label);
    }
    const old = new Map(edgeRecs.map((er) => [er.e.key, er]));
    edgeRecs = [];
    const keys = new Set(model.edges.map((e) => e.key));
    for (const e of model.edges) {
      const a = recs.get(e.from), b = recs.get(e.to);
      const pa = a.group.position, pb = b.group.position;
      const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz) || 1;
      const ux = dx / d, uz = dz / d;
      const off = keys.has(e.to + '→' + e.from) ? 0.38 : 0;
      const s = new THREE.Vector3(pa.x + ux * a.foot * 0.9, 0.22, pa.z + uz * a.foot * 0.9);
      const t = new THREE.Vector3(pb.x - ux * (b.foot * 0.9 + 0.1), 0.22, pb.z - uz * (b.foot * 0.9 + 0.1));
      const len = s.distanceTo(t);
      const lift = 0.45 + len * 0.16;
      const c1 = s.clone().lerp(t, 0.28); c1.y += lift; c1.x += -uz * off; c1.z += ux * off;
      const c2 = s.clone().lerp(t, 0.72); c2.y += lift; c2.x += -uz * off; c2.z += ux * off;
      const curve = new THREE.CubicBezierCurve3(s, c1, c2, t);
      const radius = 0.016 + 0.007 * Math.log10(1 + (e.rpm || 0));
      const mat = lineMaterial();
      const length = curve.getLength();
      mat.uniforms.uDashCount.value = Math.max(4, Math.round(length / 0.42));
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 56, radius, 6, false), mat);
      mesh.renderOrder = 2;
      edgeGroup.add(mesh);
      const pts = curve.getSpacedPoints(72);
      const prev = old.get(e.key);
      const er = { e, mesh, pts, length, acc: prev ? prev.acc : Math.random(), bacc: prev ? prev.bacc : Math.random() * 0.5, color: new THREE.Color(), label: null };
      if (e.label) {
        const lab = el('span', 'smap__elabel', e.label);
        lab.setAttribute('aria-hidden', 'true');
        const mid = curve.getPointAt(0.5);
        er.label = stage.addLabel({ el: lab, priority: -5, align: 'center', world: mid.clone().setY(mid.y + 0.12) });
      }
      edgeRecs.push(er);
    }
    const byKey = new Map(edgeRecs.map((er) => [er.e.key, er]));
    particles = particles.filter((p) => { const er = byKey.get(p.er.e.key); if (!er) return false; p.er = er; return true; });
  }

  /* --- particles: rate ∝ calls/min^0.42 (capped); failures on their own compressed scale so a 0.16 % share stays visible --- */
  const okRate = (rpm) => (rpm > 0 ? clamp(0.16 * Math.pow(rpm, 0.42), 0.08, 5) : 0);
  const badRate = (fails) => (fails > 0 ? clamp(0.25 * Math.pow(fails, 0.35), 0.12, 2.5) : 0);
  function spawn(er, bad) {
    if (particles.length >= MAXP) return;
    const p = { er, s: 0, bad, speed: 2.5 + Math.random() * 0.5, size: bad ? 0.105 : 0.07 };
    particles.push(p);
  }
  function stepParticles(dt) {
    for (const er of edgeRecs) {
      const from = recs.get(er.e.from), to = recs.get(er.e.to);
      if (!from || from.n.state === 'down') continue;
      const failShare = to && to.n.state === 'down' ? 1 : er.e.errorRate;
      if (er.e.rpm == null) {   // rate unknown: a slow trickle that still turns red when the target is down
        er.acc += (failShare >= 1 ? 0 : 0.22) * dt;
        er.bacc += (failShare > 0 ? 0.5 * failShare : 0) * dt;
      } else {
        er.acc += okRate(er.e.rpm * (1 - failShare)) * dt;
        er.bacc += badRate(er.e.rpm * failShare) * dt;
      }
      while (er.acc >= 1) { er.acc -= 1; spawn(er, false); }
      while (er.bacc >= 1) { er.bacc -= 1; spawn(er, true); }
    }
    let w = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.s += p.speed * dt;
      if (p.s >= p.er.length) continue;
      particles[w++] = p;
    }
    particles.length = w;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const f = p.s / p.er.length;
      const k = f * (p.er.pts.length - 1);
      const i0 = Math.floor(k), i1 = Math.min(p.er.pts.length - 1, i0 + 1);
      dummy.position.lerpVectors(p.er.pts[i0], p.er.pts[i1], k - i0);
      let sc = p.size * Math.min(1, f * 12);
      if (p.bad && f > 0.82) sc *= 1 + (f - 0.82) * 4;        // a failing call swells as it hits the target
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      particlesMesh.setMatrixAt(i, dummy.matrix);
      particlesMesh.setColorAt(i, p.bad ? badColor : p.er.color);
    }
    particlesMesh.count = particles.length;
    particlesMesh.instanceMatrix.needsUpdate = true;
    if (particlesMesh.instanceColor) particlesMesh.instanceColor.needsUpdate = true;
  }

  /* --- build / update --- */
  function apply(first) {
    const layout = layoutMap(model);
    const ids = new Set(model.nodes.map((n) => n.id));
    recs.forEach((rec, id) => { if (!ids.has(id) || rec.n.kind !== model.byId.get(id).kind) removeRec(rec); });
    let maxH = 0;
    const center = new THREE.Vector3();
    for (const n of model.nodes) {
      let rec = recs.get(n.id);
      const h = nodeHeight(n);
      if (!rec) rec = createRec(n);
      else {
        const oldH = rec.h * rec.grow;
        rec.n = n;
        if (Math.abs(h - rec.h) > 0.02) {
          rec.h = h;
          rebuildBody(rec);
          if (stage.animating && !first) { rec.grow = oldH / h; rec.body.scale.y = rec.grow; rec.growFrom = rec.grow; rec.growT = 0; stage.busy(1); rec.growing = true; }
        }
        fillNodeLabel(rec);
        rec.label.priority = (STATE_RANK[n.state] || 0) * 10 + ({ service: 6, worker: 5, queue: 4 }[n.kind] || 3) + Math.log10(1 + n.rpm) * 0.3;
        stage.remeasure(rec.label);
      }
      const p = layout.pos.get(n.id);
      rec.group.position.set(p.x, 0, p.z);
      rec.body.rotation.y = layout.angle.has(n.id) ? layout.angle.get(n.id) : 0;
      center.x += p.x; center.z += p.z;
      maxH = Math.max(maxH, h);
    }
    const count = Math.max(1, model.nodes.length);
    center.multiplyScalar(1 / count);
    let radius = 2;
    const points = [];
    recs.forEach((rec) => {
      const gp = rec.group.position;
      radius = Math.max(radius, Math.hypot(gp.x - center.x, gp.z - center.z) + rec.foot + 0.4);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2, x = gp.x + Math.cos(a) * rec.foot, z = gp.z + Math.sin(a) * rec.foot;
        points.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, rec.h, z));
      }
    });
    buildEdges();
    stage.setPickables(Array.from(recs.values()).map((r) => r.group));
    const idsKey = model.nodes.map((n) => n.id).sort().join('|');
    stage.setBounds({ center, radius, height: maxH, points, keepView: !first && idsKey === lastIds });   // new shape → refit
    lastIds = idsKey;
    stage.setSummary(opts.ariaLabel ? opts.ariaLabel + ' · ' + summariseMap(model) : summariseMap(model));
    paintAll();
    stage.shadowsChanged();
  }

  stage.onTick((dt, t, animate) => {
    recs.forEach((rec) => {
      if (rec.growing) {
        rec.growT = Math.min(1, rec.growT + dt / 0.7);
        rec.grow = rec.growFrom + (1 - rec.growFrom) * ease(rec.growT);
        rec.body.scale.y = rec.grow;
        stage.shadowsChanged();
        if (rec.growT >= 1) { rec.growing = false; rec.grow = 1; stage.busy(-1); }
      }
      rec.pulse.position.y = rec.h * rec.grow + 0.05;
      if (animate && rec.pulse.visible) {
        const n = rec.n;
        const period = n.state === 'down' || n.state === 'error' ? 1.7 : 2.8;
        const f = ((t / period) + rec.phase) % 1;
        rec.pulse.scale.setScalar(1 + f * (n.state === 'warn' || n.state === 'degraded' ? 0.32 : 0.55));
        rec.pulse.material.opacity = Math.pow(1 - f, 2) * 0.7;
      }
    });
    if (animate) stepParticles(dt);
  });
  stage.onMotion((on) => {
    if (!on) { particles = []; particlesMesh.count = 0; }
    particlesMesh.visible = on;
    paintAll();
  });
  stage.onTheme(() => paintAll());

  // a tall box (phone) turns the view so the tiers run top → bottom instead of left → right
  let narrow = null;
  function orient(aspect, reset) {
    const nv = aspect < 0.9;
    if (nv === narrow) return;
    narrow = nv;
    stage.setView(nv ? { azimuth: Math.PI / 2 - 0.22, polar: 0.8, sway: 0.14 } : { azimuth: 0.3, polar: 0.9, sway: 0.3 });
    if (reset) stage.resetView();
  }
  stage.onResize((w, h, aspect) => orient(aspect, true));
  orient(stage.size.w / Math.max(1, stage.size.h), false);

  apply(true);
  particlesMesh.visible = stage.animating;

  return {
    element: stage.root,
    update(next) { model = normaliseMap(next, opts); apply(false); },
    // the page points at a node (e.g. a hovered table row): same highlight as hovering it, label kept visible; null clears
    highlight(id) {
      const k = id != null && recs.has(id) ? id : null;
      if (k === hovered) return;
      if (hovered != null && recs.has(hovered)) recs.get(hovered).label.pinned = false;
      if (k != null) recs.get(k).label.pinned = true;
      hover(k);
    },
    setCompactLabels(on) { stage.root.classList.toggle('smap--names', !!on); stage.remeasure(); },
    resetView: () => stage.resetView(),
    setPaused: (p) => stage.setPaused(p),
    stats: () => ({ frames: stage.frames, running: stage.running, particles: particles.length, animating: stage.animating, dark: stage.theme.dark, webgl: true }),
    destroy() {
      particles = [];
      stage.destroy();
      recs.clear();
      edgeRecs = [];
    },
  };
}

/** No WebGL: a readable message and the same information as a plain list (never a blank box). */
function mountMapFallback(container, model, opts) {
  const root = el('div', 'smap smap--fallback');
  clearPlaceholder(container);
  container.appendChild(root);
  function render() {
    root.replaceChildren();
    root.appendChild(el('p', 'smap__fallback-msg', 'เบราว์เซอร์นี้แสดงภาพ 3 มิติไม่ได้ (ไม่มี WebGL) จึงแสดงเป็นรายการแทน'));
    const summary = el('p', 'smap__fallback-sum', summariseMap(model));
    root.appendChild(summary);
    const groups = [['service', 'worker'], ['queue'], ['dependency', 'external'], ['client']];
    const titles = ['Service และ worker', 'Queue', 'ระบบที่เรียกใช้', 'ผู้ใช้'];
    groups.forEach((kinds, gi) => {
      const items = model.nodes.filter((n) => kinds.includes(n.kind));
      if (!items.length) return;
      const sec = el('section', 'smap__fgroup');
      sec.appendChild(el('h3', 'smap__fgroup-title', titles[gi]));
      const ul = el('ul', 'smap__flist');
      items.forEach((n) => {
        const li = el('li', 'smap__fitem');
        li.dataset.state = n.state;
        const name = el(n.href ? 'a' : 'span', 'smap__fitem-name');
        if (n.href) name.href = n.href;
        const dot = el('i', 'smap__dot'); dot.setAttribute('aria-hidden', 'true');
        name.append(dot, document.createTextNode(n.label + (n.sublabel && n.sublabel.charAt(0) === '/' ? n.sublabel : '')));
        if (n.href && opts.onSelect) name.addEventListener('click', (e) => { if (opts.onSelect(n.raw, e) === false) e.preventDefault(); });
        const meta = [STATE_TEXT[n.state]];
        if (n.rpmKnown && n.rpm > 0) meta.push(fmtRate(n.rpm) + ' ' + n.rateUnit);
        if (n.errKnown && n.errorRate > 0) meta.push('error ' + fmtPct(n.errorRate));
        if (n.p95Ms != null) meta.push('p95 ' + fmtMs(n.p95Ms));
        if (n.note) meta.push(n.note);
        li.append(name, el('span', 'smap__fitem-meta', meta.join(' · ')));
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      root.appendChild(sec);
    });
    if (model.edges.length) {
      const d = el('details', 'smap__fedges');
      d.appendChild(el('summary', null, 'การเรียกระหว่างระบบ (' + model.edges.length + ')'));
      const ul = el('ul', 'smap__flist');
      model.edges.forEach((e) => {
        const a = model.byId.get(e.from), b = model.byId.get(e.to);
        const nm = (n) => n.label + (n.sublabel && n.sublabel.charAt(0) === '/' ? n.sublabel : '');
        ul.appendChild(el('li', 'smap__fitem', nm(a) + ' → ' + nm(b) + (e.rpm == null ? '' : ' · ' + fmtRate(e.rpm) + '/min') + (e.errorRate > 0 ? ' · error ' + fmtPct(e.errorRate) : '') + (e.label ? ' · ' + e.label : '')));
      });
      d.appendChild(ul);
      root.appendChild(d);
    }
  }
  render();
  return {
    element: root,
    update(next) { model = normaliseMap(next, opts); render(); },
    highlight() {}, setCompactLabels() {}, resetView() {}, setPaused() {},
    stats: () => ({ frames: 0, running: false, particles: 0, animating: false, webgl: false }),
    destroy() { root.remove(); },
  };
}

/* ---------- 7. Pipeline: how telemetry travels ---------- */

const TRANSPORTS = {
  kafka: { label: 'Kafka', sub: 'topic skilllane-monitoring.logs · skilllane-monitoring.spans', tip: 'topic skilllane-monitoring.logs และ skilllane-monitoring.spans · 3 partition · key = service/role · GZIP' },
  rabbitmq: { label: 'RabbitMQ', sub: 'exchange skilllane-monitoring.telemetry', tip: 'direct exchange skilllane-monitoring.telemetry → queue skilllane-monitoring.logs และ skilllane-monitoring.spans · persistent · confirm channel' },
  bullmq: { label: 'BullMQ', sub: 'Redis ของลูกค้า · prefix bull', tip: 'queue skilllane-monitoring.logs และ skilllane-monitoring.spans บน Redis ของลูกค้า (prefix bull) · attempts 5 · backoff 1 s' },
};
const PIPE_U = { app: 0, queue: 4.7, engine: 9.2, clickhouse: 13.1, out: 17.0 };
const PIPE_MID = 8.5;

function pipelineLegend() {
  const ul = el('ul', 'smap__legend-list');
  const item = (cls, text) => { const li = el('li', 'smap__legend-item'); const k = el('i', 'smap__key ' + cls); k.setAttribute('aria-hidden', 'true'); li.append(k, el('span', null, text)); ul.appendChild(li); };
  item('smap__key--log', 'log (skilllane-monitoring.logs)');
  item('smap__key--span', 'span (skilllane-monitoring.spans)');
  item('smap__key--err', 'log ระดับ ERR');
  item('smap__key--query', 'การอ่านข้อมูล (query)');
  return ul;
}

/**
 * mountPipeline(container, options) → { setTransport(t), destroy(), resetView(), setPaused(bool), element, stats() }
 * options = { transport: 'kafka'|'rabbitmq'|'bullmq', switcher: true, onTransportChange(t), onSelect(station, event),
 *             links: { app?, queue?, engine?, clickhouse?, monitor?, ai? } (hrefs), here: 'monitor',
 *             motion, autoRotate, controls, legend, legendOpen, fps, ariaLabel, forceFallback }
 * station = { id: 'app'|'queue'|'engine'|'clickhouse'|'monitor'|'ai', label, sub }
 */
export function mountPipeline(container, options) {
  const opts = Object.assign({ transport: 'kafka', switcher: true, motion: 'auto', autoRotate: true, controls: true, legend: true, fps: 30, links: {}, here: 'monitor' }, options || {});
  opts.links = Object.fromEntries(Object.entries(opts.links || {}).map(([k, v]) => [k, safeHref(v)]).filter(([, v]) => v));
  let transport = TRANSPORTS[opts.transport] ? opts.transport : 'kafka';
  let vertical = false;

  const stations = () => [
    { id: 'app', label: 'NestJS app', sub: 'skilllane-monitoring', tip: 'แอปติดตั้ง skilllane-monitoring: เขียน log และ span เป็น batch แล้วส่งเข้า queue ไม่บล็อกแอป' },
    { id: 'queue', label: TRANSPORTS[transport].label, sub: TRANSPORTS[transport].sub, tip: TRANSPORTS[transport].tip },
    { id: 'engine', label: 'skilllane-monitoring engine', sub: 'ingest + query API', tip: 'อ่านจาก queue แปลงเป็นแถว เขียน ClickHouse เป็น batch และเปิด query API ให้หน้าจอ' },
    { id: 'clickhouse', label: 'ClickHouse', sub: 'db skilllane_monitoring · logs, spans', tip: 'เก็บ log และ span แบบ columnar ค้นตามช่วงเวลา, trace id, user id ได้เร็ว' },
    { id: 'monitor', label: 'skilllane monitor', sub: opts.here === 'monitor' ? 'หน้าจอชุดนี้' : 'หน้าจอ', tip: 'อ่านผ่าน query API ของ engine: ภาพรวม, Log, Trace, Error, งานเบื้องหลัง' },
    { id: 'ai', label: 'AI', sub: 'SQL อ่านอย่างเดียว', tip: 'AI อ่าน ClickHouse ด้วย user skilllane_monitoring_reader (อ่านอย่างเดียว) ผ่าน MCP หรือ SQL' },
  ];
  const summary = () => (opts.ariaLabel ? opts.ariaLabel + ' · ' : '') + 'ภาพ 3 มิติเส้นทางข้อมูล: NestJS app + skilllane-monitoring → ' + TRANSPORTS[transport].label + ' → skilllane-monitoring engine → ClickHouse → skilllane monitor และ AI';

  let seg = null;
  if (opts.switcher !== false) {
    seg = el('div', 'smap__seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'เลือก queue ที่ใช้ส่งข้อมูล');
    for (const key of Object.keys(TRANSPORTS)) {
      const b = el('button', 'smap__seg-btn', TRANSPORTS[key].label);
      b.type = 'button';
      b.dataset.transport = key;
      b.setAttribute('aria-pressed', String(key === transport));
      b.addEventListener('click', () => { setTransport(key); if (opts.onTransportChange) opts.onTransportChange(key); });
      seg.appendChild(b);
    }
  }

  const stage = createStage(container, {
    kind: 'pipeline', options: opts,
    view: { azimuth: 0.36, polar: 1.0, sway: 0.16, swayPeriod: 22, minAzimuth: -0.7, maxAzimuth: 1.4, targetY: 0.25, margins: { l: 60, r: 90, t: 70, b: 30 }, marginsCompact: { l: 12, r: 130, t: 56, b: 56 } },
    legend: opts.legend ? pipelineLegend() : null,
    top: seg,
    tipFor: (id) => stationTip(id),
    onHover: (id) => { hovered = id; paint(); },
    onSelect: (id, e) => selectStation(id, e, null),
    isClickable: (id) => !!(opts.links[id] || opts.onSelect),
  });
  if (!stage) return mountPipelineFallback(container, opts, stations, () => transport, (t) => { transport = t; });

  const { scene } = stage;
  const pipe = new THREE.Group();          // local: u along the path (x), v across (z)
  scene.add(pipe);
  const st = new Map();                    // id → { group, meshes, top }
  let hovered = null;
  let queueGroup = null;
  let pathRecs = [];
  let barBump = [0, 0, 0, 0, 0];
  let bars = [];
  let ai = null;

  function addMesh(group, geo, role, list, x, y, z) {
    const m = new THREE.Mesh(geo, bodyMaterial());
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.role = role;
    group.add(m); list.push(m);
    return m;
  }
  function station(id, u, v, top) {
    const g = new THREE.Group();
    g.position.set(u - PIPE_MID, 0, v);
    g.userData.pickId = id;
    pipe.add(g);
    const rec = { id, group: g, meshes: [], top, label: null };
    st.set(id, rec);
    return rec;
  }
  // app: a block in the first service hue with the package plate on top
  {
    const r = station('app', PIPE_U.app, 0, 1.75);
    const b = new RoundedBoxGeometry(1.9, 1.4, 1.7, 4, 0.14); b.translate(0, 0.7, 0);
    addMesh(r.group, b, 'app', r.meshes);
    const p = new RoundedBoxGeometry(1.0, 0.26, 0.9, 2, 0.06); p.translate(0, 0.13, 0);
    addMesh(r.group, p, 'pkg', r.meshes, 0, 1.4, 0);
  }
  // engine: neutral block with an accent band (the part we run)
  {
    const r = station('engine', PIPE_U.engine, 0, 1.55);
    const b = new RoundedBoxGeometry(1.7, 1.2, 1.7, 4, 0.14); b.translate(0, 0.6, 0);
    addMesh(r.group, b, 'engine', r.meshes);
    const band = new RoundedBoxGeometry(1.74, 0.12, 1.74, 2, 0.05);
    addMesh(r.group, band, 'band', r.meshes, 0, 0.86, 0);
  }
  // ClickHouse: a row of columns (columnar storage); a column bumps when a batch lands
  {
    const r = station('clickhouse', PIPE_U.clickhouse, 0, 2.2);
    const hs = [1.05, 1.6, 1.25, 1.85, 1.4];
    bars = hs.map((hh, i) => {
      const geo = new RoundedBoxGeometry(0.3, hh, 1.1, 2, 0.05); geo.translate(0, hh / 2, 0);
      return addMesh(r.group, geo, 'col', r.meshes, -0.76 + i * 0.38, 0, 0);
    });
    const base = new RoundedBoxGeometry(2.1, 0.1, 1.4, 2, 0.04); base.translate(0, 0.05, 0);
    addMesh(r.group, base, 'plate', r.meshes);
  }
  // skilllane monitor: a screen with a tiny chart
  {
    const r = station('monitor', PIPE_U.out, -1.9, 1.75);
    const stand = new THREE.CylinderGeometry(0.06, 0.06, 0.4, 12); stand.translate(0, 0.2, 0);
    addMesh(r.group, stand, 'frame', r.meshes);
    const foot = new THREE.CylinderGeometry(0.42, 0.46, 0.06, 32); foot.translate(0, 0.03, 0);
    addMesh(r.group, foot, 'frame', r.meshes);
    const scr = new RoundedBoxGeometry(1.9, 1.15, 0.1, 2, 0.05);
    const screen = addMesh(r.group, scr, 'frame', r.meshes, 0, 0.98, 0);
    screen.rotation.y = -0.5;
    const face = new THREE.PlaneGeometry(1.72, 0.98);
    const f = addMesh(r.group, face, 'face', r.meshes, 0, 0, 0.052);
    f.castShadow = false;
    screen.add(f); f.position.set(0, 0, 0.052);
    [0.32, 0.55, 0.42, 0.7].forEach((hh, i) => {
      const bar = addMesh(r.group, new THREE.PlaneGeometry(0.22, hh), i === 2 ? 'chartHi' : 'chart', r.meshes);
      bar.castShadow = false;
      screen.add(bar); bar.position.set(-0.5 + i * 0.33, -0.4 + hh / 2, 0.056);
    });
  }
  // AI: a faceted gem above a small disc
  {
    const r = station('ai', PIPE_U.out, 1.9, 1.75);
    const disc = new THREE.CylinderGeometry(0.62, 0.66, 0.1, 40); disc.translate(0, 0.05, 0);
    addMesh(r.group, disc, 'plate', r.meshes);
    const gem = addMesh(r.group, new THREE.IcosahedronGeometry(0.5, 0), 'ai', r.meshes, 0, 0.88, 0);
    gem.material.flatShading = true;
    gem.castShadow = false;   // it turns; the disc below grounds it
    ai = gem;
  }

  // queue station, rebuilt on setTransport
  const queueRec = station('queue', PIPE_U.queue, 0, 1.15);
  function buildQueue() {
    if (queueGroup) { queueRec.group.remove(queueGroup); disposeTree(queueGroup); }
    queueGroup = new THREE.Group();
    queueRec.group.add(queueGroup);
    queueRec.meshes = [];
    const list = queueRec.meshes;
    if (transport === 'kafka') {
      for (const lane of [-0.45, 0.45]) {
        const slab = new RoundedBoxGeometry(3.1, 0.3, 0.66, 3, 0.08); slab.translate(0, 0.15, 0);
        addMesh(queueGroup, slab, 'q', list, 0, 0, lane);
        for (let p = 0; p < 3; p++) addMesh(queueGroup, new THREE.BoxGeometry(2.9, 0.03, 0.1), 'qline', list, 0, 0.31, lane + (p - 1) * 0.19);
      }
    } else if (transport === 'rabbitmq') {
      const ex = addMesh(queueGroup, new THREE.OctahedronGeometry(0.42, 0), 'q', list, -1.75, 0.5, 0);
      ex.material.flatShading = true;
      for (const lane of [-0.45, 0.45]) {
        const qb = new RoundedBoxGeometry(2.3, 0.34, 0.56, 3, 0.1); qb.translate(0, 0.17, 0);
        addMesh(queueGroup, qb, 'q', list, 0.42, 0, lane);
      }
    } else {
      const base = new RoundedBoxGeometry(3.2, 0.2, 1.6, 3, 0.08); base.translate(0, 0.1, 0);
      addMesh(queueGroup, base, 'redis', list);
      for (const lane of [-0.42, 0.42]) {
        for (let i = 0; i < 5; i++) {
          const c = new RoundedBoxGeometry(0.42, 0.3, 0.5, 2, 0.06); c.translate(0, 0.15, 0);
          addMesh(queueGroup, c, 'q', list, -1.1 + i * 0.55, 0.2, lane);
        }
      }
    }
    if (stage.animating) { queueGroup.scale.set(0.7, 0.7, 0.7); queueGroup.userData.pop = 0; stage.busy(1); }
    stage.shadowsChanged();
  }

  /* --- paths (local coords) --- */
  function lanePoints(stream) {
    const lane = stream === 'spans' ? 0.45 : -0.45;
    const q = PIPE_U.queue - PIPE_MID, e = PIPE_U.engine - PIPE_MID, a = PIPE_U.app - PIPE_MID, c = PIPE_U.clickhouse - PIPE_MID;
    const y = transport === 'bullmq' ? 0.66 : 0.5;
    const pts = [new THREE.Vector3(a + 0.6, 0.85, lane * 0.4), new THREE.Vector3(a + 1.25, 0.6, lane * 0.6)];
    if (transport === 'rabbitmq') {
      pts.push(new THREE.Vector3(q - 2.25, 0.55, 0), new THREE.Vector3(q - 1.75, 0.5, 0), new THREE.Vector3(q - 0.9, y, lane), new THREE.Vector3(q + 1.5, y, lane));
    } else {
      pts.push(new THREE.Vector3(q - 1.7, y, lane), new THREE.Vector3(q + 1.6, y, lane));
    }
    pts.push(new THREE.Vector3(e - 1.15, 0.55, lane * 0.4), new THREE.Vector3(e, 0.6, 0), new THREE.Vector3(e + 1.15, 0.6, 0), new THREE.Vector3(c - 1.2, 0.7, 0), new THREE.Vector3(c - 0.2, 0.75, 0));
    return pts;
  }
  function readPoints(to) {
    const c = PIPE_U.clickhouse - PIPE_MID, o = PIPE_U.out - PIPE_MID;
    const v = to === 'monitor' ? -1.9 : 1.9;
    return [new THREE.Vector3(c + 0.5, 0.9, 0), new THREE.Vector3(c + 1.7, 1.3, v * 0.45), new THREE.Vector3(o - 1.0, 1.0, v * 0.92), new THREE.Vector3(o - 0.3, 0.95, v)];
  }
  function buildPaths() {
    for (const pr of pathRecs) { pipe.remove(pr.mesh); pr.mesh.geometry.dispose(); pr.mesh.material.dispose(); }
    pathRecs = [];
    const add = (id, pts, radius) => {
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      const length = curve.getLength();
      const mat = lineMaterial();
      mat.uniforms.uDashCount.value = Math.max(6, Math.round(length / 0.4));
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius, 6, false), mat);
      mesh.renderOrder = 2;
      pipe.add(mesh);
      const samples = curve.getSpacedPoints(200);
      pathRecs.push({ id, curve, length, samples, mesh });
    };
    add('logs', lanePoints('logs'), 0.03);
    add('spans', lanePoints('spans'), 0.03);
    add('monitor', readPoints('monitor'), 0.022);
    add('ai', readPoints('ai'), 0.022);
  }
  const pathBy = (id) => pathRecs.find((p) => p.id === id);

  /* --- envelopes (instanced) --- */
  const MAXE = 160;
  const envGeo = new RoundedBoxGeometry(0.46, 0.08, 0.32, 2, 0.03);
  const envMesh = new THREE.InstancedMesh(envGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0 }), MAXE);
  envMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  envMesh.frustumCulled = false;
  envMesh.count = 0;
  for (let i = 0; i < MAXE; i++) envMesh.setColorAt(i, new THREE.Color(1, 1, 1));
  pipe.add(envMesh);
  const qGeo = new THREE.SphereGeometry(0.075, 12, 8);
  const qMesh = new THREE.InstancedMesh(qGeo, new THREE.MeshBasicMaterial(), 60);
  qMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  qMesh.frustumCulled = false;
  qMesh.count = 0;
  for (let i = 0; i < 60; i++) qMesh.setColorAt(i, new THREE.Color(1, 1, 1));
  pipe.add(qMesh);
  let envs = [];
  let reads = [];
  let batchTimer = 0.2, monTimer = 0.5, aiTimer = 1.4;
  const colors = { log: new THREE.Color(), span: new THREE.Color(), err: new THREE.Color(), query: new THREE.Color() };
  const tmp = new THREE.Object3D();
  const qStart = PIPE_U.queue - PIPE_MID - 1.7, qEnd = PIPE_U.queue - PIPE_MID + 1.6;

  function spawnBatch() {
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n && envs.length < MAXE; i++) {
      const span = Math.random() < 0.32;
      envs.push({ path: span ? 'spans' : 'logs', s: -i * 0.42, type: span ? 'span' : (Math.random() < 0.1 ? 'err' : 'log') });
    }
  }
  function speedAt(x) { return x > qStart && x < qEnd ? 0.95 : 2.3; }   // slower while waiting in the queue
  function placeOn(path, s, out) {
    const f = clamp(s / path.length, 0, 1);
    const k = f * (path.samples.length - 1);
    const i0 = Math.floor(k), i1 = Math.min(path.samples.length - 1, i0 + 1);
    out.position.lerpVectors(path.samples[i0], path.samples[i1], k - i0);
    const a = path.samples[Math.max(0, i0 - 1)], b = path.samples[Math.min(path.samples.length - 1, i1 + 1)];
    out.rotation.set(0, Math.atan2(-(b.z - a.z), b.x - a.x), 0);
    return f;
  }
  function stepEnvelopes(dt) {
    batchTimer -= dt; monTimer -= dt; aiTimer -= dt;
    if (batchTimer <= 0) { spawnBatch(); batchTimer = 1.1 + Math.random() * 0.6; }
    if (monTimer <= 0) { if (reads.length < 60) reads.push({ path: 'monitor', s: 0 }); monTimer = 0.7 + Math.random() * 0.5; }
    if (aiTimer <= 0) { if (reads.length < 60) reads.push({ path: 'ai', s: 0 }); aiTimer = 1.6 + Math.random() * 1.2; }
    let w = 0;
    for (const e of envs) {
      const path = pathBy(e.path);
      if (e.s < 0) { e.s += 2.3 * dt; envs[w++] = e; continue; }
      const k = clamp(e.s / path.length, 0, 1) * (path.samples.length - 1);
      e.s += speedAt(path.samples[Math.floor(k)].x) * dt;
      if (e.s >= path.length) { const i = Math.floor(Math.random() * bars.length); barBump[i] = 1; continue; }
      envs[w++] = e;
    }
    envs.length = w;
    w = 0;
    for (const r of reads) { r.s += 2.0 * dt; if (r.s < pathBy(r.path).length) reads[w++] = r; }
    reads.length = w;
    drawEnvelopes();
  }
  function drawEnvelopes() {
    let i = 0;
    for (const e of envs) {
      if (e.s < 0) continue;
      const path = pathBy(e.path);
      const f = placeOn(path, e.s, tmp);
      const sc = Math.min(1, f * 14) * (f > 0.93 ? Math.max(0.05, (1 - f) / 0.07) : 1);
      tmp.scale.setScalar(sc);
      tmp.updateMatrix();
      envMesh.setMatrixAt(i, tmp.matrix);
      envMesh.setColorAt(i, colors[e.type]);
      i++;
    }
    envMesh.count = i;
    envMesh.instanceMatrix.needsUpdate = true;
    if (envMesh.instanceColor) envMesh.instanceColor.needsUpdate = true;
    let j = 0;
    for (const r of reads) {
      const path = pathBy(r.path);
      const f = placeOn(path, r.s, tmp);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.setScalar(Math.min(1, f * 10, (1 - f) * 10));
      tmp.updateMatrix();
      qMesh.setMatrixAt(j, tmp.matrix);
      qMesh.setColorAt(j, colors.query);
      j++;
    }
    qMesh.count = j;
    qMesh.instanceMatrix.needsUpdate = true;
    if (qMesh.instanceColor) qMesh.instanceColor.needsUpdate = true;
  }
  /** Still frame: one log and one span envelope parked on their lanes, so the legend still matches the picture. */
  function stillEnvelopes() {
    envs = [{ path: 'logs', s: pathBy('logs').length * 0.36, type: 'log' }, { path: 'spans', s: pathBy('spans').length * 0.3, type: 'span' }, { path: 'logs', s: pathBy('logs').length * 0.62, type: 'err' }];
    reads = [{ path: 'monitor', s: pathBy('monitor').length * 0.5 }];
    drawEnvelopes();
  }

  /* --- labels --- */
  function stationLabel(s) {
    const href = opts.links[s.id];
    const node = document.createElement(href ? 'a' : 'button');
    node.className = 'smap__label smap__label--station';
    if (href) node.href = href; else node.type = 'button';
    node.dataset.station = s.id;
    if (s.id === 'monitor' && opts.here === 'monitor') node.dataset.here = 'true';
    node.addEventListener('click', (e) => selectStation(s.id, e, node));
    node.addEventListener('mouseenter', () => labelHover(s.id, true));
    node.addEventListener('mouseleave', () => labelHover(s.id, false));
    node.addEventListener('focus', () => labelHover(s.id, true));
    node.addEventListener('blur', () => labelHover(s.id, false));
    fillStationLabel(node, s);
    return node;
  }
  function fillStationLabel(node, s) {
    node.replaceChildren(el('span', 'smap__label-name', s.label), el('span', 'smap__label-meta', s.sub));
    node.setAttribute('aria-label', s.label + ' · ' + s.sub + ' · ' + s.tip);
  }
  function makeLabels() {
    for (const s of stations()) {
      const rec = st.get(s.id);
      const lab = stationLabel(s);
      rec.label = stage.addLabel({
        el: lab, priority: s.id === 'queue' ? 9 : 5, align: 'above', world: new THREE.Vector3(),
        getWorld: (v) => { rec.group.updateWorldMatrix(true, false); return v.set(0, rec.top + 0.15, 0).applyMatrix4(rec.group.matrixWorld); },
      });
    }
  }
  function labelHover(id, on) {
    const rec = st.get(id);
    rec.label.pinned = on;
    if (on) { const b = rec.label.el.getBoundingClientRect(); stage.setHover(id, b.right, b.top); } else if (stage.hoverId === id) stage.setHover(null);
  }
  function stationTip(id) {
    const s = stations().find((x) => x.id === id);
    if (!s) return null;
    return tipNode(s.label, s.sub, [{ value: s.tip, name: '' }], opts.links[id] || opts.onSelect ? 'คลิกเพื่อเปิด' : '');
  }
  function selectStation(id, e, labelEl) {
    const s = stations().find((x) => x.id === id);
    if (!s) return;
    let prevented = false;
    const detail = { id: s.id, label: s.label, sub: s.sub };
    if (opts.onSelect) prevented = opts.onSelect(detail, e) === false || (e && e.defaultPrevented);
    stage.root.dispatchEvent(new CustomEvent('smap:select', { bubbles: true, detail: { station: detail } }));
    if (labelEl) { if (prevented && e) e.preventDefault(); return; }
    if (!prevented && opts.links[id]) window.location.assign(opts.links[id]);
  }

  /* --- paint --- */
  function paint() {
    const t = stage.theme;
    const neutral = mix(t['--line-strong'], t['--muted'], t.dark ? 0.55 : 0.45);
    const roleColor = {
      app: col(t['--svc-1']), pkg: mix(t['--ink-2'], t['--surface'], t.dark ? 0.15 : 0.05),
      engine: mix(t['--ink-2'], t['--muted'], 0.5), band: col(t['--accent']),
      col: neutral, plate: mix(t['--line-strong'], t['--surface'], t.dark ? 0.1 : 0.25),
      frame: mix(t['--ink-2'], t['--muted'], 0.35), face: mix(t['--surface'], t['--surface-2'], 0.5), chart: mix(t['--muted'], t['--surface'], 0.3), chartHi: col(t['--accent']),
      ai: mix(t['--ink-2'], t['--accent'], 0.25),
      q: col(t.highlight), qline: mix(t.highlight, t['--ink'], 0.3), redis: mix(t['--line-strong'], t['--muted'], 0.5),
    };
    st.forEach((rec) => {
      const hov = hovered === rec.id;
      const dim = hovered != null && !hov;
      for (const m of rec.meshes) {
        const c = (roleColor[m.userData.role] || neutral).clone();
        m.material.color.copy(c);
        m.material.emissive.copy(c).multiplyScalar(hov ? 0.2 : (t.dark ? 0.08 : 0));
        if (m.userData.role === 'face' || m.userData.role === 'chart' || m.userData.role === 'chartHi') m.material.emissive.copy(c).multiplyScalar(t.dark ? 0.35 : 0.15);
        if (m.material.transparent !== dim) { m.material.transparent = dim; m.material.needsUpdate = true; }
        m.material.opacity = dim ? 0.55 : 1;
      }
    });
    colors.log.set(t['--info-solid']);
    colors.span.set(t['--svc-6']);
    colors.err.set(t['--danger-solid']);
    colors.query.set(t['--accent']);
    envMesh.material.emissive.set(t.dark ? 0x222222 : 0x000000);
    for (const pr of pathRecs) {
      const u = pr.mesh.material.uniforms;
      u.uColor.value.set(mix(t['--muted'], t['--line-strong'], t.dark ? 0.2 : 0.35));
      u.uOpacity.value = t.dark ? 0.7 : 0.6;
      u.uDash.value = stage.animating ? 0 : 1;
    }
    if (!stage.animating) stillEnvelopes();
    stage.requestRender();
  }

  /* --- layout: left → right when wide, top → bottom when tall --- */
  function orient(aspect) {
    const v = aspect < 0.95;
    if (v === vertical && pipe.userData.oriented) return;
    vertical = v;
    pipe.userData.oriented = true;
    pipe.rotation.y = vertical ? -Math.PI / 2 : 0;
    stage.setView(vertical
      ? { azimuth: 0.04, polar: 0.82, sway: 0.08 }
      : { azimuth: 0.36, polar: 1.0, sway: 0.16 });
    st.forEach((rec) => { if (rec.label) { rec.label.align = vertical ? 'right' : 'above'; rec.label.cand = null; } });
    pipe.updateMatrixWorld(true);
    const points = [];
    const box = new THREE.Box3();
    st.forEach((rec) => {
      box.setFromObject(rec.group);
      for (let i = 0; i < 8; i++) points.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    });
    stage.setBounds({ center: new THREE.Vector3(0, 0, 0), radius: 10, height: 1.8, points });
    stage.resetView();
  }

  stage.onResize((w, h, aspect) => orient(aspect));
  stage.onTick((dt, t, animate) => {
    if (queueGroup && queueGroup.userData.pop != null) {
      queueGroup.userData.pop = Math.min(1, queueGroup.userData.pop + dt / 0.35);
      queueGroup.scale.setScalar(0.7 + 0.3 * ease(queueGroup.userData.pop));
      stage.shadowsChanged();
      if (queueGroup.userData.pop >= 1) { queueGroup.userData.pop = null; stage.busy(-1); }
    }
    if (!animate) return;
    stepEnvelopes(dt);
    bars.forEach((b, i) => { barBump[i] = Math.max(0, barBump[i] - dt * 2.2); b.scale.y = 1 + barBump[i] * 0.07; });
    if (ai) { ai.rotation.y += dt * 0.6; ai.rotation.x = Math.sin(t * 0.7) * 0.2; ai.position.y = 0.88 + Math.sin(t * 1.3) * 0.05; }
  });
  stage.onMotion((on) => { if (on) { envs = []; reads = []; } paint(); });
  stage.onTheme(() => paint());

  function setTransport(next) {
    if (!TRANSPORTS[next] || next === transport) return;
    transport = next;
    buildQueue();
    buildPaths();
    envs = envs.filter((e) => e.s > pathBy(e.path).length * 0.5 || e.s < 0);   // keep what has left the queue
    const q = stations().find((x) => x.id === 'queue');
    fillStationLabel(st.get('queue').label.el, q);
    stage.remeasure(st.get('queue').label);
    if (seg) seg.querySelectorAll('[data-transport]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.transport === transport)));
    stage.setSummary(summary());
    if (stage.hoverId === 'queue') stage.setHover('queue', 0, 0);
    paint();
  }

  buildQueue();
  buildPaths();
  makeLabels();
  stage.setPickables(Array.from(st.values()).map((r) => r.group));
  stage.setSummary(summary());
  orient(stage.size.w / Math.max(1, stage.size.h));
  paint();

  return {
    element: stage.root,
    setTransport,
    get transport() { return transport; },
    resetView: () => stage.resetView(),
    setPaused: (p) => stage.setPaused(p),
    stats: () => ({ frames: stage.frames, running: stage.running, envelopes: envs.length, animating: stage.animating, dark: stage.theme.dark, transport, webgl: true }),
    destroy() { envs = []; reads = []; stage.destroy(); },
  };
}

function mountPipelineFallback(container, opts, stations, getT, setT) {
  const root = el('div', 'smap smap--fallback smap--pipeline-fallback');
  clearPlaceholder(container);
  container.appendChild(root);
  function render() {
    root.replaceChildren(el('p', 'smap__fallback-msg', 'เบราว์เซอร์นี้แสดงภาพ 3 มิติไม่ได้ (ไม่มี WebGL) จึงแสดงเป็นลำดับขั้นแทน'));
    const ol = el('ol', 'smap__fsteps');
    ol.setAttribute('aria-label', 'เส้นทางของข้อมูล');
    for (const s of stations()) {
      const li = el('li', 'smap__fstep');
      const name = el(opts.links[s.id] ? 'a' : 'b', 'smap__fstep-name', s.label);
      if (opts.links[s.id]) name.href = opts.links[s.id];
      li.append(name, el('span', 'smap__fstep-sub', s.sub), el('span', 'smap__fstep-tip', s.tip));
      ol.appendChild(li);
    }
    root.appendChild(ol);
  }
  render();
  return {
    element: root,
    setTransport(t) { if (TRANSPORTS[t]) { setT(t); render(); } },
    get transport() { return getT(); },
    resetView() {}, setPaused() {},
    stats: () => ({ frames: 0, running: false, envelopes: 0, animating: false, webgl: false }),
    destroy() { root.remove(); },
  };
}

/* ---------- 8. Canonical demo data (BRIEF.md, prod, 17 ต.ค. 14:20 ICT) ---------- */

/**
 * demoSystemMapData('now' | 'cache-down') → data for mountSystemMap. 'now' = 14:20 (redis cache back up since 13:43:20);
 * 'cache-down' = 13:42:50, while redis "cache" refused connections (requests fell back to the DB).
 * Only numbers the overview shows next to the map (DESIGN.md §7c): rate, error rate and p95 of each service/role from the
 * health table (last hour); the edge from a queue to its consumer and from users to an api carry that row's numbers.
 * Call rates between systems, and the rates of queues, databases, outside APIs and users, have no endpoint yet
 * (systemMapFromApi has the same gap), so they are null: drawn as a trickle, no number. Dependency notes = the Dependency list.
 */
export function demoSystemMapData(scenario) {
  const down = scenario === 'cache-down';
  return {
    nodes: [
      { id: 'clients', kind: 'client', label: 'ผู้ใช้', sublabel: 'เว็บ · แอป', rpm: null, errorRate: null, state: 'ok' },
      { id: 'core-api', kind: 'service', service: 'school-core-api', label: 'school-core-api', sublabel: '/api', rpm: 1180, errorRate: 0.0016, p95Ms: down ? 418 : 312, state: 'warn', note: 'NEW error ตั้งแต่ 31.4.0', href: 'errors.html' },
      { id: 'core-worker', kind: 'worker', service: 'school-core-api', label: 'school-core-api', sublabel: '/worker', rpm: 4, rateUnit: 'job/min', errorRate: 0.021, p95Ms: 4200, state: 'warn', href: 'jobs.html' },
      { id: 'core-persister', kind: 'worker', service: 'school-core-api', label: 'school-core-api', sublabel: '/persister', rpm: 240, rateUnit: 'msg/min', errorRate: 0, p95Ms: 38, state: 'ok', href: 'jobs.html' },
      { id: 'etl-api', kind: 'service', service: 'school-etl-api', label: 'school-etl-api', sublabel: '/api', rpm: 54, errorRate: 0, p95Ms: 1900, state: 'ok', note: 'แปลง Excel', href: 'traces.html' },
      { id: 'video-api', kind: 'service', service: 'video-transcoder-api', label: 'video-transcoder-api', sublabel: '/api', rpm: 310, errorRate: 0.001, p95Ms: 95, state: 'ok', href: 'traces.html' },
      { id: 'oracle', kind: 'dependency', label: 'oracle', sublabel: 'oracle · schema APP', rpm: null, errorRate: null, state: 'ok', href: 'errors.html' },
      { id: 'cache', kind: 'dependency', label: 'redis cache', sublabel: 'redis · 10.0.3.21:6379', rpm: null, errorRate: null, state: down ? 'down' : 'ok', note: down ? 'ECONNREFUSED ตั้งแต่ 13:42:35' : 'down 45.2 s เมื่อ 13:42', href: 'jobs.html#dep-cache' },
      { id: 'bullmq', kind: 'queue', label: 'BullMQ', sublabel: 'redis queue · 10.0.3.22:6379', rpm: null, errorRate: null, state: 'ok', href: 'jobs.html' },
      { id: 'kafka', kind: 'queue', label: 'kafka', sublabel: 'kafka-0.kafka:9092', rpm: null, errorRate: null, state: 'ok', href: 'jobs.html' },
      { id: 'rabbitmq', kind: 'queue', label: 'RabbitMQ', sublabel: '10.0.5.10:5672 · lms.sync', rpm: null, errorRate: null, state: 'ok', href: 'jobs.html' },
      { id: 'google', kind: 'external', label: 'Google Sheets API', sublabel: 'sheets.googleapis.com', rpm: null, errorRate: null, state: 'ok', href: 'errors.html#g3' },
      { id: 'thaid', kind: 'external', label: 'ThaID', sublabel: 'imauth.bora.dopa.go.th', rpm: null, errorRate: null, state: 'degraded', note: '401 4 ครั้ง', href: 'jobs.html#dep-thaid' },
    ],
    edges: [
      { from: 'clients', to: 'core-api', rpm: 1180, errorRate: 0.0016 },
      { from: 'clients', to: 'video-api', rpm: 310, errorRate: 0.001 },
      { from: 'core-api', to: 'cache', rpm: null },
      { from: 'core-api', to: 'oracle', rpm: null },
      { from: 'core-api', to: 'etl-api', rpm: null, label: 'parse-excel' },
      { from: 'core-api', to: 'thaid', rpm: null },
      { from: 'core-api', to: 'bullmq', rpm: null },
      { from: 'core-api', to: 'kafka', rpm: null, label: 'school.events.score' },
      { from: 'bullmq', to: 'core-worker', rpm: 4, errorRate: 0.021, label: 'report:generate' },
      { from: 'rabbitmq', to: 'core-worker', rpm: null, label: 'lms.sync' },
      { from: 'kafka', to: 'core-persister', rpm: 240, errorRate: 0 },
      { from: 'core-worker', to: 'google', rpm: null },
      { from: 'core-worker', to: 'oracle', rpm: null },
      { from: 'core-persister', to: 'oracle', rpm: null },
    ],
  };
}

/* ---------- 9. From the engine API ---------- */

const MODULE_LABEL = { bullmq: 'BullMQ', kafka: 'kafka', rabbitmq: 'RabbitMQ' };

/**
 * systemMapFromApi(overview, options) → data for mountSystemMap, built from GET /api/overview
 * (services[], dependencies[], jobs[], range). Role api = a block, other roles = workers; each dependency row links its
 * service/role to a drum (http → dome); each job queue (cron excluded) feeds the role that consumes it, and a BullMQ queue
 * is also fed by <service>/api when that role exists. The API has no call rates between systems yet, so dependency edges
 * carry rpm null (drawn as a trickle), and dependency nodes and the users node carry rpm / errorRate null (no number).
 * options = { thresholds: { warn: 0.001, error: 0.01 } (errorRate → state), clients: false (adds a "ผู้ใช้" node feeding
 *             every api role), href(kind, row) → string (kind 'service' | 'dependency' | 'queue', row = the API row) }
 */
export function systemMapFromApi(overview, options) {
  const o = overview || {};
  const opts = options || {};
  const th = Object.assign({ warn: 0.001, error: 0.01 }, opts.thresholds);
  const link = (kind, row) => (typeof opts.href === 'function' ? opts.href(kind, row) || '' : '');
  const r = o.range || {};
  const minutes = r.from && r.to ? Math.max(1, (Date.parse(r.to) - Date.parse(r.from)) / 60000) : 60;
  const nodes = new Map();
  const edges = new Map();
  const stateOf = (er) => (er >= th.error ? 'error' : er >= th.warn ? 'warn' : 'ok');
  const role = (service, rl, row) => {
    const id = service + '/' + rl;
    if (!nodes.has(id)) {
      const worker = rl !== 'api';
      nodes.set(id, { id, kind: worker ? 'worker' : 'service', service, label: service, sublabel: '/' + rl, rpm: 0, rateUnit: worker ? 'job/min' : 'req/min', errorRate: 0, state: 'ok', href: link('service', row || { service, role: rl }) });
    }
    return nodes.get(id);
  };
  const edge = (from, to, rpm, failed, label) => {
    const key = from + '→' + to;
    const e = edges.get(key) || { from, to, rpm: rpm == null ? null : 0, failed: 0, label: label || '' };
    if (rpm != null) e.rpm = (e.rpm || 0) + rpm;
    e.failed += failed || 0;
    edges.set(key, e);
  };
  for (const s of o.services || []) {
    const n = role(s.service, s.role, s);
    if (s.kind === 'CONSUMER') { n.kind = 'worker'; n.rateUnit = 'job/min'; }
    n.rpm = num(s.rpm);
    n.errorRate = clamp(num(s.errorRate), 0, 1);
    n.p95Ms = s.p95Ms == null ? null : num(s.p95Ms);
    n.state = stateOf(n.errorRate);
  }
  for (const d of o.dependencies || []) {
    const http = d.type === 'http';
    const id = 'dep:' + d.type + ':' + d.name + '@' + d.host + ':' + d.port;
    if (!nodes.has(id)) nodes.set(id, { id, kind: http ? 'external' : 'dependency', label: http || d.name === d.type ? d.name : d.type + ' ' + d.name, sublabel: d.host + (d.port ? ':' + d.port : ''), rpm: null, rateUnit: 'call/min', errorRate: null, state: 'ok', href: link('dependency', d) });
    const n = nodes.get(id);
    if (d.state === 'down') { n.state = 'down'; n.note = 'down อยู่'; }
    else if (num(d.attempts) > 0 && n.state !== 'down') { n.state = http ? 'degraded' : 'warn'; n.note = 'ล้มเหลว ' + nf0.format(num(d.attempts)) + ' ครั้ง'; }
    else if (d.lastOutageMs && !n.note) n.note = 'down ล่าสุด ' + fmtMs(num(d.lastOutageMs));
    edge(role(d.service, d.role).id, id, null, d.state === 'down' ? 1 : 0);
  }
  for (const j of o.jobs || []) {
    if (!j.queue || j.module === 'cron') continue;
    const id = 'q:' + j.module + ':' + j.queue;
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'queue', label: (MODULE_LABEL[j.module] || j.module) + ' ' + j.queue, sublabel: j.type || '', rpm: 0, rateUnit: j.module === 'kafka' ? 'msg/min' : 'job/min', errorRate: 0, state: 'ok', href: link('queue', j), started: 0, failed: 0 });
    const q = nodes.get(id);
    const started = num(j.started), failed = num(j.failed);
    q.started += started; q.failed += failed;
    q.rpm = q.started / minutes;
    q.errorRate = q.started ? q.failed / q.started : 0;
    edge(id, role(j.service, j.role, j).id, started / minutes, failed / minutes, j.type);
    if (j.module === 'bullmq' && nodes.has(j.service + '/api')) edge(j.service + '/api', id, started / minutes, 0);
  }
  if (opts.clients) {
    const apis = Array.from(nodes.values()).filter((n) => n.kind === 'service');
    nodes.set('clients', { id: 'clients', kind: 'client', label: 'ผู้ใช้', sublabel: 'เว็บ · แอป', rpm: null, errorRate: null, state: 'ok' });
    apis.forEach((n) => edge('clients', n.id, n.rpm, n.rpm * n.errorRate));
  }
  return {
    nodes: Array.from(nodes.values()).map((n) => { const c = Object.assign({}, n); delete c.started; delete c.failed; return c; }),
    edges: Array.from(edges.values()).map((e) => ({ from: e.from, to: e.to, rpm: e.rpm, errorRate: e.rpm ? clamp(e.failed / e.rpm, 0, 1) : clamp(e.failed, 0, 1), label: e.label })),
  };
}
