/* ══════════════════════════════════════════════════
   IT Study Hub — premium-content.js
   Fetches premium lessons and PDFs from the Worker. The Worker checks the
   signed-in user's plan on every request, so editing localStorage or the
   page's JavaScript cannot unlock anything.

   Exposes (on window):
     ishAccess()                     → Promise<boolean>  does this user have premium now?
     loadPremiumLesson(course, id)   → Promise<{ok:true, data} | {ok:false, status}>
     openPremiumPdf(file)            → opens a premium PDF in a new tab
     __ishPremium                    → last known answer (true / false), for sync UI checks
══════════════════════════════════════════════════ */
(function () {
  const FIREBASE = 'https://www.gstatic.com/firebasejs/12.13.0/';
  const firebaseConfig = {
    apiKey: "AIzaSyBTFhNaI82vjwp0kuIhkASUt4Na22OogRQ",
    authDomain: "it-study-hub.firebaseapp.com",
    projectId: "it-study-hub",
    storageBucket: "it-study-hub.firebasestorage.app",
    messagingSenderId: "566661039167",
    appId: "1:566661039167:web:122691d263631e404ea48a"
  };

  window.__ishPremium = false;
  let userPromise = null;

  // Resolves to the signed-in Firebase user, or null. Reuses the page's Firebase app if it has one.
  function getUser() {
    if (!userPromise) {
      userPromise = (async () => {
        const { getApps, getApp, initializeApp } = await import(FIREBASE + 'firebase-app.js');
        const { getAuth } = await import(FIREBASE + 'firebase-auth.js');
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
        const auth = getAuth(app);
        return new Promise((resolve) => {
          const off = auth.onAuthStateChanged((u) => { off(); resolve(u); });
        });
      })().catch((e) => { console.warn('premium-content: auth unavailable', e); return null; });
    }
    return userPromise;
  }

  async function apiGet(path) {
    const user = await getUser();
    if (!user) return { ok: false, status: 401 };
    let res;
    try {
      const token = await user.getIdToken();
      res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    } catch (e) {
      return { ok: false, status: 0 };
    }
    return res;
  }

  let accessPromise = null;
  window.ishAccess = function () {
    if (!accessPromise) {
      accessPromise = (async () => {
        const res = await apiGet('/api/access');
        if (!res.ok) { accessPromise = null; return false; }   // retry next time
        const data = await res.json().catch(() => ({}));
        const premium = data.premium === true;
        const changed = premium !== window.__ishPremium;
        window.__ishPremium = premium;
        // Cards and sidebar were drawn as "locked" before we knew; redraw once.
        if (changed && typeof window.renderIndex === 'function') window.renderIndex();
        return premium;
      })();
    }
    return accessPromise;
  };

  window.loadPremiumLesson = async function (course, id) {
    document.body.style.cursor = 'progress';
    try {
      const res = await apiGet('/api/lesson?course=' + encodeURIComponent(course) + '&id=' + encodeURIComponent(id));
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      if (!window.__ishPremium) { window.__ishPremium = true; if (typeof window.renderIndex === 'function') window.renderIndex(); }
      return { ok: true, data };
    } catch (e) {
      return { ok: false, status: 0 };
    } finally {
      document.body.style.cursor = '';
    }
  };

  window.openPremiumPdf = async function (file) {
    // Open the tab right away (inside the click) so popup blockers allow it.
    const tab = window.open('', '_blank');
    const res = await apiGet('/api/pdf?f=' + encodeURIComponent(file));
    if (!res.ok) {
      if (tab) tab.close();
      if (res.status === 401 || res.status === 403) {
        window.location.href = 'premium.html';
      } else {
        alert(res.status === 404 ? 'That file is not available yet.' : 'Could not load the file. Please try again.');
      }
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // Start checking right away so cards unlock without needing a click.
  window.ishAccess();
})();
