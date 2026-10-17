// Run: node shared.test.mjs   (Node 18+). Tests firebase.js and auth.js with stand-ins for the Firebase SDK,
// and checks the project config lives in exactly one file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("  ok  " + name); };

// ---------- build a sandbox copy of the modules whose Firebase imports point at local stand-ins ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ish-shared-"));
const stubs = {
  "app-stub.mjs": `
    export const state = { initCalls: 0, apps: [] };
    export function initializeApp(options) { state.initCalls++; const app = { name: "[DEFAULT]", options }; state.apps.push(app); return app; }
    export function getApps() { return state.apps; }
    export function getApp() { return state.apps[0]; }`,
  "auth-stub.mjs": `
    export const authState = { signedOut: 0 };
    const instances = new Map();
    export function getAuth(app) {
      if (!instances.has(app)) instances.set(app, { currentUser: null, ready: true, authStateReady: async function () { if (this.failReady) throw new Error("boom"); } });
      return instances.get(app);
    }
    export async function signOut(auth) { authState.signedOut++; auth.currentUser = null; }`,
};
for (const [name, code] of Object.entries(stubs)) fs.writeFileSync(path.join(tmp, name), code);
const rewrite = (src) => src
  .replace("https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js", "./app-stub.mjs")
  .replace("https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js", "./auth-stub.mjs")
  .replace("'/firebase.js'", "'./firebase.js'");
for (const f of ["firebase.js", "auth.js"]) fs.writeFileSync(path.join(tmp, f.replace(".js", ".mjs")), rewrite(fs.readFileSync(new URL("./" + f, import.meta.url), "utf8")).replace("'./firebase.js'", "'./firebase.mjs'"));

// ---------- browser stand-ins ----------
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.location = { href: "https://site.test/profile" };
let appCheckCalls = [];
globalThis.ishInitAppCheck = async (app) => { appCheckCalls.push(app); };
const fetchCalls = [];
globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };

const appStub = await import(pathToFileURL(path.join(tmp, "app-stub.mjs")).href);
const authStub = await import(pathToFileURL(path.join(tmp, "auth-stub.mjs")).href);
const firebase = await import(pathToFileURL(path.join(tmp, "firebase.mjs")).href);
const A = await import(pathToFileURL(path.join(tmp, "auth.mjs")).href);

console.log("firebase.js");
await test("initialises the one Firebase app for the right project, once, with App Check started first", async () => {
  assert.equal(appStub.state.initCalls, 1);
  assert.equal(firebase.app.options.projectId, "it-study-hub");
  assert.deepEqual(appCheckCalls, [firebase.app]);
});
await test("importing it again (as every page and helper does) never creates a second app", async () => {
  await import(pathToFileURL(path.join(tmp, "firebase.mjs")).href + "?again");   // a different URL = a fresh module run
  assert.equal(appStub.state.initCalls, 1, "getApps() is reused");
});

console.log("auth.js");
await test("getIdToken: null when signed out, a token when signed in, null (not a crash) if Firebase fails", async () => {
  assert.equal(await A.getIdToken(), null);
  A.auth.currentUser = { uid: "u1", getIdToken: async () => "tok-123" };
  assert.equal(await A.getIdToken(), "tok-123");
  A.auth.failReady = true;
  assert.equal(await A.getIdToken(), null);
  A.auth.failReady = false;
});
await test("apiFetch: signed-out callers get a 401 and nothing is sent", async () => {
  A.auth.currentUser = null; fetchCalls.length = 0;
  const res = await A.apiFetch("/api/run", { method: "POST", body: { a: 1 } });
  assert.equal(res.status, 401); assert.match((await res.json()).error, /sign in/i);
  assert.equal(fetchCalls.length, 0);
});
await test("apiFetch: sends the token, JSON body and method; a GET sends no body or content type", async () => {
  A.auth.currentUser = { getIdToken: async () => "tok-abc" }; fetchCalls.length = 0;
  await A.apiFetch("/api/award-xp", { method: "POST", body: { type: "quiz", score: 7 } });
  const post = fetchCalls[0];
  assert.equal(post.url, "/api/award-xp"); assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers.Authorization, "Bearer tok-abc"); assert.equal(post.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(post.init.body), { type: "quiz", score: 7 });
  await A.apiFetch("/api/access");
  const get = fetchCalls[1];
  assert.equal(get.init.method, "GET"); assert.equal(get.init.body, undefined); assert.equal(get.init.headers["Content-Type"], undefined);
});
await test("session cache: write, merge, read, clear, and corrupted data reads as empty", async () => {
  A.writeSession({ uid: "u1", name: "Ana" });
  A.mergeSession({ isAdmin: true });
  assert.deepEqual(A.readSession(), { uid: "u1", name: "Ana", isAdmin: true });
  assert.equal(store.get("ish_session").includes('"uid":"u1"'), true);
  localStorage.setItem("ish_session", "{not json");
  assert.equal(A.readSession(), null);
  A.mergeSession({ x: 1 });                                   // merging into a corrupted cache starts fresh, no crash
  assert.deepEqual(A.readSession(), { x: 1 });
  A.clearSession();
  assert.equal(A.readSession(), null);
});
await test("signOutEverywhere: clears the cache, signs out, then redirects", async () => {
  A.writeSession({ uid: "u1" }); A.auth.currentUser = { uid: "u1" };
  await A.signOutEverywhere();
  assert.equal(A.readSession(), null); assert.equal(authStub.authState.signedOut, 1); assert.equal(location.href, "index.html");
  await A.signOutEverywhere({ redirect: null }); location.href = "stay";
  assert.equal(location.href, "stay");
});
await test("classic scripts can reach the same helpers through window.ishAuth", async () => {
  for (const k of ["auth", "getIdToken", "apiFetch", "signOutEverywhere", "readSession", "writeSession", "mergeSession", "clearSession"]) {
    assert.equal(typeof window.ishAuth[k] === "function" || k === "auth", true, k);
  }
  assert.equal(window.ishAuth.apiFetch, A.apiFetch);
});

console.log("one config, everywhere");
const root = new URL("./", import.meta.url).pathname;
const files = fs.readdirSync(root).filter((f) => /\.(html|js|mjs)$/.test(f) && !f.endsWith(".test.mjs"));
await test("the Firebase project config exists in firebase.js and nowhere else", async () => {
  const holders = files.filter((f) => /AIzaSy|firebaseConfig\s*=|initializeApp\(/.test(fs.readFileSync(root + f, "utf8")));
  assert.deepEqual(holders, ["firebase.js"]);
});
await test("pages use shared Firebase and auth modules where needed", async () => {
  for (const f of ["Login", "admin", "courses", "global", "practice-panel", "profile", "quiz", "premium"]) {
    const html = fs.readFileSync(root + f + ".html", "utf8");
    assert.match(html, /from ["']\/firebase\.js["']/, f + " imports firebase.js");
    assert.match(html, /from ["']\/auth\.js["']/, f + " imports auth.js");
  }

  // c.html delegates authenticated API calls to the shared auth helper.
  const c = fs.readFileSync(root + "c.html", "utf8");
  assert.match(c, /import\(["']\/auth\.js["']\)/, "c.html dynamically imports auth.js");
  assert.match(c, /apiFetch/, "c.html uses the shared API helper");
});
await test("no page or helper keeps its own copy of sign-out or token code", async () => {
  for (const f of files) {
    const src = fs.readFileSync(root + f, "utf8");
    if (f === "auth.js") continue;
    assert.ok(!/localStorage\.(set|remove)Item\(['"]ish_session['"]/.test(src.replace(/index\.html/, "")) || f === "index.html", f + " writes ish_session directly");
    assert.ok(!/\.getIdToken\(\)/.test(src), f + " fetches a token itself");
    assert.ok(!/await signOut\(auth\)/.test(src), f + " signs out by itself");
  }
});

console.log(`\n${passed} tests passed`);
fs.rmSync(tmp, { recursive: true, force: true });
