/* ══════════════════════════════════════════════════
   IT Study Hub — ish-consent.js
   Cookie / storage notice. Shows once, remembers the choice, and can be reopened from the footer
   ("Cookie settings" calls window.ishOpenConsent()).

   ANALYTICS (optional, OFF until you paste a token):
     1. Cloudflare dashboard -> Analytics & Logs -> Web Analytics -> Add a site -> itstudyhub.dpdns.org
     2. Copy the "token" from the snippet it gives you and paste it below.
   Cloudflare Web Analytics sets no cookies and is loaded ONLY after the visitor presses "Accept all".
══════════════════════════════════════════════════ */
(function () {
  var ANALYTICS_TOKEN = '';           // e.g. 'a1b2c3d4e5f6...'  (public token, safe to commit)
  var KEY = 'ish_consent';            // 'all' | 'essential'

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function loadAnalytics() {
    if (!ANALYTICS_TOKEN || document.getElementById('ish-cfba')) return;
    var s = document.createElement('script');
    s.id = 'ish-cfba'; s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: ANALYTICS_TOKEN }));
    document.head.appendChild(s);
  }

  var css = '' +
    '.ish-consent{position:fixed;left:12px;right:12px;bottom:12px;z-index:100000;max-width:680px;margin:0 auto;padding:16px 18px;background:#0a0a14;color:#eeeef5;border:1px solid rgba(200,241,53,.35);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.6);font:14px/1.6 "DM Sans",system-ui,sans-serif}' +
    '.ish-consent p{margin:0 0 12px;color:#c9c9d6}' +
    '.ish-consent a{color:#c8f135}' +
    '.ish-consent-row{display:flex;flex-wrap:wrap;gap:10px}' +
    '.ish-consent button{font:600 13px "DM Sans",system-ui,sans-serif;padding:10px 18px;border-radius:10px;border:1px solid #c8f135;cursor:pointer;min-height:40px}' +
    '.ish-consent .ish-yes{background:#c8f135;color:#04040a}' +
    '.ish-consent .ish-no{background:transparent;color:#c8f135}' +
    'body.ish-consent-open .sticky-cta{display:none!important}';

  function close() {
    var b = document.getElementById('ish-consent'); if (b) b.remove();
    document.body.classList.remove('ish-consent-open');
  }
  function choose(v) { set(v); close(); if (v === 'all') loadAnalytics(); }

  function open() {
    if (document.getElementById('ish-consent')) return;
    if (!document.getElementById('ish-consent-css')) {
      var st = document.createElement('style'); st.id = 'ish-consent-css'; st.textContent = css; document.head.appendChild(st);
    }
    var b = document.createElement('div');
    b.id = 'ish-consent'; b.className = 'ish-consent'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', 'Cookie and storage notice');
    b.innerHTML = '<p>We use essential cookies and local storage to keep you signed in and remember your progress.' +
      (ANALYTICS_TOKEN ? ' With your OK we also use privacy-friendly analytics (no advertising, no cross-site tracking).' : '') +
      ' See our <a href="privacypolicy.html">Privacy policy</a>.</p>' +
      '<div class="ish-consent-row">' +
      (ANALYTICS_TOKEN ? '<button type="button" class="ish-yes" id="ish-all">Accept all</button><button type="button" class="ish-no" id="ish-ess">Essential only</button>'
                       : '<button type="button" class="ish-yes" id="ish-ess">Got it</button>') +
      '</div>';
    document.body.appendChild(b);
    document.body.classList.add('ish-consent-open');
    var all = document.getElementById('ish-all'); if (all) all.addEventListener('click', function () { choose('all'); });
    document.getElementById('ish-ess').addEventListener('click', function () { choose('essential'); });
  }

  window.ishOpenConsent = open;
  function init() { var c = get(); if (c === 'all') loadAnalytics(); if (!c) open(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
