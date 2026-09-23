import { applySnapshot, createBoard, writeSouthpaw } from "./render.js";
import { bindInput } from "./input.js";
import { playSounds } from "./audio.js";
import { bindRules } from "./rules.js";

const canvas = document.getElementById("board");
const lobby = document.getElementById("lobby");
const lobbyYou = document.getElementById("lobby-you");
const lobbyText = document.getElementById("lobby-text");
const playBot = document.getElementById("play-bot");
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
const meta = { you: null, opponent: null };
let seat = null;
let pending = null;
let lastTick = -1;
let replaced = false;

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
  playBot.classList.toggle("hidden", !waiting);
  if (waiting) lobbyText.textContent = "Waiting for an opponent";
  if (countdown) {
    const left = Math.max(0, Math.ceil((board.countdownEnds - Date.now()) / 1000));
    lobbyText.textContent = `Match starts in ${left}`;
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
  board.status = lobbyState.status;
  board.countdownEnds = lobbyState.countdownEnds;
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
  lobby.classList.remove("hidden");
  lobbyText.textContent = "This match is open in another tab.";
  playBot.classList.add("hidden");
  banner.classList.add("hidden");
  menu.classList.add("hidden");
  rulesUi.close();
});

socket.on("disconnect", () => {
  if (replaced) return;
  lobby.classList.remove("hidden");
  lobbyText.textContent = "Connection lost. Reload to rejoin.";
  playBot.classList.add("hidden");
  banner.classList.add("hidden");
  rulesUi.close();
});

playBot.addEventListener("click", () => socket.emit("play-bot"));
leave.addEventListener("click", () => socket.emit("leave"));

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
