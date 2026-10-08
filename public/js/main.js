import { applySnapshot, createBoard, writeSouthpaw, writeTerrainLabels } from "./render.js";
import {
  applyCountdownTiming,
  countdownSecondsLeft,
  reconnectSecondsLeft,
  unpauseSecondsLeft,
} from "./board.js";
import { bindInput } from "./input.js";
import {
  getBgmVolume,
  getSoundVolume,
  playCountdownBeep,
  playSounds,
  prefetchMatchBgm,
  setBgmVolume,
  setSoundVolume,
  startMatchBgm,
  stopMatchBgm,
  unlockAudio,
} from "./audio.js";
import { bindRules } from "./rules.js";
import { bindUnitInfo } from "./unitInfo.js";
import { bindChat } from "./chat.js";
import { readTooltipsDefault } from "./tooltips.js";
import { createTutorial } from "./tutorial.js";

const canvas = document.getElementById("board");
const lobby = document.getElementById("lobby");
const lobbyYou = document.getElementById("lobby-you");
const lobbyText = document.getElementById("lobby-text");
const lobbyLeave = document.getElementById("lobby-leave");
const banner = document.getElementById("banner");
const bannerText = document.getElementById("banner-text");
const leave = document.getElementById("leave");
const gear = document.getElementById("gear");
const menu = document.getElementById("menu");
const menuYou = document.getElementById("menu-you");
const oppName = document.getElementById("opp-name");
const oppKind = document.getElementById("opp-kind");
const pauseBtn = document.getElementById("pause-btn");
const concede = document.getElementById("concede");
const confirmBox = document.getElementById("confirm");
const concedeYes = document.getElementById("concede-yes");
const concedeNo = document.getElementById("concede-no");
const southpawBtn = document.getElementById("southpaw");
const tooltipsBtn = document.getElementById("tooltips");
const terrainLabelsBtn = document.getElementById("terrain-labels");
const soundVolume = document.getElementById("sound-volume");
const soundMute = document.getElementById("sound-mute");
const bgmVolume = document.getElementById("bgm-volume");
const bgmMute = document.getElementById("bgm-mute");
const training = document.getElementById("training");
const botDifficulty = document.getElementById("bot-difficulty");
const botSpeed = document.getElementById("bot-speed");
const debugPlay = document.getElementById("debug-play");
const debugSide = document.getElementById("debug-side");
const debugBots = document.getElementById("debug-bots");

let chatUi = { close() {}, applyLobby() {}, setPauseAlert() {} };
let matchMode = null;
let lastUnpauseBeep = null;

const rulesUi = bindRules({
  onOpen() {
    closeMenu();
    unitInfoUi.close();
    chatUi.close();
  },
});

const unitInfoUi = bindUnitInfo({
  onOpen() {
    closeMenu();
    rulesUi.close();
    chatUi.close();
  },
});

const board = createBoard(canvas);
board.tooltips = readTooltipsDefault();
board.onBuyInfo = (type) => unitInfoUi.open(type);
southpawBtn.setAttribute("aria-pressed", board.southpaw ? "true" : "false");
southpawBtn.addEventListener("click", () => {
  board.southpaw = !board.southpaw;
  writeSouthpaw(board.southpaw);
  southpawBtn.setAttribute("aria-pressed", board.southpaw ? "true" : "false");
  rulesUi.repaint();
});
tooltipsBtn.setAttribute("aria-pressed", board.tooltips ? "true" : "false");
tooltipsBtn.addEventListener("click", () => {
  board.tooltips = !board.tooltips;
  tooltipsBtn.setAttribute("aria-pressed", board.tooltips ? "true" : "false");
  if (!board.tooltips) board.gestureHints = null;
  socket.emit("tooltips", board.tooltips);
});
terrainLabelsBtn.setAttribute("aria-pressed", board.terrainLabels ? "true" : "false");
terrainLabelsBtn.addEventListener("click", () => {
  board.terrainLabels = !board.terrainLabels;
  writeTerrainLabels(board.terrainLabels);
  terrainLabelsBtn.setAttribute("aria-pressed", board.terrainLabels ? "true" : "false");
});

let soundBeforeMute = getSoundVolume() > 0 ? getSoundVolume() : 1;
let bgmBeforeMute = getBgmVolume() > 0 ? getBgmVolume() : 0.5;
let lastBgmStatus = null;
let syncingBotUi = false;
/** Sim side for debug bot games only; null uses seat for multiplayer mirror. */
let controlSide = null;

function syncSoundUi() {
  const volume = getSoundVolume();
  const muted = volume <= 0;
  soundVolume.value = String(Math.round(volume * 100));
  soundMute.setAttribute("aria-pressed", muted ? "true" : "false");
  soundMute.textContent = muted ? "Unmute" : "Mute";
  soundMute.title = muted ? "Unmute sound" : "Mute sound";
}

function syncBgmUi() {
  const volume = getBgmVolume();
  const muted = volume <= 0;
  bgmVolume.value = String(Math.round(volume * 100));
  bgmMute.setAttribute("aria-pressed", muted ? "true" : "false");
  bgmMute.textContent = muted ? "Unmute" : "Mute";
  bgmMute.title = muted ? "Unmute music" : "Mute music";
}

function syncMatchBgm() {
  const status = board.status;
  // Pull the multi-MB track during lobby/countdown so match sockets stay free.
  if (status === "waiting" || status === "countdown") prefetchMatchBgm();
  if (status === lastBgmStatus) return;
  lastBgmStatus = status;
  if (status === "playing") startMatchBgm();
  else stopMatchBgm();
}

function applyBotSettingsUi(settings) {
  const show = Boolean(settings);
  training.classList.toggle("hidden", !show);
  if (!settings) return;
  syncingBotUi = true;
  if (settings.difficulty) botDifficulty.value = settings.difficulty;
  if (settings.speed != null) botSpeed.value = String(settings.speed);
  syncingBotUi = false;
}

function applyDebugPlayUi(settings) {
  const show = Boolean(settings);
  debugPlay.classList.toggle("hidden", !show);
  if (!settings) {
    controlSide = null;
    return;
  }
  controlSide = settings.controlSide === "enemy" ? "enemy" : "player";
  debugSide.textContent = controlSide === "enemy" ? "Control Enemy" : "Control Player";
  const botsOn = Boolean(settings.botsEnabled);
  debugBots.setAttribute("aria-pressed", botsOn ? "false" : "true");
  debugBots.textContent = botsOn ? "Bots On" : "Bots Off";
}

syncSoundUi();
syncBgmUi();
soundVolume.addEventListener("input", () => {
  const next = Number(soundVolume.value) / 100;
  setSoundVolume(next);
  if (next > 0) soundBeforeMute = next;
  syncSoundUi();
});
soundMute.addEventListener("click", () => {
  if (getSoundVolume() > 0) {
    soundBeforeMute = getSoundVolume();
    setSoundVolume(0);
  } else {
    setSoundVolume(soundBeforeMute > 0 ? soundBeforeMute : 1);
  }
  syncSoundUi();
});
const meta = { you: null, opponent: null };
let seat = null;
let pending = null;
let lastTick = -1;
let replaced = false;
let leaving = false;
let lobbyMessage = "Connecting...";
let lastCountdownBeep = null;

// WebSocket first — default polling→upgrade leaves iPhone on HTTP long-poll
// under some networks, so 20 Hz state + commands feel dead while RAF still runs.
const socket = window.io({
  transports: ["websocket", "polling"],
});
chatUi = bindChat({
  socket,
  onOpen() {
    closeMenu();
    rulesUi.close();
    unitInfoUi.close();
  },
  onPauseClear() {
    board.pauseAlert = false;
  },
});
const tutorial = createTutorial(document.getElementById("tutorial"));
board.onCommand = (cmd) => {
  socket.emit("command", cmd);
  tutorial.noteCommand(cmd);
};
bindInput(board);

function persistBgmVolume() {
  socket.emit("bgmVolume", Math.round(getBgmVolume() * 100));
}

bgmVolume.addEventListener("input", () => {
  const next = Number(bgmVolume.value) / 100;
  setBgmVolume(next);
  if (next > 0) bgmBeforeMute = next;
  syncBgmUi();
});
bgmVolume.addEventListener("change", persistBgmVolume);
bgmMute.addEventListener("click", () => {
  if (getBgmVolume() > 0) {
    bgmBeforeMute = getBgmVolume();
    setBgmVolume(0);
  } else {
    setBgmVolume(bgmBeforeMute > 0 ? bgmBeforeMute : 0.5);
  }
  syncBgmUi();
  persistBgmVolume();
});

botDifficulty.addEventListener("change", () => {
  if (syncingBotUi) return;
  socket.emit("botSettings", { difficulty: botDifficulty.value });
});
botSpeed.addEventListener("change", () => {
  if (syncingBotUi) return;
  socket.emit("botSettings", { speed: Number(botSpeed.value) });
});

debugSide.addEventListener("click", () => {
  const next = controlSide === "enemy" ? "player" : "enemy";
  socket.emit("debugPlay", { controlSide: next });
});
debugBots.addEventListener("click", () => {
  const botsOff = debugBots.getAttribute("aria-pressed") === "true";
  socket.emit("debugPlay", { botsEnabled: botsOff });
});

function bannerCopy() {
  const iWon = board.winner === "player";
  if (board.winReason === "concede") return iWon ? "Opponent conceded" : "You conceded";
  return iWon ? "You win" : "Opponent wins";
}

function syncPauseButton() {
  if (!pauseBtn) return;
  const show = Boolean(board.canPause) && board.status === "playing" && !board.winner;
  pauseBtn.classList.toggle("hidden", !show);
  if (!show) return;
  if (board.paused) {
    pauseBtn.textContent = board.unpauseWant ? "Unpausing…" : "Unpause";
    pauseBtn.setAttribute("aria-pressed", board.unpauseWant ? "true" : "false");
    return;
  }
  if (board.pauseWant) {
    pauseBtn.textContent = "Cancel pause";
    pauseBtn.setAttribute("aria-pressed", "true");
    return;
  }
  pauseBtn.textContent = "Pause";
  pauseBtn.setAttribute("aria-pressed", "false");
}

function setSettingsOpen(open) {
  const next = Boolean(open);
  if (matchMode === "bot" || (matchMode === "training" && meta.opponent && meta.opponent.kind === "bot")) {
    socket.emit("settingsOpen", next);
  }
}

function syncChrome() {
  const waiting = board.status === "waiting";
  const countdown = board.status === "countdown";
  const playing = board.status === "playing";
  const reconnecting = playing && Boolean(board.reconnectWaiting || board.reconnectWaitEnds);
  const unpausing = playing && Boolean(board.unpauseEnds) && !reconnecting;
  const pausedBanner = playing && board.paused && !unpausing && !reconnecting;
  const showLobby = (waiting || countdown || unpausing || pausedBanner || reconnecting)
    && !board.winner;
  lobby.classList.toggle("hidden", !showLobby);
  lobbyLeave.classList.toggle(
    "hidden",
    lobby.classList.contains("hidden") || unpausing || pausedBanner || reconnecting,
  );
  if (waiting) lobbyText.textContent = lobbyMessage || "Waiting for an opponent";
  if (countdown) {
    const left = countdownSecondsLeft(board);
    lobbyText.textContent = `Match starts in ${left}`;
    if (Number.isFinite(left) && left !== lastCountdownBeep) {
      lastCountdownBeep = left;
      playCountdownBeep();
    }
  } else {
    lastCountdownBeep = null;
  }
  if (reconnecting) {
    const left = reconnectSecondsLeft(board);
    lobbyText.textContent = `Waiting for opponent to reconnect (${left})`;
    lastUnpauseBeep = null;
  } else if (unpausing) {
    const left = unpauseSecondsLeft(board);
    lobbyText.textContent = `Match resumes in ${left}`;
    if (Number.isFinite(left) && left !== lastUnpauseBeep) {
      lastUnpauseBeep = left;
      playCountdownBeep();
    }
  } else if (pausedBanner) {
    lobbyText.textContent = "Match paused";
    lastUnpauseBeep = null;
  } else {
    lastUnpauseBeep = null;
  }
  lobbyYou.textContent = meta.you ? `You are ${meta.you.name}` : "";
  const showBanner = Boolean(board.winner);
  banner.classList.toggle("hidden", !showBanner);
  if (showBanner) bannerText.textContent = bannerCopy();
  menuYou.textContent = meta.you ? meta.you.name : "";
  oppName.textContent = meta.opponent ? meta.opponent.name : "";
  oppKind.textContent = meta.opponent ? (meta.opponent.kind === "bot" ? "Bot" : "Player") : "";
  const canConcede = playing && !board.winner;
  const confirming = !confirmBox.classList.contains("hidden");
  concede.classList.toggle("hidden", !canConcede || confirming);
  if (!canConcede) confirmBox.classList.add("hidden");
  syncPauseButton();
  chatUi.setPauseAlert(Boolean(board.pauseAlert));
  syncMatchBgm();
}

function apply(snap) {
  const sounds = applySnapshot(board, snap, seat, controlSide);
  if (snap.tick !== lastTick) {
    playSounds(sounds);
    lastTick = snap.tick;
  }
  tutorial.noteState(snap);
  // Avoid DOM thrash every tick while playing; lobby/countdown/pause/end still sync.
  if (
    board.status !== "playing"
    || board.winner
    || board.paused
    || board.unpauseEnds
    || board.reconnectWaitEnds
  ) {
    syncChrome();
  } else {
    syncMatchBgm();
  }
}

let latestState = null;
let stateRaf = 0;

function flushState() {
  stateRaf = 0;
  const snap = latestState;
  latestState = null;
  if (!snap) return;
  if (!seat) {
    pending = snap;
    return;
  }
  apply(snap);
}

/** Keep only the newest snapshot when the main thread falls behind (phones). */
function queueState(snap) {
  latestState = snap;
  if (stateRaf) return;
  stateRaf = requestAnimationFrame(flushState);
}

socket.on("lobby", (lobbyState) => {
  seat = lobbyState.seat;
  meta.you = lobbyState.you;
  meta.opponent = lobbyState.opponent;
  matchMode = lobbyState.mode || null;
  applyBotSettingsUi(lobbyState.botSettings || null);
  applyDebugPlayUi(lobbyState.debugPlay || null);
  chatUi.applyLobby(lobbyState);
  if (lobbyState.text) lobbyMessage = lobbyState.text;
  board.status = lobbyState.status;
  const isTraining = lobbyState.mode === "training";
  board.trainingMode = isTraining;
  if (isTraining && lobbyState.status === "countdown") {
    tutorial.setActive(false, { board, seat, reset: true });
  } else if (isTraining && lobbyState.status === "playing") {
    tutorial.setActive(true, { board, seat });
  } else {
    tutorial.setActive(false);
  }
  applyCountdownTiming(board, lobbyState);
  if (lobbyState.status === "waiting") {
    board.winner = null;
    board.winReason = null;
    lastTick = -1;
    menu.classList.add("hidden");
    confirmBox.classList.add("hidden");
    setSettingsOpen(false);
  }
  if (pending) {
    const snap = pending;
    pending = null;
    apply(snap);
  } else {
    syncChrome();
  }
});

socket.on("state", (snap) => {
  if (!seat) {
    pending = snap;
    return;
  }
  queueState(snap);
});

socket.on("replaced", () => {
  replaced = true;
  stopMatchBgm();
  lastBgmStatus = null;
  lobbyMessage = "This match is open in another tab.";
  lobby.classList.remove("hidden");
  lobbyLeave.classList.remove("hidden");
  lobbyText.textContent = lobbyMessage;
  banner.classList.add("hidden");
  menu.classList.add("hidden");
  rulesUi.close();
  unitInfoUi.close();
  chatUi.close();
});

socket.on("go-home", () => {
  leaving = true;
  stopMatchBgm();
  window.location.assign("/");
});

socket.on("disconnect", () => {
  if (replaced || leaving) return;
  stopMatchBgm();
  lastBgmStatus = null;
  lobbyMessage = "Connection lost. Reload to rejoin.";
  lobby.classList.remove("hidden");
  lobbyLeave.classList.remove("hidden");
  lobbyText.textContent = lobbyMessage;
  banner.classList.add("hidden");
  rulesUi.close();
  unitInfoUi.close();
  chatUi.close();
});

socket.on("connect_error", (err) => {
  if (replaced || leaving || socket.connected) return;
  const detail = err && err.message ? String(err.message) : "";
  lobbyMessage = detail && detail !== "websocket error"
    ? `Could not connect (${detail}). Leave and try again.`
    : "Could not connect. Leave and try again.";
  lobby.classList.remove("hidden");
  lobbyLeave.classList.remove("hidden");
  lobbyText.textContent = lobbyMessage;
});

function askLeave() {
  if (!socket.connected) {
    leaving = true;
    stopMatchBgm();
    window.location.assign("/");
    return;
  }
  socket.emit("leave");
}

lobbyLeave.addEventListener("click", askLeave);
leave.addEventListener("click", askLeave);

function closeMenu() {
  if (menu.classList.contains("hidden")) return;
  menu.classList.add("hidden");
  gear.setAttribute("aria-expanded", "false");
  setSettingsOpen(false);
}

gear.addEventListener("click", () => {
  rulesUi.close();
  unitInfoUi.close();
  chatUi.close();
  const opening = menu.classList.contains("hidden");
  menu.classList.toggle("hidden");
  gear.setAttribute("aria-expanded", menu.classList.contains("hidden") ? "false" : "true");
  confirmBox.classList.add("hidden");
  if (board.status === "playing" && !board.winner) {
    concede.classList.remove("hidden");
    syncPauseButton();
  }
  setSettingsOpen(opening);
});

if (pauseBtn) {
  pauseBtn.addEventListener("click", () => {
    socket.emit("pause");
  });
}

concede.addEventListener("click", () => {
  concede.classList.add("hidden");
  confirmBox.classList.remove("hidden");
});

concedeNo.addEventListener("click", () => {
  confirmBox.classList.add("hidden");
  if (board.status === "playing" && !board.winner) concede.classList.remove("hidden");
});

concedeYes.addEventListener("click", () => {
  socket.emit("concede");
  closeMenu();
  confirmBox.classList.add("hidden");
});

document.addEventListener("pointerdown", () => unlockAudio());
document.addEventListener("keydown", () => unlockAudio());

document.addEventListener("pointerdown", (event) => {
  if (menu.classList.contains("hidden")) return;
  if (menu.contains(event.target) || event.target === gear) return;
  closeMenu();
});

// Warm BGM while the play page / lobby is idle (never during match sockets).
prefetchMatchBgm();

const showPerf = new URLSearchParams(window.location.search).has("perf");
let perfEl = null;
let perfFrames = 0;
let perfLast = 0;
if (showPerf) {
  perfEl = document.createElement("div");
  perfEl.id = "perf-fps";
  perfEl.setAttribute("aria-hidden", "true");
  Object.assign(perfEl.style, {
    position: "fixed",
    left: "8px",
    top: "8px",
    zIndex: "9999",
    padding: "2px 6px",
    font: "12px/1.2 monospace",
    color: "#8f8",
    background: "rgba(0,0,0,0.55)",
    pointerEvents: "none",
  });
  perfEl.textContent = "— fps";
  document.body.appendChild(perfEl);
}

function frame(now) {
  board.render();
  if (board.status === "countdown" || board.unpauseEnds || board.reconnectWaitEnds) {
    syncChrome();
  }
  if (perfEl) {
    perfFrames += 1;
    if (!perfLast) perfLast = now;
    const dt = now - perfLast;
    if (dt >= 500) {
      perfEl.textContent = `${Math.round((perfFrames * 1000) / dt)} fps`;
      perfFrames = 0;
      perfLast = now;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
