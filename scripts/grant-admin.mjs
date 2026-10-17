import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "it-study-hub";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function getAccessToken({ client_email, private_key }) {
  const enc = new TextEncoder();
  const pem = private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const b64url = bytes => {
    let bin = "";
    for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat, exp: iat + 3600
  })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const assertion = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

export async function setRole({ email, revoke = false, token }) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new Error("Please provide a full email address");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("A service-account token is required");
  }

  const targetEmail = email.trim().toLowerCase();
  const matches = [];
  const seenPageTokens = new Set();
  let pageToken;

  do {
    const url = new URL(`${FS_BASE}/users`);
    url.searchParams.set("pageSize", "1000");

    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error("Firestore returned a repeated pagination token");
      }
      seenPageTokens.add(pageToken);
      url.searchParams.set("pageToken", pageToken);
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Firestore email lookup failed: ${res.status}`);
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Firestore returned invalid JSON during email lookup");
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Firestore returned a malformed response");
    }

    if (
      data.documents !== undefined &&
      (!Array.isArray(data.documents) ||
        data.documents.some(
          document =>
            !document ||
            typeof document !== "object" ||
            typeof document.name !== "string" ||
            !new RegExp(`^projects/${PROJECT_ID}/databases/\\(default\\)/documents/users/[^/]+$`).test(document.name) ||
            !document.fields ||
            typeof document.fields !== "object"
        ))
    ) {
      throw new Error("Firestore returned malformed user documents");
    }

    if (
      data.nextPageToken !== undefined &&
      (typeof data.nextPageToken !== "string" || !data.nextPageToken.trim())
    ) {
      throw new Error("Firestore returned an invalid pagination token");
    }

    for (const document of data.documents ?? []) {
      const storedEmail = document.fields.email?.stringValue;

      if (
        typeof storedEmail === "string" &&
        storedEmail.trim().toLowerCase() === targetEmail
      ) {
        matches.push({ document });
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  if (!matches.length) throw new Error("No profile found for that email");
  if (matches.length > 1) throw new Error("More than one profile matches that email");

  const exact = matches;
  const doc = exact[0].document;
  const uid = doc.name.split("/").pop();
  const url = `${FS_BASE}/users/${encodeURIComponent(uid)}?updateMask.fieldPaths=role&updateMask.fieldPaths=isAdmin`;
  const fields = revoke ? {} : { role: { stringValue: "admin" } };
  const update = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!update.ok) throw new Error(`Firestore role update failed: ${update.status}`);
  return { uid, ...(revoke ? {} : { role: "admin" }) };
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args[0] === "--revoke";
  const email = args[revoke ? 1 : 0];
  if (!email) {
    console.error("Usage: node scripts/grant-admin.mjs [--revoke] email@example.com");
    process.exitCode = 1;
    return;
  }
  let sa;
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Set FIREBASE_SERVICE_ACCOUNT in your environment first");
    sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await getAccessToken(sa);
    const result = await setRole({ email, revoke, token });
    console.log(revoke ? `Revoked admin role for ${result.uid}` : `Granted admin role to ${result.uid}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
