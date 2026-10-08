import { performance } from "node:perf_hooks";
import { CONFIG } from "../shared/config.js";
import { allowCommand, allowSocketEvent, sanitizeCommand } from "./commandLimit.js";
import { debugRangesEnabled } from "./hardening.js";
import {
  allowChat,
  chatAdminHistoryMax,
  chatHistoryMax,
  encodeChatJson,
  matchChatEnabled,
  sanitizeChatText,
  serializeChatLog,
} from "./chat.js";
import {
  metricsEnabled,
  noteBroadcast,
  noteCommand,
  noteRoomTick,
  noteSim,
  shouldSampleBroadcastBytes,
} from "./metrics.js";
import {
  MATCH_SPEEDS,
  matchOptionsSummary,
  normalizeMatchOptions,
} from "../shared/matchOptions.js";
import { BotController, DIFFICULTIES, STRATEGY_MODES } from "./bot.js";
import {
  chargeHeld,
  createPlayerReport,
  eloK,
  hasPlayerReport,
  recordMatchResult,
  refundTicket,
  releaseHold,
  REPORT_BODY_MAX,
} from "./db.js";
import { asErr, child as childLogger, createSampler, safeLog } from "./logger.js";
import { nextMmr } from "./rating.js";
import { GameSim } from "./sim.js";
import { applyTrainingRules } from "./training.js";
import { TrainingBotController } from "./trainingBot.js";

const invalidActionSample = createSampler(50);
const DEBUG_CMD_TYPES = new Set(["buy", "bank", "targeting", "townProduce", "upgrade", "order"]);

export const TICK_MS = 50;
export const STEP_DT = 0.05;

/** Network snapshot interval. Sim steps stay at TICK_MS. */
export function stateIntervalMs() {
  const n = Number(process.env.STATE_MS);
  if (Number.isFinite(n) && n >= TICK_MS) return n;
  return CONFIG.stateIntervalMs || 100;
}
/** Match-start countdown for human vs human games. */
export const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 10000;
/** Match-start countdown for bot games. */
export const BOT_COUNTDOWN_MS = Number(process.env.BOT_COUNTDOWN_MS) || 5000;
/** Mutual-unpause countdown after one player requests resume. */
export const UNPAUSE_MS = Number(process.env.UNPAUSE_MS) || 60000;
/** Grace before a mid-match disconnect pauses for reconnect. */
export const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 5000;
/** How long to wait for a reconnect before auto-concede. */
export const RECONNECT_WAIT_MS = Number(process.env.RECONNECT_WAIT_MS) || 60000;

export const BOT_SPEEDS = MATCH_SPEEDS;

function emptySeat(key, sideId) {
  return {
    key,
    sideId,
    userId: null,
    name: null,
    accountId: null,
    formbarId: null,
    mmr: null,
    socket: null,
    bot: null,
    queue: [],
    chatBucket: null,
    reconnectAt: [],
    alreadyReported: false,
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
    this.log = childLogger({ matchId: this.id, mode });
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
    this.botStrategy = this.defaultBotStrategy();
    this.speedScale = 1;
    this.speedAccum = 0;
    this.matchOptions = null;
    /** Debug-server bot matches: range overlays + play controls. */
    this.debugMode = debugRangesEnabled();
    /** Which sim side human commands apply to (debug bot games only). */
    this.controlSide = "player";
    /** When false, seated bots do not act (debug bot games default off). */
    this.botsEnabled = !(mode === "bot" && this.debugMode);
    this.seat = {
      a: emptySeat("a", "player"),
      b: emptySeat("b", "enemy"),
    };
    this.stateAccumMs = 0;
    this.playSnapshotSent = false;
    this.winnerSent = false;
    /** Ephemeral match chat for clients (trimmed). */
    this.chatLog = [];
    /** Longer chat archive for admin review / games.chat_json. */
    this.adminChatLog = [];
    this.chatSeq = 0;
    /** Bot/training: freeze sim while a human has settings open. */
    this.menuPaused = false;
    /** Human vs human: both seats must request before the match freezes. */
    this.pauseWant = { a: false, b: false };
    /** Seat key that should see the red chat pause alert (the non-requester). */
    this.pauseAlertSeat = null;
    /** True after both humans agreed to pause. */
    this.paused = false;
    /** Votes to resume; either both, or the unpause countdown finishing. */
    this.unpauseWant = { a: false, b: false };
    this.unpauseEnds = null;
    this.unpauseTimer = null;
    /** Seat key in the short post-disconnect grace window (sim still runs). */
    this.disconnectGraceSeat = null;
    this.disconnectGraceTimer = null;
    /** Seat key being waited on after grace; freezes sim until reconnect or forfeit. */
    this.reconnectWaitSeat = null;
    this.reconnectWaitEnds = null;
    this.reconnectWaitTimer = null;
    if (process.env.LOAD_TEST === "1") {
      const gold = Number(process.env.LOAD_TEST_GOLD);
      const amount = Number.isFinite(gold) && gold > 0 ? gold : 20000;
      this.sim.player.gold = amount;
      this.sim.enemy.gold = amount;
    }
    if (mode === "training") {
      applyTrainingRules(this);
    }
    if (options.matchOptions) {
      this.applyMatchOptions(options.matchOptions);
    }
    safeLog(this.log, "info", { event: "match_created" }, "match created");
  }

  /** Per-lane bot strategy defaults from the active map. */
  defaultBotStrategy() {
    const ids = (this.sim && this.sim.map && this.sim.map.laneIds()) || ["top", "bottom"];
    const out = {};
    for (let i = 0; i < ids.length; i += 1) out[ids[i]] = "auto";
    return out;
  }

  /** Custom lobby settings (listed rooms). */
  applyMatchOptions(raw) {
    const opts = normalizeMatchOptions(raw);
    this.matchOptions = opts;
    this.speedScale = opts.speed;
    this.speedAccum = 0;
    this.sim.applyMatchOptions(opts);
    this.botStrategy = { ...this.defaultBotStrategy(), ...this.botStrategy };
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
    if (seat.userId && this.matchmaker && this.matchmaker.forgetUserRoom) {
      this.matchmaker.forgetUserRoom(seat.userId, this);
    }
    seat.userId = null;
    seat.name = null;
    seat.accountId = null;
    seat.formbarId = null;
    seat.mmr = null;
    seat.socket = null;
    seat.bot = null;
    seat.queue = [];
    seat.chatBucket = null;
    seat.reconnectAt = [];
    seat.alreadyReported = false;
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
    if (seat.userId && seat.userId !== player.id && this.matchmaker && this.matchmaker.forgetUserRoom) {
      this.matchmaker.forgetUserRoom(seat.userId, this);
    }
    seat.userId = player.id;
    seat.name = player.name;
    seat.accountId = player.accountId || null;
    seat.formbarId = player.formbarId || null;
    seat.mmr = Number.isFinite(player.mmr) ? player.mmr : null;
    seat.bot = null;
    seat.alreadyReported = false;
    if (player.id && this.matchmaker && this.matchmaker.rememberUserRoom) {
      this.matchmaker.rememberUserRoom(player.id, this);
    }
  }

  /** Load whether this seat already reported the current opponent (async). */
  async refreshReportState(seat) {
    if (!seat || !seat.accountId) {
      if (seat) seat.alreadyReported = false;
      return;
    }
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    if (!other || other.bot || !other.accountId) {
      seat.alreadyReported = false;
      return;
    }
    try {
      seat.alreadyReported = await hasPlayerReport(seat.accountId, other.accountId);
    } catch (err) {
      safeLog(this.log, "warn", {
        event: "report_state_failed",
        err: asErr(err),
        userId: seat.userId,
      }, "report state lookup failed");
      seat.alreadyReported = false;
    }
  }

  seatHuman(key, socket) {
    const seat = this.seat[key];
    const previous = seat.socket;
    const other = key === "a" ? this.seat.b : this.seat.a;
    // Someone already in the other seat was waiting; do not announce this join to them.
    const otherAlreadyWaiting = Boolean(other.userId && !other.bot);
    const rejoining = Boolean(seat.userId)
      && (this.status === "playing" || this.status === "countdown");
    const tabReplace = Boolean(previous && previous !== socket);
    const name = socket.data.user && socket.data.user.name
      ? String(socket.data.user.name)
      : "Player";
    this.copyPlayer(seat, socket.data.user);
    seat.socket = socket;
    socket.data.gameId = this.id;
    socket.data.seatKey = key;
    socket.join(this.roomName);
    this.remember(socket);
    if (tabReplace) {
      previous.data.replaced = true;
      previous.emit("replaced");
      previous.disconnect(true);
      safeLog(this.log, "info", {
        event: "player_replaced",
        userId: seat.userId,
        seat: key,
        socketId: socket.id,
        oldSocketId: previous.id,
      }, "player tab replaced");
    }
    const midMatchReconnect = (tabReplace || rejoining)
      && this.status === "playing"
      && !this.sim.winner;
    if (midMatchReconnect && this.noteReconnectSpam(seat)) {
      this.clearDisconnectForSeat(seat);
      return;
    }
    if (tabReplace || rejoining) {
      this.systemChat(`${name} reconnected`);
      safeLog(this.log, "info", {
        event: "player_reconnected",
        userId: seat.userId,
        seat: key,
        socketId: socket.id,
      }, "player reconnected");
    } else if (!otherAlreadyWaiting) {
      this.systemChat(`${name} joined`);
      safeLog(this.log, "info", {
        event: "player_joined",
        userId: seat.userId,
        seat: key,
        socketId: socket.id,
      }, "player joined");
    } else {
      safeLog(this.log, "info", {
        event: "player_joined",
        userId: seat.userId,
        seat: key,
        socketId: socket.id,
      }, "player joined");
    }
    this.clearDisconnectForSeat(seat);
    this.pushLobby();
    this.broadcastState();
    this.refreshReportState(seat).then(() => {
      if (seat.socket) seat.socket.emit("lobby", this.lobbyFor(seat));
    }).catch(() => {});
    if (other.userId && !other.bot) {
      this.refreshReportState(other).then(() => {
        if (other.socket) other.socket.emit("lobby", this.lobbyFor(other));
      }).catch(() => {});
    }
  }

  /**
   * Track mid-match reconnects. Returns true if the seat was force-conceded.
   */
  noteReconnectSpam(seat, now = Date.now()) {
    if (!seat || this.status !== "playing" || this.sim.winner || this.closing) {
      return false;
    }
    const max = CONFIG.reconnectSpamMax || 3;
    const windowMs = CONFIG.reconnectSpamWindowMs || 15000;
    if (!Array.isArray(seat.reconnectAt)) seat.reconnectAt = [];
    seat.reconnectAt.push(now);
    seat.reconnectAt = seat.reconnectAt.filter((at) => now - at <= windowMs);
    if (seat.reconnectAt.length < max) return false;
    this.forceConcedeSeat(seat, {
      chatLine: `${seat.name || "Player"} forfeited (reconnect spam)`,
      reason: "reconnect_spam",
      spamCount: seat.reconnectAt.length,
      spamMax: max,
      spamWindowMs: windowMs,
    });
    return true;
  }

  /** Both seats filled (human or bot) — matchup is known / about to start. */
  seatsReady() {
    const a = this.seat.a;
    const b = this.seat.b;
    const aOk = Boolean(a && (a.bot || a.userId));
    const bOk = Boolean(b && (b.bot || b.userId));
    return aOk && bOk;
  }

  /** Opponent wins; shared by concede, disconnect timeout, reconnect spam. */
  forceConcedeSeat(seat, {
    chatLine,
    reason = "concede",
    spamCount,
    spamMax,
    spamWindowMs,
  } = {}) {
    if (this.sim.winner || this.closing) return false;
    if (this.status === "playing") {
      // ok
    } else if (this.status === "countdown" || (this.status === "waiting" && this.seatsReady())) {
      // Pre-play leave is a forfeit once both seats know the matchup.
      this.cancelCountdown();
      this.countdownEnds = null;
      if (this.status === "waiting" && this.paid && !this.charged) {
        const ids = [this.seat.a.accountId, this.seat.b.accountId]
          .filter((id) => Number.isInteger(id) && id > 0);
        for (let i = 0; i < ids.length; i += 1) {
          releaseHold(ids[i]).catch(() => {});
        }
      }
      this.status = "playing";
      this.playSnapshotSent = true;
    } else {
      return false;
    }
    if (!seat || !seat.userId) return false;
    this.resetPauseState();
    this.sim.winner = seat.sideId === "player" ? "enemy" : "player";
    this.sim.winReason = "concede";
    this.sim.sounds = [];
    seat.queue = [];
    if (chatLine) this.systemChat(chatLine);
    const level = reason === "reconnect_spam" ? "warn" : "info";
    safeLog(this.log, level, {
      event: reason === "reconnect_spam" ? "reconnect_spam_forfeit"
        : reason === "disconnect" ? "disconnect_forfeit"
          : "player_conceded",
      userId: seat.userId,
      seat: seat.key,
      winnerSide: this.sim.winner,
      reason,
      count: spamCount,
      max: spamMax,
      windowMs: spamWindowMs,
    }, "seat force-conceded");
    this.pushLobby();
    this.broadcastState({ volatile: false });
    return true;
  }

  seatReserved(key, player) {
    const seat = this.seat[key];
    this.copyPlayer(seat, {
      id: player.userId || player.id,
      name: player.name,
      accountId: player.accountId,
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
    seat.accountId = null;
    seat.formbarId = null;
    seat.mmr = null;
    seat.socket = null;
    seat.queue = [];
    seat.alreadyReported = false;
    if (this.mode === "training") {
      seat.bot = new TrainingBotController(seat.sideId);
      if (typeof seat.bot.setLog === "function") seat.bot.setLog(this.log);
      return;
    }
    seat.bot = new BotController(seat.sideId, {
      difficulty: this.botDifficulty,
      strategy: { ...this.botStrategy },
    });
    seat.bot.setLog(this.log);
  }

  /** Mid-match training controls. Bot games only. */
  botSettings(socket, payload) {
    if (!allowSocketEvent(socket, "botSettings")) {
      safeLog(this.log, "warn", {
        event: "invalid_action",
        reason: "rate_limited",
        action: "botSettings",
        socketId: socket.id,
        userId: socket.data && socket.data.user && socket.data.user.id,
      }, "botSettings rate limited");
      return;
    }
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
      if (this.sim.map.hasLane(lane) && STRATEGY_MODES.includes(mode)) {
        this.botStrategy[lane] = mode;
        this.forEachBot((bot) => bot.setLaneStrategy(lane, mode));
      }
    }

    safeLog(this.log, "info", {
      event: "bot_settings",
      userId: seat.userId,
      difficulty: this.botDifficulty,
      speed: this.speedScale,
      strategy: this.botStrategy,
    }, "bot settings updated");
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
    if (!debugRangesEnabled() || !this.debugMode) return;
    if (!allowSocketEvent(socket, "debugPlay")) return;
    if (this.mode !== "bot") return;
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
      const ids = [this.seat.a.accountId, this.seat.b.accountId]
        .filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length < 2) {
        safeLog(this.log, "warn", {
          event: "match_countdown_failed",
          reason: "missing_accounts",
        }, "countdown charge missing accounts");
        return false;
      }
      const done = [];
      for (let i = 0; i < ids.length; i += 1) {
        const ok = await chargeHeld(ids[i]);
        if (!ok) {
          for (let r = 0; r < done.length; r += 1) {
            await refundTicket(done[r]);
          }
          safeLog(this.log, "warn", {
            event: "match_countdown_failed",
            reason: "ticket",
            accountId: ids[i],
          }, "countdown ticket charge failed");
          return false;
        }
        done.push(ids[i]);
        safeLog(this.log, "info", {
          event: "ticket_charged",
          accountId: ids[i],
        }, "ticket charged for match");
      }
      this.charged = true;
    }
    if (this.status !== "waiting" || this.closing) {
      if (this.charged) {
        await refundTicket(this.seat.a.accountId);
        await refundTicket(this.seat.b.accountId);
        this.charged = false;
      }
      safeLog(this.log, "warn", {
        event: "match_countdown_failed",
        reason: "race",
      }, "countdown aborted after charge");
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
    safeLog(this.log, "info", {
      event: "match_countdown",
      waitMs: wait,
      charged: this.charged,
      userIdA: this.seat.a.userId,
      userIdB: this.seat.b.userId,
    }, "match countdown started");
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
    safeLog(this.log, "info", {
      event: "match_started",
      userIdA: this.seat.a.userId,
      userIdB: this.seat.b.userId,
      botA: Boolean(this.seat.a.bot),
      botB: Boolean(this.seat.b.bot),
    }, "match started");
    this.pushLobby();
    this.stateAccumMs = 0;
    this.playSnapshotSent = false;
    this.winnerSent = false;
    this.broadcastState({ volatile: false });
    this.playSnapshotSent = true;
    if (this.matchmaker && this.matchmaker.ticker) {
      this.matchmaker.ticker.add(this);
    } else {
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  /** True when the authoritative sim must not advance. */
  simFrozen() {
    return this.menuPaused
      || this.paused
      || Boolean(this.unpauseEnds)
      || Boolean(this.reconnectWaitEnds);
  }

  /** Human vs human seats (no bots) — mutual pause is available. */
  humanPauseMatch() {
    const a = this.seat.a;
    const b = this.seat.b;
    if (a.bot || b.bot) return false;
    if (!a.userId || !b.userId) return false;
    return true;
  }

  /** Bot (or training-vs-bot): settings menu freezes the match. */
  menuPauseAllowed() {
    return Boolean(this.seat.a.bot || this.seat.b.bot);
  }

  clearPauseVotes() {
    this.pauseWant = { a: false, b: false };
    this.pauseAlertSeat = null;
  }

  clearUnpauseVotes() {
    this.unpauseWant = { a: false, b: false };
  }

  cancelUnpauseCountdown() {
    if (this.unpauseTimer) {
      clearTimeout(this.unpauseTimer);
      this.unpauseTimer = null;
    }
    this.unpauseEnds = null;
  }

  resetPauseState() {
    this.menuPaused = false;
    this.paused = false;
    this.clearPauseVotes();
    this.clearUnpauseVotes();
    this.cancelUnpauseCountdown();
    this.clearDisconnectTimers();
  }

  clearDisconnectGrace() {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
    this.disconnectGraceSeat = null;
  }

  cancelReconnectWait() {
    if (this.reconnectWaitTimer) {
      clearTimeout(this.reconnectWaitTimer);
      this.reconnectWaitTimer = null;
    }
    this.reconnectWaitEnds = null;
    this.reconnectWaitSeat = null;
  }

  clearDisconnectTimers() {
    this.clearDisconnectGrace();
    this.cancelReconnectWait();
  }

  reconnectWaitLeftMs() {
    if (!this.reconnectWaitEnds) return null;
    return Math.max(0, this.reconnectWaitEnds - Date.now());
  }

  /** Clear grace / reconnect wait for a seat that came back. */
  clearDisconnectForSeat(seat) {
    if (!seat) return;
    if (this.disconnectGraceSeat === seat.key) this.clearDisconnectGrace();
    if (this.reconnectWaitSeat === seat.key) this.cancelReconnectWait();
  }

  /**
   * After disconnect grace: freeze and wait for reconnect, then auto-concede.
   */
  beginReconnectWait(seat) {
    if (this.status !== "playing" || this.sim.winner || this.closing) return;
    if (!seat || seat.socket || seat.bot) return;
    if (this.connectedSockets().length === 0) {
      this.destroy();
      return;
    }
    this.clearDisconnectGrace();
    this.cancelUnpauseCountdown();
    this.clearUnpauseVotes();
    this.reconnectWaitSeat = seat.key;
    const wait = RECONNECT_WAIT_MS;
    this.reconnectWaitEnds = Date.now() + wait;
    this.systemChat(`Waiting for ${seat.name || "Player"} to reconnect`);
    safeLog(this.log, "info", {
      event: "player_reconnect_wait",
      userId: seat.userId,
      seat: seat.key,
      waitMs: wait,
    }, "waiting for reconnect");
    this.pushLobby();
    this.broadcastState({ volatile: false });
    this.reconnectWaitTimer = setTimeout(() => {
      this.reconnectWaitTimer = null;
      this.forfeitDisconnect(seat.key);
    }, wait);
  }

  /** Disconnected player loses after the reconnect window. */
  forfeitDisconnect(seatKey) {
    if (this.status !== "playing" || this.sim.winner || this.closing) return;
    const seat = this.seat[seatKey];
    if (!seat || seat.socket) {
      this.cancelReconnectWait();
      return;
    }
    this.forceConcedeSeat(seat, {
      chatLine: `${seat.name || "Player"} forfeited (disconnected)`,
      reason: "disconnect",
    });
  }

  unpauseLeftMs() {
    if (!this.unpauseEnds) return null;
    return Math.max(0, this.unpauseEnds - Date.now());
  }

  /** Freeze after both humans requested pause. */
  enterPaused() {
    this.paused = true;
    this.clearPauseVotes();
    this.pauseAlertSeat = null;
    this.clearUnpauseVotes();
    this.cancelUnpauseCountdown();
    this.systemChat("Match paused");
    safeLog(this.log, "info", { event: "match_paused" }, "match paused");
    this.pushLobby();
    this.broadcastState({ volatile: false });
  }

  /** Resume play (both unpaused, or countdown finished). */
  resumePlay() {
    if (!this.paused && !this.unpauseEnds) return;
    this.paused = false;
    this.clearUnpauseVotes();
    this.cancelUnpauseCountdown();
    this.clearPauseVotes();
    this.pauseAlertSeat = null;
    this.systemChat("Match resumed");
    safeLog(this.log, "info", { event: "match_resumed" }, "match resumed");
    this.pushLobby();
    this.broadcastState({ volatile: false });
  }

  beginUnpauseCountdown() {
    if (!this.paused || this.unpauseEnds) return;
    const wait = UNPAUSE_MS;
    this.unpauseEnds = Date.now() + wait;
    this.pushLobby();
    this.broadcastState({ volatile: false });
    this.unpauseTimer = setTimeout(() => this.resumePlay(), wait);
  }

  /**
   * Bot games: client reports settings open/closed.
   * Freezes the sim while open so the player can adjust without the bot playing on.
   */
  settingsOpen(socket, open) {
    if (!this.menuPauseAllowed()) return;
    if (this.status !== "playing" || this.sim.winner) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    const next = Boolean(open);
    if (this.menuPaused === next) return;
    this.menuPaused = next;
    this.broadcastState({ volatile: false });
  }

  /**
   * Human mutual pause / unpause.
   * First click while live: pause request (chat + red alert for the other).
   * Both requested → pause. While paused: unpause vote; both or 60s → resume.
   */
  pause(socket) {
    if (this.status !== "playing" || this.sim.winner) return;
    if (this.reconnectWaitEnds) return;
    if (!this.humanPauseMatch()) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot || !seat.userId) return;
    const other = this.opponentSeat(seat);
    if (!other) return;

    if (this.paused) {
      if (this.unpauseWant[seat.key]) return;
      this.unpauseWant[seat.key] = true;
      if (this.unpauseWant.a && this.unpauseWant.b) {
        this.resumePlay();
        return;
      }
      if (!this.unpauseEnds) this.beginUnpauseCountdown();
      else {
        this.pushLobby();
        this.broadcastState({ volatile: false });
      }
      return;
    }

    // Cancel a solo pause request.
    if (this.pauseWant[seat.key] && !this.pauseWant[other.key]) {
      this.pauseWant[seat.key] = false;
      this.pauseAlertSeat = null;
      this.systemChat(`${seat.name || "Player"} cancelled the pause request`);
      this.pushLobby();
      this.broadcastState({ volatile: false });
      return;
    }

    if (this.pauseWant[seat.key]) return;
    this.pauseWant[seat.key] = true;
    if (this.pauseWant.a && this.pauseWant.b) {
      this.enterPaused();
      return;
    }
    this.pauseAlertSeat = other.key;
    this.systemChat(`${seat.name || "Player"} requested a pause`);
    this.pushLobby();
    this.broadcastState({ volatile: false });
  }

  /** Clear the red chat pause alert (opening chat). */
  pauseSeen(socket) {
    const seat = this.seatBySocket(socket);
    if (!seat) return;
    if (this.pauseAlertSeat !== seat.key) return;
    this.pauseAlertSeat = null;
    this.pushLobby();
  }

  opponentSeat(seat) {
    return seat.key === "a" ? this.seat.b : this.seat.a;
  }

  tick() {
    if (this.status !== "playing") return;
    const watch = metricsEnabled();
    const t0 = watch ? performance.now() : 0;
    if (
      this.sim.winner
      && (this.paused || this.menuPaused || this.unpauseEnds || this.pauseAlertSeat
        || this.pauseWant.a || this.pauseWant.b
        || this.reconnectWaitEnds || this.disconnectGraceSeat)
    ) {
      this.resetPauseState();
      this.pushLobby();
    }
    if (!this.simFrozen()) {
      const scale = (this.mode === "bot" || this.mode === "training" || this.mode === "listed")
        ? this.speedScale
        : 1;
      this.speedAccum += scale;
      const cap = CONFIG.botSpeedStepCap || 4;
      let steps = Math.floor(this.speedAccum);
      if (steps > cap) steps = cap;
      this.speedAccum -= steps;
      const simStart = watch ? performance.now() : 0;
      for (let s = 0; s < steps; s += 1) {
        // Install this match's terrain overlay before commands/bots/sim read LOS.
        this.sim.installTerrainFx();
        if (!this.sim.beginStep(STEP_DT)) break;
        this.applyQueued();
        this.runBots();
        this.sim.finishStep(STEP_DT);
      }
      if (watch) noteSim(performance.now() - simStart);
      // Visual splats age on wall time so they do not freeze at slow speeds.
      this.sim.updateSplats(STEP_DT);
    }
    this.stateAccumMs += TICK_MS;
    const winner = Boolean(this.sim.winner);
    if (winner && !this.winnerSent) {
      this.broadcastState({ volatile: false });
      this.stateAccumMs = 0;
    } else if (this.stateAccumMs + 1e-6 >= stateIntervalMs()) {
      this.stateAccumMs = 0;
      const volatile = this.status === "playing" && !winner && this.playSnapshotSent;
      this.broadcastState({ volatile });
    }
    if (watch) noteRoomTick(performance.now() - t0);
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
    if (this.simFrozen()) {
      noteCommand(false);
      return;
    }
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot) return;
    const clean = sanitizeCommand(cmd);
    if (!clean || !allowCommand(socket, clean)) {
      noteCommand(false);
      if (invalidActionSample()) {
        safeLog(this.log, "warn", {
          event: "invalid_action",
          reason: clean ? "rate_limited" : "malformed",
          type: clean ? clean.type : (cmd && typeof cmd === "object" ? cmd.type : undefined),
          userId: seat.userId,
          socketId: socket.id,
        }, "invalid or rate-limited command");
      }
      return;
    }
    if (this.mode === "training" && clean.type === "buy" && clean.lane !== "bottom") {
      noteCommand(false);
      return;
    }
    if (seat.queue.length >= 30) {
      noteCommand(false);
      if (invalidActionSample()) {
        safeLog(this.log, "warn", {
          event: "invalid_action",
          reason: "queue_full",
          userId: seat.userId,
          socketId: socket.id,
          queueLen: seat.queue.length,
        }, "command queue full");
      }
      return;
    }
    seat.queue.push(clean);
    noteCommand(true);
    if (DEBUG_CMD_TYPES.has(clean.type)) {
      safeLog(this.log, "debug", {
        event: "player_command",
        userId: seat.userId,
        socketId: socket.id,
        type: clean.type,
        unit: clean.unit,
        lane: clean.lane,
        action: clean.action,
        troopId: clean.troopId,
      }, "command queued");
    }
  }

  nextChatId() {
    this.chatSeq += 1;
    return `${this.id}:${this.chatSeq}`;
  }

  /**
   * Chat only for human vs human when both seats are logged-in accounts.
   * Off when either seat is a bot, a guest, or empty.
   */
  roomChatActive() {
    if (!matchChatEnabled()) return false;
    const a = this.seat.a;
    const b = this.seat.b;
    if (a.bot || b.bot) return false;
    if (!a.userId || !b.userId) return false;
    if (!a.accountId || !b.accountId) return false;
    return true;
  }

  appendChat(msg) {
    this.chatLog.push(msg);
    const max = chatHistoryMax();
    if (this.chatLog.length > max) {
      this.chatLog.splice(0, this.chatLog.length - max);
    }
    this.adminChatLog.push(msg);
    const adminMax = chatAdminHistoryMax();
    if (this.adminChatLog.length > adminMax) {
      this.adminChatLog.splice(0, this.adminChatLog.length - adminMax);
    }
  }

  /** Lean chat lines for admin UI / persistence. */
  chatArchivePublic() {
    return serializeChatLog(this.adminChatLog);
  }

  chatArchiveJson() {
    return encodeChatJson(this.adminChatLog);
  }

  broadcastChat(msg) {
    const seats = this.connectedSockets();
    for (let i = 0; i < seats.length; i += 1) {
      seats[i].socket.emit("chat", msg);
    }
  }

  /** System line into history + live broadcast (no-op when chat inactive). */
  systemChat(text) {
    if (!this.roomChatActive()) return;
    const line = String(text || "").trim();
    if (!line) return;
    const msg = {
      id: this.nextChatId(),
      kind: "system",
      text: line,
      at: Date.now(),
    };
    this.appendChat(msg);
    this.broadcastChat(msg);
  }

  /**
   * Player chat. Allowed while seated in waiting / countdown / playing
   * (including post-win until leave), only when roomChatActive().
   */
  chat(socket, payload) {
    if (!this.roomChatActive()) return;
    if (this.status === "dead" || this.closing) return;
    if (
      this.status !== "waiting"
      && this.status !== "countdown"
      && this.status !== "playing"
    ) {
      return;
    }
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot || !seat.userId || !seat.accountId) return;
    const raw = payload && typeof payload === "object" ? payload.text : payload;
    const text = sanitizeChatText(raw);
    if (!text) {
      safeLog(this.log, "debug", {
        event: "chat_rejected",
        reason: "empty_or_profane",
        userId: seat.userId,
      }, "chat rejected");
      return;
    }
    if (!allowChat(seat)) {
      safeLog(this.log, "warn", {
        event: "chat_rate_limited",
        userId: seat.userId,
        seat: seat.key,
      }, "chat rate limited");
      return;
    }
    const msg = {
      id: this.nextChatId(),
      kind: "user",
      from: { name: seat.name || "Player" },
      text,
      at: Date.now(),
    };
    this.appendChat(msg);
    this.broadcastChat(msg);
  }

  concede(socket) {
    const seat = this.seatBySocket(socket);
    if (!seat) return;
    this.forceConcedeSeat(seat, { reason: "concede" });
  }

  leave(socket) {
    if (this.status === "dead" || this.closing) return;
    const seat = this.seatBySocket(socket);
    if (!seat) return;
    if (this.status === "playing" && !this.sim.winner) return;
    if (this.sim.winner) {
      safeLog(this.log, "info", {
        event: "player_left",
        userId: seat.userId,
        seat: seat.key,
        phase: "post_win",
      }, "player left after win");
      this.sendHome(socket);
      return;
    }
    // Matchup known (countdown, or waiting with both seats): leaving concedes.
    if (this.status === "countdown" || (this.status === "waiting" && this.seatsReady())) {
      this.forceConcedeSeat(seat, { reason: "concede" });
      return;
    }
    this.matchmaker.abandonSeat(this, seat, { goHome: true }).catch((err) => {
      safeLog(this.log, "error", {
        event: "match_error",
        err: asErr(err),
        userId: seat.userId,
        seat: seat.key,
        action: "abandon_leave",
      }, "abandonSeat failed on leave");
    });
  }

  disconnect(socket) {
    if (socket.data.replaced || this.status === "dead" || this.closing) return;
    const seat = this.seatBySocket(socket);
    if (!seat || seat.socket !== socket) return;
    if (this.status === "waiting" || this.status === "countdown") {
      this.matchmaker.abandonSeat(this, seat, { goHome: false }).catch((err) => {
        safeLog(this.log, "error", {
          event: "match_error",
          err: asErr(err),
          userId: seat.userId,
          seat: seat.key,
          action: "abandon_disconnect",
        }, "abandonSeat failed on disconnect");
      });
      return;
    }
    const name = seat.name || "Player";
    seat.socket = null;
    this.systemChat(`${name} disconnected`);
    safeLog(this.log, "info", {
      event: "player_disconnected",
      userId: seat.userId,
      seat: seat.key,
      socketId: socket.id,
      status: this.status,
    }, "player disconnected");
    if (this.connectedSockets().length === 0) {
      this.clearDisconnectTimers();
      this.destroy();
      return;
    }
    if (this.status === "playing" && !this.sim.winner && !seat.bot) {
      this.armDisconnectGrace(seat);
    }
  }

  /** 5s grace, then reconnect wait + pause if they stay gone. */
  armDisconnectGrace(seat) {
    if (!seat || seat.socket || this.status !== "playing" || this.sim.winner) return;
    if (this.reconnectWaitSeat === seat.key) return;
    this.clearDisconnectGrace();
    this.disconnectGraceSeat = seat.key;
    safeLog(this.log, "info", {
      event: "player_disconnect_grace",
      userId: seat.userId,
      seat: seat.key,
      graceMs: DISCONNECT_GRACE_MS,
    }, "disconnect grace started");
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      this.disconnectGraceSeat = null;
      if (this.status !== "playing" || this.sim.winner || this.closing) return;
      if (seat.socket) return;
      this.beginReconnectWait(seat);
    }, DISCONNECT_GRACE_MS);
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

  /** Logged-in human vs logged-in human (not bots/guests). */
  canReportFrom(seat) {
    if (!seat || !seat.accountId || seat.bot) return false;
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    if (!other || other.bot || !other.accountId) return false;
    return true;
  }

  /**
   * In-match player report. Ack via socket `reportResult`.
   * One report per reporter→reported pair forever.
   */
  async report(socket, payload) {
    if (!allowSocketEvent(socket, "report")) {
      socket.emit("reportResult", { ok: false, error: "rate_limited" });
      return;
    }
    if (this.status === "dead" || this.closing) {
      socket.emit("reportResult", { ok: false, error: "unavailable" });
      return;
    }
    if (
      this.status !== "waiting"
      && this.status !== "countdown"
      && this.status !== "playing"
    ) {
      socket.emit("reportResult", { ok: false, error: "unavailable" });
      return;
    }
    const seat = this.seatBySocket(socket);
    if (!seat || seat.bot || !seat.accountId) {
      socket.emit("reportResult", { ok: false, error: "login_required" });
      return;
    }
    const other = seat.key === "a" ? this.seat.b : this.seat.a;
    if (!other || other.bot || !other.accountId) {
      socket.emit("reportResult", { ok: false, error: "not_reportable" });
      return;
    }
    if (seat.alreadyReported) {
      socket.emit("reportResult", { ok: false, error: "already_reported" });
      return;
    }
    const raw = payload && typeof payload === "object" ? payload.text : payload;
    const result = await createPlayerReport({
      reporterAccountId: seat.accountId,
      reporterName: seat.name,
      reportedAccountId: other.accountId,
      reportedName: other.name,
      matchId: this.id,
      matchMode: this.mode,
      body: raw,
    });
    if (!result.ok) {
      if (result.error === "already_reported") seat.alreadyReported = true;
      socket.emit("reportResult", { ok: false, error: result.error || "failed" });
      if (result.error === "already_reported") {
        socket.emit("lobby", this.lobbyFor(seat));
      }
      return;
    }
    seat.alreadyReported = true;
    safeLog(this.log, "info", {
      event: "player_reported",
      reportId: result.id,
      reporterAccountId: seat.accountId,
      reportedAccountId: other.accountId,
      matchId: this.id,
    }, "player reported");
    socket.emit("reportResult", { ok: true, id: result.id });
    socket.emit("lobby", this.lobbyFor(seat));
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

  pausePublicFor(seat) {
    const human = this.humanPauseMatch();
    const reconnectWaiting = Boolean(this.reconnectWaitEnds);
    return {
      canPause: human && this.status === "playing" && !this.sim.winner && !reconnectWaiting,
      paused: this.paused || reconnectWaiting,
      pauseWant: Boolean(this.pauseWant[seat.key]),
      unpauseWant: Boolean(this.unpauseWant[seat.key]),
      pauseAlert: this.pauseAlertSeat === seat.key,
      unpauseEnds: this.unpauseEnds,
      unpauseLeft: this.unpauseLeftMs(),
      menuPaused: this.menuPaused,
      reconnectWaiting,
      reconnectWaitEnds: this.reconnectWaitEnds,
      reconnectWaitLeft: this.reconnectWaitLeftMs(),
    };
  }

  lobbyFor(seat) {
    const chatOn = this.roomChatActive();
    const pause = this.pausePublicFor(seat);
    const canReport = this.canReportFrom(seat);
    return {
      seat: seat.key,
      status: this.status,
      mode: this.mode,
      text: this.status === "waiting" ? this.waitingText() : "",
      countdownEnds: this.countdownEnds,
      countdownLeft: this.countdownLeftMs(),
      you: seat.userId ? { id: seat.userId, name: seat.name } : null,
      opponent: this.opponentOf(seat),
      canReport,
      alreadyReported: canReport && Boolean(seat.alreadyReported),
      reportBodyMax: REPORT_BODY_MAX,
      botSettings: this.botSettingsPublic(),
      debugPlay: this.debugPlayPublic(),
      chatEnabled: chatOn,
      chatHistory: chatOn ? this.chatLog.slice() : [],
      ...pause,
    };
  }

  pushLobby() {
    const seats = [this.seat.a, this.seat.b];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      if (seat.socket) seat.socket.emit("lobby", this.lobbyFor(seat));
    }
  }

  decorateState(snap, seat = null) {
    snap.status = this.status;
    snap.countdownEnds = this.countdownEnds;
    snap.countdownLeft = this.countdownLeftMs();
    // Per-seat identity so both clients keep opponent names even if a lobby
    // event was missed (joiner often sees state before/without a clean lobby).
    if (seat) {
      snap.you = seat.userId ? { id: seat.userId, name: seat.name } : null;
      snap.opponent = this.opponentOf(seat);
    } else {
      snap.you = null;
      snap.opponent = null;
    }
    const pause = seat
      ? this.pausePublicFor(seat)
      : {
        canPause: this.humanPauseMatch() && this.status === "playing" && !this.sim.winner
          && !this.reconnectWaitEnds,
        paused: this.paused || Boolean(this.reconnectWaitEnds),
        pauseWant: false,
        unpauseWant: false,
        pauseAlert: false,
        unpauseEnds: this.unpauseEnds,
        unpauseLeft: this.unpauseLeftMs(),
        menuPaused: this.menuPaused,
        reconnectWaiting: Boolean(this.reconnectWaitEnds),
        reconnectWaitEnds: this.reconnectWaitEnds,
        reconnectWaitLeft: this.reconnectWaitLeftMs(),
      };
    Object.assign(snap, pause);
    return snap;
  }

  /** Match state for one seat (terrain fog filtered to that side). */
  publicStateFor(seat) {
    const sideId = seat && seat.sideId ? seat.sideId : "player";
    return this.decorateState(this.sim.snapshot({ forSideId: sideId }), seat);
  }

  /** Omniscient snapshot (tests / spectators). Prefer publicStateFor. */
  publicState() {
    return this.decorateState(this.sim.snapshot());
  }

  emitState(socket, snap, volatile) {
    if (volatile && socket.volatile && typeof socket.volatile.emit === "function") {
      socket.volatile.emit("state", snap);
      return;
    }
    socket.emit("state", snap);
  }

  /**
   * Push state to connected seats.
   * Interim playing updates are volatile. Countdown, the first playing
   * snapshot, concede, and any snapshot that carries a winner are reliable.
   */
  broadcastState(opts = {}) {
    this.noteOutcome();
    const seats = [this.seat.a, this.seat.b];
    const connected = [];
    for (let i = 0; i < seats.length; i += 1) {
      if (seats[i].socket) connected.push(seats[i]);
    }
    if (!connected.length) {
      if (this.sim.winner) this.winnerSent = true;
      return;
    }
    const watch = metricsEnabled();
    const t0 = watch ? performance.now() : 0;
    const sampleBytes = shouldSampleBroadcastBytes();
    const volatile = opts.volatile === true && !this.sim.winner && this.status === "playing";
    const fogOn = this.sim.fogEnabled !== false;
    let payloadForBytes = null;
    if (!fogOn) {
      for (let i = 0; i < connected.length; i += 1) {
        const snap = this.decorateState(this.sim.snapshot(), connected[i]);
        if (!payloadForBytes) payloadForBytes = snap;
        this.emitState(connected[i].socket, snap, volatile);
      }
    } else if (connected.length === 1) {
      const snap = this.publicStateFor(connected[0]);
      payloadForBytes = snap;
      this.emitState(connected[0].socket, snap, volatile);
    } else {
      const sideIds = [];
      for (let i = 0; i < connected.length; i += 1) sideIds.push(connected[i].sideId);
      const views = this.sim.snapshotViews(sideIds);
      for (let i = 0; i < connected.length; i += 1) {
        const snap = this.decorateState(views.get(connected[i].sideId), connected[i]);
        if (!payloadForBytes) payloadForBytes = snap;
        this.emitState(connected[i].socket, snap, volatile);
      }
    }
    if (this.sim.winner) this.winnerSent = true;
    if (watch) {
      let bytes = 0;
      if (sampleBytes && payloadForBytes) {
        try {
          bytes = Buffer.byteLength(JSON.stringify(payloadForBytes));
        } catch {
          bytes = 0;
        }
      }
      const troops = payloadForBytes
        ? (payloadForBytes.sides.player.troops.length + payloadForBytes.sides.enemy.troops.length)
        : 0;
      const projectiles = payloadForBytes ? payloadForBytes.projectiles.length : 0;
      noteBroadcast(performance.now() - t0, bytes, troops, projectiles);
    }
  }

  noteOutcome() {
    if (this.recorded || !this.sim.winner || this.status !== "playing") return;
    this.recorded = true;
    const winner = this.sim.winner;
    const winReason = this.sim.winReason || "capital";
    const a = this.seat.a;
    const b = this.seat.b;
    const endedAt = Date.now();
    safeLog(this.log, "info", {
      event: "match_ended",
      winnerSide: winner,
      winReason,
      durationMs: endedAt - this.createdAt,
      accountIdA: a.accountId,
      accountIdB: b.accountId,
      userIdA: a.userId,
      userIdB: b.userId,
    }, "match ended");
    let mmrAAfter = null;
    let mmrBAfter = null;
    let ranked = null;
    try {
      if (
        this.mode === "ranked"
        && a.accountId
        && b.accountId
        && Number.isFinite(a.mmr)
        && Number.isFinite(b.mmr)
      ) {
        const aScore = winner === "player" ? 1 : 0;
        const bScore = winner === "enemy" ? 1 : 0;
        const k = eloK();
        mmrAAfter = nextMmr(a.mmr, b.mmr, aScore, k);
        mmrBAfter = nextMmr(b.mmr, a.mmr, bScore, k);
        ranked = [
          { accountId: a.accountId, mmr: mmrAAfter, won: aScore === 1 },
          { accountId: b.accountId, mmr: mmrBAfter, won: bScore === 1 },
        ];
      }
    } catch (err) {
      safeLog(this.log, "error", {
        event: "match_record_failed",
        err: asErr(err),
        phase: "mmr",
      }, "MMR calculation failed");
      ranked = null;
    }
    recordMatchResult({
      ranked,
      game: {
        id: this.id,
        mode: this.mode,
        playerA: a.userId,
        playerB: b.userId,
        nameA: a.name,
        nameB: b.name,
        formbarA: a.formbarId,
        formbarB: b.formbarId,
        accountA: a.accountId,
        accountB: b.accountId,
        winnerSide: winner,
        mmrABefore: Number.isFinite(a.mmr) ? a.mmr : null,
        mmrBBefore: Number.isFinite(b.mmr) ? b.mmr : null,
        mmrAAfter,
        mmrBAfter,
        createdAt: this.createdAt,
        endedAt,
        winReason,
        outcome: winReason === "concede" ? "forfeit" : "completed",
        chatJson: this.chatArchiveJson(),
      },
    }).catch((err) => {
      safeLog(this.log, "error", {
        event: "match_record_failed",
        err: asErr(err),
        phase: "persist",
      }, "match result persist failed");
    });
  }

  destroy() {
    if (this.status === "dead") return;
    const hadWinner = Boolean(this.sim && this.sim.winner);
    safeLog(this.log, "info", {
      event: "match_cleanup",
      hadWinner,
      aliveMs: Date.now() - this.createdAt,
    }, "match cleanup");
    this.status = "dead";
    this.cancelCountdown();
    this.resetPauseState();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.matchmaker && this.matchmaker.ticker) this.matchmaker.ticker.remove(this);
    const sockets = this.connectedSockets();
    for (let i = 0; i < sockets.length; i += 1) {
      sockets[i].socket.leave(this.roomName);
    }
    this.matchmaker.remove(this);
  }
}
