/* ══════════════════════════════════════════════════
   IT Study Hub — firebase.js
   The ONE place the Firebase project is configured. Every page does:

       import { app } from '/firebase.js';

   (This API key is meant to be public; protect it with the referrer restrictions and App Check
   described in ish-config.js, not by hiding it.)
══════════════════════════════════════════════════ */
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js';

export const firebaseConfig = {
  apiKey: "AIzaSyBTFhNaI82vjwp0kuIhkASUt4Na22OogRQ",
  authDomain: "it-study-hub.firebaseapp.com",
  projectId: "it-study-hub",
  storageBucket: "it-study-hub.firebasestorage.app",
  messagingSenderId: "566661039167",
  appId: "1:566661039167:web:122691d263631e404ea48a"
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

// App Check (does nothing until a site key is set in ish-config.js). Must start before any other
// Firebase service is used, which is why this file waits for it.
await window.ishInitAppCheck?.(app);
