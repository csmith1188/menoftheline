import { randomBytes, timingSafeEqual } from "crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function tokensMatch(sent, expected) {
  const left = Buffer.from(String(sent || ""));
  const right = Buffer.from(String(expected || ""));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Issue a session token and expose it to EJS. */
export function ensureCsrf(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString("base64url");
  }
  res.locals.csrfToken = (req.session && req.session.csrfToken) || "";
  next();
}

/**
 * Browser form POSTs must echo the session token.
 * Native /api/v1 calls use a bearer session id and are exempt.
 */
export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const path = String(req.path || "");
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    next();
    return;
  }
  const expected = req.session && req.session.csrfToken;
  const sent = req.body && req.body._csrf;
  if (!tokensMatch(sent, expected)) {
    const err = new Error("Invalid form token. Reload the page and try again.");
    err.status = 403;
    next(err);
    return;
  }
  next();
}
