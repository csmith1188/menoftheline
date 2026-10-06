import { CONFIG } from "../shared/config.js";
import {
  MATCH_SPEEDS,
  matchOptionsSummary,
  normalizeMatchOptions,
} from "../shared/matchOptions.js";
import { BotController, DIFFICULTIES, STRATEGY_MODES } from "./bot.js";
import {
  chargeHeld,
  eloK,
  insertGame,
  refundTicket,
  setRankedResult,
} from "./db.js";
import { nextMmr } from "./rating.js";
import { GameSim } from "./sim.js";
import { applyTrainingRules } from "./training.js";
import { TrainingBotController } from "./trainingBot.js";

export const TICK_MS = 50;
export const STEP_DT = 0.05;
/** Match-start countdown for human vs human games. */
export const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 10000;
/** Match-start countdown for bot games. */
export const BOT_COUNTDOWN_MS = Number(process.env.BOT_COUNTDOWN_MS) || 5000;

export const BOT_SPEEDS = MATCH_SPEEDS;

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
  constructor(matchmaker, io, mode, options = {}) {
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
    this.botDifficulty = "simple";
    this.botStrategy = { top: "auto", bottom: "auto" };
    this.speedScale = 1;
    this.speedAccum = 0;
    this.matchOptions = null;
    /** Debug-server bot matches: range overlays + play controls. */
    this.debugMode = process.env.DEBUG_RANGES === "1";
    /** Which sim side human commands apply to (debug bot games only). */
    this.controlSide = "player";
    /** When false, seated bots do not act (debug bot games default off). */
    this.botsEnabled = !(mode === "bot" && this.debugMode);
    this.seat = {
      a: emptySeat("a", "player"),
      b: emptySeat("b", "enemy"),
    };
    if (mode === "training") {
      applyTrainingRules(this);
    }
    if (options.matchOptions) {
      this.applyMatchOptions(options.matchOptions);
    }
  }

  /** Custom lobby settings (listed rooms). */
  applyMatchOptions(raw) {
    const opts = normalizeMatchOptions(raw);
    this.matchOptions = opts;
    this.speedScale = opts.speed;
    this.speedAccum = 0;
    this.sim.applyMatchOptions(opts);
  }

  /** Public summary for Open Games cards. */
  matchOptionsPublic() {
    return matchOptionsSummary(this.matchOptions || {});
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
    if (this.mode === "training") {
      seat.bot = new TrainingBotController(seat.sideId);
      return;
    }
    seat.bot = new BotController(seat.sideId, {
      difficulty: this.botDifficulty,
      strategy: { ...this.botStrategy },
    });
  }

  /** Mid-match training controls. Bot games only. */
  botSettings(socket, payload) {
    if (this.mode !== "bot") return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    if (payload.difficulty != null) {
      const d = String(payload.difficulty);
      if (DIFFICULTIES.includes(d)) {
        this.botDifficulty = d;
        this.forEachBot((bot) => bot.setDifficulty(d));
      }
    }

    if (payload.speed != null) {
      const speed = Number(payload.speed);
      if (BOT_SPEEDS.includes(speed)) {
        this.speedScale = speed;
        this.speedAccum = 0;
      }
    }

    if (payload.strategy && typeof payload.strategy === "object") {
      const lane = payload.strategy.lane;
      const mode = payload.strategy.mode;
      if ((lane === "top" || lane === "bottom") && STRATEGY_MODES.includes(mode)) {
        this.botStrategy[lane] = mode;
        this.forEachBot((bot) => bot.setLaneStrategy(lane, mode));
      }
    }

    this.pushLobby();
  }

  forEachBot(fn) {
    if (this.seat.a.bot) fn(this.seat.a.bot);
    if (this.seat.b.bot) fn(this.seat.b.bot);
  }

  botSettingsPublic() {
    if (this.mode !== "bot") return null;
    return {
      difficulty: this.botDifficulty,
      speed: this.speedScale,
      strategy: { ...this.botStrategy },
    };
  }

  /** Bottom-right debug play controls. Bot + DEBUG_RANGES only. */
  debugPlayPublic() {
    if (this.mode !== "bot" || !this.debugMode) return null;
    return {
      controlSide: this.controlSide,
      botsEnabled: this.botsEnabled,
    };
  }

  /** Toggle controlled side / bot AI. Debug bot games only. */
  debugPlay(socket, payload) {
    if (this.mode !== "bot" || !this.debugMode) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    if (payload.controlSide === "player" || payload.controlSide === "enemy") {
      this.controlSide = payload.controlSide;
    }
    if (typeof payload.botsEnabled === "boolean") {
      this.botsEnabled = payload.botsEnabled;
    }
    this.pushLobby();
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
    // Debug bot games skip the match-start wait.
    if (this.mode === "bot" && this.debugMode) {
      this.countdownEnds = null;
      this.beginPlay();
      return true;
    }
    const wait = this.countdownDurationMs();
    this.countdownEnds = Date.now() + wait;
    this.pushLobby();
    this.broadcastState();
    this.countdownTimer = setTimeout(() => this.beginPlay(), wait);
    return true;
  }

  /** 10s vs humans, 5s vs bot / train-vs-bot. */
  countdownDurationMs() {
    if (this.mode === "bot") return BOT_COUNTDOWN_MS;
    if (this.mode === "training" && (this.seat.a.bot || this.seat.b.bot)) {
      return BOT_COUNTDOWN_MS;
    }
    return COUNTDOWN_MS;
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
    const scale = (this.mode === "bot" || this.mode === "training" || this.mode === "listed")
      ? this.speedScale
      : 1;
    this.speedAccum += scale;
    const cap = CONFIG.botSpeedStepCap || 4;
    let steps = Math.floor(this.speedAccum);
    if (steps > cap) steps = cap;
    this.speedAccum -= steps;
    for (let s = 0; s < steps; s += 1) {
      // Install this match's terrain overlay before commands/bots/sim read LOS.
      this.sim.installTerrainFx();
      if (!this.sim.beginStep(STEP_DT)) break;
      this.applyQueued();
      this.runBots();
      this.sim.finishStep(STEP_DT);
    }
    // Visual splats age on wall time so they do not freeze at slow speeds.
    this.sim.updateSplats(STEP_DT);
    this.broadcastState();
  }

  /** Bot AI when enabled; skips a side the human is currently controlling. */
  runBots() {
    if (this.mode === "bot" && this.debugMode && !this.botsEnabled) return;
    if (this.seat.a.bot && this.controlSide !== this.seat.a.sideId) {
      this.seat.a.bot.act(this.sim);
    }
    if (this.seat.b.bot && this.controlSide !== this.seat.b.sideId) {
      this.seat.b.bot.act(this.sim);
    }
  }

  applyQueued() {
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (seat.bot) continue;
      const batch = seat.queue;
      seat.queue = [];
      const sideId = this.mode === "bot" && this.debugMode
        ? this.controlSide
        : seat.sideId;
      for (let c = 0; c < batch.length; c += 1) {
        this.sim.applyCommand(sideId, batch[c]);
      }
    }
  }

  command(socket, cmd) {
    if (this.status !== "playing" || this.sim.winner) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return;
    if (this.mode === "training" && cmd.type === "buy" && cmd.lane !== "bottom") {
      return;
    }
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
    if (this.mode === "training") return "Waiting for a training opponent";
    return "Waiting for an opponent";
  }

  /** Remaining ms until play, from the server clock (avoids client clock skew). */
  countdownLeftMs() {
    if (this.status !== "countdown" || !this.countdownEnds) return null;
    return Math.max(0, this.countdownEnds - Date.now());
  }

  lobbyFor(seat) {
    return {
      seat: seat.key,
      status: this.status,
      mode: this.mode,
      text: this.status === "waiting" ? this.waitingText() : "",
      countdownEnds: this.countdownEnds,
      countdownLeft: this.countdownLeftMs(),
      you: seat.userId ? { id: seat.userId, name: seat.name } : null,
      opponent: this.opponentOf(seat),
      botSettings: this.botSettingsPublic(),
      debugPlay: this.debugPlayPublic(),
    };
  }

  pushLobby() {
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (seat.socket) seat.socket.emit("lobby", this.lobbyFor(seat));
    }
  }

  /** Match state for one seat (terrain fog filtered to that side). */
  publicStateFor(seat) {
    const sideId = seat && seat.sideId ? seat.sideId : "player";
    const snap = this.sim.snapshot({ forSideId: sideId });
    snap.status = this.status;
    snap.countdownEnds = this.countdownEnds;
    snap.countdownLeft = this.countdownLeftMs();
    return snap;
  }

  /** Omniscient snapshot (tests / spectators). Prefer publicStateFor. */
  publicState() {
    const snap = this.sim.snapshot();
    snap.status = this.status;
    snap.countdownEnds = this.countdownEnds;
    snap.countdownLeft = this.countdownLeftMs();
    return snap;
  }

  broadcastState() {
    this.noteOutcome();
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (!seat.socket) continue;
      seat.socket.emit("state", this.publicStateFor(seat));
    }
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
