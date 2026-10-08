import { createHash, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { Filter } from "glin-profanity";

const scryptAsync = promisify(scrypt);

/** English + Spanish display-name filter (leetspeak-aware). */
const nameFilter = new Filter({
  languages: ["english", "spanish"],
  detectLeetspeak: true,
  normalizeUnicode: true,
});

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const TOKEN_BYTES = 32;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function envFlag(name, defaultOn = true) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultOn;
  const text = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return defaultOn;
}

export function localAccountsEnabled() {
  return envFlag("LOCAL_ACCOUNTS", true);
}

export function formbarLoginEnabled() {
  return envFlag("FORMBAR_LOGIN", true);
}

/** Discord OAuth login (needs DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET). Default off. */
export function discordLoginEnabled() {
  return envFlag("DISCORD_LOGIN", false);
}

export function authEmailEnabled() {
  return envFlag("AUTH_EMAIL", true);
}

/** Millisecond epoch floor (~2001); rejects null/0/boolean-ish SQLite `1` leftovers. */
const EMAIL_VERIFIED_AT_MIN_MS = 1_000_000_000_000;

/**
 * Account features (suggest, tickets UI, account play id) require a verified email
 * when AUTH_EMAIL is on. Provider-only accounts (no email) count as verified.
 * Unverified local accounts may still log in with guest-level access.
 */
export function accountEmailVerified(account) {
  if (!account) return false;
  if (!authEmailEnabled()) return true;
  if (!account.email) return true;
  const at = Number(account.email_verified_at);
  return Number.isFinite(at) && at >= EMAIL_VERIFIED_AT_MIN_MS;
}

/** Local account still needs a verification email (AUTH_EMAIL on, address set, not verified). */
export function needsEmailVerification(account) {
  return Boolean(
    authEmailEnabled()
    && account
    && account.email
    && account.password_hash
    && !accountEmailVerified(account),
  );
}

export function anyLoginEnabled() {
  return localAccountsEnabled() || formbarLoginEnabled() || discordLoginEnabled();
}

/** In-match player chat (Socket.IO `chat` event + play-page chrome). */
export function matchChatEnabled() {
  return envFlag("MATCH_CHAT", true);
}

export function smtpConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || "").trim()
    && String(process.env.SMTP_FROM || "").trim(),
  );
}

let bootWarned = false;

/** Log once when local + email auth need SMTP but it is incomplete. */
export function warnAuthConfig() {
  if (bootWarned) return;
  bootWarned = true;
  if (!anyLoginEnabled()) {
    console.warn("Auth: LOCAL_ACCOUNTS, FORMBAR_LOGIN, and DISCORD_LOGIN are all off; login is disabled.");
  }
  if (discordLoginEnabled()) {
    const hasId = Boolean(String(process.env.DISCORD_CLIENT_ID || "").trim());
    const hasSecret = Boolean(String(process.env.DISCORD_CLIENT_SECRET || "").trim());
    if ((!hasId || !hasSecret) && process.env.DISCORD_OAUTH_MOCK !== "1") {
      console.warn("Auth: DISCORD_LOGIN is on but DISCORD_CLIENT_ID/DISCORD_CLIENT_SECRET are incomplete.");
    }
  }
  if (localAccountsEnabled() && authEmailEnabled() && !smtpConfigured()) {
    console.warn("Auth: AUTH_EMAIL is on but SMTP_HOST/SMTP_FROM are incomplete; verify/forgot will fail.");
  }
}

export function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase().slice(0, 254);
}

/** Practical RFC-ish email check used on signup / link / login forms. */
export function isValidEmail(email) {
  const text = String(email || "");
  if (text.length < 5 || text.length > 254) return false;
  if (text.includes("..") || text.startsWith(".") || text.endsWith(".")) return false;
  // local@domain.tld — no spaces; TLD at least 2 letters
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(text)) {
    return false;
  }
  const [local, domain] = text.split("@");
  if (!local || local.length > 64 || !domain || domain.length > 253) return false;
  if (!/\.[a-z]{2,}$/i.test(domain)) return false;
  return true;
}

export function sanitizeDisplayName(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

/** Letters (incl. accents), digits, spaces, hyphen, apostrophe, underscore. */
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N} '\-_]*[\p{L}\p{N}])?$/u;

export function isProfaneName(name) {
  const text = String(name || "").trim();
  if (!text) return false;
  try {
    return Boolean(nameFilter.isProfane(text));
  } catch {
    return false;
  }
}

/**
 * Validate a player display name after sanitizeDisplayName.
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateDisplayName(raw) {
  const name = sanitizeDisplayName(raw);
  if (!name || name.length < 2) {
    return { ok: false, error: "Display name must be at least 2 characters." };
  }
  if (name.length > 32) {
    return { ok: false, error: "Display name must be at most 32 characters." };
  }
  if (!DISPLAY_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: "Display name may only use letters, numbers, spaces, hyphens, apostrophes, and underscores.",
    };
  }
  if (isProfaneName(name)) {
    return { ok: false, error: "Choose a different display name." };
  }
  return { ok: true, name };
}

/**
 * Build "Name", then "Name 2", "Name 3", … truncated to 32 chars.
 * @returns {string | null} null if the candidate fails validation
 */
export function buildDiscriminatedDisplayName(base, index = 1) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 1) return null;
  const rootCheck = validateDisplayName(base);
  const root = rootCheck.ok
    ? rootCheck.name
    : sanitizeDisplayName(base) || "Player";
  if (n === 1) {
    const check = validateDisplayName(root);
    return check.ok ? check.name : null;
  }
  const suffix = ` ${n}`;
  const maxRoot = Math.max(1, 32 - suffix.length);
  let trimmed = root.slice(0, maxRoot).trimEnd();
  if (trimmed.length < 1) trimmed = "P";
  const candidate = `${trimmed}${suffix}`;
  const check = validateDisplayName(candidate);
  return check.ok ? check.name : null;
}

export function isValidPassword(raw) {
  const text = String(raw || "");
  if (text.length < 8 || text.length > 200) return false;
  if (/^\s+$/.test(text)) return false;
  return true;
}

export function passwordError(raw) {
  const text = String(raw || "");
  if (text.length < 8) return "Password must be at least 8 characters.";
  if (text.length > 200) return "Password must be at most 200 characters.";
  if (/^\s+$/.test(text)) return "Password cannot be only spaces.";
  return null;
}

/**
 * Server-side signup field checks (name, email, password).
 * @returns {{ ok: true, name: string, email: string, password: string } | { ok: false, error: string, name: string, email: string }}
 */
export function validateSignupFields({ name, email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const nameCheck = validateDisplayName(
    sanitizeDisplayName(name) || (normalizedEmail.includes("@") ? normalizedEmail.split("@")[0] : ""),
  );
  const safeName = nameCheck.ok ? nameCheck.name : sanitizeDisplayName(name);
  if (!isValidEmail(normalizedEmail)) {
    return {
      ok: false,
      error: "Enter a valid email address.",
      name: safeName,
      email: normalizedEmail,
    };
  }
  if (!nameCheck.ok) {
    return {
      ok: false,
      error: nameCheck.error,
      name: safeName,
      email: normalizedEmail,
    };
  }
  const passErr = passwordError(password);
  if (passErr) {
    return {
      ok: false,
      error: passErr,
      name: nameCheck.name,
      email: normalizedEmail,
    };
  }
  return {
    ok: true,
    name: nameCheck.name,
    email: normalizedEmail,
    password: String(password),
  };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!salt.length || !expected.length) return false;
  const derived = await scryptAsync(String(password), salt, expected.length, { N, r, p });
  const actual = Buffer.from(derived);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function newAuthToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function verifyTokenTtlMs() {
  return VERIFY_TTL_MS;
}

export function resetTokenTtlMs() {
  return RESET_TTL_MS;
}

/** Simple in-process rate limit: max hits per window per key. */
const buckets = new Map();

export function rateLimit(key, { max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) return false;
  return true;
}

/** Test helper: clear rate-limit state. */
export function clearRateLimits() {
  buckets.clear();
}
