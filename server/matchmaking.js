import { ensureHold, holdTicket, releaseHold } from "./db.js";
import { pickRankedPair } from "./rating.js";
import { GameRoom } from "./room.js";

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function searchText(mode) {
  if (mode === "ranked") return "Searching for a ranked match";
  return "Waiting for an opponent";
}

/**
 * Bot games, free casual pairing, listed lobbies, and ranked MMR search.
 * A player is only ever in one room or queue.
 */
export class Matchmaker {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.casual = [];
    this.ranked = [];
    this.claimed = new Set();
    this.maxSpread = numberEnv("MMR_MAX_SPREAD", 200);
    this.waitMs = numberEnv("MATCH_WAIT_MS", 60000);
    this.pairing = false;
    this.timer = setInterval(() => {
      this.pairRanked().catch((err) => console.error(err));
    }, 1000);
    if (this.timer.unref) this.timer.unref();
  }

  roomForUser(userId) {
    for (const room of this.rooms.values()) {
      if (room.status === "dead") continue;
      if (room.seatForUser(userId)) return room;
    }
    return null;
  }

  findQueued(userId) {
    return this.casual.find((entry) => entry.userId === userId)
      || this.ranked.find((entry) => entry.userId === userId)
      || null;
  }

  isBusy(userId) {
    if (!userId) return false;
    return Boolean(this.roomForUser(userId) || this.findQueued(userId));
  }

  remove(room) {
    this.rooms.delete(room.id);
  }

  clearPlaySession(socket) {
    const session = socket && socket.request && socket.request.session;
    if (!session) return;
    session.gameId = null;
    session.search = null;
    session.intent = null;
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
      console.error(err);
      this.failHome(socket, "Could not start that game.");
    }).finally(() => {
      this.claimed.delete(user.id);
    });
  }

  async startIntent(socket, intent) {
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
    if (intent.mode === "casual") {
      await this.startCasual(socket);
      return;
    }
    if (intent.mode === "listed") {
      await this.startListed(socket);
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
    const room = new GameRoom(this, this.io, "bot");
    if (options.view === "3d") {
      room.view3d = true;
    }
    this.rooms.set(room.id, room);
    room.seatHuman("a", socket);
    room.seatBot("b");
    await room.startCountdown();
  }

  async startCasual(socket) {
    const user = socket.data.user;
    const entry = {
      userId: user.id,
      name: user.name,
      formbarId: user.formbarId || null,
      mmr: null,
      socket,
      joinedAt: Date.now(),
      mode: "casual",
    };
    this.casual.push(entry);
    this.markSearchSession(socket, "casual");
    this.emitSearchLobby(entry);
    await this.pairCasual();
  }

  async startListed(socket) {
    const user = socket.data.user;
    if (!user.formbarId) {
      this.failHome(socket, "Log in to create a lobby.");
      return;
    }
    const held = await holdTicket(user.formbarId);
    if (!held) {
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.formbarId);
      return;
    }
    const room = new GameRoom(this, this.io, "listed");
    this.rooms.set(room.id, room);
    room.seatHuman("a", socket);
  }

  async startRanked(socket) {
    const user = socket.data.user;
    if (!user.formbarId) {
      this.failHome(socket, "Log in to play ranked.");
      return;
    }
    const held = await holdTicket(user.formbarId);
    if (!held) {
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.formbarId);
      return;
    }
    const entry = {
      userId: user.id,
      name: user.name,
      formbarId: user.formbarId,
      mmr: user.mmr,
      socket,
      joinedAt: Date.now(),
      mode: "ranked",
    };
    this.ranked.push(entry);
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
      this.failHome(socket, "That game is no longer open.");
      return;
    }
    if (room.seat.a.userId === user.id) {
      room.attach(socket);
      return;
    }
    if (!user.formbarId) {
      this.failHome(socket, "Log in to join a game.");
      return;
    }
    const held = await holdTicket(user.formbarId);
    if (!held) {
      this.failHome(socket, "You need a free ticket.");
      return;
    }
    if (socket.data.left || !socket.connected) {
      await releaseHold(user.formbarId);
      return;
    }
    room.seatHuman("b", socket);
    const ok = await room.startCountdown();
    if (ok) return;
    await releaseHold(user.formbarId);
    room.clearSeat(room.seat.b);
    socket.data.gameId = null;
    socket.data.seatKey = null;
    socket.leave(room.roomName);
    const host = room.seat.a;
    const still = await ensureHold(host.formbarId);
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
      entry.socket.data.user.formbarId = entry.formbarId;
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
    const ok = await room.startCountdown();
    if (ok) return;
    for (const entry of [a, b]) {
      if (entry.formbarId) await releaseHold(entry.formbarId);
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
      await this.beginPaired(a, b, "casual");
    }
  }

  async pairRanked() {
    if (this.pairing) return;
    this.pairing = true;
    try {
      const now = Date.now();
      while (this.ranked.length >= 2) {
        const pair = pickRankedPair(this.ranked, now, this.maxSpread, this.waitMs);
        if (!pair) break;
        this.ranked = this.ranked.filter((entry) => entry !== pair.a && entry !== pair.b);
        await this.beginPaired(pair.a, pair.b, "ranked");
      }
    } finally {
      this.pairing = false;
    }
  }

  async removeQueued(entry) {
    this.casual = this.casual.filter((item) => item !== entry);
    this.ranked = this.ranked.filter((item) => item !== entry);
    if (entry.mode === "ranked") await releaseHold(entry.formbarId);
    if (entry.socket) this.clearPlaySession(entry.socket);
  }

  leave(socket) {
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
      this.removeQueued(queued).then(() => socket.emit("go-home")).catch((err) => {
        console.error(err);
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

  concede(socket) {
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
      this.removeQueued(queued).catch((err) => console.error(err));
    }
  }

  listLobbies() {
    const rows = [];
    for (const room of this.rooms.values()) {
      if (!this.openLobby(room.id)) continue;
      rows.push({
        id: room.id,
        host: room.seat.a.name,
        createdAt: room.createdAt,
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
    const other = seat.key === "a" ? room.seat.b : room.seat.a;
    const otherSnap = {
      userId: other.userId,
      name: other.name,
      formbarId: other.formbarId,
      mmr: other.mmr,
      socket: other.socket,
      bot: Boolean(other.bot),
    };
    const leaverSocket = seat.socket;

    if (wasCountdown && room.charged) {
      await refundTicket(room.seat.a.formbarId);
      await refundTicket(room.seat.b.formbarId);
      room.charged = false;
    } else if (room.status === "waiting" && room.paid) {
      await releaseHold(seat.formbarId);
    }

    room.cancelCountdown();
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

    if (mode === "casual" || mode === "ranked") {
      if (otherSnap.socket) {
        otherSnap.socket.leave(room.roomName);
        otherSnap.socket.data.gameId = null;
        otherSnap.socket.data.seatKey = null;
      }
      room.clearSeat(other);
      room.destroy();
      const entry = {
        userId: otherSnap.userId,
        name: otherSnap.name,
        formbarId: otherSnap.formbarId,
        mmr: otherSnap.mmr,
        socket: otherSnap.socket,
        joinedAt: Date.now(),
        mode,
      };
      if (mode === "ranked") {
        const held = await holdTicket(entry.formbarId);
        if (!held) {
          this.failHome(entry.socket, "You need a free ticket.");
          return;
        }
        this.ranked.push(entry);
        this.markSearchSession(entry.socket, mode);
        this.emitSearchLobby(entry);
        await this.pairRanked();
        return;
      }
      this.casual.push(entry);
      this.markSearchSession(entry.socket, mode);
      this.emitSearchLobby(entry);
      await this.pairCasual();
      return;
    }

    room.status = "waiting";
    room.countdownEnds = null;
    room.sim.reset();
    if (!room.seat.a.userId && room.seat.b.userId) {
      const joiner = room.seat.b;
      room.seat.a.userId = joiner.userId;
      room.seat.a.name = joiner.name;
      room.seat.a.formbarId = joiner.formbarId;
      room.seat.a.mmr = joiner.mmr;
      room.seat.a.socket = joiner.socket;
      room.seat.a.bot = null;
      room.seat.a.queue = [];
      if (joiner.socket) joiner.socket.data.seatKey = "a";
      room.clearSeat(room.seat.b);
    }
    const host = room.seat.a;
    const still = await ensureHold(host.formbarId);
    if (!still) {
      this.failHome(host.socket, "You need a free ticket.");
      room.destroy();
      return;
    }
    room.closing = false;
    if (host.socket) room.remember(host.socket);
    room.pushLobby();
    room.broadcastState();
  }
}
