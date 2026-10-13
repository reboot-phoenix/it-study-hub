/* ══════════════════════════════════════════════════
   IT Study Hub — premium-content.js
   Fetches premium lessons and PDFs from the Worker. The Worker checks the
   signed-in user's plan on every request, so editing localStorage or the
   page's JavaScript cannot unlock anything.

   Plans: Pro, Elite and admins open every course. Starter opens two courses the buyer picks once.

   Exposes (on window):
     ishAccess()                     → Promise<boolean>  does this user have an active paid plan now?
     ishHasCourse(course)            → boolean (sync, after ishAccess)  can this user open this course's premium modules?
     ishLocked(course)               → what to do when someone clicks a locked module: pricing page, the Starter
                                       course picker, or a "not in your plan" message
     loadPremiumLesson(course, id)   → Promise<{ok:true, data} | {ok:false, status, code?}>
     openPremiumPdf(file)            → opens a premium PDF in a new tab
     __ishPremium                    → last known "has an active plan" (true / false), for sync UI checks
     __ishAccess                     → last answer from /api/access: { premium, plan, courses, mayChoose, expiresAt }
══════════════════════════════════════════════════ */
(function () {
  window.__ishPremium = false;
  window.__ishAccess = { premium: false, plan: '', courses: [], mayChoose: false, expiresAt: null };

  const COURSE_NAMES = { java: 'Java', c: 'C', cpp: 'C++', r: 'R', javascript: 'JavaScript', python: 'Python' };

  // Calls our Worker with the signed-in user's token (see /auth.js). Not signed in -> a 401 response.
  async function apiCall(path, opts) {
    try {
      const { apiFetch } = await import('/auth.js');
      return await apiFetch(path, opts);
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }
  const apiGet = (path) => apiCall(path);

  function applyAccess(data) {
    const next = {
      premium: data.premium === true,
      plan: data.plan || '',
      courses: Array.isArray(data.courses) ? data.courses : [],
      mayChoose: data.mayChoose === true,
      expiresAt: data.expiresAt || null,
    };
    const changed = JSON.stringify(next) !== JSON.stringify(window.__ishAccess);
    window.__ishAccess = next;
    window.__ishPremium = next.premium;
    // Premium PDF tiles on course pages: drop the lock once this plan covers the course.
    document.querySelectorAll('.premium-mat[data-course]').forEach((tile) => {
      const open = window.ishHasCourse(tile.getAttribute('data-course'));
      const action = tile.querySelector('.mat-action');
      if (!action) return;
      if (open && !action.hasAttribute('data-locked-html')) { action.setAttribute('data-locked-html', action.innerHTML); action.classList.remove('locked'); action.textContent = '\u2193 PDF'; }
      else if (!open && action.hasAttribute('data-locked-html')) { action.innerHTML = action.getAttribute('data-locked-html'); action.removeAttribute('data-locked-html'); action.classList.add('locked'); }
    });
    // Cards and sidebar were drawn as "locked" before we knew; redraw once.
    if (changed && typeof window.renderIndex === 'function') window.renderIndex();
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
        applyAccess(await res.json().catch(() => ({})));
        return window.__ishPremium;
      })();
    }
    return accessPromise;
  };

  window.ishHasCourse = function (course) {
    return window.__ishAccess.courses.indexOf(course) !== -1;
  };

  window.loadPremiumLesson = async function (course, id) {
    document.body.style.cursor = 'progress';
    try {
      const res = await apiGet('/api/lesson?course=' + encodeURIComponent(course) + '&id=' + encodeURIComponent(id));
      if (!res.ok) {
        let code = '';
        try { code = (await res.json()).code || ''; } catch (e) {}
        return { ok: false, status: res.status, code };
      }
      const data = await res.json();
      if (!window.ishHasCourse(course)) { accessPromise = null; window.ishAccess(); }   // our copy was out of date; refresh it
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
      let code = ''; try { code = (await res.json()).code || ''; } catch (e) {}
      if (res.status === 403 && code) {
        // The plan is fine; this particular course is not part of it (Starter), or the picker has not been used yet.
        const course = /^IT_Study_Hub_Java_/.test(file) ? 'java' : /^IT_Study_Hub_C_/.test(file) ? 'c' : /^IT_Study_Hub_Cpp_/.test(file) ? 'cpp' : /^IT_Study_Hub_JavaScript_/.test(file) ? 'javascript' : /^IT_STUDY_HUB_R_/.test(file) ? 'r' : '';
        window.ishLocked(course);
      } else if (res.status === 401 || res.status === 403) {
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

  /* ───────────── what to do when a locked module is clicked ───────────── */

  window.ishLocked = async function (course) {
    const premium = await window.ishAccess();
    const a = window.__ishAccess;
    if (!premium) { window.location.href = 'premium.html'; return; }          // no plan (or signed out)
    if (a.mayChoose) { openPicker(course); return; }                           // Starter, nothing chosen yet
    if (window.ishHasCourse(course)) { if (typeof window.renderIndex === 'function') window.renderIndex(); return; }   // page was stale; redraw
    openNotice(a.courses);                                                     // Starter, but a different course
  };

  // Course-page helper: a lesson request was refused. Say why instead of just bouncing to the pricing page.
  window.ishLessonDenied = function (result, course) {
    if (result && result.status === 403 && result.code) { accessPromise = null; window.ishAccess().then(() => window.ishLocked(course)); return; }
    window.location.href = 'premium.html';
  };

  /* ───────────── small dialogs (self-contained styles) ───────────── */

  function dialog(html) {
    closeDialog();
    const wrap = document.createElement('div');
    wrap.id = 'ishDialog';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
    wrap.innerHTML = '<div style="max-width:440px;width:100%;background:#12121a;color:#f0f0f5;border:1px solid rgba(200,241,53,.25);border-radius:14px;padding:24px;font:15px/1.5 \'DM Sans\',system-ui,sans-serif;max-height:90vh;overflow:auto;">' + html + '</div>';
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeDialog(); });
    document.addEventListener('keydown', escClose);
    document.body.appendChild(wrap);
    return wrap;
  }
  function escClose(e) { if (e.key === 'Escape') closeDialog(); }
  function closeDialog() {
    const old = document.getElementById('ishDialog');
    if (old) old.remove();
    document.removeEventListener('keydown', escClose);
  }
  const btn = (primary) => 'cursor:pointer;border-radius:8px;padding:10px 16px;font-weight:600;font-size:14px;font-family:inherit;border:1px solid ' + (primary ? '#c8f135;background:#c8f135;color:#0a0a0f' : 'rgba(255,255,255,.2);background:transparent;color:#f0f0f5');

  function openNotice(courses) {
    const names = courses.map((c) => COURSE_NAMES[c] || c).join(' and ');
    const w = dialog(
      '<h2 style="margin:0 0 8px;font-size:20px">Not part of your Starter plan</h2>' +
      '<p style="margin:0 0 18px;opacity:.85">Your Starter plan unlocks <b>' + (names || 'two courses') + '</b>. Pro unlocks all six courses.</p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button id="ishClose" style="' + btn(false) + '">Close</button>' +
      '<button id="ishUp" style="' + btn(true) + '">See Pro</button></div>');
    w.querySelector('#ishClose').onclick = closeDialog;
    w.querySelector('#ishUp').onclick = () => { window.location.href = 'premium.html'; };
    w.querySelector('#ishUp').focus();
  }

  function openPicker(preselect) {
    const boxes = Object.keys(COURSE_NAMES).map((c) =>
      '<label style="display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid rgba(255,255,255,.12);border-radius:8px;margin-bottom:8px;cursor:pointer">' +
      '<input type="checkbox" value="' + c + '"' + (c === preselect ? ' checked' : '') + '> ' + COURSE_NAMES[c] + '</label>').join('');
    const w = dialog(
      '<h2 style="margin:0 0 6px;font-size:20px">Choose your 2 Starter courses</h2>' +
      '<p style="margin:0 0 14px;opacity:.85">Pick the two courses you want to unlock. <b>This choice is final</b> for this plan.</p>' +
      boxes +
      '<p id="ishPickMsg" role="status" style="min-height:20px;margin:6px 0 12px;color:#ff8a8a"></p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap"><button id="ishCancel" style="' + btn(false) + '">Cancel</button>' +
      '<button id="ishSave" style="' + btn(true) + '">Unlock these two</button></div>');
    const msg = w.querySelector('#ishPickMsg');
    const picked = () => Array.from(w.querySelectorAll('input:checked')).map((i) => i.value);
    w.addEventListener('change', (e) => {
      const p = picked();
      if (p.length > 2) { e.target.checked = false; msg.textContent = 'Starter includes exactly 2 courses.'; } else msg.textContent = '';
    });
    w.querySelector('#ishCancel').onclick = closeDialog;
    w.querySelector('#ishSave').onclick = async () => {
      const p = picked();
      if (p.length !== 2) { msg.textContent = 'Please choose exactly 2 courses.'; return; }
      const save = w.querySelector('#ishSave'); save.disabled = true; save.textContent = 'Saving…';
      const res = await apiCall('/api/starter-courses', { method: 'POST', body: { courses: p } });
      if (res.ok) { accessPromise = null; await window.ishAccess(); closeDialog(); return; }
      let why = ''; try { why = (await res.json()).error || ''; } catch (e) {}
      msg.textContent = why || 'Could not save. Please try again.';
      save.disabled = false; save.textContent = 'Unlock these two';
    };
  }

  // Start checking right away so cards unlock without needing a click.
  window.ishAccess();
})();
