import {
  clearOwner,
  ensureHold,
  holdTicket,
  ownerForUser,
  recentRankedOpponentIds,
  recordMmEvent,
  refundTicket,
  releaseHold,
  rematchCooldownMs,
} from "./db.js";
import { modeRequiresTicket, noFreePlayEnabled } from "./auth.js";
import { allowSocketEvent } from "./commandLimit.js";
import { asErr, child as childLogger, safeLog } from "./logger.js";
import { workerCount, workerIndex } from "./owners.js";
import { pickRankedPair } from "./rating.js";
import { GameRoom, TICK_MS } from "./room.js";
import { MatchTicker } from "./ticker.js";

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function safeLogRoom(room, level, obj, msg) {
  safeLog(room && room.log ? room.log : childLogger({ component: "matchmaking" }), level, obj, msg);
}

function searchText(mode) {
  if (mode === "ranked") return "Searching for a ranked match";
  if (mode === "training") return "Waiting for a training opponent";
  return "Waiting for an opponent";
}

/**
 * Bot games, free casual pairing, listed lobbies, and ranked MMR search.
 * A player is only ever in one room or queue.
 */
export class Matchmaker {
  constructor(io) {
    this.io = io;
    this.log = childLogger({ component: "matchmaking" });
    this.rooms = new Map();
    this.casual = [];
    this.training = [];
    this.ranked = [];
    this.claimed = new Set();
    /** userId → GameRoom. Ordered `rooms` stays the iteration source. */
    this.userRoom = new Map();
    /** userId → queue entry. Ordered queues stay the pairing source. */
    this.userQueue = new Map();
    this.ticker = new MatchTicker(TICK_MS);
    this.maxSpread = numberEnv("MMR_MAX_SPREAD", 200);
    this.waitMs = numberEnv("MATCH_WAIT_MS", 60000);
    this.expandPerMs = numberEnv("MMR_EXPAND_PER_MS", 0.003333);
    this.expandCap = numberEnv("MMR_EXPAND_CAP", 800);
    this.queueMaxAgeMs = numberEnv("QUEUE_MAX_AGE_MS", 10 * 60 * 1000);
    this.pairing = false;
    this.timer = setInterval(() => {
      this.expireQueues().catch((err) => {
        this.log.error({ event: "matchmaking_failed", err: asErr(err), phase: "expire" }, "expireQueues failed");
      });
      this.pairRanked().catch((err) => {
        this.log.error({ event: "matchmaking_failed", err: asErr(err), phase: "pair_ranked" }, "pairRanked failed");
      });
    }, 1000);
    if (this.timer.unref) this.timer.unref();
  }

  rememberUserRoom(userId, room) {
    if (!userId || !room) return;
    this.userQueue.delete(userId);
    this.userRoom.set(userId, room);
  }

  forgetUserRoom(userId, room) {
    if (!userId) return;
    if (!room || this.userRoom.get(userId) === room) this.userRoom.delete(userId);
  }

  rememberQueue(entry) {
    if (!entry || !entry.userId) return;
    this.userQueue.set(entry.userId, entry);
  }

  forgetQueue(entry) {
    if (!entry || !entry.userId) return;
    if (this.userQueue.get(entry.userId) === entry) this.userQueue.delete(entry.userId);
  }

  enqueue(list, entry) {
    list.push(entry);
    this.rememberQueue(entry);
  }

  roomForUser(userId) {
    const room = this.userRoom.get(userId);
    if (!room || room.status === "dead" || !room.seatForUser(userId)) {
      if (room) this.userRoom.delete(userId);
      return null;
    }
    return room;
  }

  findQueued(userId) {
    return this.userQueue.get(userId) || null;
  }

  isBusy(userId) {
    if (!userId) return false;
    return Boolean(this.roomForUser(userId) || this.findQueued(userId));
  }

  remove(room) {
    this.rooms.delete(room.id);
    if (this.ticker) this.ticker.remove(room);
    const a = room.seat && room.seat.a && room.seat.a.userId;
    const b = room.seat && room.seat.b && room.seat.b.userId;
    if (a && this.userRoom.get(a) === room) this.userRoom.delete(a);
    if (b && this.userRoom.get(b) === room) this.userRoom.delete(b);
    if (a) {
      clearOwner(a).catch((err) => {
        this.log.error({ event: "matchmaking_failed", err: asErr(err), userId: a, phase: "clear_owner" }, "clearOwner failed");
      });
    }
    if (b) {
      clearOwner(b).catch((err) => {
        this.log.error({ event: "matchmaking_failed", err: asErr(err), userId: b, phase: "clear_owner" }, "clearOwner failed");
      });
    }
  }

  clearPlaySession(socket) {
    const session = socket && socket.request && socket.request.session;
    if (!session) return;
    session.gameId = null;
    session.search = null;
    session.intent = null;
    session.view3d = null;
    session.save(() => {});
  }

  markSearchSession(socket, mode) {
    const session = socket && socket.request && socket.request.session;
    if (!session) return;
    session.gameId = null;
    session.search = mode;
    session.intent = null;
    session.save(() => {});
  }

  failHome(socket, message) {
    if (!socket) return;
    const session = socket.request && socket.request.session;
    if (session) {
      if (message) session.notice = message;
      session.intent = null;
      session.gameId = null;
      session.search = null;
      session.view3d = null;
      session.save(() => {});
    }
    socket.emit("go-home");
  }

  emitSearchLobby(entry) {
    if (!entry.socket) return;
    entry.socket.emit("lobby", {
      seat: "a",
      status: "waiting",
      mode: entry.mode,
      text: searchText(entry.mode),
      countdownEnds: null,
      countdownLeft: null,
      you: { id: entry.userId, name: entry.name },
      opponent: null,
    });
  }

  connect(socket) {
    const user = socket.data.user;
    const existing = this.roomForUser(user.id);
    if (existing) {
      existing.attach(socket);
      return;
    }
    const queued = this.findQueued(user.id);
    if (queued) {
      queued.socket = socket;
      this.markSearchSession(socket, queued.mode);
      this.emitSearchLobby(queued);
      return;
    }
    const session = socket.request.session || {};
    const intent = session.intent;
    if (!intent || !intent.mode) {
      socket.emit("go-home");
      return;
    }
    if (this.claimed.has(user.id)) {
      socket.emit("go-home");
      return;
    }
    this.claimed.add(user.id);
    session.intent = null;
    session.save(() => {});
    this.startIntent(socket, intent).catch((err) => {
      this.log.error({
        event: "mm_intent_failed",
        err: asErr(err),
        userId: user.id,
        mode: intent && intent.mode,
        socketId: socket.id,
      }, "startIntent failed");
      this.failHome(socket, "Could not start that game.");
    }).finally(() => {
      this.claimed.delete(user.id);
    });
  }

  async startIntent(socket, intent) {
    if (workerCount() > 1) {
      const assigned = await ownerForUser(socket.data.user.id);
      if (assigned != null && assigned !== workerIndex()) {
        this.log.warn({
          event: "mm_wrong_owner",
          userId: socket.data.user.id,
          assigned,
          workerIndex: workerIndex(),
        }, "match on another worker");
        this.failHome(socket, "That match is on another server.");
        return;
      }
    }
    if (this.isBusy(socket.data.user.id)) {
      const room = this.roomForUser(socket.data.user.id);
      if (room) room.attach(socket);
      else this.emitSearchLobby(this.findQueued(socket.data.user.id));
      return;
    }
    if (intent.mode === "bot") {
      await this.startBot(socket, { view: intent.view });
      return;
    }
    if (intent.mode === "trainBot") {
      await this.startTrainBot(socket);
      return;
    }
    if (intent.mode === "casual") {
      await this.startCasual(socket);
      return;
    }
    if (intent.mode === "trainCasual") {
      await this.startTrainCasual(socket);
      return;
    }
    if (intent.mode === "listed") {
      await this.startListed(socket, intent.matchOptions || null);
      return;
    }
    if (intent.mode === "ranked") {
      await this.startRanked(socket);
      return;
    }
    if (intent.mode === "join") {
      await this.startJoin(socket, intent.roomId);
      return;
    }
    this.failHome(socket, "Could not start that game.");
  }

  async startBot(socket, options = {}) {
    const user = socket.data.user;
    if (modeRequiresTicket("bot")) {
      if (!user.accountId) {
        this.failHome(socket, "Log in to play.");
        return;
      }
      const held = await holdTicket(user.accountId);
      if (!held) {
        this.log.info({
          event: "lobby_join_failed",
          reason: "ticket",
          userId: user.id,
          accountId: user.accountId,
          mode: "bot",
        }, "bot needs ticket");
        this.failHome(socket, "You need a free ticket.");
        return;
      }
      this.log.debug({
        event: "ticket_hold",
        accountId: user.accountId,
        mode: "bot",
      }, "ticket held");
      if (socket.data.left || !socket.connected) {
        await releaseHold(user.accountId);
        return;
      }
    }
    const room = new GameRoom(this, this.io, "bot");
    if (options.view === "3d") {
      room.view3d = true;
    }
    this.rooms.set(room.id, room);
    room.seatHuman("a", socket);
    room.seatBot("b");
    const ok = await room.startCountdown();
    if (ok) return;
    if (modeRequiresTicket("bot") && user.accountId) {
      await releaseHold(user.accountId);
    }
    room.destroy();
    this.failHome(socket, modeRequiresTicket("bot") ? "You need a free ticket." : "Could not start that game.");
  }

  async startTrainBot(socket) {
    const room = new GameRoom(this, this.io, "training");
    this.rooms.set(room.id, room);
    room.seatHuman("a", socket);
    room.seatBot("b");
    await room.startCountdown();
  }

  async startCasual(socket) {
    const user = socket.data.user;
    if (modeRequiresTicket("casual")) {
      if (!user.accountId) {
        this.failHome(socket, "Log in to play.");
        return;
      }
      const held = await holdTicket(user.accountId);
      if (!held) {
        this.log.info({
          event: "lobby_join_failed",
          reason: "ticket",
          userId: user.id,
          accountId: user.accountId,
          mode: "casual",
        }, "casual needs ticket");
        this.failHome(socket, "You need a free ticket.");
        return;
      }
      this.log.debug({
        event: "ticket_hold",
        accountId: user.accountId,
        mode: "casual",
      }, "ticket held");
      if (socket.data.left || !socket.connected) {
        await releaseHold(user.accountId);
        return;
      }
    }
    const entry = {
      userId: user.id,
      name: user.name,
      accountId: user.accountId || null,
      formbarId: user.formbarId || null,
      mmr: null,
      socket,
      joinedAt: Date.now(),
      mode: "casual",
    };
    this.enqueue(this.casual, entry);
    this.log.info({
      event: "queue_joined",
      mode: "casual",
      userId: user.id,
      socketId: socket.id,
    }, "joined casual queue");
    recordMmEvent({
      event: "queued",
      mode: "casual",
      accountId: entry.accountId,
    }).catch(() => {});
    this.markSearchSession(socket, "casual");
    this.emitSearchLobby(entry);
    await this.pairCasual();
  }

  async startTrainCasual(socket) {
    const user = socket.data.user;
    const entry = {
      userId: user.id,
      name: user.name,
      accountId: user.accountId || null,
      formbarId: user.formbarId || null,
      mmr: null,
      socket,
      joinedAt: Date.now(),
      mode: "training",
    };
    this.enqueue(this.training, entry);
    this.log.info({
      event: "queue_joined",
      mode: "training",
      userId: user.id,
      socketId: socket.id,
    }, "joined training queue");
    this.markSearchSession(socket, "training");
    this.emitSearchLobby(entry);
    await this.pairTraining();
  }

  async startListed(socket, matchOptions = null) {
    const user = socket.data.user;
    if (!user.accountId) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "login",
        userId: user.id,
        mode: "listed",
      }, "listed lobby requires login");
      this.failHome(socket, "Log in to create a lobby.");
      return;
    }
    const held = await holdTicket(user.accountId);
    if (!held) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "ticket",
        userId: user.id,
        accountId: user.accountId,
        mode: "listed",
      }, "listed lobby needs ticket");
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    this.log.debug({
      event: "ticket_hold",
      accountId: user.accountId,
      mode: "listed",
    }, "ticket held");
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.accountId);
      return;
    }
    const room = new GameRoom(this, this.io, "listed", {
      matchOptions: matchOptions || {},
    });
    this.rooms.set(room.id, room);
    room.seatHuman("a", socket);
  }

  async startRanked(socket) {
    const user = socket.data.user;
    if (!user.accountId) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "login",
        userId: user.id,
        mode: "ranked",
      }, "ranked requires login");
      this.failHome(socket, "Log in to play ranked.");
      return;
    }
    const held = await holdTicket(user.accountId);
    if (!held) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "ticket",
        userId: user.id,
        accountId: user.accountId,
        mode: "ranked",
      }, "ranked needs ticket");
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    this.log.debug({
      event: "ticket_hold",
      accountId: user.accountId,
      mode: "ranked",
    }, "ticket held");
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.accountId);
      return;
    }
    let recentOpponentIds = [];
    try {
      recentOpponentIds = await recentRankedOpponentIds(user.accountId, rematchCooldownMs());
    } catch (err) {
      this.log.warn({
        event: "matchmaking_failed",
        err: asErr(err),
        phase: "recent_opponents",
        accountId: user.accountId,
      }, "recent opponents lookup failed");
    }
    const entry = {
      userId: user.id,
      name: user.name,
      accountId: user.accountId,
      formbarId: user.formbarId || null,
      mmr: user.mmr,
      socket,
      joinedAt: Date.now(),
      mode: "ranked",
      recentOpponentIds: new Set(recentOpponentIds),
      officerRank: user.officerRank || "ensign",
      placementsDone: Boolean(user.placementsDone),
    };
    this.enqueue(this.ranked, entry);
    this.log.info({
      event: "queue_joined",
      mode: "ranked",
      userId: user.id,
      mmr: user.mmr,
      socketId: socket.id,
    }, "joined ranked queue");
    recordMmEvent({
      event: "queued",
      mode: "ranked",
      accountId: entry.accountId,
    }).catch(() => {});
    this.markSearchSession(socket, "ranked");
    this.emitSearchLobby(entry);
    await this.pairRanked();
  }

  openLobby(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.mode !== "listed" || room.status !== "waiting" || room.closing) return null;
    if (room.seat.b.userId || room.seat.b.bot) return null;
    if (!room.seat.a.userId) return null;
    return room;
  }

  async startJoin(socket, roomId) {
    const room = this.openLobby(roomId);
    const user = socket.data.user;
    if (!room) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "lobby_closed",
        userId: user.id,
        roomId,
      }, "lobby no longer open");
      this.failHome(socket, "That game is no longer open.");
      return;
    }
    if (room.seat.a.userId === user.id) {
      room.attach(socket);
      return;
    }
    if (!user.accountId) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "login",
        userId: user.id,
        matchId: room.id,
      }, "join requires login");
      this.failHome(socket, "Log in to join a game.");
      return;
    }
    const held = await holdTicket(user.accountId);
    if (!held) {
      this.log.info({
        event: "lobby_join_failed",
        reason: "ticket",
        userId: user.id,
        accountId: user.accountId,
        matchId: room.id,
      }, "join needs ticket");
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.accountId);
      return;
    }
    room.seatHuman("b", socket);
    const ok = await room.startCountdown();
    if (ok) return;
    await releaseHold(user.accountId);
    room.clearSeat(room.seat.b);
    socket.data.gameId = null;
    socket.data.seatKey = null;
    socket.leave(room.roomName);
    const host = room.seat.a;
    const still = await ensureHold(host.accountId);
    if (!still) {
      if (host.socket) this.failHome(host.socket, "You need a free ticket.");
      room.destroy();
    } else {
      room.pushLobby();
      room.broadcastState();
    }
    this.failHome(socket, "Could not start that game.");
  }

  place(room, key, entry) {
    if (entry.socket && entry.socket.connected) {
      entry.socket.data.user.mmr = entry.mmr;
      entry.socket.data.user.accountId = entry.accountId;
      entry.socket.data.user.formbarId = entry.formbarId;
      entry.socket.data.user.officerRank = entry.officerRank || "ensign";
      entry.socket.data.user.placementsDone = Boolean(entry.placementsDone);
      room.seatHuman(key, entry.socket);
      return;
    }
    room.seatReserved(key, entry);
  }

  async beginPaired(a, b, mode) {
    const room = new GameRoom(this, this.io, mode);
    this.rooms.set(room.id, room);
    this.place(room, "a", a);
    this.place(room, "b", b);
    this.log.info({
      event: "mm_paired",
      matchId: room.id,
      mode,
      userIdA: a.userId,
      userIdB: b.userId,
    }, "players paired");
    const now = Date.now();
    recordMmEvent({
      event: "paired",
      mode,
      matchId: room.id,
      accountId: a.accountId || null,
      waitMs: a.joinedAt ? now - a.joinedAt : null,
    }).catch(() => {});
    recordMmEvent({
      event: "paired",
      mode,
      matchId: room.id,
      accountId: b.accountId || null,
      waitMs: b.joinedAt ? now - b.joinedAt : null,
    }).catch(() => {});
    const ok = await room.startCountdown();
    if (ok) return;
    this.log.warn({
      event: "mm_pair_failed",
      matchId: room.id,
      mode,
      userIdA: a.userId,
      userIdB: b.userId,
    }, "paired match failed to start");
    for (const entry of [a, b]) {
      if (entry.accountId) await releaseHold(entry.accountId);
      if (entry.socket) this.failHome(entry.socket, "Could not start that match.");
    }
    room.destroy();
  }

  async pairCasual() {
    while (this.casual.length >= 2) {
      const a = this.casual[0];
      const b = this.casual[1];
      if (a.userId === b.userId) return;
      this.casual.splice(0, 2);
      this.forgetQueue(a);
      this.forgetQueue(b);
      await this.beginPaired(a, b, "casual");
    }
  }

  async pairTraining() {
    while (this.training.length >= 2) {
      const a = this.training[0];
      const b = this.training[1];
      if (a.userId === b.userId) return;
      this.training.splice(0, 2);
      this.forgetQueue(a);
      this.forgetQueue(b);
      await this.beginPaired(a, b, "training");
    }
  }

  async pairRanked() {
    if (this.pairing) return;
    this.pairing = true;
    try {
      const now = Date.now();
      while (this.ranked.length >= 2) {
        const pair = pickRankedPair(this.ranked, now, {
          maxSpread: this.maxSpread,
          waitMs: this.waitMs,
          expandPerMs: this.expandPerMs,
          expandCap: this.expandCap,
        });
        if (!pair) break;
        this.ranked = this.ranked.filter((entry) => entry !== pair.a && entry !== pair.b);
        this.forgetQueue(pair.a);
        this.forgetQueue(pair.b);
        await this.beginPaired(pair.a, pair.b, "ranked");
      }
    } finally {
      this.pairing = false;
    }
  }

  /** Drop searches and empty listed lobbies that have waited past QUEUE_MAX_AGE_MS. */
  async expireQueues(now = Date.now()) {
    const maxAge = this.queueMaxAgeMs;
    const lists = [this.casual, this.training, this.ranked];
    for (let i = 0; i < lists.length; i += 1) {
      const stale = lists[i].filter((entry) => now - entry.joinedAt >= maxAge);
      for (let s = 0; s < stale.length; s += 1) {
        const entry = stale[s];
        this.log.info({
          event: "queue_expired",
          mode: entry.mode,
          userId: entry.userId,
          ageMs: now - entry.joinedAt,
        }, "queue search timed out");
        recordMmEvent({
          event: "expired",
          mode: entry.mode,
          accountId: entry.accountId || null,
          waitMs: now - entry.joinedAt,
        }).catch(() => {});
        await this.removeQueued(entry);
        if (entry.socket) this.failHome(entry.socket, "Search timed out.");
      }
    }
    const rooms = [...this.rooms.values()];
    for (let i = 0; i < rooms.length; i += 1) {
      const room = rooms[i];
      if (room.mode !== "listed" || room.status !== "waiting" || room.closing) continue;
      if (now - room.createdAt < maxAge) continue;
      safeLogRoom(room, "info", {
        event: "match_lobby_expired",
        ageMs: now - room.createdAt,
      }, "listed lobby expired");
      await this.abandonSeat(room, room.seat.a, { goHome: true });
    }
  }

  async removeQueued(entry) {
    this.casual = this.casual.filter((item) => item !== entry);
    this.training = this.training.filter((item) => item !== entry);
    this.ranked = this.ranked.filter((item) => item !== entry);
    this.forgetQueue(entry);
    if (entry.mode === "ranked" || (entry.mode === "casual" && noFreePlayEnabled())) {
      await releaseHold(entry.accountId);
    }
    if (entry.socket) this.clearPlaySession(entry.socket);
  }

  leave(socket) {
    if (!allowSocketEvent(socket, "leave")) {
      this.log.warn({
        event: "invalid_action",
        reason: "rate_limited",
        action: "leave",
        socketId: socket.id,
        userId: socket.data && socket.data.user && socket.data.user.id,
      }, "leave rate limited");
      return;
    }
    socket.data.left = true;
    const user = socket.data.user;
    const room = (socket.data.gameId && this.rooms.get(socket.data.gameId))
      || (user && this.roomForUser(user.id));
    if (room) {
      room.leave(socket);
      return;
    }
    const queued = user && this.findQueued(user.id);
    if (queued && (!queued.socket || queued.socket === socket)) {
      this.log.info({
        event: "queue_left",
        mode: queued.mode,
        userId: user.id,
      }, "left queue");
      this.removeQueued(queued).then(() => socket.emit("go-home")).catch((err) => {
        this.log.error({
          event: "matchmaking_failed",
          err: asErr(err),
          userId: user.id,
          mode: queued.mode,
          phase: "leave_queue",
        }, "removeQueued failed on leave");
        socket.emit("go-home");
      });
      return;
    }
    socket.emit("go-home");
  }

  command(socket, cmd) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.command(socket, cmd);
  }

  chat(socket, payload) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.chat(socket, payload);
  }

  async report(socket, payload) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) await room.report(socket, payload);
    else if (socket) socket.emit("reportResult", { ok: false, error: "unavailable" });
  }

  pause(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.pause(socket);
  }

  pauseSeen(socket) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.pauseSeen(socket);
  }

  /** Push a maintenance notice + red chat alert into every live room. */
  announceMaintenance(message) {
    const line = String(message || "").trim();
    if (!line) return 0;
    let n = 0;
    for (const room of this.rooms.values()) {
      if (!room || room.status === "dead" || room.closing) continue;
      room.announceMaintenance(line);
      n += 1;
    }
    return n;
  }

  settingsOpen(socket, open) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.settingsOpen(socket, open);
  }

  botSettings(socket, payload) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.botSettings(socket, payload);
  }

  debugPlay(socket, payload) {
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.debugPlay(socket, payload);
  }

  concede(socket) {
    if (!allowSocketEvent(socket, "concede")) {
      this.log.warn({
        event: "invalid_action",
        reason: "rate_limited",
        action: "concede",
        socketId: socket.id,
        userId: socket.data && socket.data.user && socket.data.user.id,
      }, "concede rate limited");
      return;
    }
    const room = this.rooms.get(socket.data.gameId);
    if (room) room.concede(socket);
  }

  disconnect(socket) {
    if (socket.data.replaced) return;
    const room = socket.data.gameId && this.rooms.get(socket.data.gameId);
    if (room) {
      room.disconnect(socket);
      return;
    }
    const user = socket.data.user;
    const queued = user && this.findQueued(user.id);
    if (queued && queued.socket === socket) {
      this.log.info({
        event: "queue_disconnect",
        mode: queued.mode,
        userId: user.id,
        socketId: socket.id,
      }, "disconnected while queued");
      this.removeQueued(queued).catch((err) => {
        this.log.error({
          event: "matchmaking_failed",
          err: asErr(err),
          userId: user.id,
          mode: queued.mode,
          phase: "disconnect_queue",
        }, "removeQueued failed on disconnect");
      });
    }
  }

  /** Players sitting in matchmaking, not custom lobbies. */
  waitingCounts() {
    return {
      unranked: this.casual.length,
      ranked: this.ranked.length,
    };
  }

  listLobbies() {
    const rows = [];
    for (const room of this.rooms.values()) {
      if (!this.openLobby(room.id)) continue;
      rows.push({
        id: room.id,
        host: room.seat.a.name,
        createdAt: room.createdAt,
        match: room.matchOptionsPublic(),
      });
    }
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows;
  }

  listActive() {
    const rows = [];
    for (const room of this.rooms.values()) {
      if (room.status === "dead") continue;
      const names = [room.seat.a.name, room.seat.b.name].filter(Boolean);
      rows.push({
        id: room.id,
        mode: room.mode,
        status: room.status,
        players: names.join(" vs ") || "Waiting",
      });
    }
    for (let i = 0; i < this.casual.length; i += 1) {
      const entry = this.casual[i];
      rows.push({
        id: entry.userId,
        mode: "casual",
        status: "searching",
        players: entry.name,
      });
    }
    for (let i = 0; i < this.training.length; i += 1) {
      const entry = this.training[i];
      rows.push({
        id: entry.userId,
        mode: "training",
        status: "searching",
        players: entry.name,
      });
    }
    for (let i = 0; i < this.ranked.length; i += 1) {
      const entry = this.ranked[i];
      rows.push({
        id: entry.userId,
        mode: "ranked",
        status: "searching",
        players: `${entry.name} (${entry.mmr})`,
      });
    }
    return rows;
  }

  /**
   * Someone left before the match was underway.
   * Ranked and casual partners go back to their queue. A listed lobby
   * keeps the remaining player as host.
   */
  async abandonSeat(room, seat, { goHome }) {
    if (!room || room.status === "dead" || room.closing) return;
    room.closing = true;
    const wasCountdown = room.status === "countdown";
    const mode = room.mode;
    safeLogRoom(room, "info", {
      event: "match_abandoned",
      seat: seat.key,
      userId: seat.userId,
      wasCountdown,
      goHome: Boolean(goHome),
    }, "seat abandoned before play");
    recordMmEvent({
      event: "abandoned",
      mode,
      matchId: room.id,
      accountId: seat.accountId || null,
      meta: { wasCountdown, goHome: Boolean(goHome) },
    }).catch(() => {});
    const other = seat.key === "a" ? room.seat.b : room.seat.a;
    const otherSnap = {
      userId: other.userId,
      name: other.name,
      accountId: other.accountId,
      formbarId: other.formbarId,
      mmr: other.mmr,
      officerRank: other.officerRank,
      placementsDone: other.placementsDone,
      socket: other.socket,
      bot: Boolean(other.bot),
    };
    const leaverSocket = seat.socket;

    if (wasCountdown && room.charged) {
      await refundTicket(room.seat.a.accountId);
      await refundTicket(room.seat.b.accountId);
      safeLogRoom(room, "info", {
        event: "ticket_refunded",
        accountIdA: room.seat.a.accountId,
        accountIdB: room.seat.b.accountId,
        reason: "abandon_countdown",
      }, "tickets refunded after abandon");
      room.charged = false;
    } else if (room.status === "waiting" && room.paid) {
      await releaseHold(seat.accountId);
    }

    room.cancelCountdown();
    const leaverName = seat.name || "Player";
    if (otherSnap.socket) {
      room.systemChat(`${leaverName} left`);
    }
    room.clearSeat(seat);
    if (leaverSocket) {
      leaverSocket.leave(room.roomName);
      leaverSocket.data.gameId = null;
      leaverSocket.data.seatKey = null;
      this.clearPlaySession(leaverSocket);
      if (goHome) leaverSocket.emit("go-home");
    }

    const otherHuman = otherSnap.userId && !otherSnap.bot;
    if (!otherHuman) {
      room.destroy();
      return;
    }

    if (mode === "casual" || mode === "ranked" || mode === "training") {
      if (otherSnap.socket) {
        otherSnap.socket.leave(room.roomName);
        otherSnap.socket.data.gameId = null;
        otherSnap.socket.data.seatKey = null;
      }
      room.clearSeat(other);
      room.destroy();
      let recentOpponentIds = [];
      if (mode === "ranked" && otherSnap.accountId) {
        try {
          recentOpponentIds = await recentRankedOpponentIds(otherSnap.accountId, rematchCooldownMs());
        } catch {
          recentOpponentIds = [];
        }
      }
      const entry = {
        userId: otherSnap.userId,
        name: otherSnap.name,
        accountId: otherSnap.accountId,
        formbarId: otherSnap.formbarId,
        mmr: otherSnap.mmr,
        socket: otherSnap.socket,
        joinedAt: Date.now(),
        mode,
        recentOpponentIds: new Set(recentOpponentIds),
        officerRank: otherSnap.officerRank || "ensign",
        placementsDone: Boolean(otherSnap.placementsDone),
      };
      this.log.info({
        event: "queue_joined",
        mode,
        userId: entry.userId,
        reason: "partner_requeued",
      }, "partner requeued after abandon");
      if (mode === "ranked") {
        const held = await holdTicket(entry.accountId);
        if (!held) {
          this.failHome(entry.socket, "You need a free ticket.");
          return;
        }
        this.enqueue(this.ranked, entry);
        this.markSearchSession(entry.socket, mode);
        this.emitSearchLobby(entry);
        await this.pairRanked();
        return;
      }
      if (mode === "training") {
        this.enqueue(this.training, entry);
        this.markSearchSession(entry.socket, mode);
        this.emitSearchLobby(entry);
        await this.pairTraining();
        return;
      }
      if (modeRequiresTicket("casual")) {
        const held = await holdTicket(entry.accountId);
        if (!held) {
          this.failHome(entry.socket, "You need a free ticket.");
          return;
        }
      }
      this.enqueue(this.casual, entry);
      this.markSearchSession(entry.socket, mode);
      this.emitSearchLobby(entry);
      await this.pairCasual();
      return;
    }

    room.status = "waiting";
    room.countdownEnds = null;
    room.sim.reset();
    // Keep custom lobby knobs after a listed abandon (reset clears sim defaults).
    if (room.matchOptions) {
      room.applyMatchOptions(room.matchOptions);
    }
    if (!room.seat.a.userId && room.seat.b.userId) {
      const joiner = room.seat.b;
      room.seat.a.userId = joiner.userId;
      room.seat.a.name = joiner.name;
      room.seat.a.accountId = joiner.accountId;
      room.seat.a.formbarId = joiner.formbarId;
      room.seat.a.mmr = joiner.mmr;
      room.seat.a.socket = joiner.socket;
      room.seat.a.bot = null;
      room.seat.a.queue = [];
      if (joiner.socket) joiner.socket.data.seatKey = "a";
      room.clearSeat(room.seat.b);
    }
    const host = room.seat.a;
    const still = await ensureHold(host.accountId);
    if (!still) {
      this.failHome(host.socket, "You need a free ticket.");
      room.destroy();
      return;
    }
    room.closing = false;
    if (host.socket) room.remember(host.socket);
    safeLogRoom(room, "info", {
      event: "match_lobby_reset",
      hostUserId: host.userId,
    }, "listed lobby reset after abandon");
    room.pushLobby();
    room.broadcastState();
  }
}
