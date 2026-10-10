/* ══════════════════════════════════════════════════
   IT Study Hub — ish-config.js
   Site-wide switches. Loaded before the Firebase code on every page that signs people in.

   FIREBASE APP CHECK
   App Check makes Firebase accept requests only from your real website, not from copies of your
   API key used elsewhere. It stays OFF until you paste a reCAPTCHA v3 site key below:

     1. https://www.google.com/recaptcha/admin  -> create a "reCAPTCHA v3" site for itstudyhub.dpdns.org
     2. Firebase console -> App Check -> Apps -> your web app -> reCAPTCHA v3 -> paste the SECRET key
     3. Paste the SITE key (the public one) here, deploy, and browse the site for a day
     4. Firebase console -> App Check -> APIs -> Cloud Firestore / Cloud Storage -> check the
        "verified requests" percentage is ~100%, then click Enforce
══════════════════════════════════════════════════ */
window.ISH_APPCHECK_SITE_KEY = '';   // e.g. '6Lc...'  (public site key, safe to commit)

(function () {
  const started = new WeakSet();
  // Call right after initializeApp(): `await window.ishInitAppCheck?.(app);`
  window.ishInitAppCheck = async function (app) {
    try {
      const key = window.ISH_APPCHECK_SITE_KEY;
      if (!key || !app || started.has(app)) return;
      started.add(app);
      const m = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-check.js');
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      m.initializeAppCheck(app, { provider: new m.ReCaptchaV3Provider(key), isTokenAutoRefreshEnabled: true });
    } catch (e) { console.warn('App Check did not start:', e); }
  };
})();
