import { BotController } from "./bot.js";
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
  constructor(matchmaker, io) {
    this.matchmaker = matchmaker;
    this.io = io;
    this.id = crypto.randomUUID();
    this.roomName = `game:${this.id}`;
    this.sim = new GameSim();
    this.status = "waiting";
    this.countdownEnds = null;
    this.countdownTimer = null;
    this.tickTimer = null;
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
    seat.socket = null;
    seat.bot = null;
    seat.queue = [];
  }

  remember(socket) {
    const session = socket.request.session;
    if (!session) return;
    session.gameId = this.id;
    session.save(() => {});
  }

  seatHuman(key, socket) {
    const seat = this.seat[key];
    const previous = seat.socket;
    seat.userId = socket.data.user.id;
    seat.name = socket.data.user.name;
    seat.bot = null;
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

  attach(socket) {
    const seat = this.seatForUser(socket.data.user.id);
    if (!seat) return;
    this.seatHuman(seat.key, socket);
  }

  seatBot(key) {
    const seat = this.seat[key];
    seat.userId = null;
    seat.name = "Bot";
    seat.socket = null;
    seat.queue = [];
    seat.bot = new BotController(seat.sideId);
  }

  startCountdown() {
    if (this.status !== "waiting") return;
    this.status = "countdown";
    this.countdownEnds = Date.now() + COUNTDOWN_MS;
    this.pushLobby();
    this.broadcastState();
    this.countdownTimer = setTimeout(() => this.beginPlay(), COUNTDOWN_MS);
  }

  cancelCountdown() {
    if (!this.countdownTimer) return;
    clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
  }

  beginPlay() {
    if (this.status !== "countdown") return;
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
    if (this.status === "dead" || !this.sim.winner) return;
    const seat = this.seatBySocket(socket);
    if (!seat) return;
    this.clearSeat(seat);
    socket.leave(this.roomName);
    socket.data.gameId = null;
    socket.data.seatKey = null;
    const session = socket.request.session;
    if (session) {
      session.gameId = null;
      session.save(() => {});
    }
    if (this.connectedSockets().length === 0) this.destroy();
    this.matchmaker.enqueue(socket);
  }

  disconnect(socket) {
    if (socket.data.replaced || this.status === "dead") return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.socket !== socket) return;
    seat.socket = null;
    if (this.status === "waiting" || this.status === "countdown") {
      this.abandonLobby(seat);
      return;
    }
    if (this.connectedSockets().length === 0) this.destroy();
  }

  /** Countdown or waiting: the remaining human becomes the waiter, or the room ends. */
  abandonLobby(seat) {
    this.cancelCountdown();
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    const otherSocket = other.socket;
    if (!otherSocket) {
      this.destroy();
      return;
    }
    this.status = "waiting";
    this.countdownEnds = null;
    this.sim.reset();
    if (seat.key === "a") {
      this.seat.a.userId = other.userId;
      this.seat.a.name = other.name;
      this.seat.a.socket = otherSocket;
      this.seat.a.bot = null;
      this.seat.a.queue = [];
      otherSocket.data.seatKey = "a";
      this.clearSeat(this.seat.b);
    } else {
      this.clearSeat(seat);
    }
    this.matchmaker.waiting = this;
    this.remember(this.seat.a.socket);
    this.pushLobby();
    this.broadcastState();
  }

  opponentOf(seat) {
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    if (other.bot) return { name: "Bot", kind: "bot" };
    if (other.userId) return { name: other.name, kind: "human" };
    return null;
  }

  lobbyFor(seat) {
    return {
      seat: seat.key,
      status: this.status,
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
    this.io.to(this.roomName).emit("state", this.publicState());
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
