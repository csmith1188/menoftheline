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
  archiveSuggestion,
  claimSuggestionReward,
  canEditWiki,
  confirmWikiRevision,
  createSuggestion,
  dataPath,
  ensureGuest,
  getAccount,
  getSuggestion,
  getUser,
  getWikiPageBySlug,
  getWikiRevision,
  initDb,
  listOpenWikiRevisions,
  listSuggestions,
  listWikiPages,
  listWikiSlugs,
  deleteWikiPageBySlug,
  reopenSuggestion,
  saveWikiPage,
  bgmVolumePercent,
  clampBgmVolumePercent,
  setPlayerBgmVolume,
  setPlayerTooltips,
  setWikiRevisionRewarded,
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
import { connectFormbar, payPool, rewardFromPool } from "./server/formbar.js";
import { Matchmaker } from "./server/matchmaking.js";
import { loadNews } from "./server/news.js";
import { renderWikiBody } from "./server/wiki-render.js";
import { wikiLineDiff } from "./server/wiki-diff.js";

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

const app = express();
const httpServer = createServer(app);
// Prefer WebSocket; long-polling at 20 Hz state kills mobile Safari latency.
const io = new Server(httpServer, {
  transports: ["websocket", "polling"],
  pingInterval: 20000,
  pingTimeout: 20000,
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
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use((req, res, next) => {
  res.locals.isAdmin = isAdmin(req.session);
  next();
});
app.use("/shared", express.static(path.join(root, "shared")));
app.use("/vendor/three", express.static(path.join(root, "node_modules", "three")));
app.get("/manifest.webmanifest", (req, res) => {
  res.type("application/manifest+json");
  res.sendFile(path.join(root, "public", "manifest.webmanifest"));
});
// Long-cache match music so return visits skip the multi-MB download on the game host.
app.use("/bgm", express.static(path.join(root, "public", "bgm"), {
  maxAge: "7d",
  fallthrough: false,
}));
app.use(express.static(path.join(root, "public")));

function adminId() {
  const id = Number(process.env.ADMIN_USER_ID);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isAdmin(sess) {
  const id = adminId();
  return id != null && Number(sess && sess.formbarId) === id;
}

function safeNext(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return "/";
  return text;
}

function formbarUserIdFromToken(tokenData) {
  const raw = tokenData.id ?? tokenData.userId ?? tokenData.userID ?? tokenData.sub;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function playerFromSession(sess, options = {}) {
  if (!sess) return null;
  if (sess.formbarId) {
    const account = await getAccount(sess.formbarId);
    if (!account) return null;
    return {
      id: `f:${account.formbar_id}`,
      name: account.name,
      formbarId: account.formbar_id,
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
    formbarId: null,
    mmr: null,
    tooltips: tooltipsEnabled(guest),
    bgmVolume: bgmVolumePercent(guest),
  };
}

const matchmaker = new Matchmaker(io);

function takeNotice(req) {
  const notice = req.session.notice || null;
  if (req.session.notice) req.session.notice = null;
  return notice;
}

async function pageViewer(req) {
  return req.session.formbarId ? await getAccount(req.session.formbarId) : null;
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

app.get("/login", async (req, res, next) => {
  try {
    if (req.query.token) {
      const tokenData = jwt.decode(String(req.query.token));
      const userId = tokenData && typeof tokenData === "object"
        ? formbarUserIdFromToken(tokenData)
        : null;
      if (!tokenData || userId == null) {
        res.status(400).send("Invalid Formbar token.");
        return;
      }
      const name = String(
        tokenData.displayName || tokenData.name || `Player ${userId}`,
      ).trim().slice(0, 80) || `Player ${userId}`;
      await upsertAccount(userId, name);
      req.session.formbarId = userId;
      req.session.formbarName = name;
      req.session.save(() => res.redirect("/"));
      return;
    }
    const redirectURL = encodeURIComponent(`${THIS_URL}/login`);
    res.redirect(`${AUTH_URL}/oauth?redirectURL=${redirectURL}`);
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
    const id = Number(req.params.id);
    const account = Number.isInteger(id) && id > 0 ? await getAccount(id) : null;
    const viewer = await pageViewer(req);
    const pack = ticketPack();
    const body = {
      account,
      viewer,
      isOwner: Boolean(account && viewer && account.formbar_id === viewer.formbar_id),
      notice: takeNotice(req),
      packSize: pack.size,
      packCost: pack.cost,
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

app.post("/tickets", async (req, res, next) => {
  try {
    const back = safeNext(req.body && req.body.next);
    if (!req.session.formbarId) {
      res.redirect("/login");
      return;
    }
    const pack = ticketPack();
    const account = await getAccount(req.session.formbarId);
    if (!account) {
      req.session.notice = "Log in again to buy tickets.";
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
    if (!transfer.success) {
      req.session.notice = transfer.message || "Payment failed.";
      req.session.save(() => res.redirect(back));
      return;
    }
    await addTickets(account.formbar_id, pack.size, pack.cost);
    req.session.notice = `Added ${pack.size} tickets.`;
    req.session.save(() => res.redirect(back));
  } catch (err) {
    next(err);
  }
});

app.post("/suggestions", async (req, res, next) => {
  try {
    const back = safeNext(req.body && req.body.next);
    if (!req.session.formbarId) {
      res.redirect("/login");
      return;
    }
    const account = await getAccount(req.session.formbarId);
    if (!account) {
      req.session.notice = "Log in again to send a suggestion.";
      req.session.save(() => res.redirect(back));
      return;
    }
    const body = String(req.body && req.body.body || "").trim().slice(0, 2000);
    const isBug = Boolean(req.body && (req.body.is_bug === "on" || req.body.is_bug === "1"));
    const repro = String(req.body && req.body.repro || "").trim().slice(0, 2000);
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
    await createSuggestion({
      formbarId: account.formbar_id,
      name: account.name,
      body,
      isBug,
      repro,
    });
    req.session.notice = "Thanks for the suggestion.";
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
  if (!sess || !sess.formbarId) return false;
  if (isAdmin(sess)) return true;
  return canEditWiki(sess.formbarId);
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
    if (paid && !req.session.formbarId) {
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
      const account = await getAccount(req.session.formbarId);
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
    };
    req.session.save(() => res.redirect("/play"));
  } catch (err) {
    next(err);
  }
}

function playView(req) {
  return req.body && req.body.view === "3d" ? "3d" : null;
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
  startPlay(req, res, next, { mode: "listed", view: playView(req) });
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
    if (!req.session.formbarId) {
      res.redirect("/login");
      return;
    }
    if (!(await viewerCanEditWiki(req.session))) {
      req.session.notice = "Editing requires buying tickets and finishing a ranked game.";
      req.session.save(() => res.redirect(`/rules/${wikiSlug(req.params.slug)}`));
      return;
    }
    const slug = wikiSlug(req.params.slug);
    const viewer = await getAccount(req.session.formbarId);
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
    if (!req.session.formbarId) {
      res.redirect("/login");
      return;
    }
    const slug = wikiSlug(req.params.slug);
    if (!(await viewerCanEditWiki(req.session))) {
      req.session.notice = "Editing requires buying tickets and finishing a ranked game.";
      req.session.save(() => res.redirect(`/rules/${slug}`));
      return;
    }
    const account = await getAccount(req.session.formbarId);
    if (!account) {
      req.session.notice = "Log in again to edit the wiki.";
      req.session.save(() => res.redirect("/login"));
      return;
    }
    const found = await getWikiPageBySlug(slug);
    const title = found
      ? found.page.title
      : String(req.body && req.body.title || "").trim().slice(0, WIKI_TITLE_MAX);
    const body = String(req.body && req.body.body || "").trim().slice(0, WIKI_BODY_MAX);
    const result = await saveWikiPage({
      slug,
      title,
      body,
      formbarId: account.formbar_id,
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
    if (!req.session.formbarId) {
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
      player: { id: player.id, name: player.name },
    });
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
    res.json({
      player: { id: player.id, name: player.name },
      busy: matchmaker.isBusy(player.id),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/play", requireApiSession, async (req, res, next) => {
  try {
    const mode = req.body && req.body.mode;
    if (PAID_PLAY_MODES.has(mode)) {
      res.status(403).json({ error: "login_required" });
      return;
    }
    if (!GUEST_PLAY_MODES.has(mode)) {
      res.status(400).json({ error: "bad_mode" });
      return;
    }
    const player = await playerFromSession(req.session, { createGuest: true });
    if (!player) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (matchmaker.isBusy(player.id)) {
      res.json({ ok: true, rejoin: true });
      return;
    }
    req.session.view3d = null;
    req.session.intent = { mode, roomId: null, view: null };
    await saveSession(req.session);
    res.json({ ok: true, mode });
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
    setPlayerTooltips(socket.data.user, enabled).catch((err) => console.error(err));
  });
  socket.on("bgmVolume", (percent) => {
    if (!Number.isFinite(Number(percent))) return;
    const value = clampBgmVolumePercent(percent);
    if (socket.data.user) socket.data.user.bgmVolume = value;
    setPlayerBgmVolume(socket.data.user, value).catch((err) => console.error(err));
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await listen(PORT);
  console.log(`Men Of The Line listening on ${THIS_URL}`);
  if (process.env.DEBUG_RANGES === "1") {
    console.log("Debug ranges: forward weapon range, collision boxes, restore, fort, and keep bands");
  }
}
