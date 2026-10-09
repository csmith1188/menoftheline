import { randomBytes, timingSafeEqual } from "crypto";
import { logger } from "./logger.js";
import { requestClientIp } from "./hardening.js";

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
    const path = String(req.path || "");
    const isApi = path === "/api/v1" || path.startsWith("/api/v1/");
    // Do not mint CSRF on a brand-new API session: with saveUninitialized:false
    // that persists an empty lane.sid and can clobber a real login cookie.
    const hasIdentity = Boolean(
      req.session.accountId
      || req.session.guestId
      || req.session.userId
      || req.session.formbarId,
    );
    if (!isApi || hasIdentity) {
      req.session.csrfToken = randomBytes(32).toString("base64url");
    }
  }
  res.locals.csrfToken = (req.session && req.session.csrfToken) || "";
  next();
}

/**
 * Browser form POSTs must echo the session token (body or X-CSRF-Token).
 * Native /api/v1 calls use a bearer session id and are exempt.
 * PayPal webhooks use signature verification instead of CSRF.
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
  if (path === "/webhooks/paypal") {
    next();
    return;
  }
  const expected = req.session && req.session.csrfToken;
  const sent = (req.body && req.body._csrf)
    || req.get("x-csrf-token")
    || req.get("X-CSRF-Token");
  if (!tokensMatch(sent, expected)) {
    logger.warn({
      event: "csrf_failed",
      path,
      method: req.method,
      ip: requestClientIp(req),
    }, "CSRF token mismatch");
    const err = new Error("Invalid form token. Reload the page and try again.");
    err.status = 403;
    next(err);
    return;
  }
  next();
}
