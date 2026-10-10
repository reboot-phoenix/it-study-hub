// Grants or revokes admin for one person. Admin = users/{uid}.role == "admin", the only admin switch
// (Firestore rules and the Worker both check it; browsers cannot write it).
//
//   node scripts/grant-admin.mjs <service-account.json> <email>            make that person an admin
//   node scripts/grant-admin.mjs <service-account.json> <email> --revoke   remove admin
//
// The person must have signed in to the site at least once, so their profile exists.
// Also deletes the old "isAdmin" flag from that profile. Afterwards they should sign out and back in.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { getAccessToken } from "../worker.js";

const PROJECT = "it-study-hub";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

export async function setRole({ email, revoke = false, token, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const target = String(email || "").trim();
  if (!target.includes("@")) throw new Error("Give a full email address.");

  const found = new Map();
  for (const candidate of new Set([target, target.toLowerCase()])) {
    const res = await fetchImpl(`${BASE}:runQuery`, {
      method: "POST", headers,
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: "users" }],
        where: { fieldFilter: { field: { fieldPath: "email" }, op: "EQUAL", value: { stringValue: candidate } } },
        limit: 5,
      } }),
    });
    if (!res.ok) throw new Error(`Lookup failed (${res.status}): ${await res.text()}`);
    for (const row of await res.json()) if (row.document) found.set(row.document.name, row.document);
  }
  if (found.size === 0) throw new Error(`No profile found for ${target}. Ask them to sign in to the site once, then retry.`);
  if (found.size > 1) throw new Error(`More than one profile has the email ${target}; fix that in the Firebase console first.`);

  const [doc] = found.values();
  const uid = doc.name.split("/").pop();
  const fields = revoke ? {} : { role: { stringValue: "admin" } };   // absent + in the mask = deleted
  const res = await fetchImpl(
    `${BASE}/users/${uid}?updateMask.fieldPaths=role&updateMask.fieldPaths=isAdmin&currentDocument.exists=true`,
    { method: "PATCH", headers, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Update failed (${res.status}): ${await res.text()}`);
  return { uid, role: revoke ? null : "admin" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [keyFile, email, flag] = process.argv.slice(2);
  if (!keyFile || !email) { console.error("Usage: node scripts/grant-admin.mjs <service-account.json> <email> [--revoke]"); process.exit(1); }
  try {
    const token = await getAccessToken({ FIREBASE_SERVICE_ACCOUNT: fs.readFileSync(keyFile, "utf8") });
    const { uid, role } = await setRole({ email, revoke: flag === "--revoke", token });
    console.log(role ? `${email} (${uid}) is now an admin. Ask them to sign out and back in.` : `${email} (${uid}) is no longer an admin.`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
