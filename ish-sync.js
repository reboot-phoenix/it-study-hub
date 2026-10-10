/* ══════════════════════════════════════════════════
   IT Study Hub — ish-sync.js
   Asks the Worker to refresh your public leaderboard entry (name, XP, photo, solved count).
   Other students can only ever see that entry, never your full profile.

     ishSyncProfile(user)          once per browser session (cheap to call on every page load)
     ishSyncProfile(user, true)    right now, e.g. after you change your name or photo
══════════════════════════════════════════════════ */
window.ishSyncProfile = async function (user, force) {
  try {
    if (!user) return;
    const key = 'ish_lb_synced_' + user.uid;
    if (!force && sessionStorage.getItem(key)) return;
    const token = await user.getIdToken();
    const res = await fetch('/api/sync-profile', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) sessionStorage.setItem(key, '1');
  } catch (e) { /* leaderboard sync is best effort */ }
};
