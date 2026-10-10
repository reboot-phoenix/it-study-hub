// Moves premium lesson text and PDFs out of the public site into a KV bulk-upload file.
//
//   node scripts/extract-premium.mjs           dry run: shows what would change
//   node scripts/extract-premium.mjs --apply   strips premium lesson bodies from the six course pages
//                                              and writes premium-export/kv-bulk.json
//
// Safe to re-run: modules whose body is already empty are skipped. Every rewrite is verified by
// re-parsing the page and comparing every field of every module before anything is written.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const APPLY = process.argv.includes("--apply");
const COURSES = { java: "java.html", c: "c.html", cpp: "c++.html", r: "r.html", javascript: "javascript.html", python: "python.html" };

// Edit this list to change which PDFs are premium.
const PREMIUM_PDFS = [
  "BCA-421 JAVA-97-131.pdf", "BCA-421 JAVA-133-188.pdf", "BCA-421 JAVA-189-260.pdf",
  "IT_Study_Hub_C_Programming_Module_9.pdf", "IT_Study_Hub_C_Programming_Module_10.pdf",
  "IT_Study_Hub_C_Programming_Module_11.pdf", "IT_Study_Hub_C_Programming_Module_12.pdf",
  "C++ lecture notes Complete-67-120.pdf", "C++ lecture notes Complete-108-132.pdf", "C++ lecture notes Complete-133-146.pdf",
];

const parse = (text) => vm.runInNewContext("(" + text + ")");

// Skip a JS string / template literal starting at i; returns the index just after it.
function skipLiteral(s, i) {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === q) return i + 1;
    if (q === "`" && c === "$" && s[i + 1] === "{") { i = skipBraces(s, i + 1); continue; }
    i++;
  }
  throw new Error("Unterminated literal");
}
function skipBraces(s, i) { // s[i] === "{"
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = skipLiteral(s, i); continue; }
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error("Unbalanced braces");
}

// Skip a whole property value (a literal, or several joined with "+") up to the "," or closing
// bracket that ends it. Some lessons contain unescaped backticks, which JavaScript reads as
// `a` + code + `b`, so a value is not always one literal.
function skipValue(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") { i = skipLiteral(s, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; }
    else if (c === "," && depth === 0) return i;
    i++;
  }
  throw new Error("Unterminated value");
}

function locateArray(src) {
  const start = src.indexOf("const MODS = [");
  assert.ok(start >= 0, "MODS not found");
  const arrStart = src.indexOf("[", start);
  let from = arrStart;
  for (;;) {
    const idx = src.indexOf("\n];", from);
    if (idx < 0) throw new Error("Could not find end of MODS");
    try {
      const mods = parse(src.slice(arrStart, idx + 2));
      if (Array.isArray(mods) && mods.length >= 12) return { arrStart, arrEnd: idx + 2, mods };
    } catch { /* this "\n];" was inside a string; keep looking */ }
    from = idx + 1;
  }
}

const kv = [];
const report = [];
for (const [course, file] of Object.entries(COURSES)) {
  const src = fs.readFileSync(file, "utf8");
  const { arrStart, arrEnd, mods } = locateArray(src);
  const arrText = src.slice(arrStart, arrEnd);
  const targets = mods.filter((m) => m.free === false && typeof m.body === "string" && m.body.length > 0);
  if (!targets.length) { report.push(`${course}: nothing to extract (already done?)`); continue; }

  const edits = [];
  let cursor = 0;
  for (const m of targets) {
    const idRe = new RegExp(`(?:^|[\\s{,])"?id"?\\s*:\\s*${m.id}\\s*[,}]`, "g");
    idRe.lastIndex = cursor;
    const idMatch = idRe.exec(arrText);
    assert.ok(idMatch, `${course}: id ${m.id} not found`);
    const bodyRe = /"?\bbody\b"?\s*:\s*/g;
    bodyRe.lastIndex = idMatch.index;
    const bodyMatch = bodyRe.exec(arrText);
    assert.ok(bodyMatch, `${course}: body for ${m.id} not found`);
    const vStart = bodyMatch.index + bodyMatch[0].length;
    const quote = arrText[vStart];
    assert.ok(['"', "'", "`"].includes(quote), `${course}: unexpected body start for ${m.id}`);
    const vEnd = skipValue(arrText, vStart);
    edits.push({ vStart, vEnd });
    cursor = vEnd;
    kv.push({ key: `lesson:${course}:${m.id}`, value: JSON.stringify({ body: m.body }) });
  }

  let newArr = arrText;
  for (const e of [...edits].reverse()) newArr = newArr.slice(0, e.vStart) + '""' + newArr.slice(e.vEnd);

  // Verify: nothing changed except the premium bodies. (Compared as JSON because objects parsed
  // in separate VM contexts never pass deepStrictEqual.)
  const after = parse(newArr);
  assert.equal(after.length, mods.length, `${course}: module count changed`);
  mods.forEach((m, i) => {
    const expected = targets.includes(m) ? { ...m, body: "" } : m;
    if (JSON.stringify(after[i]) !== JSON.stringify(expected)) {
      throw new Error(`${course}: module ${m.id} changed beyond its body, aborting before writing anything`);
    }
  });

  const newSrc = src.slice(0, arrStart) + newArr + src.slice(arrEnd);
  report.push(`${course}: ${targets.length} premium bodies (${targets.map((t) => t.id).join(",")}), page ${src.length} -> ${newSrc.length} bytes, verified`);
  if (APPLY) {
    fs.mkdirSync("premium-export/backup", { recursive: true });
    fs.copyFileSync(file, path.join("premium-export/backup", file));
    fs.writeFileSync(file, newSrc);
  }
}

for (const f of PREMIUM_PDFS) {
  const p = path.join("pdf", f);
  if (fs.existsSync(p)) {
    kv.push({ key: `pdf:${f}`, value: fs.readFileSync(p).toString("base64"), base64: true });
    report.push(`pdf: ${f}`);
  } else {
    report.push(`pdf: ${f} (not found in pdf/, skipped; already moved?)`);
  }
}

console.log(report.join("\n"));
if (APPLY && kv.length && fs.existsSync("premium-export/kv-bulk.json") && !process.argv.includes("--force")) {
  console.log("\npremium-export/kv-bulk.json already exists; leaving it alone (use --force to overwrite).");
} else if (APPLY && kv.length) {
  fs.mkdirSync("premium-export", { recursive: true });
  fs.writeFileSync("premium-export/kv-bulk.json", JSON.stringify(kv));
  console.log(`\nWrote premium-export/kv-bulk.json with ${kv.length} entries. Do NOT commit it.`);
} else if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to write changes.");
}
