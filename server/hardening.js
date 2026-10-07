/**
 * Startup and request guards that do not depend on Express.
 * Session cookies, origin checks, and response headers live here so tests
 * can call them without booting the game server.
 */

const DEV_SESSION_SECRET = "lane-pusher-local";
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function allowsDevSessionSecret(env = process.env) {
  return env.NODE_ENV === "development"
    || env.NODE_ENV === "test"
    || Boolean(env.NODE_TEST_CONTEXT);
}

/**
 * Production and any non-dev process must set a long unique SESSION_SECRET.
 * Development, test, and the Node test runner may fall back to the local placeholder.
 */
export function assertSessionSecret(env = process.env) {
  const secret = env.SESSION_SECRET || "";
  if (allowsDevSessionSecret(env)) return secret || DEV_SESSION_SECRET;
  if (!secret || secret === DEV_SESSION_SECRET || secret.length < 32) {
    throw new Error(
      "Refusing to start: set SESSION_SECRET to a unique value of at least 32 characters. "
      + "Development and test may set NODE_ENV=development or NODE_ENV=test to use a local fallback.",
    );
  }
  return secret;
}

export function sessionCookieOptions(thisUrl) {
  let secure = false;
  try {
    secure = new URL(thisUrl).protocol === "https:";
  } catch {
    secure = false;
  }
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

export function httpsDeployment(thisUrl) {
  try {
    return new URL(thisUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** Debug overlays and debugPlay stay off in production even if DEBUG_RANGES=1. */
export function debugRangesEnabled(env = process.env) {
  if (env.NODE_ENV === "production") return false;
  return env.DEBUG_RANGES === "1";
}

export function positiveEnv(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Direct connections use the socket address so a client cannot spoof
 * X-Forwarded-For. Set TRUST_PROXY=1 only when Node sits behind the
 * existing Nginx proxy (one trusted hop). Express then fills req.ip.
 */
export function requestClientIp(req, env = process.env) {
  if (env.TRUST_PROXY === "1") return req.ip || "unknown";
  const addr = req.socket && req.socket.remoteAddress;
  return addr || "unknown";
}

/**
 * Browser sockets must send an Origin that matches THIS_URL.
 * Localhost origins are extra-allowed only in development and test.
 * A missing Origin is a non-browser client and is allowed only when the
 * native API token is present on the handshake.
 */
export function originAllowed(origin, { thisUrl, nodeEnv, hasAuthToken } = {}) {
  const value = typeof origin === "string" ? origin.trim() : "";
  if (!value) return Boolean(hasAuthToken);
  let expected = "";
  try {
    expected = new URL(thisUrl).origin;
  } catch {
    expected = "";
  }
  if (expected && value === expected) return true;
  if (nodeEnv === "development" || nodeEnv === "test") {
    try {
      const host = new URL(value).hostname;
      if (host === "localhost" || host === "127.0.0.1") return true;
    } catch {
      return false;
    }
  }
  return false;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(thisUrl) {
  const headers = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
  if (httpsDeployment(thisUrl)) {
    headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}

export function securityHeadersMiddleware(thisUrl) {
  const headers = securityHeaders(thisUrl);
  return function setSecurityHeaders(req, res, next) {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    next();
  };
}
