import { BotController } from "./bot.js";
import {
  chargeHeld,
  eloK,
  insertGame,
  refundTicket,
  setRankedResult,
} from "./db.js";
import { nextMmr } from "./rating.js";
import { GameSim } from "./sim.js";

export const TICK_MS = 50;
export const STEP_DT = 0.05;
export const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 5000;

function emptySeat(key, sideId) {
  return {
    key,
    sideId,
    userId: null,
    name: null,
    formbarId: null,
    mmr: null,
    socket: null,
    bot: null,
    queue: [],
  };
}

/**
 * One match in this process, bound to a Socket.IO room.
 * Humans, bots, and later agents all sit in a seat and feed the same sim.
 */
export class GameRoom {
  constructor(matchmaker, io, mode) {
    this.matchmaker = matchmaker;
    this.io = io;
    this.mode = mode;
    this.paid = mode === "ranked" || mode === "listed";
    this.id = crypto.randomUUID();
    this.roomName = `game:${this.id}`;
    this.sim = new GameSim();
    this.status = "waiting";
    this.countdownEnds = null;
    this.countdownTimer = null;
    this.tickTimer = null;
    this.createdAt = Date.now();
    this.charged = false;
    this.recorded = false;
    this.closing = false;
    this.view3d = false;
    this.seat = {
      a: emptySeat("a", "player"),
      b: emptySeat("b", "enemy"),
    };
  }

  seatBySocket(socket) {
    if (this.seat.a.socket === socket) return this.seat.a;
    if (this.seat.b.socket === socket) return this.seat.b;
    return null;
  }

  seatForUser(userId) {
    if (this.seat.a.userId === userId) return this.seat.a;
    if (this.seat.b.userId === userId) return this.seat.b;
    return null;
  }

  connectedSockets() {
    return [this.seat.a, this.seat.b].filter((seat) => seat.socket);
  }

  clearSeat(seat) {
    seat.userId = null;
    seat.name = null;
    seat.formbarId = null;
    seat.mmr = null;
    seat.socket = null;
    seat.bot = null;
    seat.queue = [];
  }

  remember(socket) {
    const session = socket.request.session;
    if (!session) return;
    session.gameId = this.id;
    session.search = null;
    session.intent = null;
    session.save(() => {});
  }

  copyPlayer(seat, player) {
    seat.userId = player.id;
    seat.name = player.name;
    seat.formbarId = player.formbarId || null;
    seat.mmr = Number.isFinite(player.mmr) ? player.mmr : null;
    seat.bot = null;
  }

  seatHuman(key, socket) {
    const seat = this.seat[key];
    const previous = seat.socket;
    this.copyPlayer(seat, socket.data.user);
    seat.socket = socket;
    socket.data.gameId = this.id;
    socket.data.seatKey = key;
    socket.join(this.roomName);
    this.remember(socket);
    if (previous && previous !== socket) {
      previous.data.replaced = true;
      previous.emit("replaced");
      previous.disconnect(true);
    }
    this.pushLobby();
    this.broadcastState();
  }

  seatReserved(key, player) {
    const seat = this.seat[key];
    this.copyPlayer(seat, {
      id: player.userId || player.id,
      name: player.name,
      formbarId: player.formbarId,
      mmr: player.mmr,
    });
    seat.socket = null;
    seat.queue = [];
  }

  attach(socket) {
    const seat = this.seatForUser(socket.data.user.id);
    if (!seat) return;
    this.seatHuman(seat.key, socket);
  }

  seatBot(key) {
    const seat = this.seat[key];
    seat.userId = null;
    seat.name = "Bot";
    seat.formbarId = null;
    seat.mmr = null;
    seat.socket = null;
    seat.queue = [];
    seat.bot = new BotController(seat.sideId);
  }

  async startCountdown() {
    if (this.status !== "waiting" || this.closing) return false;
    if (this.paid && !this.charged) {
      const ids = [this.seat.a.formbarId, this.seat.b.formbarId]
        .filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length < 2) return false;
      const done = [];
      for (let i = 0; i < ids.length; i += 1) {
        const ok = await chargeHeld(ids[i]);
        if (!ok) {
          for (let r = 0; r < done.length; r += 1) {
            await refundTicket(done[r]);
          }
          return false;
        }
        done.push(ids[i]);
      }
      this.charged = true;
    }
    if (this.status !== "waiting" || this.closing) {
      if (this.charged) {
        await refundTicket(this.seat.a.formbarId);
        await refundTicket(this.seat.b.formbarId);
        this.charged = false;
      }
      return false;
    }
    this.status = "countdown";
    this.countdownEnds = Date.now() + COUNTDOWN_MS;
    this.pushLobby();
    this.broadcastState();
    this.countdownTimer = setTimeout(() => this.beginPlay(), COUNTDOWN_MS);
    return true;
  }

  cancelCountdown() {
    if (!this.countdownTimer) return;
    clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
  }

  beginPlay() {
    if (this.status !== "countdown" || this.closing) return;
    this.countdownTimer = null;
    this.status = "playing";
    this.countdownEnds = null;
    this.pushLobby();
    this.broadcastState();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    if (this.status !== "playing") return;
    if (this.sim.beginStep(STEP_DT)) {
      this.applyQueued();
      if (this.seat.a.bot) this.seat.a.bot.act(this.sim);
      if (this.seat.b.bot) this.seat.b.bot.act(this.sim);
      this.sim.finishStep(STEP_DT);
    }
    this.sim.updateSplats(STEP_DT);
    this.broadcastState();
  }

  applyQueued() {
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (seat.bot) continue;
      const batch = seat.queue;
      seat.queue = [];
      for (let c = 0; c < batch.length; c += 1) {
        this.sim.applyCommand(seat.sideId, batch[c]);
      }
    }
  }

  command(socket, cmd) {
    if (this.status !== "playing" || this.sim.winner) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return;
    if (seat.queue.length >= 30) return;
    seat.queue.push(cmd);
  }

  concede(socket) {
    if (this.status !== "playing" || this.sim.winner) return;
    const seat = this.seatBySocket(socket);
    if (!seat || !seat.userId) return;
    this.sim.winner = seat.sideId === "player" ? "enemy" : "player";
    this.sim.winReason = "concede";
    this.sim.sounds = [];
    seat.queue = [];
    this.broadcastState();
  }

  leave(socket) {
    if (this.status === "dead" || this.closing) return;
    const seat = this.seatBySocket(socket);
    if (!seat) return;
    if (this.status === "playing" && !this.sim.winner) return;
    if (this.sim.winner) {
      this.sendHome(socket);
      return;
    }
    this.matchmaker.abandonSeat(this, seat, { goHome: true }).catch((err) => {
      console.error(err);
    });
  }

  disconnect(socket) {
    if (socket.data.replaced || this.status === "dead" || this.closing) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.socket !== socket) return;
    if (this.status === "waiting" || this.status === "countdown") {
      this.matchmaker.abandonSeat(this, seat, { goHome: false }).catch((err) => {
        console.error(err);
      });
      return;
    }
    seat.socket = null;
    if (this.connectedSockets().length === 0) this.destroy();
  }

  sendHome(socket) {
    const seat = this.seatBySocket(socket);
    if (seat) this.clearSeat(seat);
    socket.leave(this.roomName);
    socket.data.gameId = null;
    socket.data.seatKey = null;
    this.matchmaker.clearPlaySession(socket);
    if (this.status !== "dead" && this.connectedSockets().length === 0) this.destroy();
    socket.emit("go-home");
  }

  opponentOf(seat) {
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    if (other.bot) return { name: "Bot", kind: "bot" };
    if (other.userId) return { name: other.name, kind: "human" };
    return null;
  }

  waitingText() {
    if (this.mode === "ranked") return "Searching for a ranked match";
    return "Waiting for an opponent";
  }

  lobbyFor(seat) {
    return {
      seat: seat.key,
      status: this.status,
      mode: this.mode,
      text: this.status === "waiting" ? this.waitingText() : "",
      countdownEnds: this.countdownEnds,
      you: seat.userId ? { id: seat.userId, name: seat.name } : null,
      opponent: this.opponentOf(seat),
    };
  }

  pushLobby() {
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (seat.socket) seat.socket.emit("lobby", this.lobbyFor(seat));
    }
  }

  publicState() {
    const snap = this.sim.snapshot();
    snap.status = this.status;
    snap.countdownEnds = this.countdownEnds;
    return snap;
  }

  broadcastState() {
    this.noteOutcome();
    this.io.to(this.roomName).emit("state", this.publicState());
  }

  noteOutcome() {
    if (this.recorded || !this.sim.winner || this.status !== "playing") return;
    this.recorded = true;
    const winner = this.sim.winner;
    const a = this.seat.a;
    const b = this.seat.b;
    let mmrAAfter = null;
    let mmrBAfter = null;
    const tasks = [];
    if (
      this.mode === "ranked"
      && a.formbarId
      && b.formbarId
      && Number.isFinite(a.mmr)
      && Number.isFinite(b.mmr)
    ) {
      const aScore = winner === "player" ? 1 : 0;
      const bScore = winner === "enemy" ? 1 : 0;
      const k = eloK();
      mmrAAfter = nextMmr(a.mmr, b.mmr, aScore, k);
      mmrBAfter = nextMmr(b.mmr, a.mmr, bScore, k);
      tasks.push(setRankedResult(a.formbarId, mmrAAfter, aScore === 1));
      tasks.push(setRankedResult(b.formbarId, mmrBAfter, bScore === 1));
    }
    tasks.push(insertGame({
      id: this.id,
      mode: this.mode,
      playerA: a.userId,
      playerB: b.userId,
      nameA: a.name,
      nameB: b.name,
      formbarA: a.formbarId,
      formbarB: b.formbarId,
      winnerSide: winner,
      mmrABefore: Number.isFinite(a.mmr) ? a.mmr : null,
      mmrBBefore: Number.isFinite(b.mmr) ? b.mmr : null,
      mmrAAfter,
      mmrBAfter,
      createdAt: this.createdAt,
      endedAt: Date.now(),
    }));
    Promise.all(tasks).catch((err) => console.error(err));
  }

  destroy() {
    if (this.status === "dead") return;
    this.status = "dead";
    this.cancelCountdown();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const sockets = this.connectedSockets();
    for (let i = 0; i < sockets.length; i += 1) {
      sockets[i].socket.leave(this.roomName);
    }
    this.matchmaker.remove(this);
  }
}
