/* skilllane monitor mockups: theme, motion, sidebar, drawer, tabs, toggles, copy, row expand, tooltips, chart scroll.
   Load in <head> without defer so the theme and the motion switch are set before first paint. No dependencies. */
(function () {
  'use strict';
  var root = document.documentElement;
  var KEY = 'skilllane-monitor-theme';
  var SVGNS = 'http://www.w3.org/2000/svg';

  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: theme still applies for this page */ } }
  function query(name) { try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; } }

  // 1. Theme: ?theme=dark|light wins (not saved, for screenshots), then the saved choice, else the OS.
  var param = query('theme');
  var first = (param === 'dark' || param === 'light') ? param : saved();
  if (first === 'dark' || first === 'light') root.setAttribute('data-theme', first);

  // 1c. Motion: on unless ?motion=off, the OS asks for reduced motion, IntersectionObserver is missing, or the page
  //     runs in headless Chrome (CLI screenshots render no frames before the capture, so they would catch the
  //     not-yet-revealed state). ?motion=on forces it on. CSS reads :root[data-motion].
  var motionParam = query('motion');
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var headless = /HeadlessChrome/.test(navigator.userAgent);
  var motion = 'IntersectionObserver' in window && (motionParam === 'on' || (motionParam !== 'off' && !reduce && !headless));
  root.setAttribute('data-motion', motion ? 'on' : 'off');

  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeButtons() {
    var dark = current() === 'dark';
    each('[data-theme-toggle]', function (b) {
      b.setAttribute('aria-pressed', String(dark));
      var label = dark ? 'เปลี่ยนเป็นธีมสว่าง' : 'เปลี่ยนเป็นธีมมืด';
      b.setAttribute('aria-label', label);
      b.setAttribute('title', label);
    });
  }

  function each(sel, fn, scope) { Array.prototype.forEach.call((scope || document).querySelectorAll(sel), fn); }
  function onReady(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  // 8. Motion helpers (used by the reveal observer below and exposed as window.skMonitor)
  var REVEAL = '.chart, .kpi, .spark-inline, .wf, .dur, .badge-new, [data-mo]';

  // Prepare one svg the first time it is seen: bar baselines, left-to-right position, line lengths, "now" rings
  function prepSvg(svg) {
    if (svg.__mo) return; svg.__mo = true;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var bb = null; try { bb = svg.getBBox(); } catch (e) { return; }
    var x0 = vb && vb.width ? vb.x : bb.x, w = (vb && vb.width) || bb.width || 1, y0 = vb && vb.width ? vb.y : 0;
    // horizontal axis lines: a bar grows from the nearest one below it (one svg may hold two stacked plots)
    var axes = [];
    each('line.c-axis', function (l) { var a = l.y1.baseVal.value; if (Math.abs(a - l.y2.baseVal.value) < 0.01) axes.push(a); }, svg);
    var bars = Array.prototype.slice.call(svg.querySelectorAll('.c-bar'));
    var boxes = bars.map(function (b) { try { return b.getBBox(); } catch (e) { return null; } });
    var lowest = 0;
    boxes.forEach(function (b) { if (b) lowest = Math.max(lowest, b.y + b.height); });
    bars.forEach(function (bar, i) {
      var b = boxes[i]; if (!b) return;
      var bottom = b.y + b.height, base = null;
      axes.forEach(function (a) { if (a >= bottom - 1 && (base === null || a < base)) base = a; });
      if (base === null) base = lowest;
      bar.style.transformOrigin = '0 ' + (base - y0) + 'px';
      bar.style.setProperty('--mo-x', Math.max(0, Math.min(1, (b.x - x0) / w)).toFixed(3));
    });
    each('.c-dot', function (d) {
      var b = null; try { b = d.getBBox(); } catch (e) { return; }
      d.style.setProperty('--mo-x', Math.max(0, Math.min(1, (b.x - x0) / w)).toFixed(3));
    }, svg);
    each('.c-line, .spark__line', function (line) {
      line.setAttribute('pathLength', '1');
      line.classList.add('mo-draw');
      // the end dot that follows a line is the newest value: it pops in after the line and breathes
      for (var n = line.nextElementSibling; n; n = n.nextElementSibling) {
        if (n.matches('.c-line, .spark__line')) break;
        if (n.matches('circle.c-dot, circle.spark__dot')) {
          n.classList.add('mo-now');
          var ring = document.createElementNS(SVGNS, 'circle');
          var cls = n.classList.contains('spark__dot') ? 'mo-ring mo-ring--spark' : 'mo-ring ' + n.getAttribute('class').replace(/\b(c-dot|mo-now)\b/g, '').trim();
          ring.setAttribute('class', cls);
          ['cx', 'cy', 'r'].forEach(function (a) { ring.setAttribute(a, n.getAttribute(a)); });
          ring.setAttribute('aria-hidden', 'true');
          n.parentNode.insertBefore(ring, n);
          break;
        }
      }
    }, svg);
  }

  // KPI and [data-mo-count]: count a plain number ("1,180", "0.16", "345,600") up from 0 in 600 ms, then restore the exact text
  function countUp(el) {
    if (!el || el.__mo) return; el.__mo = true;
    var node = null;
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\d/.test(n.nodeValue)) { node = n; break; }
    if (!node) return;
    var text = node.nodeValue, m = /^(\s*)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*)$/.exec(text);
    if (!m) return; // dates, times and ranges stay as they are
    var dec = m[3] ? m[3].length - 1 : 0, target = parseFloat((m[2] + (m[3] || '')).replace(/,/g, ''));
    if (target < 10 && !dec) return;
    var t0 = null, dur = 600;
    function fmt(v) { return m[1] + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[4]; }
    function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      if (p < 1) { node.nodeValue = fmt(target * e); requestAnimationFrame(step); }
      else { node.nodeValue = text; el.classList.remove('is-counting'); }
    }
    el.classList.add('is-counting');
    node.nodeValue = fmt(0);
    requestAnimationFrame(step);
  }

  function reveal(el) {
    if (!el || el.classList.contains('is-in')) return;
    var targets = [el].concat(Array.prototype.slice.call(el.querySelectorAll(REVEAL)));
    targets.forEach(function (t) {
      if (t.classList.contains('is-in')) return;
      if (t.tagName.toLowerCase() === 'svg') prepSvg(t); else each('svg', prepSvg, t);
      t.classList.add('is-in');
      if (t.matches('.kpi')) countUp(t.querySelector('.kpi__value'));
      each('[data-mo-count]', countUp, t);
      if (t.matches('[data-mo-count]')) countUp(t);
      var ev; try { ev = new CustomEvent('mo:in'); } catch (e) { ev = null; }
      if (ev) t.dispatchEvent(ev);
    });
  }
  // Play an element's entrance again (components.html demo, or after new data replaces a chart)
  function replay(el) {
    if (!motion || !el) return;
    var targets = [el].concat(Array.prototype.slice.call(el.querySelectorAll(REVEAL)));
    targets.forEach(function (t) { t.classList.remove('is-in'); });
    each('.kpi__value, [data-mo-count]', function (v) { v.__mo = false; }, el);
    void el.offsetWidth;
    reveal(el);
  }
  // Show a changed value: replace the number text (unit spans stay) and flash the tint once
  function setValue(el, text) {
    var node = null;
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) { node = n; break; }
    if (node) node.nodeValue = text; else el.insertBefore(document.createTextNode(text), el.firstChild);
    el.classList.remove('is-changed'); void el.offsetWidth; el.classList.add('is-changed');
  }
  // A row that just arrived: insert on top, it slides in and its highlight fades
  function addRow(tbody, tr) {
    tr.classList.add('is-new');
    tbody.insertBefore(tr, tbody.firstElementChild);
    setTimeout(function () { tr.classList.remove('is-new'); }, 2000);
  }
  window.skMonitor = { motion: motion, reveal: reveal, replay: replay, setValue: setValue, addRow: addRow };

  onReady(function () {
    var app = document.querySelector('.app');
    var scrim = document.createElement('div');
    scrim.className = 'scrim';
    document.body.appendChild(scrim);
    var live = document.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);

    syncThemeButtons();

    // 1b. Time-axis charts that scroll on narrow screens start at the newest minute (right edge)
    each('.chart__plot[data-time-axis]', function (p) { p.scrollLeft = p.scrollWidth; });

    // 1d. Reveal: a target animates in the first time it scrolls into view (or appears: tab, drawer, details)
    if (motion) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); reveal(en.target); } });
      }, { rootMargin: '0px 0px -32px 0px' });
      each(REVEAL, function (el) { io.observe(el); });
    }

    // 2. Sidebar on narrow screens: opening moves focus to the current nav item, closing returns it to the menu button
    var navOpener = null;
    function setNav(open, from) {
      if (!app) return;
      app.classList.toggle('nav-open', open);
      each('[data-nav-toggle]', function (b) { if (b.hasAttribute('aria-controls')) b.setAttribute('aria-expanded', String(open)); });
      scrim.classList.toggle('is-on', open || !!openDrawer);
      if (open) {
        navOpener = from || null;
        var cur = document.querySelector('.sidebar .nav-item[aria-current="page"]') || document.querySelector('.sidebar .nav-item');
        if (cur) setTimeout(function () { cur.focus(); }, 0);
      } else if (navOpener) { navOpener.focus(); navOpener = null; }
    }

    // 3. Drawer: modal. Drawers move to <body> so the rest of the app can be made inert while one is open.
    var openDrawer = null, opener = null;
    each('.drawer', function (d) { d.setAttribute('aria-modal', 'true'); document.body.appendChild(d); });
    function focusables(d) {
      return Array.prototype.filter.call(d.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'),
        function (el) { return el.offsetWidth || el.offsetHeight || el.getClientRects().length; });
    }
    function showDrawer(d, from, moveFocus) {
      if (openDrawer && openDrawer !== d) hideDrawer(false);
      openDrawer = d; opener = from || null;
      d.classList.add('is-open');
      d.setAttribute('aria-hidden', 'false');
      if (opener) opener.setAttribute('aria-expanded', 'true');
      if (app) { app.inert = true; app.setAttribute('inert', ''); }
      scrim.classList.add('is-on');
      if (moveFocus === false) return;
      var f = d.querySelector('[data-drawer-focus]') || d.querySelector('.drawer__title');
      if (f) { if (!f.hasAttribute('tabindex')) f.setAttribute('tabindex', '-1'); f.focus(); }
    }
    function hideDrawer(restore) {
      if (!openDrawer) return;
      openDrawer.classList.remove('is-open');
      openDrawer.setAttribute('aria-hidden', 'true');
      if (opener) opener.setAttribute('aria-expanded', 'false');
      openDrawer = null;
      if (app) { app.inert = false; app.removeAttribute('inert'); }
      scrim.classList.toggle('is-on', !!(app && app.classList.contains('nav-open')));
      if (restore !== false && opener) opener.focus();
      opener = null;
    }
    // ?drawer=<key> opens the drawer whose opener has data-drawer-param="<key>" (for demos and screenshots); focus stays put
    var drawerParam = query('drawer');
    if (drawerParam) {
      var start = document.querySelector('[data-drawer-param="' + drawerParam.replace(/[^\w-]/g, '') + '"]');
      var startDrawer = start && document.getElementById(start.getAttribute('data-drawer-open'));
      if (startDrawer) {
        startDrawer.style.transition = 'none'; scrim.style.transition = 'none';
        showDrawer(startDrawer, start, false);
        void startDrawer.offsetWidth; startDrawer.style.transition = ''; scrim.style.transition = '';
      }
    }

    // 4. Copy to clipboard: [data-copy]="text" or [data-copy-target]="#id" (copies its textContent)
    function copy(btn) {
      var targetSel = btn.getAttribute('data-copy-target');
      var target = targetSel ? document.querySelector(targetSel) : null;
      var text = btn.hasAttribute('data-copy') ? btn.getAttribute('data-copy') : (target ? target.textContent : '');
      text = text.replace(/^\n+|\s+$/g, '');
      function done(ok) {
        var label = btn.querySelector('.btn-copy__label');
        if (label && !label.hasAttribute('data-label')) label.setAttribute('data-label', label.textContent);
        btn.classList.add(ok ? 'is-copied' : 'is-copy-manual'); // only a real copy turns the button ok-green with a check
        if (label) label.textContent = ok ? 'คัดลอกแล้ว' : 'เลือกข้อความแล้ว กด Ctrl/⌘+C';
        live.textContent = ok ? 'คัดลอกแล้ว' : 'เลือกข้อความแล้ว กด Ctrl หรือ Command กับ C เพื่อคัดลอก';
        clearTimeout(btn.__copyTimer);
        btn.__copyTimer = setTimeout(function () { btn.classList.remove('is-copied', 'is-copy-manual'); if (label) label.textContent = label.getAttribute('data-label'); }, ok ? 1600 : 4000);
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        if (!ok && target) { // last resort: select the visible text for a manual copy
          var r = document.createRange(); r.selectNodeContents(target);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        }
        done(ok);
      }
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
      else fallback();
    }

    // 5. Tabs (role=tablist > role=tab[aria-controls]); every .tabs gets one ink bar that slides to the selected tab
    function inkFor(list) {
      var ink = document.createElement('span');
      ink.className = 'tabs__ink'; ink.setAttribute('aria-hidden', 'true');
      list.appendChild(ink); list.classList.add('has-ink');
      function place() {
        var cur = list.querySelector('[role="tab"][aria-selected="true"], .tab[aria-current="page"]');
        if (!cur || !cur.offsetWidth) { ink.style.width = '0'; return; }
        ink.style.width = Math.max(0, cur.offsetWidth - 16) + 'px';
        ink.style.translate = (cur.offsetLeft + 8) + 'px 0';
      }
      place();
      requestAnimationFrame(function () { list.classList.add('is-ready'); });
      if (window.ResizeObserver) new ResizeObserver(place).observe(list);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
      return place;
    }
    each('.tabs', function (list) {
      var place = inkFor(list);
      if (list.getAttribute('role') !== 'tablist') return;
      var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
      function select(tab, focus) {
        tabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
          var p = document.getElementById(t.getAttribute('aria-controls'));
          if (p) p.hidden = !on;
        });
        place();
        if (focus) tab.focus();
      }
      list.addEventListener('click', function (e) { var t = e.target.closest('[role="tab"]'); if (t) select(t, false); });
      list.addEventListener('keydown', function (e) {
        var i = tabs.indexOf(document.activeElement); if (i < 0) return;
        var n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (n === undefined) return;
        e.preventDefault(); select(tabs[(n + tabs.length) % tabs.length], true);
      });
    });

    // 6. Tooltips: any element with data-tip="title|value::name|value::name" (data-tip-keys="svc-1,svc-3" colors the lines)
    var tip = null;
    function showTip(el, x, y) {
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip tip--float'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
      tip.textContent = '';
      var keys = (el.getAttribute('data-tip-keys') || '').split(',');
      el.getAttribute('data-tip').split('|').forEach(function (part, i) {
        var line = document.createElement('div');
        if (i === 0) { line.className = 'tip__title'; line.textContent = part; tip.appendChild(line); return; }
        line.className = 'tip__line';
        var k = keys[i - 1];
        if (k) { var key = document.createElement('span'); key.className = 'tip__key'; key.style.setProperty('--c', 'var(--' + k.trim() + ')'); line.appendChild(key); }
        var bits = part.split('::');
        var v = document.createElement('span'); v.className = 'tip__val'; v.textContent = bits[0]; line.appendChild(v);
        if (bits[1]) { var nm = document.createElement('span'); nm.className = 'tip__name'; nm.textContent = bits[1]; line.appendChild(nm); }
        tip.appendChild(line);
      });
      tip.hidden = false;
      var w = tip.offsetWidth, h = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      var left = x + 14, top = y + 14;
      if (left + w > vw - 8) left = Math.max(8, x - w - 14);
      if (top + h > vh - 8) top = Math.max(8, y - h - 14);
      tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    }
    function hideTip() { if (tip) tip.hidden = true; }
    document.addEventListener('pointermove', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showTip(el, e.clientX, e.clientY); else hideTip();
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { hideTip(); return; }
      var r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top + r.height / 2);
    });
    document.addEventListener('focusout', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });

    // 7. One click handler for everything else
    document.addEventListener('click', function (e) {
      var t = e.target;
      var el;
      if ((el = t.closest('[data-theme-toggle]'))) {
        var next = current() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next); save(next); syncThemeButtons();
        return;
      }
      if ((el = t.closest('[data-nav-toggle]'))) { var opening = !(app && app.classList.contains('nav-open')); setNav(opening, opening ? el : null); return; }
      if (t === scrim) { if (openDrawer) hideDrawer(); else setNav(false); return; }
      if ((el = t.closest('[data-drawer-open]'))) {
        var d = document.getElementById(el.getAttribute('data-drawer-open'));
        if (d) { e.preventDefault(); showDrawer(d, el); }
        return;
      }
      if ((el = t.closest('[data-drawer-close]'))) { hideDrawer(); return; }
      if ((el = t.closest('[data-copy], [data-copy-target]'))) { e.preventDefault(); copy(el); return; }
      if ((el = t.closest('[data-expand]'))) {
        var open = el.getAttribute('aria-expanded') !== 'true';
        el.setAttribute('aria-expanded', String(open));
        var panel = document.getElementById(el.getAttribute('aria-controls'));
        if (panel) panel.hidden = !open;
        var row = el.closest('tr'); if (row) row.classList.toggle('is-expanded', open);
        return;
      }
      // Motion demos (components.html): [data-mo-replay="#id"] plays the entrance again
      if ((el = t.closest('[data-mo-replay]'))) { replay(document.querySelector(el.getAttribute('data-mo-replay'))); return; }
      // Segmented control / single-choice group: [data-choice] > [aria-pressed]
      if ((el = t.closest('[data-choice] [aria-pressed]'))) {
        each('[aria-pressed]', function (b) { b.setAttribute('aria-pressed', String(b === el)); }, el.closest('[data-choice]'));
        return;
      }
      // Independent toggle (filter chips): [data-toggle][aria-pressed]
      if ((el = t.closest('[data-toggle][aria-pressed]'))) {
        el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideTip(); if (openDrawer) hideDrawer(); else if (app && app.classList.contains('nav-open')) setNav(false); }
      // Tab stays inside an open drawer
      if (e.key === 'Tab' && openDrawer) {
        var f = focusables(openDrawer); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (!openDrawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      // "/" focuses the jump box (unless typing in a field)
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        var j = document.querySelector('.jump__input');
        if (j) { e.preventDefault(); j.focus(); }
      }
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', syncThemeButtons);
    }
  });
})();
