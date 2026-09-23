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
  dataPath,
  ensureGuest,
  getAccount,
  getUser,
  initDb,
  systemStats,
  ticketPack,
  topAccounts,
  upsertAccount,
} from "./server/db.js";
import { connectFormbar, payPool } from "./server/formbar.js";
import { Matchmaker } from "./server/matchmaking.js";
import { loadNews } from "./server/news.js";

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
const io = new Server(httpServer);
const formbarSocket = connectFormbar(AUTH_URL, process.env.API_KEY || "");

const sessionMiddleware = session({
  store: new SQLiteStore({
    db: "Men Of The Line.sqlite",
    dir: dataPath,
    concurrentDb: true,
  }),
  secret: process.env.SESSION_SECRET || "lane-pusher-local",
  resave: false,
  saveUninitialized: false,
  name: "lane.sid",
  cookie: { httpOnly: true, sameSite: "lax" },
});

app.set("view engine", "ejs");
app.set("views", path.join(root, "views"));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use("/shared", express.static(path.join(root, "shared")));
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
  };
}

const matchmaker = new Matchmaker(io);

async function landingData(req) {
  const viewer = req.session.formbarId ? await getAccount(req.session.formbarId) : null;
  const player = await playerFromSession(req.session, { createGuest: false });
  const rejoin = player ? matchmaker.isBusy(player.id) : false;
  const pack = ticketPack();
  let admin = null;
  if (isAdmin(req.session)) {
    const stats = await systemStats();
    const games = matchmaker.listActive();
    admin = { games, stats: { ...stats, active: games.length } };
  }
  return {
    viewer,
    rejoin,
    canTicket: Boolean(viewer && viewer.tickets > viewer.held && !rejoin),
    lobbies: matchmaker.listLobbies(),
    leaders: await topAccounts(10),
    news: loadNews(),
    admin,
    packSize: pack.size,
    packCost: pack.cost,
    notice: null,
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
    const notice = req.session.notice || null;
    if (req.session.notice) req.session.notice = null;
    const data = await landingData(req);
    data.notice = notice;
    req.session.save(() => res.render("landing", data));
  } catch (err) {
    next(err);
  }
});

app.get("/profile/:id", async (req, res, next) => {
  try {
    const notice = req.session.notice || null;
    if (req.session.notice) req.session.notice = null;
    const id = Number(req.params.id);
    const account = Number.isInteger(id) && id > 0 ? await getAccount(id) : null;
    const viewer = req.session.formbarId ? await getAccount(req.session.formbarId) : null;
    const pack = ticketPack();
    const body = {
      account,
      viewer,
      isOwner: Boolean(account && viewer && account.formbar_id === viewer.formbar_id),
      notice,
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

async function startPlay(req, res, next, intent) {
  try {
    const paid = intent.mode === "listed" || intent.mode === "ranked" || intent.mode === "join";
    if (paid && !req.session.formbarId) {
      res.redirect("/login");
      return;
    }
    const player = await playerFromSession(req.session, { createGuest: !paid });
    if (!player) {
      res.redirect("/");
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
        req.session.save(() => res.redirect("/"));
        return;
      }
    }
    if (intent.mode === "join") {
      const room = matchmaker.openLobby(intent.roomId);
      if (!room) {
        req.session.notice = "That game is no longer open.";
        req.session.save(() => res.redirect("/"));
        return;
      }
      if (room.seat.a.userId === player.id) {
        req.session.save(() => res.redirect("/play"));
        return;
      }
    }
    req.session.intent = { mode: intent.mode, roomId: intent.roomId || null };
    req.session.save(() => res.redirect("/play"));
  } catch (err) {
    next(err);
  }
}

app.post("/play/bot", (req, res, next) => startPlay(req, res, next, { mode: "bot" }));
app.post("/play/casual", (req, res, next) => startPlay(req, res, next, { mode: "casual" }));
app.post("/play/lobby", (req, res, next) => startPlay(req, res, next, { mode: "listed" }));
app.post("/play/ranked", (req, res, next) => startPlay(req, res, next, { mode: "ranked" }));
app.post("/play/join/:id", (req, res, next) => {
  startPlay(req, res, next, { mode: "join", roomId: req.params.id });
});

app.get("/play", async (req, res, next) => {
  try {
    const player = await playerFromSession(req.session, { createGuest: false });
    const busy = player && matchmaker.isBusy(player.id);
    if (!player || (!req.session.intent && !busy)) {
      res.redirect("/");
      return;
    }
    res.render("index");
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
  res.status(500).send("Something went wrong");
});

io.use((socket, next) => {
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
  socket.on("concede", () => matchmaker.concede(socket));
  socket.on("leave", () => matchmaker.leave(socket));
  socket.on("disconnect", () => matchmaker.disconnect(socket));
});

httpServer.listen(PORT, () => {
  console.log(`Men Of The Line listening on ${THIS_URL}`);
});
