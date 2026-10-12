# IT Study Hub: handoff for a fresh chat

## How we work
- Owner: Ashtid. Prefers short, direct answers. Uploads each finished file one by one; does the dashboard/secret setup only after all 22 tasks (tracked in the task list page: https://claude.ai/artifact/D3nScAUP7GDTkHAFgyLSk2, Phase 5 = his setup steps).
- Run `npm test` after every change (Worker + shared-module tests). Page-level checks were done with jsdom.

## Done (tasks 1-13 + leaderboard split)
1. Firestore/Storage rules (firestore.rules, storage.rules): clients cannot write plan, role, xp, earnedXPKeys, quiz*; users/{uid} readable only by owner/admin; leaderboard/{uid} public read, Worker-only write; size/shape limits on profile text.
2-3. Payments verified server-side in worker.js (/api/create-order, /api/verify-payment, /api/razorpay-webhook). Prices are server-side.
4-5. Premium lessons and PDFs live in Cloudflare KV (binding PREMIUM; export in premium-export/kv-bulk.json, NEVER commit). Worker routes /api/access, /api/lesson, /api/pdf. Pages use premium-content.js.
6. XP only via /api/award-xp (quiz first 100, perfect 50 once, improve 25 up to 3; practice 10 per real problem).
7. Admin = users/{uid}.role == "admin" only (scripts/grant-admin.mjs). No emails in code.
8. IP gate removed. 9. XSS: ish-safe.js (esc, num, safeUrl, safeImgUrl), rules limits, Worker avatar URL allowlist.
10. CSP/COOP in _headers fixed for Firebase popup, Turnstile, Razorpay, Monaco. 11. App Check wired (off until site key in ish-config.js); Worker reads profiles with the service account. 12. /api/run proxies Judge0 (sign-in required, 60/min).
13. firebase.js (single config) + auth.js (getIdToken, apiFetch, signOutEverywhere, session helpers; window.ishAuth for classic scripts).
Extras: leaderboard split (/api/sync-profile, /api/admin/rebuild-leaderboard, ish-sync.js), fileshare PDF links now /pdf/...

Email sign-in is now a 6-digit code (Login.html + /api/otp/request, /api/otp/verify in worker.js): Turnstile verified server-side, codes stored only as keyed hashes in Firestore loginCodes/{sha256(email)}, 10 min expiry, 5 tries, single use, then a Firebase custom token (service account needs the Firebase Authentication Admin role). Email goes out through a Google Apps Script relay (mail-relay.gs; Worker secrets MAIL_RELAY_URL + MAIL_RELAY_SECRET; sends from the owner's Gmail, ~100/day, no domain needed) because Resend and similar services refuse free dpdns.org domains. Resend (EMAIL_FROM + RESEND_API_KEY) and a Cloudflare EMAIL binding still work if ever wanted. The old magic-link flow is removed. Needs setup: OTP_SECRET, TURNSTILE_SECRET, MAIL_RELAY_URL, MAIL_RELAY_SECRET, FIREBASE_SERVICE_ACCOUNT. Owner has no terminal: all setup is via the Cloudflare/Google/GitHub websites.
Login hardening (after launch reports): clearer errors (quota, popup, account-exists), Turnstile failures no longer strand users, in-page email form when a sign-in link is opened on another device, 60 s resend cooldown. Root causes were dashboard settings: Google consent screen in Testing mode ("Access blocked") and Firebase Spark limit of 5 email-link emails/day.

Setup check: GET /api/setup-check with header X-Setup-Key = OTP_SECRET reports each secret, role and service (service account, Firestore, Firebase user management, Turnstile secret, Gmail relay ping) without revealing values. Console snippet:
fetch('/api/setup-check',{headers:{'X-Setup-Key':'PASTE_OTP_SECRET'}}).then(r=>r.json()).then(j=>{console.log('ready:',j.ready);console.table(Object.entries(j.checks).map(([k,v])=>({check:k,ok:v.ok,detail:v.detail})))})

## Left to do
14. Course pages load lessons/quizzes from /data/<course>.json instead of 30-225 KB inline HTML (java.html, c.html, c++.html, r.html, javascript.html, python.html; scripts/extract-premium.mjs already parses MODS safely).
15. Move PDFs to R2/Storage and dedupe overlapping ranges (JAVA 29-72 vs 56-96).
16. Plan logic: Starter = any 2 courses, expiry from planExpiresAt in UI.
(17-21 are DONE: meta/OG/canonical + noindex on private pages, sitemap rebuilt by scripts/build-sitemap.mjs with per-article entries and extension-less URLs, keyboard/cursor helpers ish-a11y.js and ish-cursor-guard.js, social image cropped to 107 KB, README rewritten, site.test.mjs added.)
Open question for owner: c.html has 3 dead PDF links (C_Basics_Notes.pdf, C_Functions_Arrays.pdf, C_Pointers.pdf; files do not exist).

## Assumptions made (confirm if wrong)
- Premium PDFs: Java 97+, C modules 9-12, C++ 67+. Any active plan unlocks all premium content. Hosting is Cloudflare Workers + static assets (wrangler.toml).
- Known harmless quirk: R module 9 lesson has unescaped backticks (shows `reduce(1:5, )`).
