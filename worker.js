// IT Study Hub: Cloudflare Worker
//
// Routes
//   POST /api/create-order      signed-in user asks to buy a plan; we create the Razorpay order
//   POST /api/verify-payment    browser reports a finished payment; we verify it and activate the plan
//   POST /api/razorpay-webhook  Razorpay tells us a payment was captured (backup if the browser closes)
//   /admin*                     existing IP gate (see note below)
//   everything else             static files
//
// Secrets (set with `wrangler secret put <NAME>`; never commit them):
//   RAZORPAY_KEY_SECRET       Razorpay dashboard > API keys
//   RAZORPAY_WEBHOOK_SECRET   the secret you type when creating the webhook
//   FIREBASE_SERVICE_ACCOUNT  full JSON of a service account key with Cloud Datastore User role
// Plain var (in wrangler.toml or dashboard):
//   RAZORPAY_KEY_ID           rzp_test_... or rzp_live_...  (public key id)

const PROJECT_ID = "it-study-hub";

// Server-side source of truth for prices. The browser never sends an amount.
const PLANS = {
  basic: { name: "Starter", price: 199, months: 6, rank: 1 },
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

async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);

  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );

  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
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
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        console.error("API error:", e.message);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }

    // Existing admin IP gate, unchanged (task 8 replaces it).
    // NOTE: Cloudflare serves /admin.html straight from static assets without running this
    // Worker, so this gate does not currently protect anything.
    if (url.pathname.startsWith("/admin")) {
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const ipv4 = ip.startsWith("42.108.85.");
      const ipv6 = ip.startsWith("2402:3a80:430c:e6cd:");
      if (!ipv4 && !ipv6) return new Response("Access Denied", { status: 403 });
    }

    return env.ASSETS.fetch(request);
  },
};
