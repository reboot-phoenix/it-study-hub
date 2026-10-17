// Run: node worker.test.mjs   (Node 18+). No network, no secrets: Razorpay, Google and Firestore are mocked.
import assert from "node:assert/strict";
import worker from "./worker.js";

const enc = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmacHex = async (secret, msg) => {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", k, enc.encode(msg))).toString("hex");
};

// ── keys: one pair plays "Firebase securetoken", another plays our service account ──
const algo = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const fb = await crypto.subtle.generateKey(algo, true, ["sign", "verify"]);
const fbJwk = { ...(await crypto.subtle.exportKey("jwk", fb.publicKey)), kid: "test-kid" };
const sa = await crypto.subtle.generateKey(algo, true, ["sign", "verify"]);
const saPem = "-----BEGIN PRIVATE KEY-----\n" +
  Buffer.from(await crypto.subtle.exportKey("pkcs8", sa.privateKey)).toString("base64").match(/.{1,64}/g).join("\n") +
  "\n-----END PRIVATE KEY-----\n";

async function idToken(uid, overrides = {}, signWith = fb.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" }));
  const body = b64u(JSON.stringify({ aud: "it-study-hub", iss: "https://securetoken.google.com/it-study-hub", sub: uid, iat: now - 5, exp: now + 3600, ...overrides }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signWith, enc.encode(head + "." + body));
  return `${head}.${body}.${b64u(sig)}`;
}

// ── mock world ──
const env = {
  OTP_SECRET: "otp-test-secret", TURNSTILE_SECRET: "ts-secret", EMAIL_FROM: "IT Study Hub <login@itstudyhub.test>", RESEND_API_KEY: "re_test",
  RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "keysecret", RAZORPAY_WEBHOOK_SECRET: "whsecret",
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "svc@it-study-hub.iam.gserviceaccount.com", private_key: saPem }),
  ASSETS: { fetch: async () => new Response("asset") },
  PREMIUM: {
    store: new Map(),
    async get(key, opts) {
      const v = this.store.get(key);
      if (v === undefined) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "arrayBuffer" ? new TextEncoder().encode(v).buffer : v;
    },
  },
};
env.PREMIUM.store.set("lesson:java:7", JSON.stringify({ body: "SECRET JAVA 7" }));
env.PREMIUM.store.set("lesson:cpp:7", JSON.stringify({ body: "CPP 7 (not gated yet)" }));
env.PREMIUM.store.set("lesson:r:7", JSON.stringify({ body: "SECRET R 7" }));
env.PREMIUM.store.set("quiz:r:7", JSON.stringify([{ q: "?", o: ["a", "b"], a: 0, e: "" }]));
env.PREMIUM.store.set("pdf:BCA-421 JAVA-97-131.pdf", "%PDF-secret");
let users, payments, orders, ledger, orderSeq, lastFsAuth, lb, listPageSize = 300;
let judge0Calls = [];
let codes = {}, authUsers = {}, emailsSent = [], turnstileCalls = [], emailFails = false, idtSeq = 0, relayCalls = [], relayMode = "ok", idtDenied = false;
// ── typed-value helpers for the Firestore mock ──
let beforePatch = null;
function toTyped(key, v) {
  if (["planExpiresAt", "planActivatedAt", "expiresAt", "sentAt", "windowStart"].includes(key) && typeof v === "string") return { timestampValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => toTyped("", x)) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toTyped(k, x)])) } };
}
function fromTyped(tv) {
  if ("stringValue" in tv) return tv.stringValue;
  if ("timestampValue" in tv) return tv.timestampValue;
  if ("integerValue" in tv) return Number(tv.integerValue);
  if ("doubleValue" in tv) return tv.doubleValue;
  if ("booleanValue" in tv) return tv.booleanValue;
  if ("arrayValue" in tv) return (tv.arrayValue.values || []).map(fromTyped);
  if ("mapValue" in tv) return Object.fromEntries(Object.entries(tv.mapValue.fields || {}).map(([k, x]) => [k, fromTyped(x)]));
  return null;
}

function reset() {
  users = { alice: { plan: "" }, bob: { plan: "" }, carol: { plan: "elite" } };
  payments = {}; orders = {}; ledger = {}; orderSeq = 0; lb = {}; listPageSize = 300; judge0Calls = []; codes = {}; authUsers = {}; emailsSent = []; turnstileCalls = []; emailFails = false; idtSeq = 0; relayCalls = []; relayMode = "ok"; idtDenied = false;
}
reset();

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || "GET").toUpperCase();
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });

  if (/^https:\/\/(ce\.judge0\.com|judge0\.example\.org)\/submissions/.test(url)) {
    judge0Calls.push({ url, init });
    const body = JSON.parse(init.body);
    const src = Buffer.from(body.source_code, "base64").toString("utf8");
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");   // Judge0 wraps lines
    if (src.includes("TIMEOUT")) { const e = new Error("aborted"); e.name = "TimeoutError"; throw e; }
    if (src.includes("QUOTA")) return J({ error: "limit" }, 429);
    if (src.includes("BROKEN")) return J({ error: "boom" }, 500);
    if (src.includes("COMPILE_ERROR")) return J({ compile_output: b64("main.c:1: error: expected ';'"), status: { description: "Compilation Error" } });
    if (src.includes("EMOJI")) return J({ stdout: b64("héllo 🌍\n"), status: { description: "Accepted" }, time: "0.01", memory: 1024 });
    const stdin = Buffer.from(body.stdin || "", "base64").toString("utf8");
    return J({ stdout: b64("ran lang " + body.language_id + " stdin=" + stdin), status: { description: "Accepted" }, time: "0.02", memory: 2048 });
  }
  if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
    const p = new URLSearchParams(init.body); turnstileCalls.push(Object.fromEntries(p));
    if (p.get("secret") !== "ts-secret") return J({ success: false, "error-codes": ["invalid-input-secret"] });
    if (p.get("response") === "ts-other-host") return J({ success: true, hostname: "somewhere-else.example" });
    if (p.get("response") === "ts-used") return J({ success: false, "error-codes": ["timeout-or-duplicate"] });
    return J(p.get("response") === "ts-ok" ? { success: true, hostname: "x.test" } : { success: false, "error-codes": ["invalid-input-response"] });
  }
  if (url === "https://script.google.com/macros/s/TESTID/exec") {
    const body = JSON.parse(init.body); relayCalls.push(body);
    if (relayMode === "html") return new Response("<html>Sign in to Google</html>", { status: 200 });   // what an Apps Script set to "only me" answers with
    if (body.ping) return body.secret === "relay-secret" ? J({ ok: true, quota: 97 }) : J({ ok: false, error: "forbidden" });
    if (relayMode === "quota") return J({ ok: false, error: "quota" });
    if (relayMode === "down") return J({ ok: false, error: "error" });
    if (body.secret !== "relay-secret") return J({ ok: false, error: "forbidden" });
    emailsSent.push({ subject: `${body.code} is your IT Study Hub code`, to: [body.to], viaRelay: true }); return J({ ok: true });
  }
  if (url === "https://api.resend.com/emails") {
    if (emailFails) return J({ message: "nope" }, 500);
    const body = JSON.parse(init.body); assert.equal(init.headers.Authorization, "Bearer re_test");
    emailsSent.push(body); return J({ id: "em_1" });
  }
  if (url.startsWith("https://identitytoolkit.googleapis.com/v1/projects/it-study-hub/")) {
    assert.equal(init.headers.Authorization, "Bearer tok");
    const body = JSON.parse(init.body);
    if (idtDenied) return J({ error: { status: "PERMISSION_DENIED" } }, 403);
    if (url.endsWith("/accounts:lookup")) { const u = authUsers[body.email[0]]; return J(u ? { users: [{ localId: u.localId, email: u.email }] } : { kind: "x" }); }
    if (url.endsWith("/accounts")) { const localId = "uid-new-" + ++idtSeq; authUsers[body.email] = { localId, email: body.email, emailVerified: body.emailVerified, displayName: body.displayName }; return J({ localId }); }
  }
  if (url.includes("securetoken@system.gserviceaccount.com")) return J({ keys: [fbJwk] });
  if (url === "https://oauth2.googleapis.com/token") return J({ access_token: "tok", expires_in: 3600 });

  if (url.startsWith("https://api.razorpay.com/v1")) {
    assert.ok(init.headers.Authorization.startsWith("Basic "), "razorpay call must be authenticated");
    const path = url.replace("https://api.razorpay.com/v1", "");
    if (path === "/orders" && method === "POST") {
      const b = JSON.parse(init.body); const id = "order_" + ++orderSeq;
      orders[id] = { id, ...b }; return J(orders[id]);
    }
    let m;
    if ((m = path.match(/^\/orders\/(.+)$/))) return orders[m[1]] ? J(orders[m[1]]) : J({ error: {} }, 404);
    if ((m = path.match(/^\/payments\/(.+)\/capture$/))) { payments[m[1]].status = "captured"; return J(payments[m[1]]); }
    if ((m = path.match(/^\/payments\/(.+)$/))) return payments[m[1]] ? J(payments[m[1]]) : J({ error: {} }, 404);
  }

  if (url.startsWith("https://firestore.googleapis.com")) {
    const u = new URL(url);
    lastFsAuth = init.headers.Authorization;
    if (u.pathname.endsWith("/documents:runQuery")) {
      assert.equal(init.headers.Authorization, "Bearer tok", "queries must use the service account");
      const want = JSON.parse(init.body).structuredQuery.where.fieldFilter.value.stringValue;
      return J(Object.entries(users).filter(([, d]) => d.email === want).map(([uid, d]) => ({
        document: { name: `projects/it-study-hub/databases/(default)/documents/users/${uid}`, fields: Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("__")).map(([k, v]) => [k, toTyped(k, v)])) } })));
    }
    if (u.pathname.endsWith("/documents:commit")) {
      assert.equal(init.headers.Authorization, "Bearer tok", "commits must use the service account");
      for (const w of JSON.parse(init.body).writes) lb[w.update.name.split("/").pop()] = fromTyped({ mapValue: { fields: w.update.fields } });
      return J({});
    }
    if (method !== "GET") assert.equal(init.headers.Authorization, "Bearer tok", "writes must use the service account"); const parts = u.pathname.split("/documents/")[1].split("/");
    const [col, id] = parts;
    if (col === "users" && !id && method === "GET") {              // list (used by the rebuild)
      const all = Object.entries(users);
      const start = Number(u.searchParams.get("pageToken") || 0);
      const slice = all.slice(start, start + listPageSize);
      const documents = slice.map(([uid, doc]) => ({
        name: `projects/it-study-hub/databases/(default)/documents/users/${uid}`,
        fields: Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("__")).map(([k, v]) => [k, toTyped(k, v)])),
      }));
      return J({ documents, ...(start + listPageSize < all.length ? { nextPageToken: String(start + listPageSize) } : {}) });
    }
    if (col === "loginCodes") {
      if (method === "GET") {
        if (!codes[id]) return J({}, 404);
        const fields = {}; for (const [k, v] of Object.entries(codes[id])) if (!k.startsWith("__")) fields[k] = toTyped(k, v);
        return J({ fields, updateTime: String(codes[id].__v || 1) });
      }
      if (method === "PATCH") {
        if (beforePatch) { const hook = beforePatch; beforePatch = null; hook(codes[id]); }
        const pre = u.searchParams.get("currentDocument.updateTime");
        if (pre !== null && (!codes[id] || pre !== String(codes[id].__v || 1))) return J({ error: { status: "FAILED_PRECONDITION" } }, 400);
        const f = JSON.parse(init.body).fields; codes[id] = codes[id] || {};
        for (const k of u.searchParams.getAll("updateMask.fieldPaths")) { if (f[k]) codes[id][k] = fromTyped(f[k]); else delete codes[id][k]; }
        codes[id].__v = (codes[id].__v || 1) + 1; return J({});
      }
      if (method === "DELETE") {
        if (u.searchParams.get("currentDocument.exists") === "true" && !codes[id]) return J({ error: { status: "NOT_FOUND" } }, 404);
        delete codes[id]; return J({});
      }
    }
    if (col === "leaderboard" && method === "PATCH") {
      const f = JSON.parse(init.body).fields;
      lb[id] = lb[id] || {};
      for (const k of u.searchParams.getAll("updateMask.fieldPaths")) { if (f[k]) lb[id][k] = fromTyped(f[k]); else delete lb[id][k]; }
      return J({});
    }
    if (col === "users") {
      if (method === "GET") {
        if (!users[id]) return J({}, 404);
        const fields = {};
        for (const [k, v] of Object.entries(users[id])) if (!k.startsWith("__") && v !== undefined) fields[k] = toTyped(k, v);
        return J({ fields, updateTime: String(users[id].__v || 1) });
      }
      if (method === "PATCH") {
        if (u.searchParams.get("currentDocument.exists") === "true" && !users[id]) return J({}, 404);
        if (beforePatch) { const hook = beforePatch; beforePatch = null; hook(users[id]); }
        const pre = u.searchParams.get("currentDocument.updateTime");
        if (pre !== null && pre !== String(users[id].__v || 1)) {
          return J({ error: { code: 400, status: "FAILED_PRECONDITION", message: "update time mismatch" } }, 400);
        }
        const f = JSON.parse(init.body).fields;
        for (const path of u.searchParams.getAll("updateMask.fieldPaths")) {
          const parts = path.split(".");
          // find the typed value at this path in the request
          let tv = { mapValue: { fields: f } };
          for (const p of parts) tv = tv?.mapValue?.fields?.[p];
          // walk/create the target object in the store
          let target = users[id];
          for (const p of parts.slice(0, -1)) { target[p] = target[p] || {}; target = target[p]; }
          const last = parts[parts.length - 1];
          if (tv) target[last] = fromTyped(tv); else delete target[last];
        }
        users[id].__v = (users[id].__v || 1) + 1;
        return J({});
      }
    }
    if (col === "payments" && method === "PATCH") {
      if (ledger[id]) return J({}, 409);
      ledger[id] = JSON.parse(init.body).fields; return J({});
    }
  }
  throw new Error("Unmocked fetch: " + method + " " + url);
};

// ── helpers ──
const call = (path, body, headers = {}, method = "POST") =>
  worker.fetch(new Request("https://x.test" + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
const authed = async (uid, extra) => ({ Authorization: "Bearer " + (await idToken(uid, extra)) });
const makePayment = (orderId, status = "captured", amount = null) => {
  const id = "pay_" + Math.random().toString(36).slice(2, 8);
  payments[id] = { id, order_id: orderId, status, amount: amount ?? orders[orderId].amount, currency: "INR" };
  return id;
};
const sigFor = (o, p) => hmacHex(env.RAZORPAY_KEY_SECRET, `${o}|${p}`);
let passed = 0;
const test = async (name, fn) => { reset(); await fn(); passed++; console.log("  ok  " + name); };

console.log("create-order");
await test("rejects missing, forged and expired tokens", async () => {
  assert.equal((await call("/api/create-order", { planId: "pro" })).status, 401);
  const forged = await idToken("alice", {}, sa.privateKey); // signed with the wrong key
  assert.equal((await call("/api/create-order", { planId: "pro" }, { Authorization: "Bearer " + forged })).status, 401);
  assert.equal((await call("/api/create-order", { planId: "pro" }, await authed("alice", { exp: 1 }))).status, 401);
  assert.equal((await call("/api/create-order", { planId: "pro" }, await authed("alice", { aud: "other-project" }))).status, 401);
});
await test("price comes from the server, not the client", async () => {
  const res = await call("/api/create-order", { planId: "pro", amount: 1 }, await authed("alice"));
  const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.amount, 49900);
  assert.deepEqual(orders[data.orderId].notes, { uid: "alice", planId: "pro" });
});
await test("rejects unknown plans, bad JSON, and buying a plan you already have or outrank", async () => {
  assert.equal((await call("/api/create-order", { planId: "gold" }, await authed("alice"))).status, 400);
  assert.equal((await call("/api/create-order", "{nope", await authed("alice"))).status, 400);
  assert.equal((await call("/api/create-order", { planId: "basic" }, await authed("carol"))).status, 409);
});

console.log("verify-payment");
await test("activates the plan after a valid signed, captured payment", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "pro" }, await authed("alice"))).json();
  const pid = makePayment(orderId);
  const res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: await sigFor(orderId, pid) }, await authed("alice"));
  assert.equal(res.status, 200);
  assert.equal(users.alice.plan, "pro");
  assert.equal(users.alice.razorpayPaymentId, pid);
  assert.ok(users.alice.planExpiresAt, "pro gets an expiry");
  assert.ok(ledger[pid], "payment recorded");
});
await test("elite is lifetime (no expiry)", async () => {
  users.alice.planExpiresAt = "old";
  const { orderId } = await (await call("/api/create-order", { planId: "elite" }, await authed("alice"))).json();
  const pid = makePayment(orderId);
  await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: await sigFor(orderId, pid) }, await authed("alice"));
  assert.equal(users.alice.plan, "elite"); assert.equal(users.alice.planExpiresAt, undefined);
});
await test("rejects a forged signature", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "pro" }, await authed("alice"))).json();
  const pid = makePayment(orderId);
  const res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: "0".repeat(64) }, await authed("alice"));
  assert.equal(res.status, 400); assert.equal(users.alice.plan, "");
});
await test("rejects someone else claiming your paid order", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "pro" }, await authed("alice"))).json();
  const pid = makePayment(orderId);
  const res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: await sigFor(orderId, pid) }, await authed("bob"));
  assert.equal(res.status, 403); assert.equal(users.bob.plan, ""); assert.equal(users.alice.plan, "");
});
await test("rejects an unpaid or wrong-amount payment even with a valid signature", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "pro" }, await authed("alice"))).json();
  const failed = makePayment(orderId, "failed");
  let res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: failed, razorpay_signature: await sigFor(orderId, failed) }, await authed("alice"));
  assert.equal(res.status, 402);
  const cheap = makePayment(orderId, "captured", 100);
  res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: cheap, razorpay_signature: await sigFor(orderId, cheap) }, await authed("alice"));
  assert.equal(res.status, 400); assert.equal(users.alice.plan, "");
});
await test("captures an authorized payment, then activates", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "basic" }, await authed("alice"))).json();
  const pid = makePayment(orderId, "authorized");
  const res = await call("/api/verify-payment", { razorpay_order_id: orderId, razorpay_payment_id: pid, razorpay_signature: await sigFor(orderId, pid) }, await authed("alice"));
  assert.equal(res.status, 200); assert.equal(users.alice.plan, "basic");
});

console.log("webhook");
const hook = async (obj, secret = env.RAZORPAY_WEBHOOK_SECRET) => {
  const raw = JSON.stringify(obj);
  return call("/api/razorpay-webhook", raw, { "X-Razorpay-Signature": await hmacHex(secret, raw) });
};
await test("rejects a bad webhook signature", async () => {
  const res = await hook({ event: "payment.captured", payload: {} }, "wrong-secret");
  assert.equal(res.status, 400);
});
await test("activates when the browser never came back, and is safe to replay", async () => {
  const { orderId } = await (await call("/api/create-order", { planId: "pro" }, await authed("alice"))).json();
  const pid = makePayment(orderId);
  const evt = { event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: orderId } } } };
  assert.equal((await hook(evt)).status, 200); assert.equal(users.alice.plan, "pro");
  assert.equal((await hook(evt)).status, 200); assert.equal(users.alice.plan, "pro");
});
await test("never downgrades a higher plan", async () => {
  users.alice.plan = "elite";
  orders["order_9"] = { id: "order_9", amount: 19900, notes: { uid: "alice", planId: "basic" } };
  const pid = makePayment("order_9");
  await hook({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: "order_9" } } } });
  assert.equal(users.alice.plan, "elite");
});
await test("a webhook cannot be used to mint a plan for an order Razorpay does not know", async () => {
  const res = await hook({ event: "payment.captured", payload: { payment: { entity: { id: "pay_fake", order_id: "order_fake" } } } });
  assert.notEqual(users.alice.plan, "pro"); assert.ok([200, 500].includes(res.status));
});


console.log("premium access and content");
const get = async (path, uid, extra) =>
  worker.fetch(new Request("https://x.test" + path, { method: "GET", headers: uid ? await authed(uid, extra) : {} }), env);
const future = new Date(Date.now() + 86400000 * 30).toISOString();
const past = new Date(Date.now() - 86400000).toISOString();

await test("/api/access: signed-out is rejected, free user is not premium", async () => {
  assert.equal((await get("/api/access")).status, 401);
  assert.deepEqual(await (await get("/api/access", "alice")).json(), { premium: false, plan: "", courses: [], mayChoose: false, expiresAt: null });
});
await test("/api/access: active plan and admins are premium, expired plans are not", async () => {
  users.alice = { plan: "pro", planExpiresAt: future };
  assert.equal((await (await get("/api/access", "alice")).json()).premium, true);
  users.alice = { plan: "pro", planExpiresAt: past };
  assert.equal((await (await get("/api/access", "alice")).json()).premium, false);
  users.alice = { plan: "elite" };                       // lifetime, no expiry field
  assert.equal((await (await get("/api/access", "alice")).json()).premium, true);
  users.bob = { plan: "", role: "admin" };
  assert.equal((await (await get("/api/access", "bob")).json()).premium, true);
  users.bob = { plan: "", isAdmin: true };                // the old boolean flag no longer grants anything
  assert.equal((await (await get("/api/access", "bob")).json()).premium, false);
  users.bob = { plan: "", role: "student" };
  assert.equal((await (await get("/api/access", "bob")).json()).premium, false);
  users.bob = { plan: "gold" };                          // made-up plan names grant nothing
  assert.equal((await (await get("/api/access", "bob")).json()).premium, false);
});
await test("/api/access reads the profile with the service account, so Firestore App Check enforcement cannot break it", async () => {
  await get("/api/access", "alice");
  assert.equal(lastFsAuth, "Bearer tok");
});
await test("/api/lesson: locked for signed-out and free users, no content leaks", async () => {
  assert.equal((await get("/api/lesson?course=java&id=7")).status, 401);
  const res = await get("/api/lesson?course=java&id=7", "alice");
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes("SECRET"));
});
await test("/api/lesson: paid user gets the lesson, with no-store caching", async () => {
  users.alice = { plan: "pro", planExpiresAt: future, moduleQuiz: { java6: 75 } };   // Module 7 opens once Module 6's quiz is passed
  const res = await get("/api/lesson?course=java&id=7", "alice");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { body: "SECRET JAVA 7" });
  assert.match(res.headers.get("Cache-Control"), /no-store/);
});
await test("/api/lesson: bad input and missing lessons", async () => {
  users.alice = { plan: "pro", moduleQuiz: { java98: 80 } };
  assert.equal((await get("/api/lesson?course=../x&id=7", "alice")).status, 400);
  assert.equal((await get("/api/lesson?course=java&id=7abc", "alice")).status, 400);
  assert.equal((await get("/api/lesson?course=java&id=99", "alice")).status, 404);
});
await test("/api/pdf: locked for free users, served as a PDF to paid users", async () => {
  const f = encodeURIComponent("BCA-421 JAVA-97-131.pdf");
  assert.equal((await get("/api/pdf?f=" + f, "alice")).status, 403);
  users.alice = { plan: "pro" };
  const res = await get("/api/pdf?f=" + f, "alice");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/pdf");
  assert.equal(await res.text(), "%PDF-secret");
});
await test("/api/pdf: rejects path tricks and non-PDF names", async () => {
  users.alice = { plan: "pro" };
  for (const bad of ["../worker.js", "..%2F..%2Fsecret.pdf", "a/b.pdf", "notes.txt", "x.pdf%00.txt", ""]) {
    assert.equal((await get("/api/pdf?f=" + bad, "alice")).status, 400, bad);
  }
  assert.equal((await get("/api/pdf?f=" + encodeURIComponent("Missing file.pdf"), "alice")).status, 404);
});
await test("premium routes fail clearly (503) when the KV store is not bound yet", async () => {
  const saved = env.PREMIUM; delete env.PREMIUM;
  users.alice = { plan: "pro" };
  assert.equal((await get("/api/lesson?course=java&id=7", "alice")).status, 503);
  env.PREMIUM = saved;
});



console.log("module quizzes");
const mq = async (uid, body) => worker.fetch(new Request("https://x.test/api/module-quiz", { method: "POST", headers: { "Content-Type": "application/json", ...(uid ? await authed(uid) : {}) }, body: JSON.stringify(body) }), env);
const mprog = async (uid) => worker.fetch(new Request("https://x.test/api/module-progress?course=r", { headers: uid ? await authed(uid) : {} }), env);
await test("module quiz: signed-out and malformed requests are refused", async () => {
  assert.equal((await mq(null, { course: "r", module: 1, score: 8, total: 8 })).status, 401);
  assert.equal((await mprog(null)).status, 401);
  for (const bad of [{ course: "ruby", module: 1, score: 8, total: 8 }, { course: "r", module: 0, score: 8, total: 8 }, { course: "r", module: 1, score: 9, total: 8 }, { course: "r", module: 1, score: -1, total: 8 }, { course: "r", module: 1, score: "8", total: 8 }, { course: "r", module: 1, score: 1, total: 0 }]) {
    assert.equal((await mq("alice", bad)).status, 400, JSON.stringify(bad));
  }
});
await test("module quiz: modules must be passed in order, and 6/8 is the pass mark", async () => {
  users.alice = { plan: "pro" };
  const locked = await mq("alice", { course: "r", module: 2, score: 8, total: 8 });
  assert.equal(locked.status, 403); assert.equal((await locked.json()).code, "quiz_locked");
  const fail = await (await mq("alice", { course: "r", module: 1, score: 5, total: 8 })).json();
  assert.equal(fail.passed, false); assert.equal(users.alice.moduleQuiz.r1, 63);
  assert.equal((await mq("alice", { course: "r", module: 2, score: 8, total: 8 })).status, 403, "a failed quiz does not unlock the next module");
  const pass = await (await mq("alice", { course: "r", module: 1, score: 6, total: 8 })).json();
  assert.equal(pass.passed, true); assert.equal(users.alice.moduleQuiz.r1, 75);
  assert.equal((await mq("alice", { course: "r", module: 2, score: 7, total: 8 })).status, 200);
});
await test("module quiz: the best score never goes down", async () => {
  users.alice = { moduleQuiz: { r1: 100 } };
  const res = await (await mq("alice", { course: "r", module: 1, score: 1, total: 8 })).json();
  assert.equal(res.best, 100); assert.equal(res.passed, true); assert.equal(users.alice.moduleQuiz.r1, 100);
});
await test("module quiz: every gated course records passes under its own key", async () => {
  users.alice = { plan: "pro" };
  for (const c of ["c", "java", "python", "javascript"]) {
    assert.equal((await mq("alice", { course: c, module: 1, score: 7, total: 8 })).status, 200, c);
    assert.equal(users.alice.moduleQuiz[c + "1"], 88, c);
  }
  assert.equal((await mq("alice", { course: "cpp", module: 1, score: 8, total: 8 })).status, 400, "C++ is not enabled yet");
});
await test("module progress lists what the user has passed", async () => {
  users.alice = { moduleQuiz: { r1: 88, r2: 50 } };
  const data = await (await mprog("alice")).json();
  assert.deepEqual(data.best, { 1: 88, 2: 50 }); assert.equal(data.pass, 75);
});
await test("premium R lessons are withheld until the previous module's quiz is passed", async () => {
  users.alice = { plan: "pro" };
  const locked = await get("/api/lesson?course=r&id=7", "alice");
  assert.equal(locked.status, 403); assert.equal((await locked.json()).code, "quiz_locked");
  assert.ok(!JSON.stringify(await (await get("/api/lesson?course=r&id=7", "alice")).text()).includes("SECRET R 7"));
  users.alice = { plan: "pro", moduleQuiz: { r6: 75 } };
  const ok = await get("/api/lesson?course=r&id=7", "alice");
  assert.equal(ok.status, 200); assert.match(await ok.text(), /SECRET R 7/);
  users.alice = { plan: "pro" };
  assert.equal((await get("/api/lesson?course=cpp&id=7", "alice")).status, 200, "C++ has no module quizzes yet, so it is not gated");
  const java = await get("/api/lesson?course=java&id=7", "alice");
  assert.equal(java.status, 403); assert.equal((await java.json()).code, "quiz_locked");   // C, Java, Python and JavaScript are gated the same way
  for (const c of ["c", "python", "javascript"]) {
    env.PREMIUM.store.set(`lesson:${c}:7`, JSON.stringify({ body: "X" }));
    assert.equal((await get(`/api/lesson?course=${c}&id=7`, "alice")).status, 403, c);
    users.alice = { plan: "pro", moduleQuiz: { [c + "6"]: 80 } };
    assert.equal((await get(`/api/lesson?course=${c}&id=7`, "alice")).status, 200, c);
    users.alice = { plan: "pro" };
  }
});

console.log("award-xp");
import fs from "node:fs";
import { PRACTICE_IDS } from "./worker.js";
const award = async (uid, body, extra) =>
  worker.fetch(new Request("https://x.test/api/award-xp", { method: "POST", headers: { "Content-Type": "application/json", ...(uid ? await authed(uid, extra) : {}) }, body: JSON.stringify(body) }), env);
const quiz = (uid, subject, score, total = 10) => award(uid, { type: "quiz", subject, score, total });

await test("rejects signed-out callers and malformed requests", async () => {
  assert.equal((await quiz(null, "c", 5)).status, 401);
  assert.equal((await award("alice", { type: "bonus" })).status, 400);
  assert.equal((await quiz("alice", "ruby", 5)).status, 400);
  assert.equal((await quiz("alice", "c", 11)).status, 400);
  assert.equal((await quiz("alice", "c", -1)).status, 400);
  assert.equal((await quiz("alice", "c", 5, 0)).status, 400);
  assert.equal((await quiz("alice", "c", 5.5)).status, 400);
  assert.equal((await award("alice", { type: "quiz", subject: "c", score: "10", total: 10 })).status, 400);
  assert.equal((await award("nobody", { type: "practice", problemId: "c1" })).status, 404);
});
await test("quiz: first attempt pays 100, and the server writes xp with the service account", async () => {
  users.alice = { xp: 100, earnedXPKeys: [] };
  const res = await quiz("alice", "c", 6);
  const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.awarded, 100); assert.equal(data.xp, 200);
  assert.equal(users.alice.xp, 200); assert.equal(users.alice.quizBest.c, 60);
});
await test("quiz: retaking the same score pays nothing", async () => {
  users.alice = { xp: 100 };
  await quiz("alice", "c", 6);
  const again = await (await quiz("alice", "c", 6)).json();
  assert.equal(again.awarded, 0); assert.equal(users.alice.xp, 200);
});
await test("quiz: the perfect-score bonus is paid once per subject, not on every retake", async () => {
  users.alice = { xp: 100 };
  assert.equal((await (await quiz("alice", "java", 10)).json()).awarded, 150);   // 100 + 50
  assert.equal((await (await quiz("alice", "java", 10)).json()).awarded, 0);     // retake: nothing
  assert.equal((await (await quiz("alice", "java", 10)).json()).awarded, 0);
  assert.equal(users.alice.xp, 250);
});
await test("quiz: improvement bonus needs a real new best and stops after 3", async () => {
  users.alice = { xp: 0 };
  await quiz("alice", "r", 3);                                                    // first: 100
  assert.equal((await (await quiz("alice", "r", 2)).json()).awarded, 0);          // worse: nothing
  assert.equal(users.alice.quizBest.r, 30, "best must not go down");
  assert.equal((await (await quiz("alice", "r", 4)).json()).awarded, 25);         // better
  assert.equal((await (await quiz("alice", "r", 3)).json()).awarded, 0);          // dipping then returning pays nothing
  assert.equal((await (await quiz("alice", "r", 5)).json()).awarded, 25);
  assert.equal((await (await quiz("alice", "r", 6)).json()).awarded, 25);
  assert.equal((await (await quiz("alice", "r", 7)).json()).awarded, 0);          // allowance used up
  assert.equal(users.alice.quizBest.r, 70, "a new best is still recorded");
  assert.equal(users.alice.xp, 175);
});
await test("quiz: browser-written scores never decide XP; old users get one catch-up per subject", async () => {
  users.alice = { xp: 500, scores: { python: { pct: 100 } } };               // saved by the browser, even a forged 100
  const first = await (await quiz("alice", "python", 8)).json();
  assert.equal(first.awarded, 100, "paid once as a first attempt");
  assert.equal((await (await quiz("alice", "python", 8)).json()).awarded, 0, "and not again");
  assert.equal(users.alice.quizBest.python, 80, "best comes from the server's own record");
});
await test("quiz: if the award call failed earlier, the next attempt still pays the first-attempt XP", async () => {
  users.alice = { xp: 100, scores: { c: { pct: 70 } } };                      // score saved, no quizBest yet
  assert.equal((await (await quiz("alice", "c", 7)).json()).awarded, 100);
});
await test("practice: each real problem pays 10 once; unknown problems and repeats pay nothing", async () => {
  users.alice = { xp: 100, earnedXPKeys: ["practice:c1"] };
  assert.equal((await (await award("alice", { type: "practice", problemId: "c1" })).json()).awarded, 0);
  assert.equal((await (await award("alice", { type: "practice", problemId: "c2" })).json()).awarded, 10);
  assert.equal((await (await award("alice", { type: "practice", problemId: "c2" })).json()).awarded, 0);
  assert.deepEqual(users.alice.earnedXPKeys, ["practice:c1", "practice:c2"]);
  assert.equal(users.alice.xp, 110);
  assert.equal((await award("alice", { type: "practice", problemId: "c999" })).status, 400);
  assert.equal((await award("alice", { type: "practice", problemId: "../users" })).status, 400);
});
await test("a concurrent write between read and write is retried, never double-paid or lost", async () => {
  users.alice = { xp: 100, earnedXPKeys: [] };
  beforePatch = (doc) => { doc.xp += 7; doc.__v = (doc.__v || 1) + 1; };      // someone else's write lands first
  const data = await (await award("alice", { type: "practice", problemId: "j1" })).json();
  assert.equal(data.awarded, 10);
  assert.equal(users.alice.xp, 117, "their +7 and our +10 both survive");
});
await test("the practice id list matches practice-panel.html exactly", async () => {
  const html = fs.readFileSync(new URL("./practice-panel.html", import.meta.url), "utf8");
  const region = html.slice(html.indexOf("const PROBLEMS = {"));
  const ids = [...region.matchAll(/\n\s*\{\s*id\s*:\s*['"]([a-z0-9_\-]+)['"]\s*,/gi)].map((m) => m[1]);
  assert.deepEqual([...PRACTICE_IDS].sort(), [...ids].sort(), "update PRACTICE_IDS in worker.js to match the page");
});

console.log("leaderboard");
const post = async (path, uid, extra) =>
  worker.fetch(new Request("https://x.test" + path, { method: "POST", headers: uid ? await authed(uid, extra) : {}, body: "{}" }), env);

await test("sync-profile: signed-out and unknown users are refused", async () => {
  assert.equal((await post("/api/sync-profile")).status, 401);
  assert.equal((await post("/api/sync-profile", "nobody")).status, 404);
});
await test("sync-profile copies only public fields: no email, dob or college ever reach leaderboard/", async () => {
  users.alice = { name: "Alice", email: "alice@x.edu", dob: "2004-01-01", college: "TIU", xp: 450, photoURL: "https://lh3.googleusercontent.com/a/p",
                  practice: { solved: { c1: { ts: 1 }, c2: { ts: 2 } } } };
  assert.equal((await post("/api/sync-profile", "alice")).status, 200);
  assert.deepEqual(Object.keys(lb.alice).sort(), ["name", "photoURL", "solved", "updatedAt", "xp"]);
  assert.equal(lb.alice.name, "Alice"); assert.equal(lb.alice.xp, 450); assert.equal(lb.alice.solved, 2);
  assert.ok(!JSON.stringify(lb.alice).includes("alice@x.edu"));
});
await test("sync-profile: names are cleaned, never fall back to the email, and photos must be https", async () => {
  users.alice = { name: "  Al\u0000ice\u0007 " + "x".repeat(100), email: "secret@x.edu", xp: 1 };
  await post("/api/sync-profile", "alice");
  assert.ok(lb.alice.name.startsWith("Alice") && lb.alice.name.length <= 60);
  users.bob = { email: "bob.private@x.edu", xp: 1, photoURL: "javascript:alert(1)" };
  await post("/api/sync-profile", "bob");
  assert.equal(lb.bob.name, "Student"); assert.equal(lb.bob.photoURL, undefined);
});
await test("sync-profile: removing a photo removes it from the leaderboard too", async () => {
  users.alice = { name: "A", xp: 1, photoURL: "https://lh3.googleusercontent.com/a/p" };
  await post("/api/sync-profile", "alice");
  assert.ok(lb.alice.photoURL);
  delete users.alice.photoURL;
  await post("/api/sync-profile", "alice");
  assert.equal(lb.alice.photoURL, undefined);
});
await test("awarding XP updates the leaderboard in the same request", async () => {
  users.alice = { name: "Alice", xp: 100, earnedXPKeys: [] };
  await award("alice", { type: "practice", problemId: "c1" });
  assert.equal(lb.alice.xp, 110); assert.equal(lb.alice.name, "Alice");
});
await test("rebuild: only admins, and it pages through every user", async () => {
  users = { u1: { name: "One", xp: 10 }, u2: { name: "Two", xp: 20 }, u3: { name: "Three", xp: 30 }, u4: { name: "Four", xp: 40 }, u5: { name: "Five", xp: 50 },
            boss: { name: "Boss", xp: 5, role: "admin" } };
  assert.equal((await post("/api/admin/rebuild-leaderboard", "u1")).status, 403);
  assert.equal((await post("/api/admin/rebuild-leaderboard")).status, 401);
  listPageSize = 2;                                                       // forces several pages
  const res = await post("/api/admin/rebuild-leaderboard", "boss");
  assert.equal(res.status, 200); assert.equal((await res.json()).users, 6);
  assert.deepEqual(Object.keys(lb).sort(), ["boss", "u1", "u2", "u3", "u4", "u5"]);
  assert.equal(lb.u3.xp, 30); assert.equal(lb.u3.name, "Three");
});

console.log("grant-admin script");
import { setRole } from "./scripts/grant-admin.mjs";
await test("grants role=admin, clears the old isAdmin flag, and the Worker then treats them as admin", async () => {
  users.sam = { email: "sam@tiu.edu", isAdmin: true, xp: 5 };
  const out = await setRole({ email: "sam@tiu.edu", token: "tok" });
  assert.deepEqual(out, { uid: "sam", role: "admin" });
  assert.equal(users.sam.role, "admin"); assert.equal(users.sam.isAdmin, undefined);
  assert.equal((await (await get("/api/access", "sam")).json()).premium, true);
  assert.equal((await post("/api/admin/rebuild-leaderboard", "sam")).status, 200);
});
await test("matches the email regardless of capitalisation", async () => {
  users.sam = { email: "sam@tiu.edu" };
  assert.equal((await setRole({ email: "Sam@TIU.edu", token: "tok" })).uid, "sam");
});
await test("matches an email stored with mixed capitalisation", async () => {
  users.sam = { email: "Sam@TIU.edu" };
  const out = await setRole({ email: "sam@tiu.edu", token: "tok" });
  assert.deepEqual(out, { uid: "sam", role: "admin" });
  assert.equal(users.sam.role, "admin");
});

await test("finds a matching user on a later Firestore page", async () => {
  users = {
    first: { email: "first@tiu.edu" },
    second: { email: "second@tiu.edu" },
    target: { email: "Target@TIU.edu" }
  };
  listPageSize = 2;
  const out = await setRole({ email: "target@tiu.edu", token: "tok" });
  assert.deepEqual(out, { uid: "target", role: "admin" });
  assert.equal(users.target.role, "admin");
  assert.equal(users.first.role, undefined);
  assert.equal(users.second.role, undefined);
});

await test("revoke removes the role, and removes the powers", async () => {
  users.sam = { email: "sam@tiu.edu", role: "admin" };
  await setRole({ email: "sam@tiu.edu", revoke: true, token: "tok" });
  assert.equal(users.sam.role, undefined);
  assert.equal((await post("/api/admin/rebuild-leaderboard", "sam")).status, 403);
});
await test("refuses unknown emails and duplicate profiles instead of guessing", async () => {
  await assert.rejects(setRole({ email: "ghost@tiu.edu", token: "tok" }), /No profile found/);
  users.a1 = { email: "dup@tiu.edu" }; users.a2 = { email: "dup@tiu.edu" };
  await assert.rejects(setRole({ email: "dup@tiu.edu", token: "tok" }), /More than one profile/);
  assert.equal(users.a1.role, undefined); assert.equal(users.a2.role, undefined);
  await assert.rejects(setRole({ email: "not-an-email", token: "tok" }), /full email/);
});

console.log("avatar urls and the admin gate");
import { safeAvatarUrl } from "./worker.js";
await test("avatar URLs: only https on avatar hosts, and nothing that can break out of an attribute", async () => {
  const good = ["https://lh3.googleusercontent.com/a/photo=s96-c", "https://firebasestorage.googleapis.com/v0/b/it-study-hub.firebasestorage.app/o/pfp%2Fabc?alt=media&token=1",
                "https://avatars.githubusercontent.com/u/1?v=4"];
  for (const u of good) assert.ok(safeAvatarUrl(u), "should allow " + u);
  const bad = ['https://lh3.googleusercontent.com/a" onerror="alert(1)', "https://lh3.googleusercontent.com/a' onerror='x", "https://lh3.googleusercontent.com/a<script>",
               "http://lh3.googleusercontent.com/a", "javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>", "https://evilgoogleusercontent.com/a",
               "https://googleusercontent.com.evil.com/a", "https://evil.com/a", "https://lh3.googleusercontent.com/a b", "//lh3.googleusercontent.com/a",
               "https://lh3.googleusercontent.com/" + "a".repeat(600), 42, null, undefined];
  for (const u of bad) assert.equal(safeAvatarUrl(u), null, "should reject " + String(u).slice(0, 60));
});
await test("a poisoned photoURL never reaches the leaderboard", async () => {
  users.alice = { name: "A", xp: 1, photoURL: 'https://lh3.googleusercontent.com/a" onerror="alert(document.cookie)' };
  await post("/api/sync-profile", "alice");
  assert.equal(lb.alice.photoURL, undefined);
  assert.ok(!JSON.stringify(lb.alice).includes("onerror"));
});
await test("the Worker no longer carries an IP allowlist, and /admin is just a static file", async () => {
  const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
  // The header is still read for rate limits and the Turnstile check; what must never come back is an allowlist of addresses.
  assert.ok(!/startsWith\(["']\d/.test(src) && !/Access Denied/.test(src) && !/["']\d{1,3}\.\d{1,3}\.\d{1,3}\.["']/.test(src), "no IP allowlist in worker.js");
  const res = await worker.fetch(new Request("https://x.test/admin.html"), env);
  assert.equal(await res.text(), "asset");
});

console.log("run code");
import { RUN_LIMIT } from "./worker.js";
const run = async (uid, body, extra) =>
  worker.fetch(new Request("https://x.test/api/run", { method: "POST", headers: { "Content-Type": "application/json", ...(uid ? await authed(uid, extra) : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }), env);

await test("run: signed-out callers cannot use the code runner", async () => {
  assert.equal((await run(null, { language: "c", code: "int main(){}" })).status, 401);
  assert.equal(judge0Calls.length, 0, "nothing was sent to Judge0");
});
await test("run: maps the language, sends source and input as base64, and returns decoded output", async () => {
  const res = await run("alice", { language: "python", code: "print(input())", stdin: "héllo" });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.stdout, "ran lang 71 stdin=héllo"); assert.equal(data.status, "Accepted");
  assert.match(judge0Calls[0].url, /base64_encoded=true&wait=true/);
  for (const [lang, id] of Object.entries({ c: 50, cpp: 54, java: 62, python: 71, r: 80, javascript: 63 })) {
    judge0Calls.length = 0;
    assert.match((await (await run("alice" + lang, { language: lang, code: "x" })).json()).stdout, new RegExp("lang " + id));
  }
});
await test("run: never forwards the student's token, and uses the RapidAPI key only when one is configured", async () => {
  await run("alice", { language: "c", code: "x" });
  const h = judge0Calls[0].init.headers;
  assert.ok(!h.Authorization && !h["X-RapidAPI-Key"], "no credentials on the free public runner");
  judge0Calls.length = 0;
  const saved = { ...env }; env.JUDGE0_KEY = "secret-key"; env.JUDGE0_URL = "https://judge0.example.org/";
  await run("alice2", { language: "c", code: "x" });
  assert.equal(judge0Calls[0].init.headers["X-RapidAPI-Key"], "secret-key");
  assert.equal(judge0Calls[0].init.headers["X-RapidAPI-Host"], "judge0.example.org");
  assert.ok(judge0Calls[0].url.startsWith("https://judge0.example.org/submissions"));
  delete env.JUDGE0_KEY; delete env.JUDGE0_URL;
});
await test("run: UTF-8 output and compile errors come through intact", async () => {
  assert.equal((await (await run("alice", { language: "c", code: "EMOJI" })).json()).stdout, "héllo 🌍\n");
  const ce = await (await run("alice", { language: "c", code: "COMPILE_ERROR" })).json();
  assert.match(ce.compile_output, /expected ';'/); assert.equal(ce.status, "Compilation Error");
});
await test("run: rejects unsupported languages, empty code, and oversized code or input before calling Judge0", async () => {
  assert.equal((await run("alice", { language: "ruby", code: "x" })).status, 400);
  assert.equal((await run("alice", { language: "c", code: "   " })).status, 400);
  assert.equal((await run("alice", { language: "c" })).status, 400);
  assert.equal((await run("alice", { language: "c", code: "x".repeat(70 * 1024) })).status, 413);
  assert.equal((await run("alice", { language: "c", code: "x", stdin: "y".repeat(20 * 1024) })).status, 413);
  assert.equal((await run("alice", { language: "c", code: "x", stdin: 5 })).status, 400);
  assert.equal((await run("alice", "{not json")).status, 400);
  assert.equal(judge0Calls.length, 0);
});
await test("run: each student is limited per minute, and one student cannot use up another's allowance", async () => {
  for (let i = 0; i < RUN_LIMIT.perMinute; i++) assert.equal((await run("spammer", { language: "c", code: "x" })).status, 200);
  const blocked = await run("spammer", { language: "c", code: "x" });
  assert.equal(blocked.status, 429); assert.match((await blocked.json()).error, /too quickly/);
  assert.equal((await run("someone-else", { language: "c", code: "x" })).status, 200);
});
await test("run: runner timeouts, quota errors and failures become clear, safe messages", async () => {
  const t1 = await run("t1", { language: "c", code: "TIMEOUT" });
  assert.equal(t1.status, 504);
  const t2 = await run("t2", { language: "c", code: "QUOTA" });
  assert.equal(t2.status, 503); assert.match((await t2.json()).error, /busy/);
  const t3 = await run("t3", { language: "c", code: "BROKEN" });
  assert.equal(t3.status, 502); assert.ok(!JSON.stringify(await t3.json()).includes("boom"), "upstream details are not leaked");
});

console.log("setup diagnostics");
await test("a missing service-account secret gives a clear 503, not a vague failure", async () => {
  const fresh = (await import("./worker.js?fresh=" + Date.now())).default;      // new module instance: empty token cache
  const noSecret = { ...env }; delete noSecret.FIREBASE_SERVICE_ACCOUNT;
  users.alice = { plan: "pro" };
  const res = await fresh.fetch(new Request("https://x.test/api/access", { headers: await authed("alice") }), noSecret);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /FIREBASE_SERVICE_ACCOUNT/);
});

console.log("email code (OTP) sign-in");
const otpReq = async (body, ip = "10.0.0.1", extra = {}) =>
  worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...extra }, body: JSON.stringify(body) }), env);
const otpVerify = async (body, ip = "10.0.0.1") =>
  worker.fetch(new Request("https://x.test/api/otp/verify", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }), env);
const lastCode = () => emailsSent.at(-1).subject.slice(0, 6);
const decodeJwt = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
let ipN = 0; const freshIp = () => `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`;

await test("request: refuses to run without its secrets, and rejects bad emails and failed security checks", async () => {
  const bare = { ...env }; delete bare.OTP_SECRET;
  const r0 = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", body: JSON.stringify({ email: "a@b.edu", turnstile: "ts-ok" }) }), bare);
  assert.equal(r0.status, 503); assert.match((await r0.json()).error, /OTP_SECRET/);
  assert.equal((await otpReq({ email: "not an email", turnstile: "ts-ok" }, freshIp())).status, 400);
  assert.equal((await otpReq({ email: "ana@college.edu", turnstile: "ts-bad" }, freshIp())).status, 400);
  assert.equal((await otpReq({ email: "ana@college.edu" }, freshIp())).status, 400);
  assert.equal(emailsSent.length, 0, "nothing was emailed");
});
await test("request: emails a 6-digit code (code in the subject), stores only hashes, and the Turnstile secret is checked server-side", async () => {
  const res = await otpReq({ email: "  Ana@College.EDU ", turnstile: "ts-ok", name: "Ana" }, freshIp());
  assert.equal(res.status, 200); assert.equal((await res.json()).resendIn, 45);
  assert.equal(emailsSent.length, 1); const mail = emailsSent[0];
  assert.deepEqual(mail.to, ["ana@college.edu"]); assert.equal(mail.from, "IT Study Hub <login@itstudyhub.test>");
  assert.match(mail.subject, /^\d{6} is your IT Study Hub code$/); assert.ok(mail.text.includes(lastCode()) && mail.html.includes(lastCode()));
  assert.equal(turnstileCalls[0].secret, "ts-secret"); assert.equal(turnstileCalls[0].response, "ts-ok");
  const stored = Object.values(codes)[0];
  const dump = JSON.stringify(stored);
  assert.ok(!dump.includes(lastCode()), "the code is not stored"); assert.ok(!dump.includes("ana@college.edu"), "the address is not stored");
  assert.match(stored.codeHash, /^[0-9a-f]{64}$/); assert.equal(stored.attempts, 0);
  const ttl = Date.parse(stored.expiresAt) - Date.now(); assert.ok(ttl > 9 * 60000 && ttl <= 10 * 60000);
});
await test("request: a second ask within 45 seconds sends nothing; an hourly cap stops code spam", async () => {
  await otpReq({ email: "bo@college.edu", turnstile: "ts-ok" }, freshIp());
  const again = await (await otpReq({ email: "bo@college.edu", turnstile: "ts-ok" }, freshIp())).json();
  assert.equal(emailsSent.length, 1); assert.ok(again.resendIn > 0 && again.resendIn <= 45);
  const doc = Object.values(codes)[0]; doc.sentAt = new Date(Date.now() - 60000).toISOString(); doc.sends = 5;   // pretend 5 already went out this hour
  assert.equal((await otpReq({ email: "bo@college.edu", turnstile: "ts-ok" }, freshIp())).status, 429);
  assert.equal(emailsSent.length, 1);
});
await test("request: one network address is limited, and an email-provider failure leaves nothing behind", async () => {
  const ip = "10.9.9.9";
  for (let i = 0; i < 20; i++) assert.equal((await otpReq({ email: `u${i}@college.edu`, turnstile: "ts-ok" }, ip)).status, 200);
  assert.equal((await otpReq({ email: "one-more@college.edu", turnstile: "ts-ok" }, ip)).status, 429);
  emailFails = true;
  const bad = await otpReq({ email: "fail@college.edu", turnstile: "ts-ok" }, freshIp());
  assert.equal(bad.status, 502); assert.match((await bad.json()).error, /Google or GitHub/);
  const failId = Object.keys(codes).length; assert.equal(failId, 20, "the failed request's record was removed");
});
await test("request: with no email provider configured the error says what is missing", async () => {
  const noMail = { ...env }; delete noMail.RESEND_API_KEY;
  const r = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ email: "x@college.edu", turnstile: "ts-ok" }) }), noMail);
  assert.equal(r.status, 503); assert.match((await r.json()).error, /email sending is not configured/);
});

await test("verify: the right code signs a NEW person in, creating their account with a verified email and name", async () => {
  await otpReq({ email: "new@college.edu", turnstile: "ts-ok", name: "Nia Rao" }, freshIp());
  const code = lastCode();
  const res = await otpVerify({ email: "NEW@college.edu", code }, freshIp());
  const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.isNew, true);
  const u = authUsers["new@college.edu"]; assert.equal(u.emailVerified, true); assert.equal(u.displayName, "Nia Rao");
  // the token is a Firebase custom token, signed by the service account
  const [h, p, sig] = data.token.split(".");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", sa.publicKey, Buffer.from(sig, "base64url"), enc.encode(h + "." + p));
  assert.ok(ok, "signature verifies with the service account's public key");
  const c = decodeJwt(data.token);
  assert.equal(c.uid, u.localId); assert.equal(c.iss, "svc@it-study-hub.iam.gserviceaccount.com"); assert.equal(c.sub, c.iss);
  assert.equal(c.aud, "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"); assert.ok(c.exp - c.iat <= 3600);
  assert.equal(Object.keys(codes).length, 0, "the code is gone after use");
});
await test("verify: someone who already has an account (Google, GitHub, old links) lands in the SAME account", async () => {
  authUsers["old@college.edu"] = { localId: "uid-existing", email: "old@college.edu" };
  await otpReq({ email: "old@college.edu", turnstile: "ts-ok" }, freshIp());
  const data = await (await otpVerify({ email: "old@college.edu", code: lastCode() }, freshIp())).json();
  assert.equal(data.isNew, false); assert.equal(decodeJwt(data.token).uid, "uid-existing");
  assert.equal(idtSeq, 0, "no duplicate account was created");
});
await test("verify: a used code cannot be used twice", async () => {
  await otpReq({ email: "once@college.edu", turnstile: "ts-ok" }, freshIp()); const code = lastCode();
  assert.equal((await otpVerify({ email: "once@college.edu", code }, freshIp())).status, 200);
  const again = await otpVerify({ email: "once@college.edu", code }, freshIp());
  assert.equal(again.status, 400); assert.match((await again.json()).error, /expired/);
});
await test("verify: wrong codes count down, and after five the code is dead even if the right one is then typed", async () => {
  await otpReq({ email: "guess@college.edu", turnstile: "ts-ok" }, freshIp());
  const right = lastCode(); const wrong = right === "000000" ? "111111" : "000000";
  const first = await otpVerify({ email: "guess@college.edu", code: wrong }, freshIp());
  assert.equal(first.status, 400); assert.match((await first.json()).error, /4 tries left/);
  for (let i = 0; i < 3; i++) await otpVerify({ email: "guess@college.edu", code: wrong }, freshIp());
  const last = await otpVerify({ email: "guess@college.edu", code: wrong }, freshIp());
  assert.equal(last.status, 400); assert.match((await last.json()).error, /request a new code/);
  const afterwards = await otpVerify({ email: "guess@college.edu", code: right }, freshIp());
  assert.equal(afterwards.status, 400); assert.equal(Object.keys(authUsers).includes("guess@college.edu"), false, "no account was created");
});
await test("verify: expired codes, unknown emails and malformed input are all refused", async () => {
  await otpReq({ email: "late@college.edu", turnstile: "ts-ok" }, freshIp()); const code = lastCode();
  Object.values(codes)[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  const exp = await otpVerify({ email: "late@college.edu", code }, freshIp());
  assert.equal(exp.status, 400); assert.match((await exp.json()).error, /expired/);
  assert.equal((await otpVerify({ email: "nobody@college.edu", code: "123456" }, freshIp())).status, 400);
  assert.equal((await otpVerify({ email: "late@college.edu", code: "12345" }, freshIp())).status, 400);
  assert.equal((await otpVerify({ email: "late@college.edu", code: "abcdef" }, freshIp())).status, 400);
  assert.equal((await otpVerify({ email: "bad", code: "123456" }, freshIp())).status, 400);
});
await test("verify: parallel guesses take turns, so a guess made at the same moment is still counted", async () => {
  await otpReq({ email: "race@college.edu", turnstile: "ts-ok" }, freshIp()); const right = lastCode();
  const wrong = right === "000000" ? "111111" : "000000";
  beforePatch = (doc) => { doc.attempts = 2; doc.__v = (doc.__v || 1) + 1; };   // another guess lands between our read and write
  await otpVerify({ email: "race@college.edu", code: wrong }, freshIp());
  assert.equal(Object.values(codes)[0].attempts, 3, "their guess and ours both count");
});
await test("verify: verification is rate-limited per network address", async () => {
  const ip = "10.8.8.8";
  for (let i = 0; i < 60; i++) await otpVerify({ email: "x@college.edu", code: "123456" }, ip);
  assert.equal((await otpVerify({ email: "x@college.edu", code: "123456" }, ip)).status, 429);
});
await test("codes look random: always six digits, with leading zeros kept", async () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) { await otpReq({ email: `r${i}@college.edu`, turnstile: "ts-ok" }, freshIp()); seen.add(lastCode()); }
  assert.ok([...seen].every((c) => /^\d{6}$/.test(c))); assert.ok(seen.size > 35, "no repeats pattern");
});

console.log("setup status");
const statusOf = async (e) => { const r = await worker.fetch(new Request("https://x.test/api/setup-status"), e); const body = await r.json(); return { status: r.status, body, text: JSON.stringify(body) }; };
await test("setup-status: shows ok/missing/invalid for each item, and never a secret value", async () => {
  const full = await statusOf(env);
  assert.equal(full.status, 200); assert.equal(full.body.emailCodeLoginReady, true); assert.equal(full.body.checks.OTP_SECRET, "ok");
  for (const secret of [env.OTP_SECRET, env.TURNSTILE_SECRET, env.RESEND_API_KEY, env.FIREBASE_SERVICE_ACCOUNT, env.RAZORPAY_KEY_SECRET]) assert.ok(!full.text.includes(secret), "no secret value is shown");
  const partial = { ...env }; delete partial.TURNSTILE_SECRET; delete partial.RESEND_API_KEY; partial.FIREBASE_SERVICE_ACCOUNT = "{half pasted";
  const p = await statusOf(partial);
  assert.equal(p.body.checks.TURNSTILE_SECRET, "missing"); assert.equal(p.body.checks.FIREBASE_SERVICE_ACCOUNT, "invalid");
  assert.match(p.body.checks.EMAIL_SENDING, /missing/); assert.equal(p.body.emailCodeLoginReady, false); assert.equal(p.body.checks.OTP_SECRET, "ok");
  const none = await statusOf({ ASSETS: env.ASSETS });
  assert.equal(none.body.checks.FIREBASE_SERVICE_ACCOUNT, "missing"); assert.equal(none.body.checks.PREMIUM_STORAGE_KV, "missing");
});
await test("otp request names exactly the secret that is missing", async () => {
  const noTs = { ...env }; delete noTs.TURNSTILE_SECRET;
  const r = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", body: JSON.stringify({ email: "a@b.edu", turnstile: "x" }) }), noTs);
  const msg = (await r.json()).error;
  assert.equal(r.status, 503); assert.match(msg, /TURNSTILE_SECRET is not set/); assert.ok(!/OTP_SECRET/.test(msg), "does not blame the one that is fine");
  const neither = { ...env }; delete neither.TURNSTILE_SECRET; delete neither.OTP_SECRET;
  assert.match((await (await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", body: "{}" }), neither)).json()).error, /OTP_SECRET and TURNSTILE_SECRET are not set/);
});

console.log("security-check diagnostics");
await test("a wrong Turnstile secret is named, with a plain-words fix", async () => {
  const wrong = { ...env, TURNSTILE_SECRET: "secret-from-another-widget" };
  const r = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "CF-Connecting-IP": "10.7.7.7" }, body: JSON.stringify({ email: "a@college.edu", turnstile: "ts-ok" }) }), wrong);
  const msg = (await r.json()).error;
  assert.equal(r.status, 400); assert.match(msg, /invalid-input-secret/); assert.match(msg, /TURNSTILE_SECRET is wrong/);
  assert.equal(emailsSent.length, 0);
});
await test("reused and wrong-site checks get their own explanations, and nothing is emailed", async () => {
  const send = async (token, ip) => (await (await otpReq({ email: "z@college.edu", turnstile: token }, ip)).json()).error;
  assert.match(await send("ts-used", "10.7.7.8"), /expired or was already used/);
  assert.match(await send("ts-other-host", "10.7.7.9"), /hostname-mismatch:somewhere-else.example.*different website address/);
  assert.match(await send("junk", "10.7.7.10"), /did not finish/);
  assert.equal(emailsSent.length, 0);
});
await test("setup-status tells you when Cloudflare rejects the Turnstile secret itself", async () => {
  const wrong = await statusOf({ ...env, TURNSTILE_SECRET: "nope" });
  assert.match(wrong.body.checks.TURNSTILE_SECRET, /wrong/); assert.equal(wrong.body.emailCodeLoginReady, false);
  assert.equal((await statusOf(env)).body.checks.TURNSTILE_SECRET, "ok");
});

console.log("email via Gmail relay (no domain needed)");
await test("relay: when configured it is used instead of any other provider, and only the code travels", async () => {
  const relayEnv = { ...env, MAIL_RELAY_URL: "https://script.google.com/macros/s/TESTID/exec", MAIL_RELAY_SECRET: "relay-secret" };
  const res = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ email: "relay@college.edu", turnstile: "ts-ok" }) }), relayEnv);
  assert.equal(res.status, 200);
  assert.equal(relayCalls.length, 1); assert.deepEqual(Object.keys(relayCalls[0]).sort(), ["code", "secret", "to"], "no subject, body or HTML is sent: the script writes the email itself");
  assert.match(relayCalls[0].code, /^\d{6}$/); assert.equal(relayCalls[0].to, "relay@college.edu");
  assert.equal(emailsSent[0].viaRelay, true, "Resend was not used");
  // and the code that was emailed really signs the person in
  const v = await otpVerify({ email: "relay@college.edu", code: relayCalls[0].code }, freshIp());
  assert.equal(v.status, 200);
});
await test("relay: a full daily quota gives a clear message, and a broken relay a safe one; nothing is left behind", async () => {
  const relayEnv = { ...env, MAIL_RELAY_URL: "https://script.google.com/macros/s/TESTID/exec", MAIL_RELAY_SECRET: "relay-secret" };
  const ask = (email) => worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ email, turnstile: "ts-ok" }) }), relayEnv);
  relayMode = "quota"; const q = await ask("q@college.edu");
  assert.equal(q.status, 503); assert.match((await q.json()).error, /Google or GitHub/);
  relayMode = "down"; const d = await ask("d@college.edu");
  assert.equal(d.status, 502); assert.ok(!JSON.stringify(await d.json()).includes("forbidden"));
  assert.equal(Object.keys(codes).length, 0, "failed sends leave no code record");
  const wrong = { ...relayEnv, MAIL_RELAY_SECRET: "not-the-secret" };
  const f = await worker.fetch(new Request("https://x.test/api/otp/request", { method: "POST", headers: { "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ email: "f@college.edu", turnstile: "ts-ok" }) }), wrong);
  assert.equal(f.status, 502);
});
await test("relay: the Apps Script only sends a sign-in code, checks the secret, and has no way to send other text", async () => {
  const gs = fs.readFileSync(new URL("./mail-relay.gs", import.meta.url), "utf8");
  assert.match(gs, /d\.secret !== SECRET/); assert.match(gs, /\^\\d\{6\}\$/); assert.match(gs, /getRemainingDailyQuota/);
  assert.ok(!/d\.(subject|body|html|text)\b/.test(gs), "the script never takes the subject or body from the request");
  assert.match(gs, /Who has access|Anyone/);
});

console.log("setup check");
const check = async (key, e = env, ip = freshIp()) =>
  worker.fetch(new Request("https://x.test/api/setup-check", { headers: { "CF-Connecting-IP": ip, ...(key ? { "X-Setup-Key": key } : {}) } }), e);
const fullEnv = { ...env, MAIL_RELAY_URL: "https://script.google.com/macros/s/TESTID/exec", MAIL_RELAY_SECRET: "relay-secret", RAZORPAY_KEY_SECRET: "k", RAZORPAY_WEBHOOK_SECRET: "w" };
const RELAY = "Gmail relay answers (and shows today's remaining emails)";

await test("setup check: needs the owner's key, and says what to do first when OTP_SECRET is missing", async () => {
  assert.equal((await check(null, fullEnv)).status, 403);
  assert.equal((await check("wrong", fullEnv)).status, 403);
  const bare = { ...fullEnv }; delete bare.OTP_SECRET;
  const r = await check("anything", bare); assert.equal(r.status, 503); assert.match((await r.json()).error, /OTP_SECRET/);
});
await test("setup check: everything configured gives ready=true and never shows a secret value", async () => {
  const res = await check("otp-test-secret", fullEnv); const data = await res.json();
  assert.equal(res.status, 200); assert.equal(data.ready, true);
  for (const [name, c] of Object.entries(data.checks)) if (!/premium storage/.test(name)) assert.equal(c.ok, true, name + ": " + c.detail);
  const dump = JSON.stringify(data);
  for (const secret of ["otp-test-secret", "ts-secret", "relay-secret", "BEGIN PRIVATE KEY", "keysecret"]) assert.ok(!dump.includes(secret), "leaked " + secret);
  assert.match(data.checks[RELAY].detail, /97 emails left/);
});
await test("setup check: each missing or wrong piece is reported in plain words", async () => {
  const noMail = { ...fullEnv }; delete noMail.MAIL_RELAY_URL;
  let d = await (await check("otp-test-secret", noMail)).json();
  assert.equal(d.ready, false); assert.equal(d.checks["secret MAIL_RELAY_URL"].ok, false);
  assert.match(d.checks[RELAY].detail, /not both set/);

  idtDenied = true; d = await (await check("otp-test-secret", fullEnv)).json(); idtDenied = false;
  const um = d.checks["Firebase user management (role: Firebase Authentication Admin)"];
  assert.equal(um.ok, false); assert.match(um.detail, /Firebase Authentication Admin role/);

  relayMode = "html"; d = await (await check("otp-test-secret", fullEnv)).json(); relayMode = "ok";
  assert.equal(d.checks[RELAY].ok, false); assert.match(d.checks[RELAY].detail, /Anyone.*NEW VERSION/);

  d = await (await check("otp-test-secret", { ...fullEnv, MAIL_RELAY_SECRET: "nope" })).json();
  assert.match(d.checks[RELAY].detail, /does not match/);

  d = await (await check("otp-test-secret", { ...fullEnv, TURNSTILE_SECRET: "wrong-ts" })).json();
  assert.match(d.checks["Turnstile secret is accepted by Cloudflare"].detail, /wrong/);
});
await test("setup check: the Apps Script answers a ping with the remaining quota and sends nothing", async () => {
  const gs = fs.readFileSync(new URL("./mail-relay.gs", import.meta.url), "utf8");
  assert.match(gs, /if \(d\.ping\) return reply\(\{ ok: true, quota: MailApp\.getRemainingDailyQuota\(\) \}\)/);
  assert.ok(gs.indexOf("d.ping") > gs.indexOf("d.secret !== SECRET"), "the secret is checked before the ping answers");
});

console.log("routing");
await test("unknown API route is 404, other paths fall through to static assets", async () => {
  assert.equal((await call("/api/nope", {}, {}, "POST")).status, 404);
  assert.equal(await (await worker.fetch(new Request("https://x.test/index.html"), env)).text(), "asset");
});

console.log(`\n${passed} tests passed`);
