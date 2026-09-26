import { applySnapshot, createBoard, writeSouthpaw } from "./render.js";
import { applyCountdownTiming, countdownSecondsLeft } from "./board.js";
import { bindInput } from "./input.js";
import { getSoundVolume, playCountdownBeep, playSounds, setSoundVolume, unlockAudio } from "./audio.js";
import { bindRules } from "./rules.js";

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
const concede = document.getElementById("concede");
const confirmBox = document.getElementById("confirm");
const concedeYes = document.getElementById("concede-yes");
const concedeNo = document.getElementById("concede-no");
const southpawBtn = document.getElementById("southpaw");
const soundVolume = document.getElementById("sound-volume");
const soundMute = document.getElementById("sound-mute");

const rulesUi = bindRules({
  onOpen() {
    menu.classList.add("hidden");
  },
});

const board = createBoard(canvas);
southpawBtn.setAttribute("aria-pressed", board.southpaw ? "true" : "false");
southpawBtn.addEventListener("click", () => {
  board.southpaw = !board.southpaw;
  writeSouthpaw(board.southpaw);
  southpawBtn.setAttribute("aria-pressed", board.southpaw ? "true" : "false");
  rulesUi.repaint();
});

let soundBeforeMute = getSoundVolume() > 0 ? getSoundVolume() : 1;

function syncSoundUi() {
  const volume = getSoundVolume();
  const muted = volume <= 0;
  soundVolume.value = String(Math.round(volume * 100));
  soundMute.setAttribute("aria-pressed", muted ? "true" : "false");
  soundMute.textContent = muted ? "Unmute" : "Mute";
  soundMute.title = muted ? "Unmute sound" : "Mute sound";
}

syncSoundUi();
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

const socket = window.io();
board.onCommand = (cmd) => socket.emit("command", cmd);
bindInput(board);

function bannerCopy() {
  const iWon = board.winner === "player";
  if (board.winReason === "concede") return iWon ? "Opponent conceded" : "You conceded";
  return iWon ? "You win" : "Opponent wins";
}

function syncChrome() {
  const waiting = board.status === "waiting";
  const countdown = board.status === "countdown";
  const playing = board.status === "playing";
  lobby.classList.toggle("hidden", !(waiting || countdown) || Boolean(board.winner));
  lobbyLeave.classList.toggle("hidden", lobby.classList.contains("hidden"));
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
}

function apply(snap) {
  const sounds = applySnapshot(board, snap, seat);
  if (snap.tick !== lastTick) {
    playSounds(sounds);
    lastTick = snap.tick;
  }
  syncChrome();
}

socket.on("lobby", (lobbyState) => {
  seat = lobbyState.seat;
  meta.you = lobbyState.you;
  meta.opponent = lobbyState.opponent;
  if (lobbyState.text) lobbyMessage = lobbyState.text;
  board.status = lobbyState.status;
  applyCountdownTiming(board, lobbyState);
  if (lobbyState.status === "waiting") {
    board.winner = null;
    board.winReason = null;
    lastTick = -1;
    menu.classList.add("hidden");
    confirmBox.classList.add("hidden");
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
  apply(snap);
});

socket.on("replaced", () => {
  replaced = true;
  lobbyMessage = "This match is open in another tab.";
  lobby.classList.remove("hidden");
  lobbyLeave.classList.remove("hidden");
  lobbyText.textContent = lobbyMessage;
  banner.classList.add("hidden");
  menu.classList.add("hidden");
  rulesUi.close();
});

socket.on("go-home", () => {
  leaving = true;
  window.location.assign("/");
});

socket.on("disconnect", () => {
  if (replaced || leaving) return;
  lobbyMessage = "Connection lost. Reload to rejoin.";
  lobby.classList.remove("hidden");
  lobbyLeave.classList.remove("hidden");
  lobbyText.textContent = lobbyMessage;
  banner.classList.add("hidden");
  rulesUi.close();
});

function askLeave() {
  socket.emit("leave");
}

lobbyLeave.addEventListener("click", askLeave);
leave.addEventListener("click", askLeave);

gear.addEventListener("click", () => {
  rulesUi.close();
  menu.classList.toggle("hidden");
  confirmBox.classList.add("hidden");
  if (board.status === "playing" && !board.winner) concede.classList.remove("hidden");
});

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
  menu.classList.add("hidden");
  confirmBox.classList.add("hidden");
});

document.addEventListener("pointerdown", () => unlockAudio());
document.addEventListener("keydown", () => unlockAudio());

document.addEventListener("pointerdown", (event) => {
  if (menu.classList.contains("hidden")) return;
  if (menu.contains(event.target) || event.target === gear) return;
  menu.classList.add("hidden");
});

function frame() {
  board.render();
  if (board.status === "countdown") syncChrome();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
