/* ══════════════════════════════════════════════════
   IT Study Hub — ish-cursor-guard.js
   The custom cursor hides the real mouse pointer. That is only safe once the custom cursor is actually
   moving, so the stylesheet hides the real one only inside  html.custom-cursor, and this script adds
   that class on the first mouse move. If a page's script fails, or the device has no mouse, visitors
   keep their normal pointer.
══════════════════════════════════════════════════ */
(function () {
  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;
  if (!document.getElementById('cur') && !document.querySelector('.cursor')) return;   // this page has no custom cursor
  function activate() {
    document.documentElement.classList.add('custom-cursor');
    document.removeEventListener('mousemove', activate);
  }
  document.addEventListener('mousemove', activate);
})();
