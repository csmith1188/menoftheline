/**
 * Verify Formbar OAuth access tokens.
 *
 * Formbar signs tokens with RS256 and publishes the public key PEM at
 * GET {AUTH_URL}/certs. This module caches that key. It never falls back
 * to jwt.decode(). A failed fetch or a failed verify rejects the login.
 */
import jwt from "jsonwebtoken";

const CACHE_MS = 60 * 60 * 1000;
const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/;

let cached = { pem: "", at: 0, url: "" };

export function resetFormbarAuthCache() {
  cached = { pem: "", at: 0, url: "" };
}

function findPemString(value) {
  if (typeof value === "string" && value.includes("-----BEGIN")) return value;
  if (!value || typeof value !== "object") return null;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const found = findPemString(value[keys[i]]);
    if (found) return found;
  }
  return null;
}

/** Pull a PEM block out of a raw body or a JSON document that contains one. */
export function extractPem(body) {
  const text = String(body || "").trim();
  if (!text) return "";
  let source = text;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      source = findPemString(JSON.parse(text)) || text;
    } catch {
      source = text;
    }
  }
  const match = String(source).match(PEM_RE);
  return match ? match[0] : "";
}

/**
 * Test processes may supply the PEM as base64 so a spawned server does not
 * call the real Formbar host. Production always fetches /certs.
 */
function testPublicKey(env) {
  if (env.NODE_ENV !== "test" && !env.NODE_TEST_CONTEXT) return "";
  const b64 = env.FORMBAR_PUBLIC_KEY_B64;
  if (!b64) return "";
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    return pem.includes("-----BEGIN") ? pem : "";
  } catch {
    return "";
  }
}

export async function loadFormbarPublicKey(authUrl, { force = false, fetchImpl = fetch } = {}) {
  const base = String(authUrl || "").replace(/\/$/, "");
  if (!force && cached.pem && cached.url === base && Date.now() - cached.at < CACHE_MS) {
    return cached.pem;
  }
  const response = await fetchImpl(`${base}/certs`);
  if (!response || !response.ok) {
    throw new Error("Formbar certificate request failed.");
  }
  const text = await response.text();
  const pem = extractPem(text);
  if (!pem) throw new Error("Formbar certificate response had no public key.");
  cached = { pem, at: Date.now(), url: base };
  return pem;
}

export function verifyFormbarToken(token, pem) {
  return jwt.verify(token, pem, { algorithms: ["RS256"] });
}

function invalidToken(code = "invalid_token") {
  const err = new Error("Invalid Formbar token.");
  err.code = code;
  return err;
}

function identityFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidToken();
  }
  const raw = payload.id ?? payload.userId ?? payload.userID ?? payload.sub;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw invalidToken();
  const named = payload.displayName || payload.name || "";
  return {
    id,
    rawName: named ? String(named) : `Player ${id}`,
  };
}

/**
 * Verify a Formbar access token and return { id, rawName }.
 * Throws code certs_unavailable when the public key cannot be loaded.
 * Throws on a bad signature, expiry, or malformed token. Never returns
 * an unverified payload.
 */
export async function authenticateFormbarToken(token, authUrl, options = {}) {
  const env = options.env || process.env;
  if (typeof token !== "string" || !token || token.length > 4096) {
    throw invalidToken();
  }
  const injected = testPublicKey(env);
  let pem = injected;
  if (!pem) {
    try {
      pem = await loadFormbarPublicKey(authUrl, options);
    } catch {
      const err = new Error("Formbar certificate is unavailable.");
      err.code = "certs_unavailable";
      throw err;
    }
  }
  try {
    return identityFromPayload(verifyFormbarToken(token, pem));
  } catch (err) {
    if (err.code === "invalid_token") throw err;
    if (injected) throw err;
    if (err && (err.name === "TokenExpiredError" || err.name === "NotBeforeError")) throw err;
    try {
      pem = await loadFormbarPublicKey(authUrl, { ...options, force: true });
    } catch {
      const unavailable = new Error("Formbar certificate is unavailable.");
      unavailable.code = "certs_unavailable";
      throw unavailable;
    }
    return identityFromPayload(verifyFormbarToken(token, pem));
  }
}
