/* ══════════════════════════════════════════════════
   IT Study Hub — xp-engine.js
   Shared XP / leveling engine used by all course pages.
   Wires into the existing Firestore users/{uid}.xp field
   (the same field global.html leaderboard already reads).

   Usage in a course page:
     <script type="module">
       import { initXP, awardXP, getXPState } from './xp-engine.js';
       await initXP();                     // call once on page load
       await awardXP('c_mod1_quiz', 5);     // award XP for a unique action key
     </script>
══════════════════════════════════════════════════ */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, increment } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBTFhNaI82vjwp0kuIhkASUt4Na22OogRQ",
  authDomain: "it-study-hub.firebaseapp.com",
  projectId: "it-study-hub",
  storageBucket: "it-study-hub.firebasestorage.app",
  messagingSenderId: "566661039167",
  appId: "1:566661039167:web:122691d263631e404ea48a"
};

const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser = null;
let xpState = { xp: 0, level: 1, earnedKeys: [] };
let readyResolve;
const ready = new Promise(res => { readyResolve = res; });

/* ── XP amounts (balanced against the existing 500 XP/level curve) ── */
export const XP_VALUES = {
  mcq: 5,            // one correct MCQ
  predict: 5,         // one correct "predict the output"
  challenge: 15,       // one passed code challenge (Judge0)
  moduleBonus: 10      // bonus for finishing all checks in a module
};

function levelFromXP(xp) {
  return Math.floor(xp / 500) + 1;
}

function localKey() {
  return currentUser ? `ish_xp_keys_${currentUser.uid}` : 'ish_xp_keys_guest';
}

function getEarnedKeysLocal() {
  try { return JSON.parse(localStorage.getItem(localKey()) || '[]'); }
  catch (e) { return []; }
}

function saveEarnedKeysLocal(keys) {
  localStorage.setItem(localKey(), JSON.stringify(keys));
}

/* ── Initialize: call once per page load ── */
export function initXP() {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      xpState = { xp: 0, level: 1, earnedKeys: getEarnedKeysLocal() };
      readyResolve();
      return;
    }
    try {
      const ref = doc(db, 'users', user.uid);
      const snap = await getDoc(ref);
      let xp = 100; // matches existing default on account creation
      let earnedKeys = [];
      if (snap.exists()) {
        const data = snap.data();
        xp = data.xp || 0;
        earnedKeys = data.earnedXPKeys || [];
      } else {
        await setDoc(ref, { xp: 100, earnedXPKeys: [] }, { merge: true });
      }
      xpState = { xp, level: levelFromXP(xp), earnedKeys };
    } catch (e) {
      console.warn('XP engine: Firestore read failed, falling back to local', e);
      xpState = { xp: 0, level: 1, earnedKeys: getEarnedKeysLocal() };
    }
    readyResolve();
  });
  return ready;
}

/* ── Award XP for a unique action (idempotent — same key only pays once) ── */
export async function awardXP(actionKey, amount) {
  await ready;
  if (xpState.earnedKeys.includes(actionKey)) {
    return { awarded: false, xp: xpState.xp, level: xpState.level };
  }

  const prevLevel = levelFromXP(xpState.xp);
  xpState.xp += amount;
  xpState.earnedKeys.push(actionKey);
  xpState.level = levelFromXP(xpState.xp);
  const leveledUp = xpState.level > prevLevel;

  if (currentUser) {
    try {
      const ref = doc(db, 'users', currentUser.uid);
      await updateDoc(ref, {
        xp: increment(amount),
        earnedXPKeys: xpState.earnedKeys
      });
    } catch (e) {
      console.warn('XP engine: Firestore write failed', e);
    }
  } else {
    saveEarnedKeysLocal(xpState.earnedKeys);
  }

  showXPToast(amount, leveledUp, xpState.level);
  return { awarded: true, xp: xpState.xp, level: xpState.level, leveledUp };
}

export function getXPState() {
  return { ...xpState };
}

export function hasEarned(actionKey) {
  return xpState.earnedKeys.includes(actionKey);
}

/* ── Toast UI feedback ── */
function showXPToast(amount, leveledUp, newLevel) {
  let toast = document.getElementById('xpToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'xpToast';
    toast.style.cssText = `
      position: fixed; bottom: 28px; right: 28px; z-index: 99999;
      background: linear-gradient(135deg, #c8f135, #a8e63d);
      color: #0a0a0f; font-family: 'JetBrains Mono', monospace;
      font-size: 13px; font-weight: 700; padding: 14px 20px;
      border-radius: 12px; box-shadow: 0 12px 32px rgba(200,241,53,0.35);
      transform: translateY(120px); opacity: 0; transition: all 0.4s cubic-bezier(.2,.9,.3,1.3);
      display: flex; align-items: center; gap: 10px;
    `;
    document.body.appendChild(toast);
  }
  toast.innerHTML = leveledUp
    ? `🎉 +${amount} XP — Level Up! Now Lv ${newLevel}`
    : `⚡ +${amount} XP`;
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
  clearTimeout(showXPToast._t);
  showXPToast._t = setTimeout(() => {
    toast.style.transform = 'translateY(120px)';
    toast.style.opacity = '0';
  }, 2600);
}
