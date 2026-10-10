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
};
let users, payments, orders, ledger, orderSeq;
function reset() {
  users = { alice: { plan: "" }, bob: { plan: "" }, carol: { plan: "elite" } };
  payments = {}; orders = {}; ledger = {}; orderSeq = 0;
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
    assert.equal(init.headers.Authorization, "Bearer tok");
    const u = new URL(url); const parts = u.pathname.split("/documents/")[1].split("/");
    const [col, id] = parts;
    if (col === "users") {
      if (method === "GET") return users[id] ? J({ fields: { plan: { stringValue: users[id].plan } } }) : J({}, 404);
      if (method === "PATCH") {
        if (u.searchParams.get("currentDocument.exists") === "true" && !users[id]) return J({}, 404);
        const f = JSON.parse(init.body).fields;
        for (const k of u.searchParams.getAll("updateMask.fieldPaths")) {
          if (f[k]) users[id][k] = Object.values(f[k])[0]; else delete users[id][k];
        }
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

console.log("routing");
await test("unknown API route is 404, other paths fall through to static assets", async () => {
  assert.equal((await call("/api/nope", {}, {}, "POST")).status, 404);
  assert.equal(await (await worker.fetch(new Request("https://x.test/index.html"), env)).text(), "asset");
});

console.log(`\n${passed} tests passed`);
