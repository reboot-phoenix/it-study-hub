/* ══════════════════════════════════════════════════
   IT Study Hub — ish-a11y.js
   Keyboard and screen-reader support for the page's clickable cards and icon buttons.

   - A <div>/<span> with an onclick (cards, tiles, tabs) becomes focusable with Tab, is announced as a
     button, and can be activated with Enter or Space. It also covers cards the page builds later.
   - Icon-only buttons take their accessible name from their title, when they have one.
   Click-outside overlays and anything that already contains real links or buttons are left alone.
══════════════════════════════════════════════════ */
(function () {
  var NATIVE = 'a[href],button,input,select,textarea,summary,[tabindex],[role],[contenteditable]';
  var INNER = 'a[href],button,input,select,textarea';

  function isOverlay(el) {
    if (/overlay|backdrop|modal-bg|scrim/i.test(el.className && el.className.baseVal === undefined ? el.className : '')) return true;
    var cs = window.getComputedStyle(el);
    return cs.position === 'fixed';
  }

  function enhance(root) {
    root.querySelectorAll('[onclick]').forEach(function (el) {
      if (el.matches(NATIVE) || el.querySelector(INNER) || el.hasAttribute('aria-hidden') || el === document.body || isOverlay(el)) return;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('data-ish-key', '1');
    });
    root.querySelectorAll('button:not([aria-label])').forEach(function (b) {
      if (!b.textContent.trim() && b.getAttribute('title')) b.setAttribute('aria-label', b.getAttribute('title'));
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target;
    if (!el || !el.getAttribute || el.getAttribute('data-ish-key') !== '1') return;
    e.preventDefault();                       // Space must not scroll the page
    el.click();
  });

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; enhance(document); });
  }

  function start() {
    enhance(document);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
