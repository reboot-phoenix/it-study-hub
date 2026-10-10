/* ══════════════════════════════════════════════════
   IT Study Hub — ish-safe.js
   Small helpers for putting user-supplied data into a page safely.
   Anything that came from a profile, a Google account or the URL must go through one of these
   (or be set with textContent / DOM APIs) before it is added to innerHTML.

     esc(x)         HTML-escapes text, including quotes, so it is safe in text AND attribute values
     num(x, d)      a finite number, or d (default 0)
     safeUrl(x)     an https URL string, or '' (blocks javascript:, data:, relative tricks)
     safeImgUrl(x)  like safeUrl, but only for hosts that serve avatars (Google, Firebase Storage, GitHub)
══════════════════════════════════════════════════ */
(function () {
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  const AVATAR_HOSTS = ['googleusercontent.com', 'firebasestorage.googleapis.com', 'firebasestorage.app', 'storage.googleapis.com', 'avatars.githubusercontent.com'];

  window.esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, (c) => ENTITIES[c]);
  };

  window.num = function (value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  };

  window.safeUrl = function (value) {
    try {
      const raw = String(value == null ? '' : value).trim();
      if (!raw || raw.length > 500 || /[\s"'<>`\\]/.test(raw)) return '';
      const u = new URL(raw);
      return u.protocol === 'https:' ? u.href : '';
    } catch (e) { return ''; }
  };

  window.safeImgUrl = function (value) {
    const href = window.safeUrl(value);
    if (!href) return '';
    const host = new URL(href).hostname;
    return AVATAR_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? href : '';
  };
})();
