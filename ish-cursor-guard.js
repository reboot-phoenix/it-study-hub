/* ══════════════════════════════════════════════════
   IT Study Hub — ish-cursor-guard.js   (the custom cursor, for EVERY page)

   One implementation, loaded by every page. It does not depend on any page's CSS or markup:
     • it injects its own styles and creates its own dot + ring,
     • it hides the real mouse pointer only after the custom cursor is actually moving
       (class html.custom-cursor, added on the first mouse move),
     • it switches itself off for touch, for pages inside a frame, and if anything fails,
       so a visitor never ends up with no pointer at all.
   The older per-page cursor elements (#cur, #curR, .cursor, .cursor-ring) are hidden, never removed,
   so pages that still have their own cursor script keep working without errors.
   Do not add cursor code to individual pages. site.test.mjs checks that every page loads this file.
══════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.self !== window.top) return;                                           // inside an iframe (e.g. the practice panel)
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;  // touch devices keep their normal behaviour

  var ROOT = document.documentElement;
  var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var HOVER = 'a,button,[role="button"],[onclick],summary,select,label[for],input[type="checkbox"],input[type="radio"],input[type="submit"],input[type="button"]';

  var style = document.createElement('style');
  style.textContent =
    '.cursor,.cursor-ring,#cur,#curR{display:none!important}' +                                 // old per-page cursors: replaced by this one
    '.ish-cur{position:fixed;left:0;top:0;pointer-events:none;border-radius:50%;opacity:0;' +
      'transform:translate3d(var(--x,-100px),var(--y,-100px),0) translate(-50%,-50%) scale(var(--s,1));' +
      'transition:opacity .2s ease;mix-blend-mode:difference;will-change:transform}' +
    '.ish-cur-dot{width:10px;height:10px;background:var(--lime,#c8f135);z-index:2147483647}' +
    '.ish-cur-ring{width:36px;height:36px;border:1px solid var(--lime,#c8f135);z-index:2147483646}' +
    'html.custom-cursor .ish-cur{opacity:1}' +
    'html.custom-cursor.ish-cursor-out .ish-cur{opacity:0}' +
    ':where(html.custom-cursor) *,:where(html.custom-cursor) *::before,:where(html.custom-cursor) *::after{cursor:none!important}';

  var dot, ring, raf = 0;
  var mx = 0, my = 0, rx = 0, ry = 0, scale = 1;

  function frame() {
    rx += (mx - rx) * (calm ? 1 : 0.14);
    ry += (my - ry) * (calm ? 1 : 0.14);
    dot.style.setProperty('--x', mx + 'px'); dot.style.setProperty('--y', my + 'px'); dot.style.setProperty('--s', scale === 1 ? 1 : 1.8);
    ring.style.setProperty('--x', rx + 'px'); ring.style.setProperty('--y', ry + 'px'); ring.style.setProperty('--s', scale === 1 ? 1 : 1.5);
    raf = requestAnimationFrame(frame);
  }

  function stop() {                       // give the normal pointer back
    cancelAnimationFrame(raf); raf = 0;
    ROOT.classList.remove('custom-cursor', 'ish-cursor-out');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseover', onOver);
  }

  function start() {
    try {
      (document.head || ROOT).appendChild(style);
      dot = document.createElement('div'); dot.className = 'ish-cur ish-cur-dot'; dot.setAttribute('aria-hidden', 'true');
      ring = document.createElement('div'); ring.className = 'ish-cur ish-cur-ring'; ring.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ring); document.body.appendChild(dot);
      document.addEventListener('mousemove', onMove, { passive: true });
      document.addEventListener('mouseover', onOver, { passive: true });
      document.addEventListener('mouseleave', function () { ROOT.classList.add('ish-cursor-out'); });
      document.addEventListener('mouseenter', function () { ROOT.classList.remove('ish-cursor-out'); });
      document.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') stop(); }, { passive: true });
    } catch (err) { stop(); }
  }

  function onMove(e) {
    mx = e.clientX; my = e.clientY;
    if (!raf) { rx = mx; ry = my; ROOT.classList.add('custom-cursor'); raf = requestAnimationFrame(frame); }   // first move: start, no matter what a page did to the class
    ROOT.classList.remove('ish-cursor-out');
  }

  function onOver(e) {
    var t = e.target;
    scale = (t && t.closest && t.closest(HOVER)) ? 2 : 1;
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
