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
env.PREMIUM.store.set("pdf:BCA-421 JAVA-97-131.pdf", "%PDF-secret");
let users, payments, orders, ledger, orderSeq, lastFsAuth, lb, listPageSize = 300;
// ── typed-value helpers for the Firestore mock ──
let beforePatch = null;
function toTyped(key, v) {
  if (["planExpiresAt", "planActivatedAt"].includes(key) && typeof v === "string") return { timestampValue: v };
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
  payments = {}; orders = {}; ledger = {}; orderSeq = 0; lb = {}; listPageSize = 300;
}
reset();

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || "GET").toUpperCase();
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });

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
  assert.deepEqual(await (await get("/api/access", "alice")).json(), { premium: false, plan: "" });
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
await test("/api/access reads the profile with the user's own token, not the service account", async () => {
  await get("/api/access", "alice");
  assert.notEqual(lastFsAuth, "Bearer tok");
});
await test("/api/lesson: locked for signed-out and free users, no content leaks", async () => {
  assert.equal((await get("/api/lesson?course=java&id=7")).status, 401);
  const res = await get("/api/lesson?course=java&id=7", "alice");
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes("SECRET"));
});
await test("/api/lesson: paid user gets the lesson, with no-store caching", async () => {
  users.alice = { plan: "basic", planExpiresAt: future };
  const res = await get("/api/lesson?course=java&id=7", "alice");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { body: "SECRET JAVA 7" });
  assert.match(res.headers.get("Cache-Control"), /no-store/);
});
await test("/api/lesson: bad input and missing lessons", async () => {
  users.alice = { plan: "pro" };
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

console.log("routing");
await test("unknown API route is 404, other paths fall through to static assets", async () => {
  assert.equal((await call("/api/nope", {}, {}, "POST")).status, 404);
  assert.equal(await (await worker.fetch(new Request("https://x.test/index.html"), env)).text(), "asset");
});

console.log(`\n${passed} tests passed`);
