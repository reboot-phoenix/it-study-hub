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
  window.__ishPremium = false;

  // Calls our Worker with the signed-in user's token (see /auth.js). Not signed in -> a 401 response.
  async function apiGet(path) {
    try {
      const { apiFetch } = await import('/auth.js');
      return await apiFetch(path);
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }

  let accessPromise = null;
  window.ishAccess = function () {
    if (!accessPromise) {
      accessPromise = (async () => {
        const res = await apiGet('/api/access');
        if (!res.ok) {
          accessPromise = null;   // retry next time
          let why = ''; try { why = (await res.json()).error || ''; } catch (e) {}
          if (res.status !== 401) console.warn('Premium check failed (' + res.status + '): ' + (why || 'no details') + '. Premium content stays locked until this works.');
          return false;
        }
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
