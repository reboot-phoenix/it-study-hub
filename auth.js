/* ══════════════════════════════════════════════════
   IT Study Hub — auth.js
   Shared sign-in helpers, so no page re-implements them.

   In a module script:   import { auth, getIdToken, apiFetch, signOutEverywhere } from '/auth.js';
   In a classic script:  window.ishAuth.apiFetch(...)   (available once this module has loaded)

     auth                     the Firebase Auth instance
     getIdToken()             a fresh ID token, or null if nobody is signed in
     apiFetch(path, opts)     calls our Worker (/api/...) with the token attached. opts: { method, body }
                              (body is sent as JSON). Not signed in -> a 401 Response, no request is made.
     signOutEverywhere(opts)  signs out, clears the cached session, then goes to opts.redirect (default index.html)
     readSession / writeSession / mergeSession / clearSession
                              the 'ish_session' cache used for a fast first paint. It is a convenience only:
                              nothing in it is trusted for security (the Worker and Firestore rules decide).
══════════════════════════════════════════════════ */
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import { app } from '/firebase.js';

export const auth = getAuth(app);

export const SESSION_KEY = 'ish_session';

export function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}
export function writeSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}
export function mergeSession(patch) {
  writeSession({ ...(readSession() || {}), ...patch });
}
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

export async function getIdToken() {
  try {
    await auth.authStateReady();                       // waits until Firebase has restored the saved login
    return auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch (e) { return null; }
}

export async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = await getIdToken();
  if (!token) {
    return new Response(JSON.stringify({ error: 'Please sign in first.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function signOutEverywhere({ redirect = 'index.html' } = {}) {
  clearSession();
  try { await signOut(auth); } catch (e) { /* still leave the page */ }
  if (redirect) window.location.href = redirect;
}

// Classic (non-module) scripts, such as the course pages' run buttons, use this.
window.ishAuth = { auth, getIdToken, apiFetch, signOutEverywhere, readSession, writeSession, mergeSession, clearSession };
