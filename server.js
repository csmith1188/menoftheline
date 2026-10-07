import "./server/load-env.js";
import path from "path";
import { createServer } from "http";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import {
  addTickets,
  assignOwner,
  archiveSuggestion,
  claimSuggestionReward,
  canEditWiki,
  confirmWikiRevision,
  consumeAuthToken,
  countOpenBugs,
  countOpenSuggestions,
  createAuthToken,
  createLocalAccount,
  createSuggestion,
  dataPath,
  ensureGuest,
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
  linkFormbarToAccount,
  listOpenWikiRevisions,
  listSuggestions,
  listWikiPages,
  listWikiSlugs,
  deleteWikiPageBySlug,
  MAX_OPEN_BUGS,
  MAX_OPEN_WIKI_REVISIONS,
  mergeAccounts,
  reopenSuggestion,
  sanitizeUserText,
  saveWikiPage,
  bgmVolumePercent,
  clampBgmVolumePercent,
  setAccountPassword,
  setEmailVerified,
  setLocalCredentials,
  setPlayerBgmVolume,
  setPlayerTooltips,
  setWikiRevisionRewarded,
  spendFreeTicket,
  SUGGESTION_BODY_MAX,
  SUGGESTION_REPRO_MAX,
  systemStats,
  ticketPack,
  topAccounts,
  tooltipsEnabled,
  undoWikiRevision,
  upsertAccount,
  wikiRewardAmount,
  wikiSlug,
  WIKI_BODY_MAX,
  WIKI_TITLE_MAX,
} from "./server/db.js";
import {
  anyLoginEnabled,
  authEmailEnabled,
  formbarLoginEnabled,
  hashPassword,
  hashToken,
  isValidEmail,
  localAccountsEnabled,
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

await initDb();
warnAuthConfig();

const app = express();
const httpServer = createServer(app);
// Prefer WebSocket; long-polling at 20 Hz state kills mobile Safari latency.
const io = new Server(httpServer, {
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
  secret: process.env.SESSION_SECRET || "lane-pusher-local",
  resave: false,
  saveUninitialized: false,
  name: "lane.sid",
  cookie: { httpOnly: true, sameSite: "lax" },
});

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
app.locals.suggestionBodyMax = SUGGESTION_BODY_MAX;
app.locals.suggestionReproMax = SUGGESTION_REPRO_MAX;
app.locals.wikiTitleMax = WIKI_TITLE_MAX;
app.locals.wikiBodyMax = WIKI_BODY_MAX;
app.locals.maxOpenBugs = MAX_OPEN_BUGS;
app.locals.maxOpenWikiRevisions = MAX_OPEN_WIKI_REVISIONS;
app.locals.freeOpenSuggestions = FREE_OPEN_SUGGESTIONS;
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.locals.isAdmin = isAdmin(req.session);
  res.locals.localAccountsEnabled = localAccountsEnabled();
  res.locals.formbarLoginEnabled = formbarLoginEnabled();
  res.locals.authEmailEnabled = authEmailEnabled();
  res.locals.anyLoginEnabled = anyLoginEnabled();
  next();
});
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

function formbarUserIdFromToken(tokenData) {
  const raw = tokenData.id ?? tokenData.userId ?? tokenData.userID ?? tokenData.sub;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function accountPublic(account) {
  if (!account) return null;
  return {
    formbarId: account.formbar_id,
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

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || "unknown";
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

/** Attach a Formbar OAuth JWT to a session. Returns the account or null if invalid. */
async function applyFormbarToken(sess, tokenString) {
  const tokenData = jwt.decode(String(tokenString || ""));
  const userId = tokenData && typeof tokenData === "object"
    ? formbarUserIdFromToken(tokenData)
    : null;
  if (!tokenData || userId == null) return null;
  const name = String(
    tokenData.displayName || tokenData.name || `Player ${userId}`,
  ).trim().slice(0, 80) || `Player ${userId}`;
  const account = await upsertAccount(userId, name);
  if (!account) return null;
  setAccountSession(sess, account);
  return account;
}

async function playerFromSession(sess, options = {}) {
  if (!sess) return null;
  const account = await resolveSessionAccount(sess);
  if (account) {
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
  if (paid && !sess.formbarId) {
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
    const account = await resolveSessionAccount(sess);
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
  const player = await playerFromSession(req.session, { createGuest: false });
  const rejoin = player ? matchmaker.isBusy(player.id) : false;
  const pack = ticketPack();
  return {
    nav: "games",
    viewer,
    rejoin,
    canTicket: Boolean(viewer && viewer.tickets > viewer.held && !rejoin),
    lobbies: matchmaker.listLobbies(),
    packSize: pack.size,
    packCost: pack.cost,
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
  const tokenData = jwt.decode(String(token));
  const userId = tokenData && typeof tokenData === "object"
    ? formbarUserIdFromToken(tokenData)
    : null;
  if (!tokenData || userId == null) {
    res.status(400).send("Invalid Formbar token.");
    return;
  }
  const rawName = String(
    tokenData.displayName || tokenData.name || `Player ${userId}`,
  );
  const nameCheck = validateDisplayName(rawName);
  const name = nameCheck.ok ? nameCheck.name : `Player ${userId}`;

  const linkId = Number(req.session.linkAccountId);
  if (Number.isInteger(linkId) && linkId > 0) {
    req.session.linkAccountId = null;
    const result = await linkFormbarToAccount(linkId, userId);
    if (!result.ok) {
      req.session.notice = result.error === "already_linked"
        ? "This account already has Formbar linked."
        : result.error === "conflict"
          ? "That Formbar account cannot be linked."
          : "Could not link Formbar account.";
      req.session.save(() => res.redirect(`/profile/${linkId}`));
      return;
    }
    await upsertAccount(userId, name);
    const linked = await getAccount(result.account.id);
    setAccountSession(req.session, linked || result.account);
    req.session.notice = "Formbar account linked.";
    req.session.save(() => res.redirect(`/profile/${(linked || result.account).id}`));
    return;
  }

  const account = await upsertAccount(userId, name);
  setAccountSession(req.session, account);
  req.session.save(() => res.redirect("/"));
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
    if (!rateLimit(`login:${clientIp(req)}:${email}`, { max: 20 })) {
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
    if (authEmailEnabled() && !account.email_verified_at) {
      renderFail("Verify your email before logging in.");
      return;
    }
    setAccountSession(req.session, account);
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
    if (needVerify) {
      try {
        await issueVerifyEmail(account);
      } catch (err) {
        console.error(err);
        renderFail("Could not send verification email. Try again later.");
        return;
      }
      req.session.notice = "Check your email to verify your account.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    setAccountSession(req.session, account);
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
    setAccountSession(req.session, fresh || account);
    req.session.notice = "Email verified. You are logged in.";
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
    if (account && account.password_hash && !account.email_verified_at && mailReady()) {
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
      if (account && account.password_hash && account.email_verified_at && mailReady()) {
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
    setAccountSession(req.session, fresh || account);
    req.session.notice = "Password updated.";
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

app.get("/games/create", async (req, res, next) => {
  try {
    const data = await gamesData(req);
    if (!data.viewer) {
      res.redirect("/login");
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
    const pack = ticketPack();
    const body = {
      account,
      viewer,
      isOwner: Boolean(account && viewer && account.id === viewer.id),
      notice: takeNotice(req),
      packSize: pack.size,
      packCost: pack.cost,
      canLinkFormbar: Boolean(
        account && viewer && account.id === viewer.id
        && !account.formbar_id
        && formbarLoginEnabled(),
      ),
      canAddLocal: Boolean(
        account && viewer && account.id === viewer.id
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

app.post("/profile/link/formbar", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!viewer) {
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

app.post("/profile/link/local", async (req, res, next) => {
  try {
    const viewer = await pageViewer(req);
    if (!viewer) {
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
        req.session.notice = "Could not link that email account.";
        req.session.save(() => res.redirect(back));
        return;
      }
      setAccountSession(req.session, merged.account);
      if (authEmailEnabled() && !merged.account.email_verified_at && mailReady()) {
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
    if (!account) {
      res.redirect("/login");
      return;
    }
    if (!account.formbar_id) {
      req.session.notice = "Link a Formbar account to buy tickets with Digipogs.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const pack = ticketPack();
    const transfer = await payPool(formbarSocket, {
      userId: account.formbar_id,
      poolId: POOL_ID,
      amount: pack.cost,
      pin: req.body && req.body.pin,
      reason: `${pack.size} game tickets`,
    });
    if (!transfer.success) {
      req.session.notice = transfer.message || "Payment failed.";
      req.session.save(() => res.redirect(back));
      return;
    }
    await addTickets(account.id, pack.size, pack.cost, account.formbar_id);
    req.session.notice = `Added ${pack.size} tickets.`;
    req.session.save(() => res.redirect(back));
  } catch (err) {
    next(err);
  }
});

app.post("/suggestions", async (req, res, next) => {
  try {
    const back = safeNext(req.body && req.body.next);
    const account = await pageViewer(req);
    if (!account) {
      res.redirect("/login");
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
    await archiveSuggestion(req.params.id);
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
    const suggestion = await getSuggestion(req.params.id);
    if (!suggestion || suggestion.archived_at || suggestion.rewarded_at) {
      req.session.notice = "Suggestion not found.";
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
    let transfer;
    try {
      transfer = await rewardFromPool(formbarSocket, {
        userId: suggestion.formbar_id,
        amount,
        reason: "MOTL Suggestion Reward",
      });
    } catch (err) {
      await reopenSuggestion(suggestion.id);
      throw err;
    }
    if (!transfer.success) {
      await reopenSuggestion(suggestion.id);
      req.session.notice = transfer.message || "Reward transfer failed.";
      req.session.save(() => res.redirect("/admin/suggestions"));
      return;
    }
    req.session.notice = `Archived and sent ${amount} digipogs to ${suggestion.name}.`;
    req.session.save(() => res.redirect("/admin/suggestions"));
  } catch (err) {
    next(err);
  }
});

async function viewerCanEditWiki(sess) {
  const account = await resolveSessionAccount(sess);
  if (!account) return false;
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
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    const ok = await confirmWikiRevision(req.params.id);
    req.session.notice = ok ? "Revision confirmed." : "Revision not found.";
    req.session.save(() => res.redirect("/admin/wiki"));
  } catch (err) {
    next(err);
  }
});

app.post("/admin/wiki/:id/undo", async (req, res, next) => {
  try {
    if (!isAdmin(req.session)) {
      res.redirect("/");
      return;
    }
    const result = await undoWikiRevision(req.params.id);
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
    const revision = await getWikiRevision(req.params.id);
    if (!revision || revision.undone_at) {
      req.session.notice = "Revision not found.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (revision.rewarded_at) {
      req.session.notice = "Already rewarded.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    if (revision.formbar_id <= 0) {
      req.session.notice = "System revisions cannot be rewarded.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    const amount = wikiRewardAmount();
    const transfer = await rewardFromPool(formbarSocket, {
      userId: revision.formbar_id,
      amount,
      reason: `MOTL Wiki Reward: ${revision.title}`,
    });
    if (!transfer.success) {
      req.session.notice = transfer.message || "Reward transfer failed.";
      req.session.save(() => res.redirect("/admin/wiki"));
      return;
    }
    await setWikiRevisionRewarded(revision.id);
    req.session.notice = `Sent ${amount} digipogs to ${revision.name}.`;
    req.session.save(() => res.redirect("/admin/wiki"));
  } catch (err) {
    next(err);
  }
});

async function startPlay(req, res, next, intent) {
  try {
    const paid = intent.mode === "listed" || intent.mode === "ranked" || intent.mode === "join";
    const account = await resolveSessionAccount(req.session);
    if (paid && !account) {
      res.redirect("/login");
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
    if (!viewer) {
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
    if (!account) {
      res.redirect("/login");
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
    if (!(await pageViewer(req))) {
      res.redirect("/login");
      return;
    }
    const slug = wikiSlug(req.params.slug);
    if (!isAdmin(req.session)) {
      req.session.notice = "Only admins can delete wiki pages.";
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
      debugRanges: process.env.DEBUG_RANGES === "1",
      tooltipsDefault: player.tooltips !== false,
      bgmVolumeDefault: Number.isFinite(player.bgmVolume) ? player.bgmVolume : 50,
    });
  } catch (err) {
    next(err);
  }
});

app.use("/api/v1", express.json({ limit: "32kb" }));

app.get("/api/v1/metrics", (req, res) => {
  if (process.env.METRICS !== "1") {
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
    const pack = ticketPack();
    res.json({
      player: playerPublic(player),
      busy,
      account: accountPublic(account),
      canTicket: Boolean(account && account.tickets > account.held && !busy),
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
    if (!account || !account.formbar_id) {
      res.status(403).json({ error: "login_required" });
      return;
    }
    const pack = ticketPack();
    const transfer = await payPool(formbarSocket, {
      userId: account.formbar_id,
      poolId: POOL_ID,
      amount: pack.cost,
      pin: req.body && req.body.pin,
      reason: `${pack.size} game tickets`,
    });
    if (!transfer.success) {
      res.status(400).json({
        error: "payment_failed",
        message: transfer.message || "Payment failed.",
      });
      return;
    }
    await addTickets(account.id, pack.size, pack.cost, account.formbar_id);
    const updated = await getAccount(account.id);
    const player = await playerFromSession(req.session, { createGuest: false });
    const busy = player ? matchmaker.isBusy(player.id) : false;
    res.json({
      ok: true,
      account: accountPublic(updated),
      canTicket: Boolean(updated && updated.tickets > updated.held && !busy),
      pack: { size: pack.size, cost: pack.cost },
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/play", requireApiSession, async (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = body.mode;
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

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  if (String(req.path || "").startsWith("/api/")) {
    res.status(500).json({ error: "server_error" });
    return;
  }
  res.status(500).send("Something went wrong");
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
  socket.on("command", (cmd) => matchmaker.command(socket, cmd));
  socket.on("botSettings", (payload) => matchmaker.botSettings(socket, payload));
  socket.on("debugPlay", (payload) => matchmaker.debugPlay(socket, payload));
  socket.on("tooltips", (on) => {
    const enabled = Boolean(on);
    if (socket.data.user) socket.data.user.tooltips = enabled;
    scheduleSettingWrite(socket, "tooltips", enabled, (value) => {
      return setPlayerTooltips(socket.data.user, value);
    });
  });
  socket.on("bgmVolume", (percent) => {
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
  await listen(PORT);
  console.log(`Men Of The Line listening on ${THIS_URL}`);
  if (process.env.DEBUG_RANGES === "1") {
    console.log("Debug ranges: forward weapon range, collision boxes, restore, fort, and keep bands");
  }
}
