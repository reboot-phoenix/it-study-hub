// Run: node site.test.mjs. Checks the things search engines, social previews and keyboard users depend on.
import assert from "node:assert/strict";
import fs from "node:fs";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };
const pages = fs.readdirSync(".").filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).sort();
const PRIVATE = new Set(["admin", "global", "Login", "profile", "404"]);
const read = (n) => fs.readFileSync(n + ".html", "utf8");
const BASE = "https://itstudyhub.dpdns.org";

console.log("search and sharing tags");
test("every public page has a unique title, a real description, a canonical address and social tags", () => {
  const titles = new Set();
  for (const n of pages.filter((p) => !PRIVATE.has(p))) {
    const s = read(n);
    const title = s.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title, n + ": title"); assert.ok(!titles.has(title) || n === "blog-post", n + ": duplicate title"); titles.add(title);
    const desc = s.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert.ok(desc && desc.length >= 50 && desc.length <= 200, `${n}: description length ${desc?.length}`);
    const want = n === "index" ? BASE + "/" : `${BASE}/${n}`;
    assert.equal(s.match(/<link rel="canonical" href="([^"]+)"/)?.[1], want, n + ": canonical");
    for (const p of ["og:title", "og:description", "og:url", "og:image", "og:type", "og:site_name"]) assert.ok(s.includes(`property="${p}"`), `${n}: ${p}`);
    assert.ok(s.includes('name="twitter:card"'), n + ": twitter card");
    assert.ok(!/\.html"/.test(s.match(/<link rel="canonical"[^>]*>/)[0]), n + ": canonical must not end in .html (the site serves pages without it)");
  }
});
test("pages for signed-in users and utility pages are kept out of search results", () => {
  for (const n of PRIVATE) assert.match(read(n), /<meta name="robots" content="noindex, nofollow">/, n);
  for (const n of pages.filter((p) => !PRIVATE.has(p))) assert.ok(!/name="robots" content="noindex/.test(read(n)), n + " is public");
});
test("robots.txt points at the sitemap and does not block pages that carry noindex", () => {
  const r = fs.readFileSync("robots.txt", "utf8");
  assert.match(r, /Sitemap: https:\/\/itstudyhub\.dpdns\.org\/sitemap\.xml/);
  for (const n of PRIVATE) assert.ok(!r.includes(`Disallow: /${n}`), n + " must stay crawlable so its noindex is seen");
});
test("each blog article gets its own title, description and address when opened", () => {
  const s = read("blog-post");
  for (const key of ['document.title = post.title', "'meta[name=\"description\"]'", "'link[rel=\"canonical\"]'", "blog-post?id="]) assert.ok(s.includes(key), key);
});

console.log("sitemap");
const xml = fs.readFileSync("sitemap.xml", "utf8");
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
test("the sitemap lists every public page exactly once, nothing missing and nothing private", () => {
  assert.equal(new Set(locs).size, locs.length, "duplicate entries");
  const expected = pages.filter((p) => !PRIVATE.has(p) && p !== "blog-post").map((p) => (p === "index" ? BASE + "/" : `${BASE}/${p}`));
  for (const u of expected) assert.ok(locs.includes(u), "missing " + u);
  for (const u of locs.filter((l) => !l.includes("blog-post?id="))) assert.ok(expected.includes(u), "lists a page that does not exist or is private: " + u);
});
test("every blog article is in the sitemap", () => {
  const ids = [...read("blog-post").matchAll(/\n\s*id:\s*(\d+),\s*\n\s*slug:/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10);
  for (const id of ids) assert.ok(locs.includes(`${BASE}/blog-post?id=${id}`), "article " + id);
});

console.log("accessibility");
test("every page loads the keyboard and cursor helpers", () => {
  for (const n of pages) { const s = read(n); assert.ok(s.includes("ish-a11y.js") && s.includes("ish-cursor-guard.js"), n); }
});
test("the real mouse pointer is only ever hidden once the custom cursor is running", () => {
  for (const f of fs.readdirSync(".").filter((x) => /\.(html|css)$/.test(x))) {
    const s = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of s.matchAll(/([^{}]*)\{[^{}]*cursor:\s*none/g)) assert.ok(/custom-cursor/.test(m[1]), `${f}: unguarded cursor:none (${m[1].trim().slice(0, 40)})`);
  }
});
test("no image is missing alt text, and icon-only buttons have a name", () => {
  for (const n of pages) {
    const s = read(n).replace(/<script[\s\S]*?<\/script>/g, (m) => m.replace(/<img/g, "<IMG-IN-SCRIPT"));
    assert.deepEqual([...s.matchAll(/<img(?![^>]*\balt=)[^>]*>/g)].map((m) => m[0].slice(0, 40)), [], n);
    for (const m of read(n).replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const named = m[2].replace(/<[^>]+>/g, "").trim() || /aria-label|title=/.test(m[1]);
      assert.ok(named, `${n}: icon-only button without a name`);
    }
  }
  assert.ok(/alt=""/.test(fs.readFileSync("practice-panel.html", "utf8")));
});

console.log("weight");
test("the social preview image is small and the right shape", () => {
  const size = fs.statSync("team_image.jpeg").size;
  assert.ok(size < 150 * 1024, "team_image.jpeg is " + Math.round(size / 1024) + " KB");
});

console.log(`\n${passed} tests passed`);
