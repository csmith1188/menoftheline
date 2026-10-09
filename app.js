import "./server/load-env.js";
import path from "path";
import { createServer } from "http";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import { timingSafeEqual } from "crypto";
import { Server } from "socket.io";
import { asErr, child as childLogger, logger } from "./server/logger.js";
import {
  assignOwner,
  beginTicketPurchase,
  canEditWiki,
  completeTicketPurchase,
  consumeAuthToken,
  countOpenBugs,
  countOpenSuggestions,
  createAuthToken,
  createLocalAccount,
  createSuggestion,
  deleteLocalAccount,
  dataPath,
  ensureGuest,
  failTicketPurchase,
  findAccountForProfile,
  FREE_OPEN_SUGGESTIONS,
  getAccount,
  getAccountByEmail,
  getAccountByFormbar,
  getUser,
  getWikiPageBySlug,
  initDb,
  linkDiscordToAccount,
  linkFormbarToAccount,
  listAccountMmrHistory,
  listPaypalPurchasesForAccount,
  listWikiPages,
  listWikiSlugs,
  deleteWikiPageBySlug,
  MAX_OPEN_BUGS,
  MAX_OPEN_WIKI_REVISIONS,
  mergeAccounts,
  sanitizeUserText,
  saveWikiPage,
  bgmVolumePercent,
  clampBgmVolumePercent,
  isDisplayNameTaken,
  setAccountDisplayName,
  setAccountPassword,
  setEmailVerified,
  setLocalCredentials,
  setPlayerBgmVolume,
  setPlayerTooltips,
  spendFreeTicket,
  tryLockTicketPurchase,
  unlockTicketPurchase,
  SUGGESTION_BODY_MAX,
  SUGGESTION_REPRO_MAX,
  isAccountBanned,
  recordOpsSample,
  ticketPack,
  topAccounts,
  touchAccountLogin,
  touchAccountSeen,
  tooltipsEnabled,
  upsertAccount,
  upsertDiscordAccount,
  wikiSlug,
  WIKI_BODY_MAX,
  WIKI_TITLE_MAX,
} from "./server/db.js";
import {
  accountEmailVerified,
  anyLoginEnabled,
  authEmailEnabled,
  discordLoginEnabled,
  formbarLoginEnabled,
  hashPassword,
  hashToken,
  isValidEmail,
  localAccountsEnabled,
  matchChatEnabled,
  needsEmailVerification,
  newAuthToken,
  normalizeEmail,
  passwordError,
  rateLimit,
  resetTokenTtlMs,
  validateDisplayName,
  validateSignupFields,
  verifyPassword,
  verifyTokenTtlMs,
  warnAuthConfig,
} from "./server/auth.js";
import { mailReady, sendResetEmail, sendVerifyEmail } from "./server/mail.js";
import { ensureMetrics, report as metricsReport, startMetrics } from "./server/metrics.js";
import { workerCount } from "./server/owners.js";
import { scheduleSettingWrite } from "./server/settingsWrite.js";
import { readPrefsCookies, writePrefsCookies } from "./server/prefsCookie.js";
import { connectFormbar, disconnectFormbar, payPool, rewardFromPool } from "./server/formbar.js";
import { authenticateFormbarToken } from "./server/formbarAuth.js";
import { ensureCsrf, requireCsrf } from "./server/csrf.js";
import {
  accountCanBuyPaypal,
  createPaypalOrder,
  handlePaypalWebhookEvent,
  listPaypalPackages,
  paypalCheckoutEnabled,
  paypalClientIdPublic,
  paypalMode,
  settlePaypalPurchase,
  startPaypalReconcileLoop,
  stopPaypalReconcileLoop,
  verifyPaypalWebhookSignature,
} from "./server/paypal.js";
import {
  assertSessionSecret,
  debugRangesEnabled,
  originAllowed,
  positiveEnv,
  requestClientIp,
  securityHeadersMiddleware,
  sessionCookieOptions,
} from "./server/hardening.js";
import {
  PREFS_BGM_DEFAULT,
  PREFS_TOOLTIPS_DEFAULT,
} from "./shared/prefs.js";
import { allowSocketEvent } from "./server/commandLimit.js";
import {
  discordAuthorizeUrl,
  discordConfigured,
  discordDisplayName,
  fetchDiscordUserFromCode,
  newDiscordOAuthState,
} from "./server/discord.js";
import { Matchmaker } from "./server/matchmaking.js";
import { loadNews } from "./server/news.js";
import { renderWikiBody } from "./server/wiki-render.js";
import { createAdminRouter } from "./server/admin/routes.js";
import {
  getStaffContext,
  sessionIsAdmin,
} from "./server/admin/auth.js";
import {
  getMaintenanceMessage,
  isMatchmakingPaused,
} from "./server/admin/ops.js";
import {
  BASE_GPS_MAX,
  BASE_GPS_MIN,
  MATCH_SPEEDS,
  defaultMatchOptions,
  normalizeMatchOptions,
} from "./shared/matchOptions.js";
import { MAP_PRESETS, mapPresetIds } from "./shared/maps.js";
import {
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  isClientOutdated,
  parseProtocol,
} from "./shared/protocol.js";

const require = createRequire(import.meta.url);
const connectSqlite3 = require("connect-sqlite3");
const SQLiteStore = connectSqlite3(session);

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const AUTH_URL = String(process.env.AUTH_URL || "https://formbar.yorktechapps.com")
  .replace(/\/oauth\/?$/, "")
  .replace(/\/$/, "");
const THIS_URL = String(process.env.THIS_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const POOL_ID = Number(process.env.POOL_ID);

let sessionSecret;
try {
  sessionSecret = assertSessionSecret(process.env);
} catch (err) {
  logger.fatal({ event: "server_session_secret_invalid", errMessage: err.message }, "refusing to start");
  process.exit(1);
}

try {
  await initDb();
} catch (err) {
  logger.fatal({ event: "db_init_failed", err: asErr(err) }, "database init failed");
  process.exit(1);
}
warnAuthConfig();

const app = express();
const httpServer = createServer(app);
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
// Prefer WebSocket; long-polling at 20 Hz state kills mobile Safari latency.
// Browser Origins must match THIS_URL. A missing Origin is allowed here and
// checked again in io.use, where native clients present auth.token.
const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (originAllowed(origin, {
        thisUrl: THIS_URL,
        nodeEnv: process.env.NODE_ENV,
        hasAuthToken: false,
      })) {
        callback(null, true);
        return;
      }
      callback(new Error("origin not allowed"), false);
    },
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingInterval: 20000,
  pingTimeout: 20000,
  // Game commands are tiny. A 1 MB default buffer is a memory lever, not a need.
  maxHttpBufferSize: 64 * 1024,
  // Skip websocket payload compression — decompressing every tick hammers phones.
  perMessageDeflate: false,
  httpCompression: true,
});
const formbarSocket = connectFormbar(AUTH_URL, process.env.API_KEY || "");

const sessionStore = new SQLiteStore({
  db: "Men Of The Line.sqlite",
  dir: dataPath,
  concurrentDb: true,
});
if (sessionStore.db && sessionStore.db.configure) {
  sessionStore.db.configure("busyTimeout", 5000);
}
const sessionMiddleware = session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: "lane.sid",
  cookie: sessionCookieOptions(THIS_URL),
});

const LIMITS = {
  login: positiveEnv(process.env, "RATE_LOGIN_MAX", 20),
  loginWindow: positiveEnv(process.env, "RATE_LOGIN_WINDOW_MS", 15 * 60 * 1000),
  guest: positiveEnv(process.env, "RATE_GUEST_MAX", 10),
  guestWindow: positiveEnv(process.env, "RATE_GUEST_WINDOW_MS", 10 * 60 * 1000),
  play: positiveEnv(process.env, "RATE_PLAY_MAX", 30),
  ticket: positiveEnv(process.env, "RATE_TICKET_MAX", 6),
  suggest: positiveEnv(process.env, "RATE_SUGGEST_MAX", 10),
  suggestWindow: positiveEnv(process.env, "RATE_SUGGEST_WINDOW_MS", 10 * 60 * 1000),
  wiki: positiveEnv(process.env, "RATE_WIKI_MAX", 10),
  admin: positiveEnv(process.env, "RATE_ADMIN_MAX", 60),
  lobby: positiveEnv(process.env, "RATE_LOBBY_MAX", 10),
};

const GUEST_PLAY_MODES = new Set(["bot", "trainBot", "casual", "trainCasual"]);
const PAID_PLAY_MODES = new Set(["listed", "ranked", "join"]);

/** Attach store-backed save helpers so API/socket token sessions match cookie sessions. */
function wrapStoredSession(sid, data) {
  const sess = data || {};
  sess.save = (cb) => {
    sessionStore.set(sid, sess, typeof cb === "function" ? cb : () => {});
  };
  sess.reload = (cb) => {
    sessionStore.get(sid, (err, fresh) => {
      if (err) {
        if (typeof cb === "function") cb(err);
        return;
      }
      if (!fresh) {
        if (typeof cb === "function") cb(new Error("failed to load session"));
        return;
      }
      for (const key of Object.keys(sess)) {
        if (key === "save" || key === "reload" || key === "destroy" || key === "touch") continue;
        delete sess[key];
      }
      Object.assign(sess, fresh);
      if (typeof cb === "function") cb();
    });
  };
  sess.destroy = (cb) => {
    sessionStore.destroy(sid, typeof cb === "function" ? cb : () => {});
  };
  sess.touch = (cb) => {
    if (typeof sessionStore.touch === "function") {
      sessionStore.touch(sid, sess, typeof cb === "function" ? cb : () => {});
      return;
    }
    if (typeof cb === "function") cb();
  };
  return sess;
}

function loadStoredSession(sid) {
  return new Promise((resolve, reject) => {
    sessionStore.get(sid, (err, data) => {
      if (err) reject(err);
      else resolve(data || null);
    });
  });
}

function minClientProtocol() {
  const fromEnv = parseProtocol(process.env.MOTL_MIN_PROTOCOL);
  return fromEnv == null ? PROTOCOL_VERSION : fromEnv;
}

function clientProtocolFromRequest(req) {
  const headerProto = parseProtocol(req.headers["x-motl-protocol"]);
  if (headerProto != null) return headerProto;
  return parseProtocol(req.body && req.body.protocol);
}

function rejectIfClientOutdated(req, res) {
  const clientProtocol = clientProtocolFromRequest(req);
  const minProtocol = minClientProtocol();
  if (!isClientOutdated(clientProtocol, minProtocol)) return false;
  res.status(426).json({
    error: "client_outdated",
    protocol: PROTOCOL_VERSION,
    minProtocol,
    clientProtocol,
  });
  return true;
}

function requireApiSession(req, res, next) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (match) {
    const sid = match[1];
    loadStoredSession(sid).then((data) => {
      if (data) {
        req.sessionID = sid;
        req.session = wrapStoredSession(sid, data);
        next();
        return;
      }
      // Stale shell token after login regenerateSession: fall back to cookie.
      if (req.session && req.sessionID) {
        next();
        return;
      }
      logger.warn({
        event: "api_unauthorized",
        path: req.path,
        ip: clientIp(req),
        reason: "no_session",
      }, "API unauthorized");
      res.status(401).json({ error: "unauthorized" });
    }).catch(next);
    return;
  }
  // Website menus: cookie session from express-session middleware.
  if (req.session && req.sessionID) {
    next();
    return;
  }
  logger.warn({
    event: "api_unauthorized",
    path: req.path,
    ip: clientIp(req),
    reason: "missing_bearer",
  }, "API unauthorized");
  res.status(401).json({ error: "unauthorized" });
}

function saveSession(sess) {
  return new Promise((resolve, reject) => {
    sess.save((err) => (err ? reject(err) : resolve()));
  });
}

app.set("view engine", "ejs");
app.set("views", path.join(root, "views"));
app.locals.assetVersion = process.env.ASSET_VERSION || "1";
app.locals.accountEmailVerified = accountEmailVerified;
app.locals.suggestionBodyMax = SUGGESTION_BODY_MAX;
app.locals.suggestionReproMax = SUGGESTION_REPRO_MAX;
app.locals.wikiTitleMax = WIKI_TITLE_MAX;
app.locals.wikiBodyMax = WIKI_BODY_MAX;
app.locals.maxOpenBugs = MAX_OPEN_BUGS;
app.locals.maxOpenWikiRevisions = MAX_OPEN_WIKI_REVISIONS;
app.locals.freeOpenSuggestions = FREE_OPEN_SUGGESTIONS;
app.use(securityHeadersMiddleware(THIS_URL));
// Serve static assets before sessions. Otherwise a cookieless first visit races
// HTML + CSS/JS through ensureCsrf, each minting a different lane.sid / CSRF
// token, and guest form POSTs fail with "Invalid form token".
const staticHour = { maxAge: "1h", etag: true };
app.use("/shared", express.static(path.join(root, "shared"), staticHour));
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three"), staticHour));
app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json");
  res.sendFile(path.join(root, "public", "manifest.webmanifest"));
});
// Long-cache match music so return visits skip the multi-MB download on the game host.
app.use("/bgm", express.static(path.join(root, "public", "bgm"), {
  maxAge: "7d",
  fallthrough: false,
}));
app.use(express.static(path.join(root, "public"), staticHour));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(sessionMiddleware);
app.use(ensureCsrf);
app.use(requireCsrf);
app.use(async (req, res, next) => {
  try {
    const staff = await getStaffContext(req.session);
    res.locals.isAdmin = staff.role === "admin" || staff.role === "moderator";
    res.locals.staffRole = staff.role;
    res.locals.localAccountsEnabled = localAccountsEnabled();
    res.locals.formbarLoginEnabled = formbarLoginEnabled();
    res.locals.discordLoginEnabled = discordLoginEnabled();
    res.locals.authEmailEnabled = authEmailEnabled();
    res.locals.anyLoginEnabled = anyLoginEnabled();
    res.locals.matchChatEnabled = matchChatEnabled();

    if (staff.account) {
      if (isAccountBanned(staff.account)) {
        const sid = req.sessionID;
        req.session.destroy(() => {
          res.redirect("/login");
        });
        return;
      }
      const sessEpoch = Number(req.session.sessionEpoch || 0);
      const acctEpoch = Number(staff.account.session_epoch || 0);
      if (sessEpoch !== acctEpoch) {
        req.session.destroy(() => {
          res.redirect("/login");
        });
        return;
      }
      touchAccountSeen(staff.account.id).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
});

function safeNext(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return "/";
  return text;
}

/** Public base URL for OAuth callbacks (Host / forwarded headers, else THIS_URL). */
function publicBase(req) {
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  if (!host || /[/\s\\]/.test(host)) return THIS_URL;
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto !== "http" && proto !== "https") return THIS_URL;
  return `${proto}://${host}`;
}

/** Native app deep-link allowlist for Formbar/Discord login return. */
function safeAppReturn(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (text === "motl://auth") return "motl://auth";
  return null;
}

const DEFAULT_APP_RETURN = "motl://auth";

function accountPublic(account) {
  if (!account) return null;
  return {
    formbarId: account.formbar_id,
    discordId: account.discord_id || null,
    name: account.name,
    mmr: account.mmr,
    tickets: account.tickets,
    held: account.held,
    wins: account.wins,
    losses: account.losses,
  };
}

function playerPublic(player) {
  if (!player) return null;
  return {
    id: player.id,
    name: player.name,
    formbarId: player.formbarId || null,
  };
}

function setAccountSession(sess, account) {
  sess.accountId = account.id;
  sess.formbarId = account.formbar_id || null;
  sess.formbarName = account.name;
  sess.sessionEpoch = Number(account.session_epoch || 0);
}

function regenerateSession(req) {
  const notice = req.session && req.session.notice;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else {
        if (notice) req.session.notice = notice;
        resolve();
      }
    });
  });
}

async function establishAccountSession(req, account, notice, provider = null, res = null) {
  if (isAccountBanned(account)) {
    const err = new Error("banned");
    err.code = "banned";
    throw err;
  }
  await regenerateSession(req);
  setAccountSession(req.session, account);
  if (notice) req.session.notice = notice;
  touchAccountLogin(account.id, provider).catch(() => {});
  if (res) {
    writePrefsCookies(res, {
      tooltips: tooltipsEnabled(account),
      bgmVolume: bgmVolumePercent(account),
    }, THIS_URL);
  }
}

/** User-facing notice for profile link / merge failures. */
function linkMergeNotice(error, provider) {
  if (error === "already_linked") {
    return `This account already has ${provider} linked.`;
  }
  if (error === "conflict_formbar") {
    return "That account already has a different Formbar login linked. Use a different account.";
  }
  if (error === "conflict_discord") {
    return "That account already has a different Discord login linked. Use a different account.";
  }
  if (error === "conflict_email") {
    return "That account already has a different email linked. Use a different account.";
  }
  if (error === "conflict") {
    return `That ${provider} account cannot be linked.`;
  }
  return `Could not link ${provider} account.`;
}

function clientIp(req) {
  return requestClientIp(req);
}

function logRateLimited(req, bucket, extra = {}) {
  logger.warn({
    event: "rate_limited",
    bucket,
    ip: clientIp(req),
    path: req.path,
    ...extra,
  }, "rate limited");
}

function adminLimited(req) {
  const accountId = req.session && req.session.accountId;
  const key = accountId ? `admin:${accountId}` : `admin-ip:${clientIp(req)}`;
  const ok = rateLimit(key, { max: LIMITS.admin, windowMs: 60 * 1000 });
  if (!ok) {
    logger.warn({
      event: "admin_rate_limited",
      accountId: accountId || undefined,
      ip: clientIp(req),
      path: req.path,
    }, "admin rate limited");
  }
  return ok;
}

function routeId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function isAdmin(sess) {
  return sessionIsAdmin(sess);
}

const AMBIGUOUS_TRANSFER = "The transfer may have gone through. It will not be retried automatically because Formbar has no transaction id.";

function bearerMatches(header, secret) {
  if (!secret) return false;
  const match = /^Bearer\s+(\S+)/i.exec(String(header || ""));
  if (!match) return false;
  const left = Buffer.from(match[1]);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function resolveSessionAccount(sess) {
  if (!sess) return null;
  if (sess.accountId) {
    const account = await getAccount(sess.accountId);
    if (account) {
      setAccountSession(sess, account);
      return account;
    }
  }
  if (sess.formbarId) {
    const account = await getAccountByFormbar(sess.formbarId);
    if (account) {
      setAccountSession(sess, account);
      return account;
    }
  }
  return null;
}

/** Attach a verified Formbar OAuth JWT to a session. Returns the account or null if invalid. */
async function applyFormbarToken(sess, tokenString) {
  let identity;
  try {
    identity = await authenticateFormbarToken(tokenString, AUTH_URL);
  } catch (err) {
    const code = err && err.code;
    if (code === "certs_unavailable") {
      logger.error({ event: "formbar_certs_unavailable", source: "applyFormbarToken" }, "Formbar certs unavailable");
    } else {
      logger.warn({
        event: "auth_failed",
        provider: "formbar",
        reason: code || "token_invalid",
      }, "Formbar token apply failed");
    }
    return null;
  }
  const nameCheck = validateDisplayName(identity.rawName);
  const name = nameCheck.ok ? nameCheck.name : `Player ${identity.id}`;
  const account = await upsertAccount(identity.id, name);
  if (!account) return null;
  setAccountSession(sess, account);
  return account;
}

async function playerFromSession(sess, options = {}) {
  if (!sess) return null;
  const account = await resolveSessionAccount(sess);
  if (account && accountEmailVerified(account)) {
    return {
      id: `a:${account.id}`,
      name: account.name,
      accountId: account.id,
      formbarId: account.formbar_id || null,
      mmr: account.mmr,
      tooltips: tooltipsEnabled(account),
      bgmVolume: bgmVolumePercent(account),
    };
  }
  let guest = null;
  if (sess.guestId) guest = await getUser(sess.guestId);
  if (!guest && sess.userId) guest = await getUser(sess.userId);
  if (!guest && options.createGuest) guest = await ensureGuest(sess);
  if (!guest) return null;
  sess.guestId = guest.id;
  const prefs = options.prefs || {};
  const tooltips = typeof prefs.tooltips === "boolean"
    ? prefs.tooltips
    : PREFS_TOOLTIPS_DEFAULT;
  const bgmVolume = Number.isFinite(Number(prefs.bgmVolume))
    ? clampBgmVolumePercent(prefs.bgmVolume)
    : PREFS_BGM_DEFAULT;
  return {
    id: guest.id,
    name: guest.name,
    accountId: null,
    formbarId: null,
    mmr: null,
    tooltips,
    bgmVolume,
  };
}

/** Logged-in: DB prefs overwrite cookies. Guests: cookies are the source of truth. */
function syncPrefsCookies(res, player, req) {
  if (!player) return;
  if (player.accountId) {
    writePrefsCookies(res, {
      tooltips: player.tooltips !== false,
      bgmVolume: Number.isFinite(player.bgmVolume) ? player.bgmVolume : PREFS_BGM_DEFAULT,
    }, THIS_URL);
    return;
  }
  const fromReq = req ? readPrefsCookies(req) : null;
  if (fromReq && fromReq.hasTooltips && fromReq.hasBgm) return;
  writePrefsCookies(res, {
    tooltips: player.tooltips !== false,
    bgmVolume: Number.isFinite(player.bgmVolume) ? player.bgmVolume : PREFS_BGM_DEFAULT,
  }, THIS_URL);
}

async function issueVerifyEmail(account) {
  const token = newAuthToken();
  await createAuthToken(
    account.id,
    "verify",
    hashToken(token),
    Date.now() + verifyTokenTtlMs(),
  );
  const verifyUrl = `${THIS_URL}/verify?token=${encodeURIComponent(token)}`;
  await sendVerifyEmail({ to: account.email, name: account.name, verifyUrl });
}

async function issueResetEmail(account) {
  const token = newAuthToken();
  await createAuthToken(
    account.id,
    "reset",
    hashToken(token),
    Date.now() + resetTokenTtlMs(),
  );
  const resetUrl = `${THIS_URL}/reset?token=${encodeURIComponent(token)}`;
  await sendResetEmail({ to: account.email, name: account.name, resetUrl });
}

const matchmaker = new Matchmaker(io);

/**
 * Set session.intent the same way startPlay does. Returns a JSON-ready result
 * `{ ok, mode }` / `{ ok, rejoin }` or `{ error, status }`.
 */
async function preparePlayIntent(sess, intent) {
  const mode = intent && intent.mode;
  const paid = PAID_PLAY_MODES.has(mode);
  if (!GUEST_PLAY_MODES.has(mode) && !paid) {
    return { error: "bad_mode", status: 400 };
  }
  const account = await resolveSessionAccount(sess);
  const privileged = accountEmailVerified(account);
  if (paid && (!privileged || !sess.formbarId)) {
    return { error: "login_required", status: 403 };
  }
  const player = await playerFromSession(sess, { createGuest: !paid });
  if (!player) {
    return { error: "unauthorized", status: 401 };
  }
  if (matchmaker.isBusy(player.id)) {
    return { ok: true, rejoin: true };
  }
  if (paid) {
    if (!account || account.tickets <= account.held) {
      return { error: "no_ticket", status: 403 };
    }
  }
  if (mode === "join") {
    const roomId = intent.roomId || null;
    if (!roomId) {
      return { error: "bad_room", status: 400 };
    }
    const room = matchmaker.openLobby(roomId);
    if (!room) {
      return { error: "lobby_closed", status: 404 };
    }
    if (room.seat.a.userId === player.id) {
      return { ok: true, rejoin: true };
    }
  }
  const matchOptions = mode === "listed"
    ? normalizeMatchOptions(intent.matchOptions || {})
    : null;
  sess.view3d = null;
  sess.intent = {
    mode,
    roomId: intent.roomId || null,
    view: null,
    matchOptions,
  };
  await saveSession(sess);
  const assigned = workerCount() > 1 ? await assignOwner(player.id, mode) : null;
  return {
    ok: true,
    mode,
    worker: assigned ? assigned.worker : 0,
    owner: assigned && assigned.owner ? assigned.owner : null,
  };
}

if (process.env.METRICS === "1") {
  startMetrics({
    log: process.env.METRICS_LOG !== "0",
    gauges() {
      let socketBacklog = 0;
      const sockets = io.sockets && io.sockets.sockets;
      if (sockets) {
        for (const sock of sockets.values()) {
          const buf = sock.conn && sock.conn.writeBuffer;
          if (buf) socketBacklog += buf.length;
        }
      }
      return {
        rooms: matchmaker.rooms.size,
        sockets: io.engine ? io.engine.clientsCount : 0,
        socketBacklog,
      };
    },
  });
}

function takeNotice(req) {
  const notice = req.session.notice || null;
  if (req.session.notice) req.session.notice = null;
  return notice;
}

async function pageViewer(req) {
  return resolveSessionAccount(req.session);
}

function errorTitle(status) {
  if (status === 404) return "Not found";
  if (status === 403) return "Forbidden";
  if (status === 400) return "Bad request";
  if (status === 429) return "Too many requests";
  if (status === 503) return "Unavailable";
  return "Error";
}

function errorMessage(status) {
  if (status === 404) return "That page does not exist.";
  if (status === 403) return "You do not have access to that.";
  if (status === 400) return "The request could not be understood.";
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status === 503) return "That service is temporarily unavailable.";
  return "Something went wrong.";
}

/** Render the shared HTML error page (header + message + home link). */
async function renderError(req, res, { status = 500, title, message } = {}) {
  const code = Number(status) || 500;
  let viewer = null;
  try {
    viewer = await pageViewer(req);
  } catch {
    viewer = null;
  }
  if (res.headersSent) return;
  res.status(code).render("error", {
    viewer,
    notice: null,
    status: code,
    title: title || errorTitle(code),
    message: message || errorMessage(code),
  });
}

async function homeData(req) {
  const maintenance = await getMaintenanceMessage();
  const paused = await isMatchmakingPaused();
  let notice = takeNotice(req);
  if (!notice && (maintenance || paused)) {
    notice = maintenance || "Matchmaking is temporarily paused.";
  }
  return {
    nav: "home",
    viewer: await pageViewer(req),
    news: loadNews(),
    notice,
  };
}

async function gamesData(req) {
  const viewer = await pageViewer(req);
  const privileged = accountEmailVerified(viewer);
  const player = await playerFromSession(req.session, { createGuest: false });
  const rejoin = player ? matchmaker.isBusy(player.id) : false;
  let notice = takeNotice(req);
  if (!notice && (await isMatchmakingPaused())) {
    notice = (await getMaintenanceMessage()) || "Matchmaking is temporarily paused.";
  }
  return {
    nav: "games",
    viewer,
    rejoin,
    canTicket: Boolean(privileged && viewer.tickets > viewer.held && !rejoin),
    waiting: matchmaker.waitingCounts(),
    lobbies: matchmaker.listLobbies(),
    notice,
  };
}

async function scoresData(req) {
  return {
    nav: "scores",
    viewer: await pageViewer(req),
    leaders: await topAccounts(10),
    notice: takeNotice(req),
  };
}

async function completeFormbarLogin(req, res, token) {
  if (!formbarLoginEnabled()) {
    res.status(404).send("Formbar login is disabled.");
    return;
  }
  const linkId = Number(req.session.linkAccountId);
  let identity;
  try {
    identity = await authenticateFormbarToken(token, AUTH_URL);
  } catch (err) {
    if (err && err.code === "certs_unavailable") {
      logger.error({ event: "formbar_certs_unavailable", source: "completeFormbarLogin" }, "Formbar certs unavailable");
      res.status(503).send("Formbar login is temporarily unavailable.");
      return;
    }
    logger.warn({ event: "auth_failed", provider: "formbar", reason: "token_invalid" }, "Formbar login failed");
    res.status(400).send("Invalid Formbar token.");
    return;
  }
  const nameCheck = validateDisplayName(identity.rawName);
  const name = nameCheck.ok ? nameCheck.name : `Player ${identity.id}`;
  const userId = identity.id;
  await regenerateSession(req);

  if (Number.isInteger(linkId) && linkId > 0) {
    const result = await linkFormbarToAccount(linkId, userId);
    if (!result.ok) {
      logger.warn({
        event: "account_link_conflict",
        provider: "formbar",
        accountId: linkId,
        error: result.error,
      }, "Formbar link conflict");
      req.session.notice = linkMergeNotice(result.error, "Formbar");
      req.session.save(() => res.redirect(`/profile/${linkId}`));
      return;
    }
    await upsertAccount(userId, name);
    const linked = await getAccount(result.account.id);
    setAccountSession(req.session, linked || result.account);
    logger.info({
      event: result.merged ? "account_merged" : "account_linked",
      provider: "formbar",
      accountId: (linked || result.account).id,
      formbarId: userId,
      merged: Boolean(result.merged),
    }, result.merged ? "accounts merged via Formbar" : "Formbar linked");
    req.session.notice = result.merged
      ? "Accounts merged. Formbar is linked."
      : "Formbar account linked.";
    req.session.save(() => res.redirect(`/profile/${(linked || result.account).id}`));
    return;
  }

  const account = await upsertAccount(userId, name);
  if (account && isAccountBanned(account)) {
    req.session.notice = "This account is banned.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  setAccountSession(req.session, account);
  if (account) touchAccountLogin(account.id, "formbar").catch(() => {});
  if (account) {
    writePrefsCookies(res, {
      tooltips: tooltipsEnabled(account),
      bgmVolume: bgmVolumePercent(account),
    }, THIS_URL);
  }
  logger.info({
    event: "auth_login",
    provider: "formbar",
    userId: account && account.id,
    formbarId: userId,
  }, "Formbar login ok");
  req.session.save(() => res.redirect("/"));
}

function discordCallbackUrl(req) {
  return `${publicBase(req)}/login/discord/callback`;
}

function discordApiCallbackUrl(req) {
  return `${publicBase(req)}/api/v1/login/discord/callback`;
}

function nameFromDiscordUser(user) {
  const raw = discordDisplayName(user);
  const nameCheck = validateDisplayName(raw);
  if (nameCheck.ok) return nameCheck.name;
  const tail = String(user && user.id || "").slice(-6) || "user";
  return `Player ${tail}`;
}

async function beginDiscordOAuth(req, res, { callbackUrl, nextPath = "/" } = {}) {
  if (!discordLoginEnabled()) {
    res.status(404).send("Discord login is disabled.");
    return;
  }
  if (!discordConfigured() && process.env.DISCORD_OAUTH_MOCK !== "1") {
    res.status(503).send("Discord login is not configured.");
    return;
  }
  const state = newDiscordOAuthState();
  req.session.discordOAuthState = state;
  req.session.discordOAuthNext = nextPath;
  const redirectUri = callbackUrl || discordCallbackUrl(req);
  req.session.save((err) => {
    if (err) {
      res.status(500).send("Could not start Discord login.");
      return;
    }
    if (process.env.DISCORD_OAUTH_MOCK === "1") {
      const mockUser = process.env.DISCORD_MOCK_USER
        || JSON.stringify({ id: "999001", username: "MockDiscord", global_name: "Mock Discord" });
      const code = Buffer.from(mockUser).toString("base64url");
      const dest = new URL(redirectUri, publicBase(req));
      dest.searchParams.set("code", code);
      dest.searchParams.set("state", state);
      res.redirect(dest.toString());
      return;
    }
    res.redirect(discordAuthorizeUrl(redirectUri, state));
  });
}

async function completeDiscordLogin(req, res, { redirectUri, successRedirect = "/" } = {}) {
  if (!discordLoginEnabled()) {
    res.status(404).send("Discord login is disabled.");
    return;
  }
  const state = String(req.query.state || "");
  const expected = String(req.session.discordOAuthState || "");
  delete req.session.discordOAuthState;
  const nextPath = req.session.discordOAuthNext || successRedirect;
  delete req.session.discordOAuthNext;
  if (!state || !expected || state !== expected) {
    logger.warn({ event: "auth_failed", provider: "discord", reason: "state_mismatch" }, "Discord OAuth state mismatch");
    req.session.notice = "Discord login expired. Try again.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  if (req.query.error) {
    logger.warn({ event: "auth_failed", provider: "discord", reason: "cancelled" }, "Discord login cancelled");
    req.session.notice = "Discord login was cancelled.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  const code = String(req.query.code || "");
  if (!code) {
    res.status(400).send("Missing Discord authorization code.");
    return;
  }
  let user;
  try {
    user = await fetchDiscordUserFromCode(code, redirectUri || discordCallbackUrl(req));
  } catch (err) {
    logger.warn({
      event: "auth_failed",
      provider: "discord",
      reason: err && err.message ? String(err.message).slice(0, 80) : "oauth_failed",
    }, "Discord login failed");
    req.session.notice = "Discord login failed. Try again.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  const name = nameFromDiscordUser(user);

  const linkId = Number(req.session.linkAccountId);
  if (Number.isInteger(linkId) && linkId > 0) {
    req.session.linkAccountId = null;
    const result = await linkDiscordToAccount(linkId, user.id);
    if (!result.ok) {
      logger.warn({
        event: "account_link_conflict",
        provider: "discord",
        accountId: linkId,
        error: result.error,
      }, "Discord link conflict");
      req.session.notice = linkMergeNotice(result.error, "Discord");
      req.session.save(() => res.redirect(`/profile/${linkId}`));
      return;
    }
    await upsertDiscordAccount(user.id, name);
    const linked = await getAccount(result.account.id);
    setAccountSession(req.session, linked || result.account);
    logger.info({
      event: result.merged ? "account_merged" : "account_linked",
      provider: "discord",
      accountId: (linked || result.account).id,
      discordId: user.id,
      merged: Boolean(result.merged),
    }, result.merged ? "accounts merged via Discord" : "Discord linked");
    req.session.notice = result.merged
      ? "Accounts merged. Discord is linked."
      : "Discord account linked.";
    req.session.save(() => res.redirect(`/profile/${(linked || result.account).id}`));
    return;
  }

  const account = await upsertDiscordAccount(user.id, name);
  if (!account) {
    res.status(500).send("Could not create account.");
    return;
  }
  if (isAccountBanned(account)) {
    req.session.notice = "This account is banned.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  setAccountSession(req.session, account);
  touchAccountLogin(account.id, "discord").catch(() => {});
  writePrefsCookies(res, {
    tooltips: tooltipsEnabled(account),
    bgmVolume: bgmVolumePercent(account),
  }, THIS_URL);
  logger.info({
    event: "auth_login",
    provider: "discord",
    userId: account.id,
    discordId: user.id,
  }, "Discord login ok");
  const dest = typeof nextPath === "string" && nextPath.startsWith("/") ? nextPath : "/";
  req.session.save(() => res.redirect(dest === "/login" ? "/" : dest));
}

app.get("/login", async (req, res, next) => {
  try {
    if (req.query.token) {
      await completeFormbarLogin(req, res, req.query.token);
      return;
    }
    if (req.query.formbar === "1") {
      if (!formbarLoginEnabled()) {
        res.status(404).send("Formbar login is disabled.");
        return;
      }
      const redirectURL = encodeURIComponent(`${THIS_URL}/login`);
      res.redirect(`${AUTH_URL}/oauth?redirectURL=${redirectURL}`);
      return;
    }
    if (req.query.discord === "1") {
      await beginDiscordOAuth(req, res, { callbackUrl: discordCallbackUrl(req) });
      return;
    }
    if (!anyLoginEnabled()) {
      const viewer = await pageViewer(req);
      req.session.save(() => res.status(404).render("login", {
        nav: null,
        viewer,
        notice: "Login is disabled.",
        email: "",
        disabled: true,
      }));
      return;
    }
    const viewer = await pageViewer(req);
    if (viewer) {
      res.redirect("/");
      return;
    }
    req.session.save(() => res.render("login", {
      nav: null,
      viewer: null,
      notice: takeNotice(req),
      email: "",
      disabled: false,
    }));
  } catch (err) {
    next(err);
  }
});

app.get("/login/discord/callback", async (req, res, next) => {
  try {
    await completeDiscordLogin(req, res, {
      redirectUri: discordCallbackUrl(req),
      successRedirect: "/",
    });
  } catch (err) {
    next(err);
  }
});

app.post("/login", async (req, res, next) => {
  try {
    if (!localAccountsEnabled()) {
      res.status(404).send("Local accounts are disabled.");
      return;
    }
    const email = normalizeEmail(req.body && req.body.email);
    const password = String(req.body && req.body.password || "");
    const renderFail = (notice) => {
      req.session.save(() => res.status(400).render("login", {
        nav: null,
        viewer: null,
        notice,
        email,
        disabled: false,
      }));
    };
    if (!rateLimit(`login-ip:${clientIp(req)}`, { max: LIMITS.login * 2, windowMs: LIMITS.loginWindow })) {
      logRateLimited(req, "login-ip");
      renderFail("Too many login attempts. Try again later.");
      return;
    }
    if (!rateLimit(`login:${clientIp(req)}:${email}`, { max: LIMITS.login, windowMs: LIMITS.loginWindow })) {
      logRateLimited(req, "login");
      renderFail("Too many login attempts. Try again later.");
      return;
    }
    const account = await getAccountByEmail(email);
    if (!account || !account.password_hash) {
      logger.warn({
        event: "auth_failed",
        provider: "local",
        reason: "invalid_credentials",
        ip: clientIp(req),
      }, "local login failed");
      renderFail("Invalid email or password.");
      return;
    }
    const ok = await verifyPassword(password, account.password_hash);
    if (!ok) {
      logger.warn({
        event: "auth_failed",
        provider: "local",
        reason: "invalid_credentials",
        ip: clientIp(req),
        accountId: account.id,
      }, "local login failed");
      renderFail("Invalid email or password.");
      return;
    }
    const notice = needsEmailVerification(account)
      ? "Verify your email to unlock account features. Until then you can play like a guest."
      : undefined;
    await establishAccountSession(req, account, notice, "local", res);
    logger.info({ event: "auth_login", provider: "local", userId: account.id }, "local login ok");
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    if (err && err.code === "banned") {
      req.session.notice = "This account is banned.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    next(err);
  }
});

app.get("/signup", async (req, res, next) => {
  try {
    if (!localAccountsEnabled()) {
      res.status(404).send("Local accounts are disabled.");
      return;
    }
    if (await pageViewer(req)) {
      res.redirect("/");
      return;
    }
    req.session.save(() => res.render("signup", {
      nav: null,
      viewer: null,
      notice: takeNotice(req),
      email: "",
      name: "",
    }));
  } catch (err) {
    next(err);
  }
});

app.post("/signup", async (req, res, next) => {
  try {
    if (!localAccountsEnabled()) {
      res.status(404).send("Local accounts are disabled.");
      return;
    }
    const fields = validateSignupFields({
      name: req.body && req.body.name,
      email: req.body && req.body.email,
      password: req.body && req.body.password,
    });
    const renderFail = (notice) => {
      req.session.save(() => res.status(400).render("signup", {
        nav: null,
        viewer: null,
        notice,
        email: fields.email,
        name: fields.name,
      }));
    };
    if (!rateLimit(`signup:${clientIp(req)}`, { max: 10 })) {
      logRateLimited(req, "signup");
      renderFail("Too many signups from this address. Try again later.");
      return;
    }
    if (!fields.ok) {
      renderFail(fields.error);
      return;
    }
    const { email, name, password } = fields;
    if (await getAccountByEmail(email)) {
      renderFail("An account with that email already exists.");
      return;
    }
    const passwordHash = await hashPassword(password);
    const needVerify = authEmailEnabled();
    if (needVerify && !mailReady()) {
      renderFail("Email is not configured. Try again later.");
      return;
    }
    let account;
    try {
      account = await createLocalAccount({
        email,
        passwordHash,
        name,
        verifiedAt: needVerify ? null : Date.now(),
      });
    } catch (err) {
      if (err && err.code === "SQLITE_CONSTRAINT") {
        renderFail("An account with that email already exists.");
        return;
      }
      throw err;
    }
    const nameNote = account.name !== name
      ? ` Display name set to "${account.name}" because "${name}" was taken.`
      : "";
    if (needVerify) {
      try {
        await issueVerifyEmail(account);
      } catch (err) {
        logger.error({
          event: "mail_send_failed",
          purpose: "verify",
          accountId: account.id,
          err: asErr(err),
        }, "signup verify email failed");
        try {
          await deleteLocalAccount(account.id);
        } catch (cleanupErr) {
          logger.error({
            event: "auth_signup_cleanup_failed",
            accountId: account.id,
            err: asErr(cleanupErr),
          }, "signup cleanup failed");
        }
        renderFail("Could not send verification email. Try again later.");
        return;
      }
      logger.info({ event: "auth_signup", accountId: account.id, needVerify: true }, "signup pending verify");
      req.session.notice = `Check your email to verify your account.${nameNote}`;
      req.session.save(() => res.redirect("/login"));
      return;
    }
    await establishAccountSession(req, account, nameNote ? nameNote.trim() : undefined, null, res);
    logger.info({ event: "auth_signup", accountId: account.id, needVerify: false }, "signup ok");
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    next(err);
  }
});

app.get("/verify", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Email verification is disabled.");
      return;
    }
    const token = String(req.query.token || "");
    if (!token) {
      res.status(400).send("Missing verification token.");
      return;
    }
    const account = await consumeAuthToken("verify", hashToken(token));
    if (!account) {
      logger.warn({ event: "auth_failed", provider: "local", reason: "verify_token_invalid" }, "verify token invalid");
      req.session.notice = "That verification link is invalid or expired.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    await setEmailVerified(account.id);
    const fresh = await getAccount(account.id);
    await establishAccountSession(req, fresh || account, "Email verified. You are logged in.", null, res);
    logger.info({ event: "auth_verify", accountId: account.id }, "email verified");
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    next(err);
  }
});

app.post("/verify/resend", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Email verification is disabled.");
      return;
    }
    const email = normalizeEmail(req.body && req.body.email);
    if (!rateLimit(`resend:${clientIp(req)}:${email}`, { max: 5 })) {
      logRateLimited(req, "resend");
      req.session.notice = "If that account exists, a new email was sent.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    const account = await getAccountByEmail(email);
    if (!account) {
      logger.info({ event: "verify_resend_skip", reason: "no_account" }, "verify resend skipped");
    } else if (!needsEmailVerification(account)) {
      logger.info({
        event: "verify_resend_skip",
        reason: "not_needed",
        accountId: account.id,
      }, "verify resend skipped");
    } else if (!mailReady()) {
      logger.warn({
        event: "verify_resend_skip",
        reason: "mail_not_ready",
        accountId: account.id,
      }, "verify resend skipped");
    } else {
      try {
        await issueVerifyEmail(account);
        logger.info({
          event: "verify_resend_ok",
          accountId: account.id,
        }, "verify resend sent");
      } catch (err) {
        logger.error({
          event: "mail_send_failed",
          purpose: "verify_resend",
          accountId: account.id,
          err: asErr(err),
        }, "verify resend failed");
      }
    }
    req.session.notice = "If that account exists, a new email was sent.";
    req.session.save(() => res.redirect("/login"));
  } catch (err) {
    next(err);
  }
});

app.get("/forgot", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Password recovery is disabled.");
      return;
    }
    const viewer = await pageViewer(req);
    req.session.save(() => res.render("forgot", {
      nav: null,
      viewer,
      notice: takeNotice(req),
      email: "",
    }));
  } catch (err) {
    next(err);
  }
});

app.post("/forgot", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Password recovery is disabled.");
      return;
    }
    const email = normalizeEmail(req.body && req.body.email);
    if (rateLimit(`forgot:${clientIp(req)}:${email}`, { max: 5 })) {
      const account = await getAccountByEmail(email);
      if (
        account
        && account.password_hash
        && accountEmailVerified(account)
        && mailReady()
      ) {
        try {
          await issueResetEmail(account);
        } catch (err) {
          logger.error({
            event: "mail_send_failed",
            purpose: "reset",
            accountId: account.id,
            err: asErr(err),
          }, "reset email failed");
        }
      }
    }
    req.session.notice = "If that account exists, a reset link was sent.";
    req.session.save(() => res.redirect("/login"));
  } catch (err) {
    next(err);
  }
});

app.get("/reset", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Password recovery is disabled.");
      return;
    }
    const token = String(req.query.token || "");
    if (!token) {
      res.status(400).send("Missing reset token.");
      return;
    }
    req.session.save(() => res.render("reset", {
      nav: null,
      viewer: null,
      notice: takeNotice(req),
      token,
    }));
  } catch (err) {
    next(err);
  }
});

app.post("/reset", async (req, res, next) => {
  try {
    if (!localAccountsEnabled() || !authEmailEnabled()) {
      res.status(404).send("Password recovery is disabled.");
      return;
    }
    const token = String(req.body && req.body.token || "");
    const password = String(req.body && req.body.password || "");
    const passErr = passwordError(password);
    if (passErr) {
      req.session.save(() => res.status(400).render("reset", {
        nav: null,
        viewer: null,
        notice: passErr,
        token,
      }));
      return;
    }
    const account = await consumeAuthToken("reset", hashToken(token));
    if (!account) {
      logger.warn({ event: "auth_failed", provider: "local", reason: "reset_token_invalid" }, "reset token invalid");
      req.session.notice = "That reset link is invalid or expired.";
      req.session.save(() => res.redirect("/forgot"));
      return;
    }
    await setAccountPassword(account.id, await hashPassword(password));
    const fresh = await getAccount(account.id);
    await establishAccountSession(req, fresh || account, "Password updated.", null, res);
    logger.info({ event: "auth_reset", accountId: account.id }, "password reset ok");
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    next(err);
  }
});

app.get("/logout", (req, res) => {
  const accountId = req.session && req.session.accountId;
  logger.info({ event: "auth_logout", accountId: accountId || undefined }, "logout");
  req.session.destroy(() => res.redirect("/"));
});

app.get("/", async (req, res, next) => {
  try {
    const data = await homeData(req);
    req.session.save(() => res.render("landing", data));
  } catch (err) {
    next(err);
  }
});

app.get("/games", async (req, res, next) => {
  try {
    const data = await gamesData(req);
    req.session.save(() => res.render("games", data));
  } catch (err) {
    next(err);
  }
});

app.get("/buy", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    const pack = ticketPack();
    const canPaypal = accountCanBuyPaypal(viewer);
    const paypalPurchases = canPaypal && viewer
      ? await listPaypalPurchasesForAccount(viewer.id, { limit: 25 })
      : [];
    req.session.save(() => res.render("tickets", {
      nav: "buy",
      viewer,
      notice: takeNotice(req),
      packSize: pack.size,
      packCost: pack.cost,
      paypalEnabled: paypalCheckoutEnabled(),
      canPaypal,
      paypalClientId: paypalClientIdPublic(),
      paypalMode: paypalMode(),
      paypalPackages: listPaypalPackages(),
      paypalPurchases,
    }));
  } catch (err) {
    next(err);
  }
});

const paypalJson = express.json({ limit: "16kb" });
const paypalWebhookJson = express.json({
  limit: "256kb",
  verify(req, _res, buf) {
    req.rawBody = buf.toString("utf8");
  },
});

app.post("/api/paypal/orders", paypalJson, async (req, res, next) => {
  try {
    const account = await pageViewer(req);
    if (!account) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    if (!accountCanBuyPaypal(account)) {
      res.status(403).json({ error: "paypal_unavailable" });
      return;
    }
    const packageId = req.body && req.body.packageId;
    // Same URL for return and cancel (PayPal App Switch / mobile redirect).
    const checkoutUrl = `${publicBase(req)}/buy`;
    const created = await createPaypalOrder({
      packageId,
      accountId: account.id,
      returnUrl: checkoutUrl,
      cancelUrl: checkoutUrl,
    });
    if (!created.ok) {
      const status = created.error === "unknown_package" ? 400 : 502;
      res.status(status).json({ error: created.error });
      return;
    }
    res.json({ id: created.orderId, orderId: created.orderId });
  } catch (err) {
    next(err);
  }
});

app.post("/api/paypal/orders/:orderId/capture", paypalJson, async (req, res, next) => {
  try {
    const account = await pageViewer(req);
    if (!account) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    if (!accountCanBuyPaypal(account)) {
      res.status(403).json({ error: "paypal_unavailable" });
      return;
    }
    const orderId = String(req.params.orderId || "").trim();
    const settled = await settlePaypalPurchase(orderId, {
      accountId: account.id,
      captureIfNeeded: true,
    });
    if (!settled.ok) {
      const map = {
        forbidden: 403,
        not_found: 404,
        amount_mismatch: 409,
        merchant_mismatch: 409,
        not_completed: 409,
      };
      res.status(map[settled.error] || 502).json({
        error: settled.error,
        purchase: settled.purchase
          ? { id: settled.purchase.id, status: settled.purchase.status }
          : null,
      });
      return;
    }
    const fresh = await getAccount(account.id);
    res.json({
      ok: true,
      credited: Boolean(settled.credited),
      duplicate: Boolean(settled.duplicate),
      tickets: settled.purchase ? settled.purchase.tickets : 0,
      balance: settled.balance != null
        ? settled.balance
        : (fresh ? fresh.tickets : null),
      status: settled.purchase ? settled.purchase.status : "credited",
    });
  } catch (err) {
    next(err);
  }
});

app.post("/webhooks/paypal", paypalWebhookJson, async (req, res) => {
  try {
    const rawBody = req.rawBody != null
      ? req.rawBody
      : JSON.stringify(req.body || {});
    const verified = await verifyPaypalWebhookSignature({
      headers: req.headers,
      rawBody,
    });
    if (!verified.ok) {
      logger.warn({
        event: "paypal_webhook_rejected",
        reason: verified.error,
      }, "PayPal webhook rejected");
      res.status(400).json({ error: verified.error || "invalid" });
      return;
    }
    const result = await handlePaypalWebhookEvent(verified.event);
    res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate) });
  } catch (err) {
    logger.error({
      event: "paypal_webhook_error",
      err: asErr(err),
    }, "PayPal webhook handler error");
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/games/create", async (req, res, next) => {
  try {
    const data = await gamesData(req);
    if (!accountEmailVerified(data.viewer)) {
      if (data.viewer) {
        req.session.notice = "Verify your email to unlock account features.";
        req.session.save(() => res.redirect("/games"));
      } else {
        res.redirect("/login");
      }
      return;
    }
    if (!data.canTicket && !data.rejoin) {
      req.session.notice = "You need a free ticket.";
      req.session.save(() => res.redirect("/games"));
      return;
    }
    if (data.rejoin) {
      req.session.save(() => res.redirect("/play"));
      return;
    }
    const defaults = defaultMatchOptions();
    const queryView = req.query && req.query.view === "3d" ? "3d" : null;
    req.session.save(() => res.render("lobby-create", {
      ...data,
      nav: "games",
      queryView,
      matchDefaults: defaults,
      matchSpeeds: MATCH_SPEEDS,
      mapIds: mapPresetIds(),
      mapPresets: MAP_PRESETS,
      baseGpsMin: BASE_GPS_MIN,
      baseGpsMax: BASE_GPS_MAX,
    }));
  } catch (err) {
    next(err);
  }
});

app.get("/scores", async (req, res, next) => {
  try {
    const data = await scoresData(req);
    req.session.save(() => res.render("scores", data));
  } catch (err) {
    next(err);
  }
});

function disconnectBannedAccount(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  const prefix = `a:${id}`;
  for (const [userId, socks] of socketsByUser.entries()) {
    if (userId !== prefix && !String(userId).endsWith(`:${id}`)) continue;
    for (const sock of socks.slice()) {
      try {
        sock.emit("go-home");
        sock.disconnect(true);
      } catch {
        /* ignore */
      }
    }
  }
  // Also scan rooms for this account and force disconnect seats
  for (const room of matchmaker.rooms.values()) {
    for (const seat of [room.seat.a, room.seat.b]) {
      if (Number(seat.accountId) !== id) continue;
      if (seat.socket) {
        try {
          seat.socket.emit("go-home");
          seat.socket.disconnect(true);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

app.use("/admin", createAdminRouter({
  matchmaker,
  pageViewer,
  formbarSocket,
  rewardFromPool,
  issueVerifyEmail,
  ambiguousTransfer: AMBIGUOUS_TRANSFER,
  disconnectBannedAccount,
  ioStats: () => {
    let socketBacklog = 0;
    const sockets = io.sockets && io.sockets.sockets;
    if (sockets) {
      for (const sock of sockets.values()) {
        const buf = sock.conn && sock.conn.writeBuffer;
        if (buf) socketBacklog += buf.length;
      }
    }
    return {
      rooms: matchmaker.rooms.size,
      sockets: io.engine ? io.engine.clientsCount : 0,
      socketBacklog,
    };
  },
}));

app.get("/profile/:id", async (req, res, next) => {
  try {
    const account = await findAccountForProfile(req.params.id);
    const viewer = await pageViewer(req);
    const privileged = accountEmailVerified(viewer);
    const isOwner = Boolean(account && viewer && account.id === viewer.id);
    const mmrPage = Math.max(1, Number.parseInt(String(req.query.mmrpage || "1"), 10) || 1);
    const mmrHistory = account
      ? await listAccountMmrHistory(account.id, { page: mmrPage })
      : { rows: [], total: 0, page: 1, pageSize: 20 };
    const body = {
      account,
      viewer,
      isOwner,
      mmrHistory,
      notice: takeNotice(req),
      canLinkFormbar: Boolean(
        isOwner && privileged
        && account
        && !account.formbar_id
        && formbarLoginEnabled(),
      ),
      canLinkDiscord: Boolean(
        isOwner && privileged
        && account
        && !account.discord_id
        && discordLoginEnabled(),
      ),
      canAddLocal: Boolean(
        isOwner && privileged
        && account
        && !account.email
        && localAccountsEnabled(),
      ),
    };
    req.session.save(() => {
      if (!account) {
        res.status(404).render("profile", body);
        return;
      }
      res.render("profile", body);
    });
  } catch (err) {
    next(err);
  }
});

app.post("/profile/name", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!accountEmailVerified(viewer)) {
      res.redirect("/login");
      return;
    }
    const back = `/profile/${viewer.id}`;
    const nameCheck = validateDisplayName(req.body && req.body.name);
    if (!nameCheck.ok) {
      req.session.notice = nameCheck.error;
      req.session.save(() => res.redirect(back));
      return;
    }
    if (viewer.name === nameCheck.name) {
      req.session.notice = "Display name unchanged.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (await isDisplayNameTaken(nameCheck.name, viewer.id)) {
      req.session.notice = "That display name is already taken.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (viewer.tickets <= viewer.held) {
      req.session.notice = "Changing your display name costs 1 ticket.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (!rateLimit(`displayname:${viewer.id}`, { max: 3, windowMs: 60 * 60 * 1000 })) {
      req.session.notice = "Display name changed too often. Try again in an hour.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const result = await setAccountDisplayName(viewer.id, nameCheck.name, { spendTicket: true });
    if (!result.ok) {
      req.session.notice = result.error === "taken"
        ? "That display name is already taken."
        : result.error === "no_ticket"
          ? "Changing your display name costs 1 ticket."
          : result.message || "Could not update display name.";
      req.session.save(() => res.redirect(back));
      return;
    }
    setAccountSession(req.session, result.account);
    req.session.notice = "Display name updated. Used 1 ticket.";
    req.session.save(() => res.redirect(`/profile/${result.account.id}`));
  } catch (err) {
    next(err);
  }
});

app.post("/profile/link/formbar", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!accountEmailVerified(viewer)) {
      res.redirect("/login");
      return;
    }
    if (!formbarLoginEnabled()) {
      res.status(404).send("Formbar login is disabled.");
      return;
    }
    if (viewer.formbar_id) {
      req.session.notice = "Formbar is already linked.";
      req.session.save(() => res.redirect(`/profile/${viewer.id}`));
      return;
    }
    req.session.linkAccountId = viewer.id;
    const redirectURL = encodeURIComponent(`${THIS_URL}/login`);
    req.session.save(() => {
      res.redirect(`${AUTH_URL}/oauth?redirectURL=${redirectURL}`);
    });
  } catch (err) {
    next(err);
  }
});

app.post("/profile/link/discord", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!accountEmailVerified(viewer)) {
      res.redirect("/login");
      return;
    }
    if (!discordLoginEnabled()) {
      res.status(404).send("Discord login is disabled.");
      return;
    }
    if (viewer.discord_id) {
      req.session.notice = "Discord is already linked.";
      req.session.save(() => res.redirect(`/profile/${viewer.id}`));
      return;
    }
    req.session.linkAccountId = viewer.id;
    await beginDiscordOAuth(req, res, {
      callbackUrl: discordCallbackUrl(req),
      nextPath: `/profile/${viewer.id}`,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/profile/link/local", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!accountEmailVerified(viewer)) {
      res.redirect("/login");
      return;
    }
    if (!localAccountsEnabled()) {
      res.status(404).send("Local accounts are disabled.");
      return;
    }
    const back = `/profile/${viewer.id}`;
    if (viewer.email) {
      req.session.notice = "Email is already linked.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const email = normalizeEmail(req.body && req.body.email);
    const password = String(req.body && req.body.password || "");
    if (!isValidEmail(email)) {
      req.session.notice = "Enter a valid email address.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const passErr = passwordError(password);
    if (passErr) {
      req.session.notice = passErr;
      req.session.save(() => res.redirect(back));
      return;
    }
    const passwordHash = await hashPassword(password);
    const other = await getAccountByEmail(email);
    if (other && other.id !== viewer.id) {
      const okPass = other.password_hash
        && await verifyPassword(password, other.password_hash);
      if (!okPass) {
        req.session.notice = "That email belongs to another account. Enter its password to merge.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const merged = await mergeAccounts(viewer.id, other.id, {
        email,
        passwordHash: other.password_hash || passwordHash,
        verifiedAt: other.email_verified_at || (authEmailEnabled() ? null : Date.now()),
      });
      if (!merged.ok) {
        req.session.notice = linkMergeNotice(merged.error, "email");
        req.session.save(() => res.redirect(back));
        return;
      }
      setAccountSession(req.session, merged.account);
      logger.info({
        event: "account_merged",
        survivorId: viewer.id,
        donorId: other.id,
        provider: "email",
      }, "accounts merged via email link");
      if (needsEmailVerification(merged.account) && mailReady()) {
        try {
          await issueVerifyEmail(merged.account);
          req.session.notice = "Accounts merged. Check your email to verify.";
        } catch (err) {
          logger.error({
            event: "mail_send_failed",
            purpose: "verify",
            accountId: merged.account.id,
            err: asErr(err),
          }, "merge verify email failed");
          req.session.notice = "Accounts merged.";
        }
      } else {
        req.session.notice = "Accounts merged.";
      }
      req.session.save(() => res.redirect(`/profile/${merged.account.id}`));
      return;
    }
    const needVerify = authEmailEnabled();
    if (needVerify && !mailReady()) {
      req.session.notice = "Email is not configured. Try again later.";
      req.session.save(() => res.redirect(back));
      return;
    }
    await setLocalCredentials(viewer.id, {
      email,
      passwordHash,
      verifiedAt: needVerify ? null : Date.now(),
    });
    const fresh = await getAccount(viewer.id);
    setAccountSession(req.session, fresh || viewer);
    if (needVerify) {
      try {
        await issueVerifyEmail(fresh);
        req.session.notice = "Check your email to verify the new address.";
      } catch (err) {
        logger.error({
          event: "mail_send_failed",
          purpose: "verify",
          accountId: viewer.id,
          err: asErr(err),
        }, "link-local verify email failed");
        req.session.notice = "Email saved, but verification could not be sent.";
      }
    } else {
      req.session.notice = "Email and password added.";
    }
    req.session.save(() => res.redirect(back));
  } catch (err) {
    next(err);
  }
});

app.post("/tickets", async (req, res, next) => {
  try {
    const back = safeNext(req.body && req.body.next);
    const account = await pageViewer(req);
    if (!accountEmailVerified(account)) {
      res.redirect("/login");
      return;
    }
    if (!account.formbar_id) {
      req.session.notice = "Link a Formbar account to buy tickets with Digipogs.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (!rateLimit(`tickets:${account.id}`, { max: LIMITS.ticket, windowMs: 60 * 1000 })) {
      logRateLimited(req, "tickets", { accountId: account.id });
      req.session.notice = "Too many ticket purchases. Try again in a minute.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (!tryLockTicketPurchase(account.id)) {
      logger.warn({
        event: "ticket_purchase",
        status: "rejected",
        reason: "in_progress",
        accountId: account.id,
      }, "ticket purchase already in progress");
      req.session.notice = "A ticket purchase is already in progress.";
      req.session.save(() => res.redirect(back));
      return;
    }
    try {
      const pack = ticketPack();
      const purchaseId = await beginTicketPurchase({
        accountId: account.id,
        formbarId: account.formbar_id,
        tickets: pack.size,
        digipogs: pack.cost,
      });
      if (!purchaseId) {
        logger.warn({
          event: "ticket_purchase",
          status: "rejected",
          reason: "pending",
          accountId: account.id,
        }, "ticket purchase already pending");
        req.session.notice = "A ticket purchase is already pending and was not retried.";
        req.session.save(() => res.redirect(back));
        return;
      }
      logger.info({
        event: "ticket_purchase",
        status: "started",
        purchaseId,
        accountId: account.id,
        formbarId: account.formbar_id,
        tickets: pack.size,
        digipogs: pack.cost,
      }, "ticket purchase started");
      const transfer = await payPool(formbarSocket, {
        userId: account.formbar_id,
        poolId: POOL_ID,
        amount: pack.cost,
        pin: req.body && req.body.pin,
        reason: `${pack.size} game tickets`,
      });
      if (transfer.ambiguous) {
        logger.error({
          event: "ticket_purchase_ambiguous",
          purchaseId,
          accountId: account.id,
          formbarId: account.formbar_id,
          digipogs: pack.cost,
          tickets: pack.size,
        }, "ticket purchase ambiguous");
        req.session.notice = AMBIGUOUS_TRANSFER;
        req.session.save(() => res.redirect(back));
        return;
      }
      if (!transfer.success) {
        await failTicketPurchase(purchaseId);
        logger.warn({
          event: "ticket_purchase",
          status: "failed",
          purchaseId,
          accountId: account.id,
        }, "ticket purchase failed");
        req.session.notice = transfer.message || "Payment failed.";
        req.session.save(() => res.redirect(back));
        return;
      }
      await completeTicketPurchase(purchaseId, account.id, pack.size);
      logger.info({
        event: "ticket_purchase",
        status: "completed",
        purchaseId,
        accountId: account.id,
        tickets: pack.size,
        digipogs: pack.cost,
      }, "ticket purchase completed");
      req.session.notice = `Added ${pack.size} tickets.`;
      req.session.save(() => res.redirect(back));
    } finally {
      unlockTicketPurchase(account.id);
    }
  } catch (err) {
    next(err);
  }
});

app.post("/suggestions", async (req, res, next) => {
  try {
    const back = safeNext(req.body && req.body.next);
    const account = await pageViewer(req);
    if (!accountEmailVerified(account)) {
      res.redirect("/login");
      return;
    }
    if (!rateLimit(`suggest:${account.id}`, { max: LIMITS.suggest, windowMs: LIMITS.suggestWindow })) {
      req.session.notice = "Too many suggestions. Try again later.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const body = sanitizeUserText(req.body && req.body.body, {
      max: SUGGESTION_BODY_MAX,
      allowNewlines: true,
    });
    const isBug = Boolean(req.body && (req.body.is_bug === "on" || req.body.is_bug === "1"));
    const repro = sanitizeUserText(req.body && req.body.repro, {
      max: SUGGESTION_REPRO_MAX,
      allowNewlines: true,
    });
    if (!body) {
      req.session.notice = "Suggestion text is required.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (isBug && !repro) {
      req.session.notice = "Bug reports need steps to reproduce.";
      req.session.save(() => res.redirect(back));
      return;
    }
    let spentTicket = false;
    if (isBug) {
      const openBugs = await countOpenBugs(account.id);
      if (openBugs >= MAX_OPEN_BUGS) {
        req.session.notice = `You already have ${MAX_OPEN_BUGS} unresolved bug reports.`;
        req.session.save(() => res.redirect(back));
        return;
      }
    } else {
      const openSuggestions = await countOpenSuggestions(account.id);
      if (openSuggestions >= FREE_OPEN_SUGGESTIONS) {
        spentTicket = await spendFreeTicket(account.id);
        if (!spentTicket) {
          req.session.notice = "You already have an unanswered suggestion. Extra suggestions cost 1 ticket.";
          req.session.save(() => res.redirect(back));
          return;
        }
      }
    }
    await createSuggestion({
      accountId: account.id,
      formbarId: account.formbar_id || 0,
      name: account.name,
      body,
      isBug,
      repro,
    });
    req.session.notice = spentTicket
      ? "Thanks for the suggestion. Used 1 ticket."
      : (isBug ? "Thanks for the bug report." : "Thanks for the suggestion.");
    req.session.save(() => res.redirect(back));
  } catch (err) {
    next(err);
  }
});

async function viewerCanEditWiki(sess) {
  const account = await resolveSessionAccount(sess);
  if (!accountEmailVerified(account)) return false;
  if (await isAdmin(sess)) return true;
  return canEditWiki(account.id);
}

function titleFromSlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, WIKI_TITLE_MAX) || "Page";
}

async function renderWikiView(req, res, slugParam) {
  const slug = wikiSlug(slugParam || "home");
  const viewer = await pageViewer(req);
  const notice = takeNotice(req);
  const canEdit = await viewerCanEditWiki(req.session);
  const found = await getWikiPageBySlug(slug);
  const slugs = await listWikiSlugs();
  const existingSlugs = new Set(slugs);
  const bodyHtml = found && found.revision
    ? renderWikiBody(found.revision.body, { existingSlugs })
    : "";
  req.session.save(() => {
    res.render("rules", {
      nav: "rules",
      viewer,
      notice,
      canEdit,
      slug,
      page: found ? found.page : null,
      revision: found ? found.revision : null,
      bodyHtml,
      missingTitle: titleFromSlug(slug),
    });
  });
}

async function startPlay(req, res, next, intent) {
  try {
    const paid = intent.mode === "listed" || intent.mode === "ranked" || intent.mode === "join";
    const playMax = intent.mode === "listed" ? LIMITS.lobby : LIMITS.play;
    if (!rateLimit(`play:${clientIp(req)}`, { max: playMax, windowMs: 60 * 1000 })) {
      req.session.notice = "Too many game requests. Try again in a minute.";
      req.session.save(() => res.redirect("/games"));
      return;
    }
    if (await isMatchmakingPaused()) {
      const msg = (await getMaintenanceMessage()) || "Matchmaking is temporarily paused.";
      req.session.notice = msg;
      req.session.save(() => res.redirect("/games"));
      return;
    }
    const account = await resolveSessionAccount(req.session);
    if (account && isAccountBanned(account)) {
      req.session.notice = "This account is banned.";
      req.session.save(() => res.redirect("/"));
      return;
    }
    const privileged = accountEmailVerified(account);
    if (account && !rateLimit(`play-acct:${account.id}`, { max: playMax, windowMs: 60 * 1000 })) {
      req.session.notice = "Too many game requests. Try again in a minute.";
      req.session.save(() => res.redirect("/games"));
      return;
    }
    const needsNewGuest = !paid && !privileged && !req.session.guestId && !req.session.userId;
    if (needsNewGuest && !rateLimit(`guest:${clientIp(req)}`, { max: LIMITS.guest, windowMs: LIMITS.guestWindow })) {
      req.session.notice = "Too many new players from this network. Try again later.";
      req.session.save(() => res.redirect("/games"));
      return;
    }
    if (paid && !privileged) {
      if (account) {
        req.session.notice = "Verify your email to unlock account features.";
        req.session.save(() => res.redirect("/games"));
      } else {
        res.redirect("/login");
      }
      return;
    }
    const player = await playerFromSession(req.session, { createGuest: !paid });
    if (!player) {
      res.redirect("/games");
      return;
    }
    if (matchmaker.isBusy(player.id)) {
      req.session.save(() => res.redirect("/play"));
      return;
    }
    if (paid) {
      if (!account || account.tickets <= account.held) {
        req.session.notice = "You need a free ticket.";
        req.session.save(() => res.redirect("/games"));
        return;
      }
    }
    if (intent.mode === "join") {
      const room = matchmaker.openLobby(intent.roomId);
      if (!room) {
        req.session.notice = "That game is no longer open.";
        req.session.save(() => res.redirect("/games"));
        return;
      }
      if (room.seat.a.userId === player.id) {
        req.session.save(() => res.redirect("/play"));
        return;
      }
    }
    req.session.view3d = intent.view === "3d";
    req.session.intent = {
      mode: intent.mode,
      roomId: intent.roomId || null,
      view: intent.view || null,
      matchOptions: intent.matchOptions || null,
    };
    req.session.save(() => res.redirect("/play"));
  } catch (err) {
    next(err);
  }
}

function playView(req) {
  return req.body && req.body.view === "3d" ? "3d" : null;
}

function matchOptionsFromBody(body) {
  return normalizeMatchOptions(body || {});
}

app.post("/play/bot", (req, res, next) => {
  startPlay(req, res, next, { mode: "bot", view: playView(req) });
});
app.post("/play/train/bot", (req, res, next) => {
  startPlay(req, res, next, { mode: "trainBot" });
});
app.post("/play/casual", (req, res, next) => {
  startPlay(req, res, next, { mode: "casual", view: playView(req) });
});
app.post("/play/train/casual", (req, res, next) => {
  startPlay(req, res, next, { mode: "trainCasual" });
});
app.post("/play/lobby", (req, res, next) => {
  startPlay(req, res, next, {
    mode: "listed",
    view: playView(req),
    matchOptions: matchOptionsFromBody(req.body),
  });
});
app.post("/play/ranked", (req, res, next) => {
  startPlay(req, res, next, { mode: "ranked", view: playView(req) });
});
app.post("/play/join/:id", (req, res, next) => {
  startPlay(req, res, next, { mode: "join", roomId: req.params.id, view: playView(req) });
});

app.get("/rules", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    const notice = takeNotice(req);
    const canEdit = await viewerCanEditWiki(req.session);
    const pages = await listWikiPages();
    req.session.save(() => {
      res.render("wiki-index", { nav: "rules", viewer, notice, canEdit, pages });
    });
  } catch (err) {
    next(err);
  }
});

app.get("/rules/:slug/edit", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!accountEmailVerified(viewer)) {
      res.redirect("/login");
      return;
    }
    if (!(await viewerCanEditWiki(req.session))) {
      req.session.notice = "Editing requires finishing a ranked game.";
      req.session.save(() => res.redirect(`/rules/${wikiSlug(req.params.slug)}`));
      return;
    }
    const slug = wikiSlug(req.params.slug);
    const notice = takeNotice(req);
    const found = await getWikiPageBySlug(slug);
    req.session.save(() => {
      res.render("wiki-edit", {
        nav: "rules",
        viewer,
        notice,
        slug,
        exists: Boolean(found),
        title: found ? found.page.title : titleFromSlug(slug),
        body: found && found.revision ? found.revision.body : "",
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/rules/:slug/edit", async (req, res, next) => {
  try {
    const account = await pageViewer(req);
    if (!accountEmailVerified(account)) {
      res.redirect("/login");
      return;
    }
    if (!rateLimit(`wiki:${account.id}`, { max: LIMITS.wiki, windowMs: LIMITS.suggestWindow })) {
      req.session.notice = "Too many wiki edits. Try again later.";
      const slug = wikiSlug(req.params.slug);
      req.session.save(() => res.redirect(`/rules/${slug}`));
      return;
    }
    const slug = wikiSlug(req.params.slug);
    if (!(await viewerCanEditWiki(req.session))) {
      req.session.notice = "Editing requires finishing a ranked game.";
      req.session.save(() => res.redirect(`/rules/${slug}`));
      return;
    }
    const found = await getWikiPageBySlug(slug);
    const title = found
      ? found.page.title
      : sanitizeUserText(req.body && req.body.title, {
        max: WIKI_TITLE_MAX,
        allowNewlines: false,
      });
    const body = sanitizeUserText(req.body && req.body.body, {
      max: WIKI_BODY_MAX,
      allowNewlines: true,
    });
    const result = await saveWikiPage({
      slug,
      title,
      body,
      formbarId: account.formbar_id || 0,
      accountId: account.id,
      name: account.name,
    });
    if (!result.ok) {
      req.session.notice = result.error || "Could not save page.";
      req.session.save(() => res.redirect(`/rules/${slug}/edit`));
      return;
    }
    req.session.notice = result.created ? "Page created." : "Page updated.";
    req.session.save(() => res.redirect(`/rules/${result.slug}`));
  } catch (err) {
    next(err);
  }
});

app.post("/rules/:slug/delete", async (req, res, next) => {
  try {
    if (!accountEmailVerified(await pageViewer(req))) {
      res.redirect("/login");
      return;
    }
    const slug = wikiSlug(req.params.slug);
    if (!(await isAdmin(req.session))) {
      logger.warn({
        event: "authz_denied",
        path: req.path,
        ip: clientIp(req),
        accountId: req.session && req.session.accountId,
      }, "wiki delete denied");
      req.session.notice = "Only admins can delete wiki pages.";
      req.session.save(() => res.redirect(`/rules/${slug}/edit`));
      return;
    }
    if (!adminLimited(req)) {
      req.session.notice = "Too many admin actions. Try again in a minute.";
      req.session.save(() => res.redirect(`/rules/${slug}/edit`));
      return;
    }
    const result = await deleteWikiPageBySlug(slug);
    if (!result.ok) {
      req.session.notice = result.error || "Could not delete page.";
      req.session.save(() => res.redirect(`/rules/${slug}/edit`));
      return;
    }
    logger.info({
      event: "admin_action",
      action: "wiki_page_deleted",
      adminUserId: req.session.accountId,
      slug,
    }, "wiki page deleted");
    req.session.notice = "Page deleted.";
    req.session.save(() => res.redirect("/rules"));
  } catch (err) {
    next(err);
  }
});

app.get("/rules/:slug", async (req, res, next) => {
  try {
    await renderWikiView(req, res, req.params.slug);
  } catch (err) {
    next(err);
  }
});

app.get("/play", async (req, res, next) => {
  try {
    const prefs = readPrefsCookies(req);
    const player = await playerFromSession(req.session, {
      createGuest: false,
      prefs,
    });
    const busy = player && matchmaker.isBusy(player.id);
    if (!player || (!req.session.intent && !busy)) {
      res.redirect("/games");
      return;
    }
    const intent = req.session.intent;
    const room = matchmaker.roomForUser(player.id);
    const use3d = Boolean(req.session.view3d)
      || (intent && intent.view === "3d")
      || (room && room.view3d);
    syncPrefsCookies(res, player, req);
    res.render(use3d ? "play3d" : "index", {
      debugRanges: debugRangesEnabled(),
      matchChatEnabled: matchChatEnabled(),
      tooltipsDefault: player.tooltips !== false,
      bgmVolumeDefault: Number.isFinite(player.bgmVolume) ? player.bgmVolume : 50,
    });
  } catch (err) {
    next(err);
  }
});

app.use("/api/v1", (req, res, next) => {
  if (req.query && (req.query.token || req.query.access_token || req.query.session)) {
    logger.warn({
      event: "api_token_in_query_rejected",
      path: req.path,
      ip: clientIp(req),
    }, "API token in query rejected");
    res.status(400).json({ error: "bad_request" });
    return;
  }
  next();
});
app.use("/api/v1", express.json({ limit: "32kb" }));

app.get("/api/v1/metrics", async (req, res) => {
  if (process.env.METRICS !== "1") {
    res.status(404).end();
    return;
  }
  const tokenOk = bearerMatches(req.headers.authorization, process.env.METRICS_TOKEN || "");
  if (!tokenOk && !(await isAdmin(req.session))) {
    res.status(404).end();
    return;
  }
  ensureMetrics();
  let socketBacklog = 0;
  const sockets = io.sockets && io.sockets.sockets;
  if (sockets) {
    for (const sock of sockets.values()) {
      const buf = sock.conn && sock.conn.writeBuffer;
      if (buf) socketBacklog += buf.length;
    }
  }
  res.json(metricsReport({
    rooms: matchmaker.rooms.size,
    sockets: io.engine ? io.engine.clientsCount : 0,
    socketBacklog,
  }));
});

app.get("/api/v1/version", (req, res) => {
  res.json({
    protocol: PROTOCOL_VERSION,
    minProtocol: minClientProtocol(),
    serverVersion: CLIENT_VERSION,
    clientVersion: CLIENT_VERSION,
    assetVersion: app.locals.assetVersion,
  });
});

app.post("/api/v1/session", async (req, res, next) => {
  try {
    if (!rateLimit(`guest:${clientIp(req)}`, { max: LIMITS.guest, windowMs: LIMITS.guestWindow })) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const name = req.body && req.body.name;
    await ensureGuest(req.session, { name });
    await saveSession(req.session);
    const player = await playerFromSession(req.session, { createGuest: false });
    if (!player) {
      res.status(500).json({ error: "server_error" });
      return;
    }
    res.json({
      token: req.sessionID,
      player: playerPublic(player),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Start Formbar OAuth for the native app (Custom Tabs).
 * Browser cookie session stores the deep-link return; callback redirects with ?token=sessionId.
 */
app.get("/api/v1/login", (req, res, next) => {
  try {
    if (!formbarLoginEnabled()) {
      res.status(404).json({ error: "formbar_disabled" });
      return;
    }
    const ret = safeAppReturn(req.query && req.query.return) || DEFAULT_APP_RETURN;
    req.session.apiReturn = ret;
    req.session.save((err) => {
      if (err) {
        next(err);
        return;
      }
      const redirectURL = encodeURIComponent(`${publicBase(req)}/api/v1/login/callback`);
      res.redirect(`${AUTH_URL}/oauth?redirectURL=${redirectURL}`);
    });
  } catch (err) {
    next(err);
  }
});

/** Formbar redirect target for native login. */
app.get("/api/v1/login/callback", async (req, res, next) => {
  try {
    if (!formbarLoginEnabled()) {
      res.status(404).send("Formbar login is disabled.");
      return;
    }
    const account = await applyFormbarToken(req.session, req.query && req.query.token);
    if (!account) {
      res.status(400).send("Invalid Formbar token.");
      return;
    }
    if (isAccountBanned(account)) {
      res.status(403).send("This account is banned.");
      return;
    }
    touchAccountLogin(account.id, "formbar").catch(() => {});
    const ret = safeAppReturn(req.session.apiReturn) || DEFAULT_APP_RETURN;
    delete req.session.apiReturn;
    await saveSession(req.session);
    res.redirect(`${ret}?token=${encodeURIComponent(req.sessionID)}`);
  } catch (err) {
    next(err);
  }
});

/**
 * Attach a Formbar JWT to the Bearer session (tests / alternate clients).
 * Body: `{ "token": "<formbar jwt>" }`.
 */
app.post("/api/v1/login/token", requireApiSession, async (req, res, next) => {
  try {
    if (!formbarLoginEnabled()) {
      res.status(404).json({ error: "formbar_disabled" });
      return;
    }
    const account = await applyFormbarToken(req.session, req.body && req.body.token);
    if (!account) {
      res.status(400).json({ error: "invalid_token" });
      return;
    }
    if (isAccountBanned(account)) {
      res.status(403).json({ error: "banned" });
      return;
    }
    touchAccountLogin(account.id, "formbar").catch(() => {});
    await saveSession(req.session);
    const player = await playerFromSession(req.session, { createGuest: false });
    syncPrefsCookies(res, player, req);
    res.json({
      token: req.sessionID,
      player: playerPublic(player),
      account: accountPublic(account),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Start Discord OAuth for the native app (Custom Tabs).
 * Callback deep-links with ?token=sessionId like Formbar.
 */
app.get("/api/v1/login/discord", async (req, res, next) => {
  try {
    const ret = safeAppReturn(req.query && req.query.return) || DEFAULT_APP_RETURN;
    req.session.apiReturn = ret;
    await beginDiscordOAuth(req, res, { callbackUrl: discordApiCallbackUrl(req) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/login/discord/callback", async (req, res, next) => {
  try {
    if (!discordLoginEnabled()) {
      res.status(404).send("Discord login is disabled.");
      return;
    }
    const state = String(req.query.state || "");
    const expected = String(req.session.discordOAuthState || "");
    delete req.session.discordOAuthState;
    delete req.session.discordOAuthNext;
    if (!state || !expected || state !== expected) {
      res.status(400).send("Discord login expired.");
      return;
    }
    if (req.query.error) {
      res.status(400).send("Discord login was cancelled.");
      return;
    }
    const code = String(req.query.code || "");
    if (!code) {
      res.status(400).send("Missing Discord authorization code.");
      return;
    }
    let user;
    try {
      user = await fetchDiscordUserFromCode(code, discordApiCallbackUrl(req));
    } catch {
      res.status(400).send("Discord login failed.");
      return;
    }
    const account = await upsertDiscordAccount(user.id, nameFromDiscordUser(user));
    if (!account) {
      res.status(500).send("Could not create account.");
      return;
    }
    if (isAccountBanned(account)) {
      res.status(403).send("This account is banned.");
      return;
    }
    setAccountSession(req.session, account);
    touchAccountLogin(account.id, "discord").catch(() => {});
    const ret = safeAppReturn(req.session.apiReturn) || DEFAULT_APP_RETURN;
    delete req.session.apiReturn;
    await saveSession(req.session);
    res.redirect(`${ret}?token=${encodeURIComponent(req.sessionID)}`);
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/logout", requireApiSession, async (req, res, next) => {
  try {
    await new Promise((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/me", requireApiSession, async (req, res, next) => {
  try {
    const prefs = readPrefsCookies(req);
    const player = await playerFromSession(req.session, {
      createGuest: false,
      prefs,
    });
    if (!player) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    syncPrefsCookies(res, player, req);
    const busy = matchmaker.isBusy(player.id);
    const account = await resolveSessionAccount(req.session);
    const privileged = accountEmailVerified(account);
    const pack = ticketPack();
    res.json({
      player: playerPublic(player),
      busy,
      account: privileged ? accountPublic(account) : null,
      canTicket: Boolean(privileged && account.tickets > account.held && !busy),
      pack: { size: pack.size, cost: pack.cost },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/lobbies", requireApiSession, async (req, res, next) => {
  try {
    res.json({ lobbies: matchmaker.listLobbies() });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/queues", requireApiSession, async (req, res, next) => {
  try {
    res.json({
      waiting: matchmaker.waitingCounts(),
      lobbies: matchmaker.listLobbies(),
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/match-options", requireApiSession, async (req, res, next) => {
  try {
    const defaults = defaultMatchOptions();
    res.json({
      defaults,
      speeds: MATCH_SPEEDS,
      maps: mapPresetIds().map((id) => ({
        id,
        label: (MAP_PRESETS[id] && MAP_PRESETS[id].label) || id,
      })),
      baseGpsMin: BASE_GPS_MIN,
      baseGpsMax: BASE_GPS_MAX,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/tickets", requireApiSession, async (req, res, next) => {
  try {
    const account = await resolveSessionAccount(req.session);
    if (!accountEmailVerified(account) || !account.formbar_id) {
      res.status(403).json({ error: "login_required" });
      return;
    }
    if (!rateLimit(`tickets:${account.id}`, { max: LIMITS.ticket, windowMs: 60 * 1000 })) {
      logRateLimited(req, "tickets", { accountId: account.id });
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    if (!tryLockTicketPurchase(account.id)) {
      logger.warn({
        event: "ticket_purchase",
        status: "rejected",
        reason: "in_progress",
        accountId: account.id,
        source: "api",
      }, "ticket purchase already in progress");
      res.status(409).json({ error: "purchase_in_progress" });
      return;
    }
    try {
      const pack = ticketPack();
      const purchaseId = await beginTicketPurchase({
        accountId: account.id,
        formbarId: account.formbar_id,
        tickets: pack.size,
        digipogs: pack.cost,
      });
      if (!purchaseId) {
        logger.warn({
          event: "ticket_purchase",
          status: "rejected",
          reason: "pending",
          accountId: account.id,
          source: "api",
        }, "ticket purchase already pending");
        res.status(409).json({ error: "purchase_pending" });
        return;
      }
      logger.info({
        event: "ticket_purchase",
        status: "started",
        purchaseId,
        accountId: account.id,
        formbarId: account.formbar_id,
        tickets: pack.size,
        digipogs: pack.cost,
        source: "api",
      }, "ticket purchase started");
      const transfer = await payPool(formbarSocket, {
        userId: account.formbar_id,
        poolId: POOL_ID,
        amount: pack.cost,
        pin: req.body && req.body.pin,
        reason: `${pack.size} game tickets`,
      });
      if (transfer.ambiguous) {
        logger.error({
          event: "ticket_purchase_ambiguous",
          purchaseId,
          accountId: account.id,
          formbarId: account.formbar_id,
          digipogs: pack.cost,
          tickets: pack.size,
          source: "api",
        }, "ticket purchase ambiguous");
        res.status(502).json({ error: "payment_ambiguous", message: AMBIGUOUS_TRANSFER });
        return;
      }
      if (!transfer.success) {
        await failTicketPurchase(purchaseId);
        logger.warn({
          event: "ticket_purchase",
          status: "failed",
          purchaseId,
          accountId: account.id,
          source: "api",
        }, "ticket purchase failed");
        res.status(400).json({
          error: "payment_failed",
          message: transfer.message || "Payment failed.",
        });
        return;
      }
      await completeTicketPurchase(purchaseId, account.id, pack.size);
      logger.info({
        event: "ticket_purchase",
        status: "completed",
        purchaseId,
        accountId: account.id,
        tickets: pack.size,
        digipogs: pack.cost,
        source: "api",
      }, "ticket purchase completed");
      const updated = await getAccount(account.id);
      const player = await playerFromSession(req.session, { createGuest: false });
      const busy = player ? matchmaker.isBusy(player.id) : false;
      res.json({
        ok: true,
        account: accountPublic(updated),
        canTicket: Boolean(updated && updated.tickets > updated.held && !busy),
        pack: { size: pack.size, cost: pack.cost },
      });
    } finally {
      unlockTicketPurchase(account.id);
    }
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/play", requireApiSession, async (req, res, next) => {
  try {
    if (rejectIfClientOutdated(req, res)) return;
    const body = req.body || {};
    const mode = body.mode;
    const paid = PAID_PLAY_MODES.has(mode);
    const playMax = mode === "listed" ? LIMITS.lobby : LIMITS.play;
    if (!rateLimit(`play:${clientIp(req)}`, { max: playMax, windowMs: 60 * 1000 })) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const account = await resolveSessionAccount(req.session);
    const privileged = accountEmailVerified(account);
    const accountId = account && account.id;
    if (accountId && !rateLimit(`play-acct:${accountId}`, { max: playMax, windowMs: 60 * 1000 })) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const needsNewGuest = !paid && !privileged && !req.session.guestId && !req.session.userId;
    if (needsNewGuest && !rateLimit(`guest:${clientIp(req)}`, { max: LIMITS.guest, windowMs: LIMITS.guestWindow })) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const matchOptions = body.matchOptions && typeof body.matchOptions === "object"
      ? body.matchOptions
      : {
        speed: body.speed,
        fogEnabled: body.fogEnabled,
        fog: body.fog,
        mapId: body.mapId,
        map: body.map,
        fortsEnabled: body.fortsEnabled,
        forts: body.forts,
        baseGps: body.baseGps,
        baseIncome: body.baseIncome,
      };
    const result = await preparePlayIntent(req.session, {
      mode,
      roomId: body.roomId || null,
      matchOptions,
    });
    if (result.error) {
      res.status(result.status || 400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  if (String(req.path || "").startsWith("/api/")) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  renderError(req, res, { status: 404 }).catch(next);
});

app.use((err, req, res, next) => {
  const raw = Number(err && (err.status || err.statusCode)) || 500;
  const status = raw >= 400 && raw < 600 ? raw : 500;
  const level = status >= 500 ? "error" : "warn";
  logger[level]({
    event: "http_error",
    err: status >= 500 ? asErr(err) : undefined,
    errMessage: err && err.message,
    status,
    method: req.method,
    path: req.path,
    ip: clientIp(req),
  }, status >= 500 ? "HTTP server error" : "HTTP client error");
  if (res.headersSent) {
    next(err);
    return;
  }
  if (String(req.path || "").startsWith("/api/")) {
    const code = status === 403 ? "forbidden"
      : status === 404 ? "not_found"
      : status === 429 ? "rate_limited"
      : "server_error";
    res.status(status).json({ error: code });
    return;
  }
  const message = status < 500 && err && err.message ? err.message : undefined;
  renderError(req, res, { status, message }).catch((renderErr) => {
    logger.error({
      event: "http_error_render_failed",
      err: asErr(renderErr),
      status,
      path: req.path,
    }, "error page render failed");
    if (!res.headersSent) res.status(status).send("Something went wrong");
  });
});

const socketsByUser = new Map();

function capUserSockets(socket) {
  const user = socket.data.user;
  if (!user || !user.id) return;
  const max = positiveEnv(process.env, "MAX_SOCKETS_PER_USER", 4);
  let list = socketsByUser.get(user.id);
  if (!list) {
    list = [];
    socketsByUser.set(user.id, list);
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].connected) list.splice(i, 1);
  }
  list.push(socket);
  while (list.length > max) {
    const old = list.shift();
    if (old && old !== socket && old.connected) {
      logger.info({
        event: "socket_capped",
        userId: user.id,
        socketId: old.id,
        newSocketId: socket.id,
      }, "capped older socket");
      old.disconnect(true);
    }
  }
  socket.on("disconnect", () => {
    const current = socketsByUser.get(user.id);
    if (!current) return;
    const idx = current.indexOf(socket);
    if (idx >= 0) current.splice(idx, 1);
    if (!current.length) socketsByUser.delete(user.id);
  });
}

io.use((socket, next) => {
  const origin = socket.handshake.headers && socket.handshake.headers.origin;
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const hasAuthToken = typeof token === "string" && Boolean(token.trim());
  if (!originAllowed(origin, {
    thisUrl: THIS_URL,
    nodeEnv: process.env.NODE_ENV,
    hasAuthToken,
  })) {
    let originHost;
    try {
      originHost = origin ? new URL(origin).host : undefined;
    } catch {
      originHost = undefined;
    }
    logger.warn({
      event: "origin_rejected",
      socketId: socket.id,
      originHost,
    }, "socket origin rejected");
    next(new Error("origin not allowed"));
    return;
  }
  next();
});

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const clientProtocol = parseProtocol(auth.protocol);
  const minProtocol = minClientProtocol();
  if (isClientOutdated(clientProtocol, minProtocol)) {
    logger.warn({
      event: "socket_auth_failed",
      reason: "client_outdated",
      socketId: socket.id,
      clientProtocol,
      minProtocol,
    }, "socket client outdated");
    next(new Error("client_outdated"));
    return;
  }
  const token = auth.token;
  if (typeof token === "string" && token.trim()) {
    const sid = token.trim();
    loadStoredSession(sid).then((data) => {
      if (data) {
        socket.request.sessionID = sid;
        socket.request.session = wrapStoredSession(sid, data);
        next();
        return;
      }
      // Stale Bearer: use cookie session (website) instead of failing hard.
      sessionMiddleware(socket.request, {}, next);
    }).catch(next);
    return;
  }
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess) {
    logger.warn({
      event: "socket_auth_failed",
      reason: "no_session",
      socketId: socket.id,
    }, "socket auth failed");
    next(new Error("no session"));
    return;
  }
  playerFromSession(sess, {
    createGuest: false,
    prefs: readPrefsCookies(socket.request),
  }).then(async (user) => {
    if (!user) {
      logger.warn({
        event: "socket_auth_failed",
        reason: "no_player",
        socketId: socket.id,
      }, "socket auth failed");
      next(new Error("no player"));
      return;
    }
    if (user.accountId) {
      const account = await getAccount(user.accountId);
      if (account && isAccountBanned(account)) {
        logger.warn({
          event: "socket_auth_failed",
          reason: "banned",
          socketId: socket.id,
          accountId: account.id,
        }, "banned socket rejected");
        next(new Error("banned"));
        return;
      }
      const sessEpoch = Number(sess.sessionEpoch || 0);
      const acctEpoch = Number(account?.session_epoch || 0);
      if (account && sessEpoch !== acctEpoch) {
        next(new Error("session revoked"));
        return;
      }
      touchAccountSeen(user.accountId).catch(() => {});
    }
    socket.data.user = user;
    sess.save((err) => next(err));
  }).catch(next);
});

io.on("connection", (socket) => {
  const user = socket.data.user;
  const slog = childLogger({
    component: "socket",
    socketId: socket.id,
    userId: user && user.id,
  });
  slog.info({ event: "socket_connected" }, "socket connected");
  matchmaker.connect(socket);
  capUserSockets(socket);
  socket.on("error", (err) => {
    slog.error({ event: "socket_error", err: asErr(err) }, "socket error");
  });
  socket.on("command", (cmd) => matchmaker.command(socket, cmd));
  socket.on("chat", (payload) => matchmaker.chat(socket, payload));
  socket.on("report", (payload) => {
    Promise.resolve(matchmaker.report(socket, payload)).catch((err) => {
      slog.warn({ event: "report_failed", err: asErr(err) }, "report handler failed");
      try {
        socket.emit("reportResult", { ok: false, error: "failed" });
      } catch {
        // ignore emit failures on a dead socket
      }
    });
  });
  socket.on("pause", () => matchmaker.pause(socket));
  socket.on("pauseSeen", () => matchmaker.pauseSeen(socket));
  socket.on("settingsOpen", (open) => matchmaker.settingsOpen(socket, open));
  socket.on("botSettings", (payload) => matchmaker.botSettings(socket, payload));
  socket.on("debugPlay", (payload) => matchmaker.debugPlay(socket, payload));
  socket.on("tooltips", (on) => {
    if (!allowSocketEvent(socket, "tooltips")) return;
    const enabled = Boolean(on);
    if (socket.data.user) socket.data.user.tooltips = enabled;
    // Guests persist via cookies on the client; only accounts hit SQLite.
    if (!socket.data.user || !socket.data.user.accountId) return;
    scheduleSettingWrite(socket, "tooltips", enabled, (value) => {
      return setPlayerTooltips(socket.data.user, value);
    });
  });
  socket.on("bgmVolume", (percent) => {
    if (!allowSocketEvent(socket, "bgmVolume")) return;
    if (!Number.isFinite(Number(percent))) return;
    const value = clampBgmVolumePercent(percent);
    if (socket.data.user) socket.data.user.bgmVolume = value;
    if (!socket.data.user || !socket.data.user.accountId) return;
    scheduleSettingWrite(socket, "bgmVolume", value, (next) => {
      return setPlayerBgmVolume(socket.data.user, next);
    });
  });
  socket.on("concede", () => matchmaker.concede(socket));
  socket.on("leave", () => matchmaker.leave(socket));
  socket.on("disconnect", (reason) => {
    slog.info({ event: "socket_disconnected", reason }, "socket disconnected");
    matchmaker.disconnect(socket);
  });
});

export { app, httpServer, io, matchmaker, PORT, THIS_URL };

export function listen(port = PORT) {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      httpServer.off("error", reject);
      resolve(httpServer);
    });
  });
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "shutdown", signal }, "shutting down");
  try {
    io.close();
  } catch {
    // ignore
  }
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
    setTimeout(resolve, 5000).unref?.();
  });
  try {
    stopPaypalReconcileLoop();
  } catch {
    // ignore
  }
  try {
    disconnectFormbar();
  } catch {
    // ignore
  }
  process.exit(0);
}

// PM2 loads via ProcessContainer, so argv[1] is not this file; use pm_exec_path instead.
const thisFile = fileURLToPath(import.meta.url);
const entryPaths = [process.argv[1], process.env.pm_id != null ? process.env.pm_exec_path : null]
  .filter(Boolean)
  .map((p) => path.resolve(p));
const isMain = entryPaths.some((entry) => entry === thisFile);
if (isMain) {
  process.on("uncaughtException", (err) => {
    logger.fatal({ event: "uncaught_exception", err: asErr(err) }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ event: "unhandled_rejection", err: asErr(reason) }, "unhandled rejection");
  });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });

  if (process.env.NODE_ENV === "production" && process.env.DEBUG_RANGES === "1") {
    logger.warn({ event: "config_debug_ranges_ignored" }, "DEBUG_RANGES is set but ignored in production.");
  }
  await listen(PORT);
  logger.info({
    event: "server_started",
    port: PORT,
    url: THIS_URL,
    workers: workerCount(),
  }, `Men Of The Line listening on ${THIS_URL}`);
  if (paypalCheckoutEnabled()) {
    startPaypalReconcileLoop();
    logger.info({
      event: "paypal_enabled",
      mode: paypalMode(),
    }, "PayPal ticket checkout enabled");
  }
  if (debugRangesEnabled()) {
    logger.info({
      event: "debug_ranges_enabled",
    }, "debug ranges overlays enabled");
  }
  setInterval(() => {
    const waiting = matchmaker.waitingCounts();
    recordOpsSample({
      rooms: matchmaker.rooms.size,
      sockets: io.engine ? io.engine.clientsCount : 0,
      queueCasual: matchmaker.casual.length,
      queueRanked: matchmaker.ranked.length,
      queueTraining: matchmaker.training.length,
    }).catch(() => {});
    void waiting;
  }, 60_000).unref?.();
}
