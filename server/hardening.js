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
 * Loopback, RFC1918, link-local, and .local hosts used when phones/tablets
 * open the dev server by LAN IP while THIS_URL still points at localhost.
 */
export function isDevLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    const [a, b] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  if (host.includes(":")) {
    if (host.startsWith("fe80:")) return true;
    const first = host.split(":", 1)[0];
    if (/^f[cd][0-9a-f]{0,2}$/i.test(first)) return true;
  }
  return false;
}

/**
 * If the request Host is not THIS_URL's host, return an absolute redirect URL
 * to the canonical host (same path + query). Skips loopback / private THIS_URL
 * and missing Host. Used so www vs apex do not split lane.sid cookies.
 */
export function canonicalRedirectLocation(thisUrl, req) {
  let expected;
  try {
    expected = new URL(thisUrl);
  } catch {
    return null;
  }
  if (isDevLocalHost(expected.hostname)) return null;
  const hostHeader = String(req.get?.("host") || req.headers?.host || "").split(",")[0].trim();
  if (!hostHeader) return null;
  let reqHost = hostHeader;
  try {
    // Host may be "www.example.com:443" — URL needs a scheme.
    reqHost = new URL(`http://${hostHeader}`).host;
  } catch {
    return null;
  }
  if (reqHost.toLowerCase() === expected.host.toLowerCase()) return null;
  const path = String(req.originalUrl || req.url || "/");
  return `${expected.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

/** www.example.com ↔ example.com for the same site (cookie/host split). */
export function apexSiblingHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || isDevLocalHost(host)) return null;
  if (host.startsWith("www.")) return host.slice(4);
  if (host.includes(".")) return `www.${host}`;
  return null;
}

/**
 * Browser sockets (cookie auth) must send an Origin that matches THIS_URL
 * (or its www/apex sibling). Packaged Electron/Capacitor clients authenticate
 * with auth.token (session id); for those, Origin is ignored — shells often
 * send Origin "null", capacitor://localhost, or https://localhost.
 *
 * Extra allowance for loopback / private LAN Origins when:
 * - NODE_ENV is development or test, or
 * - THIS_URL itself is loopback/private (local play with phones on Wi‑Fi
 *   while THIS_URL stays http://localhost:PORT — works even if NODE_ENV
 *   was never set in .env).
 */
export function originAllowed(origin, { thisUrl, nodeEnv, hasAuthToken } = {}) {
  // Bearer session id is sufficient for native/shell clients.
  if (hasAuthToken) return true;
  const value = typeof origin === "string" ? origin.trim() : "";
  if (!value || value === "null") return false;
  let expected = "";
  let thisHost = "";
  let thisProto = "https:";
  try {
    const expectedUrl = new URL(thisUrl);
    expected = expectedUrl.origin;
    thisHost = expectedUrl.hostname;
    thisProto = expectedUrl.protocol;
  } catch {
    expected = "";
  }
  if (expected && value === expected) return true;
  let originHost = "";
  let originOrigin = "";
  try {
    const originUrl = new URL(value);
    originHost = originUrl.hostname;
    originOrigin = originUrl.origin;
  } catch {
    return false;
  }
  const sibling = apexSiblingHost(thisHost);
  if (sibling && originHost.toLowerCase() === sibling && originOrigin === `${thisProto}//${sibling}`) {
    return true;
  }
  const relaxLocal = nodeEnv === "development"
    || nodeEnv === "test"
    || isDevLocalHost(thisHost);
  if (relaxLocal && isDevLocalHost(originHost)) return true;
  return false;
}

const PAYPAL_HOSTS = [
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
  "https://www.paypalobjects.com",
  "https://c.paypal.com",
  "https://c.sandbox.paypal.com",
].join(" ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${PAYPAL_HOSTS}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  `connect-src 'self' ${PAYPAL_HOSTS}`,
  `frame-src 'self' ${PAYPAL_HOSTS}`,
  "child-src 'self' https://www.paypal.com https://www.sandbox.paypal.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.paypal.com https://www.sandbox.paypal.com",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(thisUrl) {
  const headers = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(self \"https://www.paypal.com\" \"https://www.sandbox.paypal.com\")",
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
