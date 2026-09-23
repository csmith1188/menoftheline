import "./server/load-env.js";
import path from "path";
import { createServer } from "http";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import { Server } from "socket.io";
import { dataPath, ensureUser, initDb } from "./server/db.js";
import { Matchmaker } from "./server/matchmaking.js";

const require = createRequire(import.meta.url);
const connectSqlite3 = require("connect-sqlite3");
const SQLiteStore = connectSqlite3(session);

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

await initDb();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

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
app.use(sessionMiddleware);
app.use("/shared", express.static(path.join(root, "shared")));
app.use(express.static(path.join(root, "public")));

app.get("/", async (req, res, next) => {
  try {
    await ensureUser(req.session);
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

const matchmaker = new Matchmaker(io);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  const sess = socket.request.session;
  if (!sess) {
    next(new Error("no session"));
    return;
  }
  ensureUser(sess).then((user) => {
    socket.data.user = user;
    sess.save((err) => next(err));
  }).catch(next);
});

io.on("connection", (socket) => {
  matchmaker.connect(socket);
  socket.on("command", (cmd) => matchmaker.command(socket, cmd));
  socket.on("play-bot", () => matchmaker.playBot(socket));
  socket.on("concede", () => matchmaker.concede(socket));
  socket.on("leave", () => matchmaker.leave(socket));
  socket.on("disconnect", () => matchmaker.disconnect(socket));
});

httpServer.listen(PORT, () => {
  console.log(`Men Of The Line listening on http://localhost:${PORT}`);
});
