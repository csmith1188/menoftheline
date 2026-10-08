import "./server/load-env.js";
import path from "path";
import { createServer } from "http";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import { timingSafeEqual } from "crypto";
import { Server } from "socket.io";
import {
  assignOwner,
  archiveSuggestion,
  beginTicketPurchase,
  claimSuggestionReward,
  claimWikiReward,
  canEditWiki,
  completeSuggestionReward,
  completeTicketPurchase,
  completeWikiReward,
  confirmWikiRevision,
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
  getSuggestion,
  getUser,
  getWikiPageBySlug,
  getWikiRevision,
  initDb,
  linkDiscordToAccount,
  linkFormbarToAccount,
  listOpenWikiRevisions,
  listSuggestions,
  listWikiPages,
  listWikiSlugs,
  deleteWikiPageBySlug,
  MAX_OPEN_BUGS,
  MAX_OPEN_WIKI_REVISIONS,
  mergeAccounts,
  releaseSuggestionReward,
  releaseWikiReward,
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
  systemStats,
  ticketPack,
  topAccounts,
  tooltipsEnabled,
  undoWikiRevision,
  upsertAccount,
  upsertDiscordAccount,
  wikiRewardAmount,
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
import { connectFormbar, payPool, rewardFromPool } from "./server/formbar.js";
import { authenticateFormbarToken } from "./server/formbarAuth.js";
import { ensureCsrf, requireCsrf } from "./server/csrf.js";
import {
  assertSessionSecret,
  debugRangesEnabled,
  originAllowed,
  positiveEnv,
  requestClientIp,
  securityHeadersMiddleware,
  sessionCookieOptions,
} from "./server/hardening.js";
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
import { wikiLineDiff } from "./server/wiki-diff.js";
import {
  BASE_GPS_MAX,
  BASE_GPS_MIN,
  MATCH_SPEEDS,
  defaultMatchOptions,
  normalizeMatchOptions,
} from "./shared/matchOptions.js";
import { MAP_PRESETS, mapPresetIds } from "./shared/maps.js";

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
  console.error(err.message);
  process.exit(1);
}

await initDb();
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

function requireApiSession(req, res, next) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const sid = match[1];
  loadStoredSession(sid).then((data) => {
    if (!data) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.sessionID = sid;
    req.session = wrapStoredSession(sid, data);
    next();
  }).catch(next);
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
app.use((req, res, next) => {
  res.locals.isAdmin = isAdmin(req.session);
  res.locals.localAccountsEnabled = localAccountsEnabled();
  res.locals.formbarLoginEnabled = formbarLoginEnabled();
  res.locals.discordLoginEnabled = discordLoginEnabled();
  res.locals.authEmailEnabled = authEmailEnabled();
  res.locals.anyLoginEnabled = anyLoginEnabled();
  res.locals.matchChatEnabled = matchChatEnabled();
  next();
});

function adminId() {
  const id = Number(process.env.ADMIN_USER_ID);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAdmin(sess) {
  const id = adminId();
  if (id == null || !sess) return false;
  return Number(sess.formbarId) === id;
}

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

/** Native app deep-link allowlist for Formbar login return. */
function safeAppReturn(value) {
  const text = String(value || "").trim();
  if (text === "pocketmotl://auth" || text === "pocketmotl://auth/") {
    return "pocketmotl://auth";
  }
  return null;
}

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

async function establishAccountSession(req, account, notice) {
  await regenerateSession(req);
  setAccountSession(req.session, account);
  if (notice) req.session.notice = notice;
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

function adminLimited(req) {
  const accountId = req.session && req.session.accountId;
  const key = accountId ? `admin:${accountId}` : `admin-ip:${clientIp(req)}`;
  return rateLimit(key, { max: LIMITS.admin, windowMs: 60 * 1000 });
}

function routeId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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
  } catch {
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
  return {
    id: guest.id,
    name: guest.name,
    accountId: null,
    formbarId: null,
    mmr: null,
    tooltips: tooltipsEnabled(guest),
    bgmVolume: bgmVolumePercent(guest),
  };
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
  return {
    nav: "home",
    viewer: await pageViewer(req),
    news: loadNews(),
    notice: takeNotice(req),
  };
}

async function gamesData(req) {
  const viewer = await pageViewer(req);
  const privileged = accountEmailVerified(viewer);
  const player = await playerFromSession(req.session, { createGuest: false });
  const rejoin = player ? matchmaker.isBusy(player.id) : false;
  return {
    nav: "games",
    viewer,
    rejoin,
    canTicket: Boolean(privileged && viewer.tickets > viewer.held && !rejoin),
    waiting: matchmaker.waitingCounts(),
    lobbies: matchmaker.listLobbies(),
    notice: takeNotice(req),
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

async function adminData(req) {
  const stats = await systemStats();
  const games = matchmaker.listActive();
  return {
    nav: "admin",
    viewer: await pageViewer(req),
    admin: { games, stats: { ...stats, active: games.length } },
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
      res.status(503).send("Formbar login is temporarily unavailable.");
      return;
    }
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
      req.session.notice = linkMergeNotice(result.error, "Formbar");
      req.session.save(() => res.redirect(`/profile/${linkId}`));
      return;
    }
    await upsertAccount(userId, name);
    const linked = await getAccount(result.account.id);
    setAccountSession(req.session, linked || result.account);
    req.session.notice = result.merged
      ? "Accounts merged. Formbar is linked."
      : "Formbar account linked.";
    req.session.save(() => res.redirect(`/profile/${(linked || result.account).id}`));
    return;
  }

  const account = await upsertAccount(userId, name);
  setAccountSession(req.session, account);
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
    req.session.notice = "Discord login expired. Try again.";
    req.session.save(() => res.redirect("/login"));
    return;
  }
  if (req.query.error) {
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
  } catch {
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
      req.session.notice = linkMergeNotice(result.error, "Discord");
      req.session.save(() => res.redirect(`/profile/${linkId}`));
      return;
    }
    await upsertDiscordAccount(user.id, name);
    const linked = await getAccount(result.account.id);
    setAccountSession(req.session, linked || result.account);
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
  setAccountSession(req.session, account);
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
      renderFail("Too many login attempts. Try again later.");
      return;
    }
    if (!rateLimit(`login:${clientIp(req)}:${email}`, { max: LIMITS.login, windowMs: LIMITS.loginWindow })) {
      renderFail("Too many login attempts. Try again later.");
      return;
    }
    const account = await getAccountByEmail(email);
    if (!account || !account.password_hash) {
      renderFail("Invalid email or password.");
      return;
    }
    const ok = await verifyPassword(password, account.password_hash);
    if (!ok) {
      renderFail("Invalid email or password.");
      return;
    }
    const notice = needsEmailVerification(account)
      ? "Verify your email to unlock account features. Until then you can play like a guest."
      : undefined;
    await establishAccountSession(req, account, notice);
    req.session.save(() => res.redirect("/"));
  } catch (err) {
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
        console.error(err);
        try {
          await deleteLocalAccount(account.id);
        } catch (cleanupErr) {
          console.error(cleanupErr);
        }
        renderFail("Could not send verification email. Try again later.");
        return;
      }
      req.session.notice = `Check your email to verify your account.${nameNote}`;
      req.session.save(() => res.redirect("/login"));
      return;
    }
    await establishAccountSession(req, account, nameNote ? nameNote.trim() : undefined);
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
      req.session.notice = "That verification link is invalid or expired.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    await setEmailVerified(account.id);
    const fresh = await getAccount(account.id);
    await establishAccountSession(req, fresh || account, "Email verified. You are logged in.");
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
      req.session.notice = "If that account exists, a new email was sent.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    const account = await getAccountByEmail(email);
    if (needsEmailVerification(account) && mailReady()) {
      try {
        await issueVerifyEmail(account);
      } catch (err) {
        console.error(err);
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
          console.error(err);
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
      req.session.notice = "That reset link is invalid or expired.";
      req.session.save(() => res.redirect("/forgot"));
      return;
    }
    await setAccountPassword(account.id, await hashPassword(password));
    const fresh = await getAccount(account.id);
    await establishAccountSession(req, fresh || account, "Password updated.");
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    next(err);
  }
});

app.get("/logout", (req, res) => {
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
    req.session.save(() => res.render("tickets", {
      nav: "buy",
      viewer,
      notice: takeNotice(req),
      packSize: pack.size,
      packCost: pack.cost,
    }));
  } catch (err) {
    next(err);
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

app.get("/admin", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    const data = await adminData(req);
    req.session.save(() => res.render("admin", data));
  } catch (err) {
    next(err);
  }
});

app.get("/profile/:id", async (req, res, next) => {
  try {
    const account = await findAccountForProfile(req.params.id);
    const viewer = await pageViewer(req);
    const privileged = accountEmailVerified(viewer);
    const pack = ticketPack();
    const isOwner = Boolean(account && viewer && account.id === viewer.id);
    const body = {
      account,
      viewer,
      isOwner,
      notice: takeNotice(req),
      packSize: pack.size,
      packCost: pack.cost,
      canLinkFormbar: Boolean(
        isOwner && privileged
        && !account.formbar_id
        && formbarLoginEnabled(),
      ),
      canLinkDiscord: Boolean(
        isOwner && privileged
        && !account.discord_id
        && discordLoginEnabled(),
      ),
      canAddLocal: Boolean(
        isOwner && privileged
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
    if (!rateLimit(`displayname:${viewer.id}`, { max: 3, windowMs: 60 * 60 * 1000 })) {
      req.session.notice = "Display name changed too often. Try again in an hour.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const result = await setAccountDisplayName(viewer.id, nameCheck.name);
    if (!result.ok) {
      req.session.notice = result.error === "taken"
        ? "That display name is already taken."
        : result.message || "Could not update display name.";
      req.session.save(() => res.redirect(back));
      return;
    }
    setAccountSession(req.session, result.account);
    req.session.notice = "Display name updated.";
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
      if (needsEmailVerification(merged.account) && mailReady()) {
        try {
          await issueVerifyEmail(merged.account);
          req.session.notice = "Accounts merged. Check your email to verify.";
        } catch (err) {
          console.error(err);
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
        console.error(err);
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
      req.session.notice = "Too many ticket purchases. Try again in a minute.";
      req.session.save(() => res.redirect(back));
      return;
    }
    if (!tryLockTicketPurchase(account.id)) {
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
        req.session.notice = "A ticket purchase is already pending and was not retried.";
        req.session.save(() => res.redirect(back));
        return;
      }
      const transfer = await payPool(formbarSocket, {
        userId: account.formbar_id,
        poolId: POOL_ID,
        amount: pack.cost,
        pin: req.body && req.body.pin,
        reason: `${pack.size} game tickets`,
      });
      if (transfer.ambiguous) {
        req.session.notice = AMBIGUOUS_TRANSFER;
        req.session.save(() => res.redirect(back));
        return;
      }
      if (!transfer.success) {
        await failTicketPurchase(purchaseId);
        req.session.notice = transfer.message || "Payment failed.";
        req.session.save(() => res.redirect(back));
        return;
      }
      await completeTicketPurchase(purchaseId, account.id, pack.size);
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

app.get("/admin/suggestions", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    const viewer = await pageViewer(req);
    const notice = takeNotice(req);
    const suggestions = await listSuggestions({ archived: false });
    req.session.save(() => {
      res.render("admin-suggestions", {
        nav: "admin",
        viewer,
        notice,
        suggestions,
        rewardAmount: wikiRewardAmount(),
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/suggestions/:id/archive", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    if (!adminLimited(req)) {
      req.session.notice = "Too many admin actions. Try again in a minute.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    const suggestionId = routeId(req.params.id);
    if (!suggestionId) {
      req.session.notice = "Suggestion not found.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    await archiveSuggestion(suggestionId);
    req.session.notice = "Suggestion archived.";
    req.session.save(() => res.redirect("/admin/suggestions"));
  } catch (err) {
    next(err);
  }
});

app.post("/admin/suggestions/:id/archive-reward", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    if (!adminLimited(req)) {
      req.session.notice = "Too many admin actions. Try again in a minute.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    const suggestionId = routeId(req.params.id);
    const suggestion = suggestionId ? await getSuggestion(suggestionId) : null;
    if (!suggestion || suggestion.archived_at || suggestion.rewarded_at || suggestion.reward_status === "pending") {
      req.session.notice = suggestion && suggestion.reward_status === "pending"
        ? AMBIGUOUS_TRANSFER
        : "Suggestion not found.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    if (suggestion.formbar_id <= 0) {
      req.session.notice = "This suggestion cannot be rewarded.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    const claimed = await claimSuggestionReward(suggestion.id);
    if (!claimed) {
      req.session.notice = "Suggestion not found.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    const amount = wikiRewardAmount();
    const transfer = await rewardFromPool(formbarSocket, {
      userId: suggestion.formbar_id,
      amount,
      reason: "MOTL Suggestion Reward",
    });
    if (transfer.ambiguous) {
      req.session.notice = AMBIGUOUS_TRANSFER;
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    if (!transfer.success) {
      await releaseSuggestionReward(suggestion.id);
      req.session.notice = transfer.message || "Reward transfer failed.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    await completeSuggestionReward(suggestion.id);
    req.session.notice = `Archived and sent ${amount} digipogs to ${suggestion.name}.`;
    req.session.save(() => res.redirect("/admin/suggestions"));
  } catch (err) {
    next(err);
  }
});

async function viewerCanEditWiki(sess) {
  const account = await resolveSessionAccount(sess);
  if (!accountEmailVerified(account)) return false;
  if (isAdmin(sess)) return true;
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

app.get("/admin/wiki", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    const viewer = await pageViewer(req);
    const notice = takeNotice(req);
    const revisions = (await listOpenWikiRevisions()).map((item) => ({
      ...item,
      isCreate: item.previous_body == null,
      diff: wikiLineDiff(item.previous_body, item.body),
    }));
    req.session.save(() => {
      res.render("admin-wiki", {
        nav: "admin",
        viewer,
        notice,
        revisions,
        rewardAmount: wikiRewardAmount(),
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/wiki/:id/confirm", async (req, res, next) => {
  try {
    if (!isAdmin(req.session) || !adminLimited(req)) {
      res.redirect("/");
      return;
    }
    const ok = await confirmWikiRevision(routeId(req.params.id));
    req.session.notice = ok ? "Revision confirmed." : "Revision not found.";
    req.session.save(() => res.redirect("/admin/wiki"));
  } catch (err) {
    next(err);
  }
});

app.post("/admin/wiki/:id/undo", async (req, res, next) => {
  try {
    if (!isAdmin(req.session) || !adminLimited(req)) {
      res.redirect("/");
      return;
    }
    const result = await undoWikiRevision(routeId(req.params.id));
    if (!result.ok) {
      req.session.notice = result.error || "Could not undo.";
    } else if (result.deleted) {
      req.session.notice = "Page deleted.";
    } else {
      req.session.notice = "Revision undone.";
    }
    req.session.save(() => res.redirect("/admin/wiki"));
  } catch (err) {
    next(err);
  }
});

app.post("/admin/wiki/:id/reward", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    if (!adminLimited(req)) {
      req.session.notice = "Too many admin actions. Try again in a minute.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    const revisionId = routeId(req.params.id);
    const revision = revisionId ? await getWikiRevision(revisionId) : null;
    if (!revision || revision.undone_at) {
      req.session.notice = "Revision not found.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (revision.rewarded_at || revision.reward_status === "completed") {
      req.session.notice = "Already rewarded.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (revision.reward_status === "pending") {
      req.session.notice = AMBIGUOUS_TRANSFER;
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (revision.formbar_id <= 0) {
      req.session.notice = "System revisions cannot be rewarded.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    const claimed = await claimWikiReward(revision.id);
    if (!claimed) {
      req.session.notice = "Already rewarded.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    const amount = wikiRewardAmount();
    const transfer = await rewardFromPool(formbarSocket, {
      userId: revision.formbar_id,
      amount,
      reason: `MOTL Wiki Reward: ${revision.title}`,
    });
    if (transfer.ambiguous) {
      req.session.notice = AMBIGUOUS_TRANSFER;
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (!transfer.success) {
      await releaseWikiReward(revision.id);
      req.session.notice = transfer.message || "Reward transfer failed.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    await completeWikiReward(revision.id);
    req.session.notice = `Sent ${amount} digipogs to ${revision.name}.`;
    req.session.save(() => res.redirect("/admin/wiki"));
  } catch (err) {
    next(err);
  }
});

async function startPlay(req, res, next, intent) {
  try {
    const paid = intent.mode === "listed" || intent.mode === "ranked" || intent.mode === "join";
    const playMax = intent.mode === "listed" ? LIMITS.lobby : LIMITS.play;
    if (!rateLimit(`play:${clientIp(req)}`, { max: playMax, windowMs: 60 * 1000 })) {
      req.session.notice = "Too many game requests. Try again in a minute.";
      req.session.save(() => res.redirect("/games"));
      return;
    }
    const account = await resolveSessionAccount(req.session);
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
    if (!isAdmin(req.session)) {
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
    const player = await playerFromSession(req.session, { createGuest: false });
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
    res.status(400).json({ error: "bad_request" });
    return;
  }
  next();
});
app.use("/api/v1", express.json({ limit: "32kb" }));

app.get("/api/v1/metrics", (req, res) => {
  if (process.env.METRICS !== "1") {
    res.status(404).end();
    return;
  }
  const tokenOk = bearerMatches(req.headers.authorization, process.env.METRICS_TOKEN || "");
  if (!tokenOk && !isAdmin(req.session)) {
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
    const ret = safeAppReturn(req.query && req.query.return) || "pocketmotl://auth";
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
    const ret = safeAppReturn(req.session.apiReturn) || "pocketmotl://auth";
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
    await saveSession(req.session);
    const player = await playerFromSession(req.session, { createGuest: false });
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
    const ret = safeAppReturn(req.query && req.query.return) || "pocketmotl://auth";
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
    setAccountSession(req.session, account);
    const ret = safeAppReturn(req.session.apiReturn) || "pocketmotl://auth";
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
    const player = await playerFromSession(req.session, { createGuest: false });
    if (!player) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
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
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    if (!tryLockTicketPurchase(account.id)) {
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
        res.status(409).json({ error: "purchase_pending" });
        return;
      }
      const transfer = await payPool(formbarSocket, {
        userId: account.formbar_id,
        poolId: POOL_ID,
        amount: pack.cost,
        pin: req.body && req.body.pin,
        reason: `${pack.size} game tickets`,
      });
      if (transfer.ambiguous) {
        res.status(502).json({ error: "payment_ambiguous", message: AMBIGUOUS_TRANSFER });
        return;
      }
      if (!transfer.success) {
        await failTicketPurchase(purchaseId);
        res.status(400).json({
          error: "payment_failed",
          message: transfer.message || "Payment failed.",
        });
        return;
      }
      await completeTicketPurchase(purchaseId, account.id, pack.size);
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
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  const raw = Number(err && (err.status || err.statusCode)) || 500;
  const status = raw >= 400 && raw < 600 ? raw : 500;
  if (String(req.path || "").startsWith("/api/")) {
    const code = status === 403 ? "forbidden"
      : status === 404 ? "not_found"
      : status === 429 ? "rate_limited"
      : "server_error";
    res.status(status).json({ error: code });
    return;
  }
  const message = status < 500 && err && err.message ? err.message : undefined;
  renderError(req, res, { status, message }).catch(() => {
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
    if (old && old !== socket && old.connected) old.disconnect(true);
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
    next(new Error("origin not allowed"));
    return;
  }
  next();
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token === "string" && token.trim()) {
    const sid = token.trim();
    loadStoredSession(sid).then((data) => {
      if (!data) {
        next(new Error("no session"));
        return;
      }
      socket.request.sessionID = sid;
      socket.request.session = wrapStoredSession(sid, data);
      next();
    }).catch(next);
    return;
  }
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess) {
    next(new Error("no session"));
    return;
  }
  playerFromSession(sess, { createGuest: false }).then((user) => {
    if (!user) {
      next(new Error("no player"));
      return;
    }
    socket.data.user = user;
    sess.save((err) => next(err));
  }).catch(next);
});

io.on("connection", (socket) => {
  matchmaker.connect(socket);
  capUserSockets(socket);
  socket.on("command", (cmd) => matchmaker.command(socket, cmd));
  socket.on("chat", (payload) => matchmaker.chat(socket, payload));
  socket.on("pause", () => matchmaker.pause(socket));
  socket.on("pauseSeen", () => matchmaker.pauseSeen(socket));
  socket.on("settingsOpen", (open) => matchmaker.settingsOpen(socket, open));
  socket.on("botSettings", (payload) => matchmaker.botSettings(socket, payload));
  socket.on("debugPlay", (payload) => matchmaker.debugPlay(socket, payload));
  socket.on("tooltips", (on) => {
    if (!allowSocketEvent(socket, "tooltips")) return;
    const enabled = Boolean(on);
    if (socket.data.user) socket.data.user.tooltips = enabled;
    scheduleSettingWrite(socket, "tooltips", enabled, (value) => {
      return setPlayerTooltips(socket.data.user, value);
    });
  });
  socket.on("bgmVolume", (percent) => {
    if (!allowSocketEvent(socket, "bgmVolume")) return;
    if (!Number.isFinite(Number(percent))) return;
    const value = clampBgmVolumePercent(percent);
    if (socket.data.user) socket.data.user.bgmVolume = value;
    scheduleSettingWrite(socket, "bgmVolume", value, (next) => {
      return setPlayerBgmVolume(socket.data.user, next);
    });
  });
  socket.on("concede", () => matchmaker.concede(socket));
  socket.on("leave", () => matchmaker.leave(socket));
  socket.on("disconnect", () => matchmaker.disconnect(socket));
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

// PM2 loads via ProcessContainer, so argv[1] is not this file; use pm_exec_path instead.
const thisFile = fileURLToPath(import.meta.url);
const entryPaths = [process.argv[1], process.env.pm_id != null ? process.env.pm_exec_path : null]
  .filter(Boolean)
  .map((p) => path.resolve(p));
const isMain = entryPaths.some((entry) => entry === thisFile);
if (isMain) {
  if (process.env.NODE_ENV === "production" && process.env.DEBUG_RANGES === "1") {
    console.warn("DEBUG_RANGES is set but ignored in production.");
  }
  await listen(PORT);
  console.log(`Men Of The Line listening on ${THIS_URL}`);
  if (debugRangesEnabled()) {
    console.log("Debug ranges: forward weapon range, collision boxes, restore, fort, and keep bands");
  }
}
