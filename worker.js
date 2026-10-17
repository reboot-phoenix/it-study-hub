// IT Study Hub: Cloudflare Worker
//
// Routes
//   POST /api/create-order      signed-in user asks to buy a plan; we create the Razorpay order
//   POST /api/verify-payment    browser reports a finished payment; we verify it and activate the plan
//   POST /api/razorpay-webhook  Razorpay tells us a payment was captured (backup if the browser closes)
//   GET  /api/access            does the signed-in user currently have premium access?
//   GET  /api/lesson?course=&id=  premium lesson text (only for users with an active plan)
//   GET  /api/pdf?f=<file>      premium PDF (only for users with an active plan)
//   POST /api/starter-courses   a Starter buyer picks their two courses (once)
//   POST /api/award-xp          the only way XP changes: quiz results and practice solves
//   GET  /api/module-progress?course=  which module quizzes the signed-in user has passed (75%+)
//   POST /api/module-quiz       records a module quiz result; a module needs the previous module's quiz passed
//   GET  /api/setup-check       owner-only checklist: which secrets and permissions are working (header X-Setup-Key = OTP_SECRET)
//   POST /api/otp/request       emails a 6-digit sign-in code (Turnstile-checked, rate-limited)
//   POST /api/otp/verify        checks the code and returns a Firebase custom token for that email's account
//   POST /api/run               runs student code on Judge0 (signed-in users only, size- and rate-limited)
//   POST /api/sync-profile      copies the public bits of a profile (name, xp, photo, solved) to leaderboard/{uid}
//   POST /api/admin/rebuild-leaderboard   admins only: rebuilds leaderboard/ from users/ (run once after deploying)
//   everything else             static files
//
// Secrets (set with `wrangler secret put <NAME>`; never commit them):
//   RAZORPAY_KEY_SECRET       Razorpay dashboard > API keys
//   RAZORPAY_WEBHOOK_SECRET   the secret you type when creating the webhook
//   FIREBASE_SERVICE_ACCOUNT  full JSON of a service account key with Cloud Datastore User role
// Plain var (in wrangler.toml or dashboard):
//   RAZORPAY_KEY_ID           rzp_test_... or rzp_live_...  (public key id)
//   JUDGE0_URL                code runner base URL (default https://ce.judge0.com)
//   EMAIL_FROM                sender for sign-in codes, e.g. "IT Study Hub <login@itstudyhub.dpdns.org>" (must be a verified domain)
// Secrets for email-code sign-in:
//   OTP_SECRET                any long random string; keys the hashing of codes
//   TURNSTILE_SECRET          the Turnstile widget's secret key (verifies the check on the server)
//   MAIL_RELAY_URL            web-app URL of the Google Apps Script in mail-relay.gs (sends from your Gmail; no domain needed)
//   MAIL_RELAY_SECRET         the same long random string you put in that script
//   (alternatively RESEND_API_KEY + EMAIL_FROM with a verified domain, or a Cloudflare EMAIL binding)
// Optional secret:
//   JUDGE0_KEY                RapidAPI key, if you use a paid/hosted Judge0 instead of the free public one
// Optional binding:
//   RUN_LIMITER               a Cloudflare Rate Limiting binding for /api/run (see wrangler.toml)
// KV namespace binding:
//   PREMIUM                   holds premium lesson text ("lesson:<course>:<id>"), premium quizzes ("quiz:<course>:<id>") and PDFs ("pdf:<file>")

const PROJECT_ID = "it-study-hub";

// Server-side source of truth for prices. The browser never sends an amount.
const PLANS = {
  basic: { name: "Starter", price: 199, months: 6, rank: 1, courses: 2 },   // courses: how many courses it unlocks (absent = all six)
  pro:   { name: "Pro",     price: 499, months: 12, rank: 2 },
  elite: { name: "Elite",   price: 999, months: null, rank: 3 }, // lifetime
};

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/* ───────────────────────── small helpers ───────────────────────── */

const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string comparison.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request, maxBytes = 4096) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON"); }
}

/* ───────────────── Firebase ID token verification ───────────────── */

let jwksCache = { keys: null, exp: 0 };

async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.exp) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new HttpError(503, "Auth keys unavailable");
  const data = await res.json();
  jwksCache = { keys: data.keys, exp: Date.now() + 60 * 60 * 1000 };
  return data.keys;
}

// Returns the Firebase uid of the caller, or throws 401.
export async function requireUser(request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Sign in required");

  let head, payload;
  try {
    head = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch { throw new HttpError(401, "Invalid token"); }

  if (head.alg !== "RS256" || !head.kid) throw new HttpError(401, "Invalid token");

  const jwk = (await getJwks()).find((k) => k.kid === head.kid);
  if (!jwk) throw new HttpError(401, "Invalid token");

  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), enc.encode(parts[0] + "." + parts[1])
  );
  if (!ok) throw new HttpError(401, "Invalid token");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID || payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new HttpError(401, "Invalid token");
  if (!payload.exp || payload.exp < now) throw new HttpError(401, "Session expired, sign in again");
  if (payload.iat && payload.iat > now + 60) throw new HttpError(401, "Invalid token");
  if (!payload.sub) throw new HttpError(401, "Invalid token");
  return payload.sub;
}

/* ─────────────── Firestore via service account (REST) ─────────────── */

let tokenCache = { token: null, exp: 0 };

export async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(503, "Server setup incomplete: the FIREBASE_SERVICE_ACCOUNT secret is not set on the Worker");
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token",
    iat, exp: iat + 3600,
  };
  const unsigned = bytesToB64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." +
                   bytesToB64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const assertion = unsigned + "." + bytesToB64url(sig);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error("Could not get Google access token: " + res.status);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in - 120) * 1000 };
  return tokenCache.token;
}

async function fsFetch(env, path, init = {}, query = "") {
  const token = await getAccessToken(env);
  return fetch(`${FS_BASE}/${path}${query}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function getUserPlan(env, uid) {
  const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore read failed: " + res.status);
  const doc = await res.json();
  return doc.fields?.plan?.stringValue || "";
}

async function activatePlan(env, uid, planId, paymentId, orderId) {
  const plan = PLANS[planId];
  const now = new Date();
  let expiresAt = null;
  if (plan.months) { expiresAt = new Date(now); expiresAt.setUTCMonth(expiresAt.getUTCMonth() + plan.months); }

  const fields = {
    plan: { stringValue: planId },
    planActivatedAt: { timestampValue: now.toISOString() },
    razorpayPaymentId: { stringValue: paymentId },
    razorpayOrderId: { stringValue: orderId },
  };
  const mask = ["plan", "planActivatedAt", "razorpayPaymentId", "razorpayOrderId", "planExpiresAt"];
  if (expiresAt) fields.planExpiresAt = { timestampValue: expiresAt.toISOString() }; // absent + in mask = cleared (lifetime)

  const query = "?" + mask.map((m) => `updateMask.fieldPaths=${m}`).join("&") + "&currentDocument.exists=true";
  const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`, { method: "PATCH", body: JSON.stringify({ fields }) }, query);
  if (!res.ok) throw new Error("Firestore plan update failed: " + res.status + " " + (await res.text()));
}

// Private ledger (no client access: rules deny everything except /users). Best effort.
async function recordPayment(env, p) {
  const fields = {
    uid: { stringValue: p.uid }, planId: { stringValue: p.planId },
    amount: { integerValue: String(p.amount) }, orderId: { stringValue: p.orderId },
    source: { stringValue: p.source }, createdAt: { timestampValue: new Date().toISOString() },
  };
  const res = await fsFetch(env, `payments/${encodeURIComponent(p.paymentId)}`, { method: "PATCH", body: JSON.stringify({ fields }) },
    "?currentDocument.exists=false&" + Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&"));
  if (!res.ok && res.status !== 409) console.error("Ledger write failed", res.status);
}

/* ─────────────────────────── Razorpay ─────────────────────────── */

async function rzp(env, path, init = {}) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay ${path} failed: ${res.status} ${JSON.stringify(data.error || data)}`);
  return data;
}

// Confirms with Razorpay itself that this payment is real, captured, for the right order and amount,
// then activates the plan. Safe to call repeatedly (browser verify and webhook can both arrive).
export async function settlePayment(env, orderId, paymentId, source, expectUid) {
  let payment = await rzp(env, `/payments/${encodeURIComponent(paymentId)}`);
  if (payment.order_id !== orderId) throw new HttpError(400, "Payment does not belong to this order");

  if (payment.status === "authorized") {
    payment = await rzp(env, `/payments/${encodeURIComponent(paymentId)}/capture`, {
      method: "POST", body: JSON.stringify({ amount: payment.amount, currency: payment.currency }),
    });
  }
  if (payment.status !== "captured") throw new HttpError(402, "Payment not completed");

  const order = await rzp(env, `/orders/${encodeURIComponent(orderId)}`);
  const uid = order.notes?.uid;
  const planId = order.notes?.planId;
  const plan = PLANS[planId];
  if (!uid || !plan) throw new HttpError(400, "Order has no valid plan");
  if (expectUid && uid !== expectUid) throw new HttpError(403, "This order belongs to another account");
  if (order.amount !== plan.price * 100 || payment.amount !== order.amount || payment.currency !== "INR") {
    throw new HttpError(400, "Amount mismatch");
  }

  const current = await getUserPlan(env, uid);
  if (current === null) throw new HttpError(404, "User profile not found");
  // Never downgrade (e.g. someone who bought Elite then pays for Starter).
  if (!current || (PLANS[current]?.rank || 0) <= plan.rank) {
    await activatePlan(env, uid, planId, paymentId, orderId);
  }
  await recordPayment(env, { uid, planId, amount: order.amount, orderId, paymentId, source });
  return { uid, planId };
}

/* ───────────────────────── XP (server-owned) ───────────────────────── */
// Firestore rules forbid browsers from writing `xp`, so every point comes through here.
// The server decides what each action is worth and pays each one at most once.

const QUIZ_SUBJECTS = new Set(["c", "java", "python", "cpp", "r", "js"]);
const XP_RULES = { quizFirst: 100, quizPerfect: 50, quizImprove: 25, quizImproveMax: 3, practiceSolve: 10 };

// Every real practice problem id (from practice-panel.html). worker.test.mjs fails if this list
// drifts from the page, so adding a problem without adding it here is caught.
export const PRACTICE_IDS = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15", "cpp1", "cpp2", "cpp3", "cpp4", "cpp5", "cpp6", "cpp7", "cpp8", "cpp9", "cpp10", "cpp11", "cpp12", "j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9", "j10", "j11", "j12", "j13", "py1", "py2", "py3", "py4", "py5", "py6", "py7", "py8", "py9", "py10", "py11", "py12", "py13", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "js1", "js2", "js3", "js4", "js5", "js6", "js7", "js8", "js9", "js10", "js11", "js12"]);

const numOf = (v) => (v && (v.integerValue !== undefined ? Number(v.integerValue) : v.doubleValue !== undefined ? Number(v.doubleValue) : undefined));
const intVal = (n) => ({ integerValue: String(n) });
const mapEntry = (fields, mapName, key) => fields[mapName]?.mapValue?.fields?.[key];

// Reads the user doc, lets `compute` decide what to award, and writes it back only if nobody
// else changed the doc in between (updateTime precondition), retrying a few times if they did.
async function awardXp(env, uid, compute) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
    if (res.status === 404) throw new HttpError(404, "Open your profile once first");
    if (!res.ok) throw new Error("Firestore read failed: " + res.status);
    const doc = await res.json();
    const fields = doc.fields || {};
    const xpNow = numOf(fields.xp) || 0;

    const plan = compute(fields);
    if (!plan.delta && !(plan.mask && plan.mask.length)) return { awarded: 0, xp: xpNow, breakdown: [] };

    const body = { fields: { xp: intVal(xpNow + plan.delta), ...plan.fields } };
    const mask = ["xp", ...plan.mask].map((m) => `updateMask.fieldPaths=${m}`).join("&");
    const patch = await fsFetch(env, `users/${encodeURIComponent(uid)}`, { method: "PATCH", body: JSON.stringify(body) },
      `?${mask}&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`);
    if (patch.ok) {
      try { await writeLeaderboard(env, uid, { ...fields, xp: intVal(xpNow + plan.delta) }); }
      catch (e) { console.error("Leaderboard sync failed", e.message); }   // never fail an award over this
      return { awarded: plan.delta, xp: xpNow + plan.delta, breakdown: plan.breakdown };
    }

    const text = await patch.text();
    if (!/FAILED_PRECONDITION|ABORTED/.test(text)) throw new Error("Firestore xp update failed: " + patch.status + " " + text);
    // someone else wrote the doc a moment ago: read it again and recompute
  }
  throw new HttpError(409, "Busy, please try again");
}

function planQuiz(subject, score, total) {
  const pct = Math.round((score / total) * 100);
  return (f) => {
    // Only the server's own records count. Scores saved by the browser are never used to decide XP,
    // so people who took quizzes before this change get one catch-up payment per subject, and a
    // failed request is simply paid on the next attempt.
    const best = numOf(mapEntry(f, "quizBest", subject));
    const perfectPaid = mapEntry(f, "quizPerfect", subject)?.booleanValue === true;
    const improves = numOf(mapEntry(f, "quizImprove", subject)) || 0;

    const out = { delta: 0, fields: {}, mask: [], breakdown: [] };
    const add = (reason, amount) => { out.delta += amount; out.breakdown.push({ reason, amount }); };

    if (best === undefined) add("First attempt", XP_RULES.quizFirst);
    if (pct === 100 && !perfectPaid) {
      add("Perfect score", XP_RULES.quizPerfect);
      out.fields.quizPerfect = { mapValue: { fields: { [subject]: { booleanValue: true } } } };
      out.mask.push(`quizPerfect.${subject}`);
    }
    if (best !== undefined && pct > best && improves < XP_RULES.quizImproveMax) {
      add("Improved score", XP_RULES.quizImprove);
      out.fields.quizImprove = { mapValue: { fields: { [subject]: intVal(improves + 1) } } };
      out.mask.push(`quizImprove.${subject}`);
    }
    if (best === undefined || pct > best) {
      out.fields.quizBest = { mapValue: { fields: { [subject]: intVal(pct) } } };
      out.mask.push(`quizBest.${subject}`);
    }
    return out;   // a new best is still saved when no XP is due (e.g. the improvement allowance is used up)
  };
}

function planPractice(problemId) {
  const key = `practice:${problemId}`;
  return (f) => {
    const keys = (f.earnedXPKeys?.arrayValue?.values || []).map((v) => v.stringValue);
    if (keys.includes(key)) return { delta: 0 };
    return {
      delta: XP_RULES.practiceSolve,
      mask: ["earnedXPKeys"],
      fields: { earnedXPKeys: { arrayValue: { values: [...keys, key].map((k) => ({ stringValue: k })) } } },
      breakdown: [{ reason: "Practice problem solved", amount: XP_RULES.practiceSolve }],
    };
  };
}

async function awardXpRoute(request, env) {
  const uid = await requireUser(request);
  const body = await readJson(request);

  if (body.type === "quiz") {
    const { subject, score, total } = body;
    if (!QUIZ_SUBJECTS.has(subject) || !Number.isInteger(score) || !Number.isInteger(total) || total < 1 || total > 100 || score < 0 || score > total) {
      throw new HttpError(400, "Bad quiz result");
    }
    return json(await awardXp(env, uid, planQuiz(subject, score, total)));
  }
  if (body.type === "practice") {
    if (typeof body.problemId !== "string" || !PRACTICE_IDS.has(body.problemId)) throw new HttpError(400, "Unknown problem");
    return json(await awardXp(env, uid, planPractice(body.problemId)));
  }
  throw new HttpError(400, "Unknown award type");
}


/* ───────────────────────── Module quizzes (pass mark unlocks the next module) ───────────────────────── */
// users/{uid}.moduleQuiz = { r1: 88, r2: 75, ... } is the best percent per module. Browsers cannot write it
// (it is not in clientFields in firestore.rules), so the pass record belongs to the server.
// Like /api/award-xp, the score itself is reported by the page; what the server adds is the order:
// module N is only recorded once module N-1 is passed, and premium lessons check it too.
const MODULE_QUIZ_COURSES = new Set(["r", "c", "java", "python", "javascript"]);   // C++ joins once its notes and quizzes exist
const MODULE_PASS_PERCENT = 75;
const moduleKey = (course, n) => `${course}${n}`;
const passedPercent = (fields, course, n) => numOf(mapEntry(fields, "moduleQuiz", moduleKey(course, n))) ?? null;
const hasPassed = (fields, course, n) => (passedPercent(fields, course, n) ?? -1) >= MODULE_PASS_PERCENT;

async function readUserFields(env, uid) {
  const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
  if (res.status === 404) return { fields: {}, doc: null };
  if (!res.ok) throw new Error("Firestore read failed: " + res.status);
  const doc = await res.json();
  return { fields: doc.fields || {}, doc };
}

async function moduleProgressRoute(request, env) {
  const uid = await requireUser(request);
  const course = new URL(request.url).searchParams.get("course") || "";
  if (!MODULE_QUIZ_COURSES.has(course)) throw new HttpError(400, "Bad course");
  const { fields } = await readUserFields(env, uid);
  const best = {};
  for (let n = 1; n <= 99; n++) { const p = passedPercent(fields, course, n); if (p !== null) best[n] = p; }
  return json({ course, pass: MODULE_PASS_PERCENT, best });
}

async function moduleQuizRoute(request, env) {
  const uid = await requireUser(request);
  const body = await readJson(request);
  const { course, module: n, score, total } = body;
  if (!MODULE_QUIZ_COURSES.has(course) || !Number.isInteger(n) || n < 1 || n > 99
      || !Number.isInteger(score) || !Number.isInteger(total) || total < 1 || total > 50 || score < 0 || score > total) {
    throw new HttpError(400, "Bad quiz result");
  }
  const pct = Math.round((score / total) * 100);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
    if (res.status === 404) throw new HttpError(404, "Open your profile once first");
    if (!res.ok) throw new Error("Firestore read failed: " + res.status);
    const doc = await res.json();
    const fields = doc.fields || {};
    if (n > 1 && !hasPassed(fields, course, n - 1)) {
      const e = new HttpError(403, `Pass the Module ${n - 1} quiz first`);
      e.extra = { code: "quiz_locked", needs: n - 1 };
      throw e;
    }
    const before = passedPercent(fields, course, n);
    const best = Math.max(before ?? 0, pct);
    const out = { course, module: n, percent: pct, best, passed: best >= MODULE_PASS_PERCENT, thisAttemptPassed: pct >= MODULE_PASS_PERCENT };
    if (before !== null && best === before) return json(out);   // not a new best: nothing to write
    const key = moduleKey(course, n);
    const patch = await fsFetch(env, `users/${encodeURIComponent(uid)}`,
      { method: "PATCH", body: JSON.stringify({ fields: { moduleQuiz: { mapValue: { fields: { [key]: intVal(best) } } } } }) },
      `?updateMask.fieldPaths=${encodeURIComponent("moduleQuiz." + key)}&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`);
    if (patch.ok) return json(out);
    const text = await patch.text();
    if (!/FAILED_PRECONDITION|ABORTED/.test(text)) throw new Error("Firestore module quiz update failed: " + patch.status + " " + text);
  }
  throw new HttpError(409, "Busy, please try again");
}

/* ───────────────────────── Run student code ───────────────────────── */
// The browser never talks to the code runner directly: keys stay here, only signed-in students can
// use it, and size and rate limits protect the (free) quota.

const RUN_LANGS = { c: 50, cpp: 54, java: 62, python: 71, r: 80, javascript: 63 };   // Judge0 language ids
export const RUN_LIMIT = { perMinute: 60 };   // a Submit runs every test case, one call each
const MAX_CODE = 64 * 1024, MAX_STDIN = 16 * 1024;
const runHits = new Map();   // per-isolate fallback limiter: uid -> recent timestamps

function utf8ToB64(str) {
  let bin = "";
  for (const b of enc.encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToUtf8(b64) {
  if (!b64) return "";
  const bin = atob(b64);   // atob ignores the newlines Judge0 adds
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function allowRun(env, uid) {
  if (env.RUN_LIMITER?.limit) return (await env.RUN_LIMITER.limit({ key: uid })).success;
  const now = Date.now();
  const recent = (runHits.get(uid) || []).filter((t) => now - t < 60000);
  if (recent.length >= RUN_LIMIT.perMinute) { runHits.set(uid, recent); return false; }
  recent.push(now); runHits.set(uid, recent);
  if (runHits.size > 5000) for (const [k, v] of runHits) if (!v.some((t) => now - t < 60000)) runHits.delete(k);
  return true;
}

async function runRoute(request, env) {
  const uid = await requireUser(request);
  const { language, code, stdin } = await readJson(request, MAX_CODE + MAX_STDIN + 1024);
  const languageId = RUN_LANGS[language];
  if (!languageId) throw new HttpError(400, "Unsupported language");
  if (typeof code !== "string" || !code.trim()) throw new HttpError(400, "Write some code first");
  if (code.length > MAX_CODE) throw new HttpError(413, "Your code is too long to run (64 KB max)");
  if (stdin !== undefined && typeof stdin !== "string") throw new HttpError(400, "Input must be text");
  if (stdin && stdin.length > MAX_STDIN) throw new HttpError(413, "Your input is too long (16 KB max)");
  if (!(await allowRun(env, uid))) throw new HttpError(429, "You are running code too quickly. Wait a few seconds and try again.");

  const base = (env.JUDGE0_URL || "https://ce.judge0.com").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (env.JUDGE0_KEY) { headers["X-RapidAPI-Key"] = env.JUDGE0_KEY; headers["X-RapidAPI-Host"] = new URL(base).host; }

  let res;
  try {
    res = await fetch(`${base}/submissions?base64_encoded=true&wait=true`, {
      method: "POST", headers, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ source_code: utf8ToB64(code), language_id: languageId, stdin: utf8ToB64(stdin || "") }),
    });
  } catch (e) {
    throw new HttpError(504, "The code runner took too long or could not be reached. Please try again.");
  }
  if (res.status === 429) throw new HttpError(503, "The code runner is busy right now. Please try again in a minute.");
  if (!res.ok) { console.error("Judge0 error", res.status); throw new HttpError(502, "The code runner returned an error. Please try again."); }

  const r = await res.json();
  return json({
    stdout: b64ToUtf8(r.stdout),
    stderr: b64ToUtf8(r.stderr),
    compile_output: b64ToUtf8(r.compile_output),
    status: r.status?.description || "",
    time: r.time ?? null,
    memory: r.memory ?? null,
  });
}

/* ───────────────── Leaderboard (public copy of a profile) ───────────────── */
// users/{uid} holds private data (email, date of birth, ...) and is readable only by its owner and admins.
// leaderboard/{uid} holds just what other students may see. Only this Worker writes it.

function cleanName(raw) {
  return String(raw || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "Student";
}

const AVATAR_HOSTS = ["googleusercontent.com", "firebasestorage.googleapis.com", "firebasestorage.app", "storage.googleapis.com", "avatars.githubusercontent.com"];

// A profile photo is shown in other students' pages, so it must be an https URL on a host that serves
// avatars, with nothing in it that could break out of an HTML attribute. Anything else is dropped.
export function safeAvatarUrl(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 500 || /[\s"'<>`\\]/.test(raw)) return null;
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    return AVATAR_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h)) ? u.href : null;
  } catch { return null; }
}

function leaderboardFields(f) {
  const solvedMap = f.practice?.mapValue?.fields?.solved?.mapValue?.fields;
  const photo = safeAvatarUrl(f.photoURL?.stringValue);
  const out = {
    name: { stringValue: cleanName(f.name?.stringValue) },   // never falls back to the email address
    xp: intVal(numOf(f.xp) || 0),
    solved: intVal(solvedMap ? Object.keys(solvedMap).length : 0),
    updatedAt: { timestampValue: new Date().toISOString() },
  };
  if (photo) out.photoURL = { stringValue: photo };
  return out;
}

const LB_MASK = ["name", "xp", "solved", "updatedAt", "photoURL"];   // photoURL in the mask but absent = cleared

async function writeLeaderboard(env, uid, userFields) {
  const res = await fsFetch(env, `leaderboard/${encodeURIComponent(uid)}`,
    { method: "PATCH", body: JSON.stringify({ fields: leaderboardFields(userFields) }) },
    "?" + LB_MASK.map((k) => `updateMask.fieldPaths=${k}`).join("&"));
  if (!res.ok) console.error("Leaderboard write failed", res.status);
}

async function syncProfileRoute(request, env) {
  const uid = await requireUser(request);
  const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
  if (res.status === 404) throw new HttpError(404, "Open your profile once first");
  if (!res.ok) throw new Error("Firestore read failed: " + res.status);
  await writeLeaderboard(env, uid, (await res.json()).fields || {});
  return json({ ok: true });
}

async function rebuildLeaderboardRoute(request, env) {
  const a = await getAccess(request, env);
  if (!a.admin) throw new HttpError(403, "Admins only");
  const token = await getAccessToken(env);
  let pageToken = "", users = 0, pages = 0;
  do {
    const qs = "?pageSize=300&mask.fieldPaths=name&mask.fieldPaths=xp&mask.fieldPaths=photoURL&mask.fieldPaths=practice" +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await fsFetch(env, "users", {}, qs);
    if (!res.ok) throw new Error("Firestore list failed: " + res.status);
    const page = await res.json();
    const docs = page.documents || [];
    users += docs.length;
    const writes = docs.map((d) => ({
      update: {
        name: `projects/${PROJECT_ID}/databases/(default)/documents/leaderboard/${d.name.split("/").pop()}`,
        fields: leaderboardFields(d.fields || {}),
      },
    }));
    for (let i = 0; i < writes.length; i += 400) {
      const commit = await fetch(`${FS_BASE}:commit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ writes: writes.slice(i, i + 400) }),
      });
      if (!commit.ok) throw new Error("Firestore commit failed: " + commit.status + " " + (await commit.text()));
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken && ++pages < 20);
  return json({ ok: true, users });
}

/* ───────────────────── Email code (OTP) sign-in ───────────────────── */
// Firebase has no built-in "email me a code" login, so the Worker does it: it emails a 6-digit code, checks
// it, then gives the browser a Firebase custom token for that email's account (created on first sign-in).
// Codes are stored only as keyed hashes, expire in 10 minutes, allow 5 guesses, and work once.

export const OTP = { ttlMs: 10 * 60 * 1000, maxAttempts: 5, resendMs: 45 * 1000, sendsPerHour: 5 };
const EMAIL_RE = /^[^\s@<>"'`\\]{1,64}@[^\s@<>"'`\\]{1,255}\.[^\s@<>"'`\\]{2,}$/;
const ipHits = new Map();   // per-isolate fallback limiter: "kind:ip" -> recent timestamps

function allowHit(key, limit, windowMs) {
  const now = Date.now();
  const recent = (ipHits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) { ipHits.set(key, recent); return false; }
  recent.push(now); ipHits.set(key, recent);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < windowMs)) ipHits.delete(k);
  return true;
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode() {                       // uniform 000000-999999 (rejection sampling, no modulo bias)
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(buf[0] % 1000000).padStart(6, "0");
}

function normaliseEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  return email;
}

async function verifyTurnstile(env, token, request) {
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, codes: ["missing-input-response"] };
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get("CF-Connecting-IP") || "" }),
    });
    if (!res.ok) return { ok: false, codes: ["siteverify-http-" + res.status] };
    const data = await res.json();
    if (data.success !== true) return { ok: false, codes: data["error-codes"]?.length ? data["error-codes"] : ["unknown"] };
    const host = new URL(request.url).hostname;
    if (data.hostname && data.hostname !== host) return { ok: false, codes: ["hostname-mismatch:" + data.hostname] };
    return { ok: true, codes: [] };
  } catch { return { ok: false, codes: ["siteverify-unreachable"] }; }
}

// Plain-words hint for the site owner, shown with Cloudflare's own reason code.
function turnstileHint(codes) {
  const c = codes.join(" ");
  if (/invalid-input-secret|missing-input-secret/.test(c)) return "The Worker's TURNSTILE_SECRET is wrong, or belongs to a different Turnstile widget than this page uses.";
  if (/timeout-or-duplicate/.test(c)) return "The check expired or was already used. Please try again.";
  if (/hostname-mismatch/.test(c)) return "The check was solved on a different website address than this one.";
  if (/missing-input-response|invalid-input-response/.test(c)) return "The check did not finish. Please try again.";
  return "Please try again.";
}

async function sendOtpEmail(env, to, code) {
  const subject = `${code} is your IT Study Hub code`;
  const text = `Your IT Study Hub sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email; nobody can sign in without the code.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px"><p style="margin:0 0 12px">Your IT Study Hub sign-in code:</p>` +
    `<p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:0 0 16px">${code}</p>` +
    `<p style="color:#555;font-size:13px;margin:0">It expires in 10 minutes. If you did not ask for it, ignore this email; nobody can sign in without the code.</p></div>`;
  try {
    if (env.MAIL_RELAY_URL && env.MAIL_RELAY_SECRET) {
      // Google Apps Script relay (see mail-relay.gs): mail is sent from your own Gmail, no domain needed.
      // Only the code goes over; the script writes the email itself, so a leaked secret cannot send arbitrary mail.
      const res = await fetch(env.MAIL_RELAY_URL, {
        method: "POST", redirect: "follow", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ secret: env.MAIL_RELAY_SECRET, to, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        if (data.error === "quota") throw new HttpError(503, "We have sent as many sign-in emails as we can today. Please sign in with Google or GitHub, or try again tomorrow.");
        throw new Error("Mail relay " + res.status + " " + JSON.stringify(data));
      }
      return;
    }
    if (env.EMAIL?.send) {                                         // Cloudflare Email Service binding (Workers Paid)
      await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject, html, text });
      return;
    }
    if (env.RESEND_API_KEY && env.EMAIL_FROM) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
      });
      if (!res.ok) throw new Error("Resend " + res.status + " " + (await res.text()));
      return;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("OTP email failed:", e.message);
    throw new HttpError(502, "We could not send the email right now. Please try again, or sign in with Google or GitHub.");
  }
  throw new HttpError(503, "Server setup incomplete: email sending is not configured (set MAIL_RELAY_URL and MAIL_RELAY_SECRET, or RESEND_API_KEY and EMAIL_FROM, or an EMAIL binding)");
}

const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });

async function serviceKey(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new HttpError(503, "Server setup incomplete: the FIREBASE_SERVICE_ACCOUNT secret is not set on the Worker");
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return { sa, key };
}

// A Firebase "custom token": the browser exchanges it for a normal signed-in session (signInWithCustomToken).
async function mintCustomToken(env, uid) {
  const { sa, key } = await serviceKey(env);
  const iat = Math.floor(Date.now() / 1000);
  const claims = { iss: sa.client_email, sub: sa.client_email, aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit", iat, exp: iat + 3600, uid };
  const unsigned = bytesToB64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + bytesToB64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  return unsigned + "." + bytesToB64url(sig);
}

async function idtPost(env, path, body) {
  const token = await getAccessToken(env);
  return fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

// Same email = same account, whichever way they signed in before (Google, GitHub, earlier links, or a code).
async function getOrCreateAuthUser(env, email, name) {
  const look = await idtPost(env, "/accounts:lookup", { email: [email] });
  if (!look.ok) throw new Error("Auth lookup failed: " + look.status + " " + (await look.text()));
  const found = (await look.json()).users?.[0];
  if (found?.localId) return { uid: found.localId, isNew: false };
  const created = await idtPost(env, "/accounts", { email, emailVerified: true, ...(name ? { displayName: name } : {}) });
  if (!created.ok) throw new Error("Auth create failed: " + created.status + " " + (await created.text()));
  return { uid: (await created.json()).localId, isNew: true };
}

function needOtpSecrets(env) {
  const missing = ["OTP_SECRET", "TURNSTILE_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new HttpError(503, `Server setup incomplete: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set on the Worker`);
}

// A public, value-free checklist of what the Worker can see (ok / missing / invalid), so setup mistakes are easy to find.
// Visit /api/setup-status in a browser. It never shows a secret's value.
async function setupStatusRoute(request, env) {
  const has = (k) => (typeof env[k] === "string" ? env[k].trim().length > 0 : !!env[k]);
  const simple = (k) => (has(k) ? "ok" : "missing");
  let serviceAccount = "missing";
  if (has("FIREBASE_SERVICE_ACCOUNT")) {
    try { const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); serviceAccount = sa.client_email && sa.private_key ? "ok" : "invalid"; }
    catch { serviceAccount = "invalid"; }       // usually a half-pasted JSON file
  }
  let turnstile = simple("TURNSTILE_SECRET");
  if (turnstile === "ok") {
    // A made-up answer with the real secret: Cloudflare says "invalid-input-secret" only if the secret itself is wrong.
    const probe = await verifyTurnstile(env, "setup-check", request);
    if (probe.codes.some((c) => /secret/.test(c))) turnstile = "wrong: Cloudflare rejected this secret";
  }
  const checks = {
    OTP_SECRET: simple("OTP_SECRET"),
    TURNSTILE_SECRET: turnstile,
    FIREBASE_SERVICE_ACCOUNT: serviceAccount,
    EMAIL_FROM: simple("EMAIL_FROM"),
    EMAIL_SENDING: env.EMAIL?.send || has("RESEND_API_KEY") ? "ok" : "missing (RESEND_API_KEY)",
    RAZORPAY_KEY_SECRET: simple("RAZORPAY_KEY_SECRET"),
    RAZORPAY_WEBHOOK_SECRET: simple("RAZORPAY_WEBHOOK_SECRET"),
    PREMIUM_STORAGE_KV: env.PREMIUM ? "ok" : "missing",
  };
  const loginReady = ["OTP_SECRET", "TURNSTILE_SECRET", "FIREBASE_SERVICE_ACCOUNT", "EMAIL_FROM", "EMAIL_SENDING"].every((k) => checks[k] === "ok");
  return json({ emailCodeLoginReady: loginReady, checks });
}

async function otpRequestRoute(request, env) {
  needOtpSecrets(env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!allowHit("otp-req:" + ip, 20, 3600000)) throw new HttpError(429, "Too many requests from your network. Please try again later.");
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  const human = await verifyTurnstile(env, body.turnstile, request);
  if (!human.ok) throw new HttpError(400, `The security check failed (${human.codes.join(", ")}). ${turnstileHint(human.codes)}`);

  const id = await sha256Hex(email);          // the record is keyed by a hash, so no address list is kept
  const path = `loginCodes/${id}`;
  const now = Date.now();
  let sends = 0, windowStart = now;
  const existing = await fsFetch(env, path);
  if (existing.ok) {
    const f = (await existing.json()).fields || {};
    const sentAt = Date.parse(f.sentAt?.timestampValue || 0);
    if (now - sentAt < OTP.resendMs) return json({ ok: true, resendIn: Math.ceil((OTP.resendMs - (now - sentAt)) / 1000) });
    const ws = Date.parse(f.windowStart?.timestampValue || 0);
    if (now - ws < 3600000) { sends = numOf(f.sends) || 0; windowStart = ws; }
    if (sends >= OTP.sendsPerHour) throw new HttpError(429, "Too many codes were requested for this email. Please try again in a while.");
  } else if (existing.status !== 404) {
    throw new Error("Firestore read failed: " + existing.status);
  }

  const code = randomCode();
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const fields = {
    codeHash: { stringValue: await hmacSha256Hex(env.OTP_SECRET, `${id}:${code}`) },
    expiresAt: ts(now + OTP.ttlMs), attempts: intVal(0), sentAt: ts(now), windowStart: ts(windowStart), sends: intVal(sends + 1),
  };
  if (rawName) fields.name = { stringValue: cleanName(rawName) };
  const mask = ["codeHash", "expiresAt", "attempts", "sentAt", "windowStart", "sends", "name"].map((k) => `updateMask.fieldPaths=${k}`).join("&");
  const save = await fsFetch(env, path, { method: "PATCH", body: JSON.stringify({ fields }) }, "?" + mask);
  if (!save.ok) throw new Error("Firestore write failed: " + save.status + " " + (await save.text()));

  try { await sendOtpEmail(env, email, code); }
  catch (e) { await fsFetch(env, path, { method: "DELETE" }); throw e; }     // no half-finished request left behind
  return json({ ok: true, resendIn: OTP.resendMs / 1000 });
}

async function otpVerifyRoute(request, env) {
  needOtpSecrets(env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!allowHit("otp-verify:" + ip, 60, 3600000)) throw new HttpError(429, "Too many attempts from your network. Please try again later.");
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) throw new HttpError(400, "Enter the 6-digit code.");

  const id = await sha256Hex(email);
  const path = `loginCodes/${id}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fsFetch(env, path);
    if (res.status === 404) throw new HttpError(400, "That code has expired. Please request a new one.");
    if (!res.ok) throw new Error("Firestore read failed: " + res.status);
    const doc = await res.json();
    const f = doc.fields || {};
    if (Date.parse(f.expiresAt?.timestampValue || 0) < Date.now()) {
      await fsFetch(env, path, { method: "DELETE" });
      throw new HttpError(400, "That code has expired. Please request a new one.");
    }
    const attempts = numOf(f.attempts) || 0;
    if (attempts >= OTP.maxAttempts) {
      await fsFetch(env, path, { method: "DELETE" });
      throw new HttpError(429, "Too many wrong tries. Please request a new code.");
    }
    // Count this try first. The updateTime precondition makes parallel guesses take turns, so five really means five.
    const patch = await fsFetch(env, path, { method: "PATCH", body: JSON.stringify({ fields: { attempts: intVal(attempts + 1) } }) },
      `?updateMask.fieldPaths=attempts&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`);
    if (!patch.ok) {
      if (/FAILED_PRECONDITION|ABORTED/.test(await patch.text())) continue;   // someone else just wrote it: read again
      throw new Error("Firestore update failed: " + patch.status);
    }

    const given = await hmacSha256Hex(env.OTP_SECRET, `${id}:${body.code}`);
    if (!safeEqual(f.codeHash?.stringValue || "", given)) {
      const left = OTP.maxAttempts - (attempts + 1);
      if (left <= 0) { await fsFetch(env, path, { method: "DELETE" }); throw new HttpError(400, "That code is not right. Please request a new code."); }
      throw new HttpError(400, `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`);
    }

    // Right code: burn it (only one request can win this delete), then sign them in.
    const burn = await fsFetch(env, path, { method: "DELETE" }, "?currentDocument.exists=true");
    if (!burn.ok) throw new HttpError(400, "That code was already used. Please request a new one.");
    const user = await getOrCreateAuthUser(env, email, f.name?.stringValue || "");
    return json({ token: await mintCustomToken(env, user.uid), isNew: user.isNew });
  }
  throw new HttpError(409, "Busy, please try again.");
}

/* ───────────────────────── Setup check (for the owner) ───────────────────────── */
// Tells you, piece by piece, what is configured and working, without exposing any secret values.
// Call it with the header  X-Setup-Key: <your OTP_SECRET>  (see the one-line console snippet in HANDOFF.md).

async function setupCheckRoute(request, env) {
  if (!env.OTP_SECRET) throw new HttpError(503, "Add the OTP_SECRET secret first; it is also the key for this check.");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!allowHit("setup-check:" + ip, 20, 3600000)) throw new HttpError(429, "Too many checks. Try again later.");
  if (!safeEqual(request.headers.get("X-Setup-Key") || "", env.OTP_SECRET)) throw new HttpError(403, "Wrong setup key.");

  const checks = {};
  const run = async (name, fn) => {
    try { const detail = await fn(); checks[name] = { ok: true, detail: detail || "ok" }; }
    catch (e) { checks[name] = { ok: false, detail: String(e.message || e).slice(0, 300) }; }
  };
  const present = (name) => { if (!env[name]) throw new Error("not set"); return "set"; };

  for (const name of ["OTP_SECRET", "TURNSTILE_SECRET", "FIREBASE_SERVICE_ACCOUNT", "MAIL_RELAY_URL", "MAIL_RELAY_SECRET"]) {
    await run("secret " + name, async () => present(name));
  }
  for (const name of ["RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) await run("secret " + name + " (payments)", async () => present(name));
  checks["premium storage (KV binding PREMIUM)"] = env.PREMIUM ? { ok: true, detail: "bound" } : { ok: false, detail: "not bound yet (only needed for premium lessons)" };

  await run("Google service account key works", async () => { await getAccessToken(env); return "token obtained"; });
  await run("Firestore access (role: Cloud Datastore User)", async () => {
    const res = await fsFetch(env, "loginCodes/setup-check-probe");
    if (res.status === 404 || res.ok) return "can read and write the database";
    if (res.status === 403) throw new Error("denied: give the service account the Cloud Datastore User role");
    throw new Error("unexpected status " + res.status);
  });
  await run("Firebase user management (role: Firebase Authentication Admin)", async () => {
    const res = await idtPost(env, "/accounts:lookup", { email: ["setup-check@example.invalid"] });
    if (res.ok) return "can look up and create accounts";
    if (res.status === 403) throw new Error("denied: give the service account the Firebase Authentication Admin role");
    throw new Error("unexpected status " + res.status + " " + (await res.text()).slice(0, 120));
  });
  await run("Firebase sign-in token can be signed", async () => { await mintCustomToken(env, "setup-check"); return "ok"; });
  await run("Turnstile secret is accepted by Cloudflare", async () => {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET || "", response: "setup-check" }) });
    const codes = (await res.json())["error-codes"] || [];
    if (codes.includes("invalid-input-secret")) throw new Error("Cloudflare says this secret key is wrong");
    return "secret recognised";
  });
  await run("Gmail relay answers (and shows today's remaining emails)", async () => {
    if (!env.MAIL_RELAY_URL || !env.MAIL_RELAY_SECRET) throw new Error("MAIL_RELAY_URL and MAIL_RELAY_SECRET are not both set");
    const res = await fetch(env.MAIL_RELAY_URL, { method: "POST", redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ secret: env.MAIL_RELAY_SECRET, ping: true }) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { throw new Error("the web app did not answer with JSON; check it is deployed with 'Who has access: Anyone' and that you deployed a NEW VERSION after editing"); }
    if (data.error === "forbidden") throw new Error("the secret in the script does not match MAIL_RELAY_SECRET");
    if (data.ok !== true) throw new Error("relay answered: " + JSON.stringify(data));
    return "reachable, " + data.quota + " emails left today";
  });

  const needed = Object.entries(checks).filter(([k]) => !/payments|premium storage/.test(k));
  return json({ ready: needed.every(([, v]) => v.ok), checks });
}

/* ───────────────── Premium access and content ───────────────── */

const COURSES = new Set(["java", "c", "cpp", "r", "javascript", "python"]);

// Who is asking is proven by their Firebase ID token (verified above). What plan they have is read with
// the Worker's own service account, so this keeps working even if Firestore App Check enforcement is on
// (a request made with only the user's token would carry no App Check token and be refused).
// Premium = an active (not expired) paid plan, an admin, or an institution account inside its free EDU_MONTHS window.
// Courses: Pro, Elite and admins can open all six. Starter opens the two courses stored in users/{uid}.starterCourses
// (written only by /api/starter-courses below). `mayChoose` is true while a Starter plan has no choice yet.
// Free access for institution email addresses: exact suffix match (never a substring), for a limited time.
const EDU_EMAIL_SUFFIX = "@technoindiaeducation.com";
const EDU_MONTHS = 6;
export async function getAccess(request, env) {
  const uid = await requireUser(request);
  const res = await fsFetch(env, `users/${encodeURIComponent(uid)}`);
  if (res.status === 404) return { uid, plan: "", premium: false, admin: false, courses: [], mayChoose: false, expiresAt: null };
  if (!res.ok) throw new Error("Firestore read failed: " + res.status);
  const doc = await res.json();
  const f = doc.fields || {};
  const plan = f.plan?.stringValue || "";
  const expiresAt = f.planExpiresAt?.timestampValue || null;
  const expiresMs = expiresAt ? Date.parse(expiresAt) : null;
  const planActive = !!PLANS[plan] && (expiresMs === null || expiresMs > Date.now());
  const admin = f.role?.stringValue === "admin";   // the one and only admin switch; set in the Firebase console or with scripts/grant-admin.mjs
  // Email is server-trusted: Firestore rules only allow it at profile creation when it matches
  // the signed-in Firebase token, and do not allow clients to change it afterwards.
  const email = (f.email?.stringValue || "").trim().toLowerCase();
  // Institution accounts get EDU_MONTHS of free access counted from when their profile was created.
  // The start date is Firestore's own createTime (set by the server; no client can write or change it).
  // If it is missing or unreadable the free access is withheld, never extended.
  const eduDomain = email.endsWith(EDU_EMAIL_SUFFIX);
  let eduEnds = null;
  if (eduDomain) {
    const start = Date.parse(doc.createTime || "");
    if (Number.isFinite(start)) { const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + EDU_MONTHS); eduEnds = d.toISOString(); }
  }
  const education = eduDomain && eduEnds !== null && Date.parse(eduEnds) > Date.now();
  const limit = planActive ? PLANS[plan].courses : undefined;
  let courses = [...COURSES], mayChoose = false;
  if (education) {
    // Active institution accounts can open all courses without a paid plan.
    courses = [...COURSES];
  } else if (!admin && planActive && limit) {
    const picked = (f.starterCourses?.arrayValue?.values || []).map((v) => v.stringValue).filter((c) => COURSES.has(c));
    courses = [...new Set(picked)].slice(0, limit);
    mayChoose = courses.length < limit;
  } else if (!admin && !planActive) courses = [];
  // Which end date the page should show: a paid plan's own expiry, unless the free institution window runs longer.
  let shownExpiry = planActive && !admin ? expiresAt : null;
  if (education && !admin && (!planActive || (expiresMs !== null && expiresMs < Date.parse(eduEnds)))) shownExpiry = eduEnds;
  return { uid, plan, admin, premium: planActive || admin || education, courses, mayChoose, expiresAt: shownExpiry };
}

function requireStore(env) {
  if (!env.PREMIUM) throw new HttpError(503, "Premium content storage is not set up yet");
  return env.PREMIUM;
}

async function accessRoute(request, env) {
  const a = await getAccess(request, env);
  return json({ premium: a.premium, plan: a.plan, courses: a.courses, mayChoose: a.mayChoose, expiresAt: a.expiresAt });
}

// Premium is not enough: the plan must also cover this course (Starter = two chosen courses).
function requireCourse(a, course) {
  if (a.courses.includes(course)) return;
  const e = new HttpError(403, a.mayChoose ? "Choose your two Starter courses first" : "Your plan does not include this course");
  e.extra = { code: a.mayChoose ? "choose_courses" : "course_not_in_plan", courses: a.courses };
  throw e;
}

async function lessonRoute(request, env) {
  const store = requireStore(env);
  const url = new URL(request.url);
  const course = url.searchParams.get("course") || "";
  const id = url.searchParams.get("id") || "";
  if (!COURSES.has(course) || !/^\d{1,3}$/.test(id)) throw new HttpError(400, "Bad lesson request");

  const a = await getAccess(request, env);
  if (!a.premium) throw new HttpError(403, "Premium plan required");
  requireCourse(a, course);

  // Module quizzes gate the course in order: a module's text is only served once the previous module's quiz is passed.
  if (MODULE_QUIZ_COURSES.has(course) && Number(id) > 1) {
    const uid = await requireUser(request);
    const { fields } = await readUserFields(env, uid);
    if (!hasPassed(fields, course, Number(id) - 1)) {
      const e = new HttpError(403, `Pass the Module ${Number(id) - 1} quiz first`);
      e.extra = { code: "quiz_locked", needs: Number(id) - 1 };
      throw e;
    }
  }

  const [lesson, quiz] = await Promise.all([
    store.get(`lesson:${course}:${Number(id)}`, "text"),
    store.get(`quiz:${course}:${Number(id)}`, "text"),
  ]);
  if (lesson === null) throw new HttpError(404, "Lesson not found");
  let out = lesson;
  if (quiz !== null) out = JSON.stringify({ ...JSON.parse(lesson), quiz: JSON.parse(quiz) });   // the quiz (with its answers) travels only with the lesson
  return new Response(out, {
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// Which course a premium PDF belongs to, from its file name.
const PDF_COURSES = [["IT_Study_Hub_Java_Module_", "java"], ["IT_Study_Hub_C_Programming_Module_", "c"], ["IT_Study_Hub_Cpp_Module_", "cpp"], ["IT_Study_Hub_JavaScript_Module_", "javascript"], ["IT_STUDY_HUB_R_Module_", "r"]];
export function pdfCourse(file) {
  return PDF_COURSES.find(([prefix]) => file.startsWith(prefix))?.[1] || null;
}

async function pdfRoute(request, env) {
  const store = requireStore(env);
  const file = new URL(request.url).searchParams.get("f") || "";
  if (!/^[\w #()+.\-]{1,100}\.pdf$/.test(file) || file.includes("..")) throw new HttpError(400, "Bad file name");

  const a = await getAccess(request, env);
  if (!a.premium) throw new HttpError(403, "Premium plan required");
  const course = pdfCourse(file);
  if (course) requireCourse(a, course);
  else if (a.courses.length < COURSES.size) throw new HttpError(403, "Your plan does not include this file");   // unknown file: only all-course access

  const data = await store.get(`pdf:${file}`, { type: "arrayBuffer" });
  if (data === null) throw new HttpError(404, "File not found");
  return new Response(data, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// A Starter buyer picks exactly two courses, once. Only the Worker can write the field (it is not in the browser rules).
// To let someone change their pick, edit users/{uid}.starterCourses in the Firebase console.
async function starterCoursesRoute(request, env) {
  const a = await getAccess(request, env);
  if (!a.premium || a.admin) throw new HttpError(403, "You need an active Starter plan to choose courses");
  const limit = PLANS[a.plan]?.courses;
  if (!limit) throw new HttpError(400, "Your plan already includes every course");
  if (!a.mayChoose) throw new HttpError(409, "You have already chosen your courses");
  const { courses } = await readJson(request);
  if (!Array.isArray(courses) || courses.length !== limit || new Set(courses).size !== limit || !courses.every((c) => COURSES.has(c))) {
    throw new HttpError(400, `Choose exactly ${limit} different courses`);
  }
  const body = { fields: { starterCourses: { arrayValue: { values: courses.map((c) => ({ stringValue: c })) } } } };
  const res = await fsFetch(env, `users/${encodeURIComponent(a.uid)}`, { method: "PATCH", body: JSON.stringify(body) },
    "?updateMask.fieldPaths=starterCourses&currentDocument.exists=true");
  if (!res.ok) throw new Error("Firestore update failed: " + res.status);
  return json({ ok: true, courses });
}

/* ─────────────────────────── API routes ─────────────────────────── */

async function createOrder(request, env) {
  const uid = await requireUser(request);
  const { planId } = await readJson(request);
  const plan = PLANS[planId];
  if (!plan) throw new HttpError(400, "Unknown plan");

  const current = await getUserPlan(env, uid);
  if (current === null) throw new HttpError(404, "Open your profile once before buying");
  if ((PLANS[current]?.rank || 0) >= plan.rank) throw new HttpError(409, "You already have this plan or a higher one");

  const order = await rzp(env, "/orders", {
    method: "POST",
    body: JSON.stringify({
      amount: plan.price * 100,
      currency: "INR",
      receipt: `ish_${Date.now()}`,
      notes: { uid, planId },
    }),
  });
  return json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID, planName: plan.name });
}

async function verifyPayment(request, env) {
  const uid = await requireUser(request);
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = await readJson(request);
  if (![orderId, paymentId, signature].every((v) => typeof v === "string" && v.length > 0 && v.length < 100)) {
    throw new HttpError(400, "Missing payment details");
  }
  const expected = await hmacSha256Hex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!safeEqual(expected, signature)) throw new HttpError(400, "Invalid payment signature");

  const { planId } = await settlePayment(env, orderId, paymentId, "verify", uid);
  return json({ ok: true, plan: planId });
}

async function razorpayWebhook(request, env) {
  const raw = await request.text();
  const sig = request.headers.get("X-Razorpay-Signature") || "";
  const expected = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!safeEqual(expected, sig)) return json({ error: "Bad signature" }, 400);

  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: "Bad body" }, 400); }

  if (event.event === "payment.captured" || event.event === "order.paid") {
    const payment = event.payload?.payment?.entity;
    if (payment?.id && payment?.order_id) {
      try {
        await settlePayment(env, payment.order_id, payment.id, "webhook", null);
      } catch (e) {
        console.error("Webhook settle failed", e.message);
        // 5xx makes Razorpay retry. 4xx-style problems (bad order, mismatch) will not fix themselves.
        return json({ error: "Retry" }, e instanceof HttpError ? 200 : 500);
      }
    }
  }
  return json({ ok: true });
}

const ROUTES = {
  "GET /api/access": accessRoute,
  "GET /api/lesson": lessonRoute,
  "GET /api/pdf": pdfRoute,
  "POST /api/award-xp": awardXpRoute,
  "GET /api/module-progress": moduleProgressRoute,
  "POST /api/module-quiz": moduleQuizRoute,
  "GET /api/setup-status": setupStatusRoute,
  "GET /api/setup-check": setupCheckRoute,
  "POST /api/otp/request": otpRequestRoute,
  "POST /api/otp/verify": otpVerifyRoute,
  "POST /api/run": runRoute,
  "POST /api/sync-profile": syncProfileRoute,
  "POST /api/admin/rebuild-leaderboard": rebuildLeaderboardRoute,
  "POST /api/starter-courses": starterCoursesRoute,
  "POST /api/create-order": createOrder,
  "POST /api/verify-payment": verifyPayment,
  "POST /api/razorpay-webhook": razorpayWebhook,
};

/* ─────────────────────────── entry point ─────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const handler = ROUTES[`${request.method} ${url.pathname}`];
      if (!handler) return json({ error: "Not found" }, 404);
      try {
        return await handler(request, env);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
        console.error("API error:", e.message);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // Admin access is NOT decided here. admin.html is a static file that Cloudflare serves directly,
    // so a check in this Worker would never run. What protects admin data is Firestore: only profiles
    // with role == "admin" can read other users' documents (see firestore.rules), and the Worker's
    // admin routes check the same role.
    return env.ASSETS.fetch(request);
  },
};
