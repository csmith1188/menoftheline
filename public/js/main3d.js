import { CONFIG } from "../shared/config.js";
import { applySnapshot, createBoardState, inspectReadout, writeSouthpaw } from "./board.js";
import { bindInput } from "./input.js";
import { playCountdownBeep, playSounds, unlockAudio } from "./audio.js";
import { bindRules } from "./rules.js";
import { createScene } from "./scene3d.js";

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
const topChrome = document.getElementById("top-chrome");
const scoreEl = document.getElementById("score");
const banksPlayer = document.getElementById("banks-player");
const banksEnemy = document.getElementById("banks-enemy");
const hudEl = document.getElementById("hud");
const upgradeBar = document.getElementById("upgrade-bar");
const upgradePlayer = document.getElementById("upgrade-player");
const upgradeEnemy = document.getElementById("upgrade-enemy");
const inspectEl = document.getElementById("inspect");
const orderEl = document.getElementById("order-flash");

const rulesUi = bindRules({
  onOpen() {
    menu.classList.add("hidden");
  },
});

const scene = createScene(canvas);
const board = createBoardState(canvas);
board.directOrders = true;
function mapPointer(event) {
  const point = scene.pointerToGame(event);
  board.pickedTroopId = scene.lastPickedTroopId();
  return point;
}
board.worldPoint = mapPointer;
board.canvasPoint = mapPointer;
board.telescopeWorld = (screen) => {
  const point = scene.logicalToGame(screen);
  board.pickedTroopId = scene.lastPickedTroopId();
  return point;
};
const hitBuyAt = board.hitBuyAt.bind(board);
const hitUnlockAt = board.hitVariantUnlockAt.bind(board);
board.hitBuyAt = (point) => (board.telescope ? null : hitBuyAt(point));
board.hitVariantUnlockAt = (point) => (board.telescope ? null : hitUnlockAt(point));
board.hitBankAt = () => false;
// Ground-plane pointers are already in world space; do not shrink thresholds
// by the 2D telescope screen scale.
board.orderDragMin = function orderDragMin3d() {
  return this.uiMetrics().dragMin;
};
board.laneDragMin = function laneDragMin3d() {
  return CONFIG.laneDragMin;
};

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

function sideLine(side) {
  if (!side) return "";
  const gold = Math.floor(side.gold);
  const land = Math.floor(side.land);
  const econ = `${gold}💰 ${side.goldRateLabel()}   ${land}🌿 +${side.landIncome}/s`;
  const detail = side.economyDetail();
  return `${econ}<br><span class="mass-tax${side.netIncome() < 0 ? " over" : ""}">${detail}</span>`;
}

function syncScore() {
  if (!board.player) return;
  const pHp = Math.max(0, board.player.capitalHP);
  const eHp = Math.max(0, board.enemy.capitalHP);
  scoreEl.innerHTML = [
    `<div class="side">${sideLine(board.player)}</div>`,
    `<div class="keeps"><span class="you">${pHp}</span> — <span class="them">${eHp}</span></div>`,
    `<div class="side foe">${sideLine(board.enemy)}</div>`,
  ].join("");
  if (upgradePlayer) upgradePlayer.textContent = board.player.upgradeLabel();
  if (upgradeEnemy) upgradeEnemy.textContent = board.enemy.upgradeLabel();
}

function bankRowKey(side, clickable) {
  if (!side) return "";
  const parts = [side.banks, board.status, board.winner ? 1 : 0, clickable ? 1 : 0];
  for (let i = 0; i < CONFIG.bankCount; i += 1) {
    const open = i < side.banks;
    const next = i === side.banks;
    const timed = side.bankUnlockedByTime(i);
    const ready = next && timed && side.gold >= side.bankCost();
    const label = open
      ? "open"
      : timed
        ? String(side.bankCost())
        : side.bankCooldownLabel(i);
    parts.push(`${i}:${label}:${ready ? 1 : 0}:${next ? 1 : 0}`);
  }
  return parts.join("|");
}

function fillBanks(el, side, clickable) {
  if (!el) return;
  const key = bankRowKey(side, clickable);
  if (el.dataset.bankKey === key) return;
  el.dataset.bankKey = key;
  el.replaceChildren();
  if (!side) return;
  for (let i = 0; i < CONFIG.bankCount; i += 1) {
    const button = document.createElement("button");
    button.type = "button";
    const open = i < side.banks;
    const next = i === side.banks;
    const timed = side.bankUnlockedByTime(i);
    const ready = next && timed && side.gold >= side.bankCost();
    button.classList.toggle("open", open);
    button.classList.toggle("ready", ready && clickable);
    if (open) button.textContent = "🏛️";
    else if (!timed) button.textContent = side.bankCooldownLabel(i);
    else button.textContent = String(side.bankCost());
    // Next slot stays enabled once its unlock time hits; click handler checks gold/status.
    button.disabled = !clickable || !next || !timed;
    if (clickable && next && timed) {
      button.addEventListener("click", () => {
        if (board.winner || board.status !== "playing" || board.telescope) return;
        if (side.gold < side.bankCost()) return;
        board.onCommand({ type: "bank" });
      });
    }
    el.appendChild(button);
  }
}

function syncBanks() {
  const show = Boolean(board.player) && !board.telescope;
  banksPlayer.classList.toggle("hidden", !show);
  banksEnemy.classList.toggle("hidden", !show);
  if (!show) return;
  fillBanks(banksPlayer, board.player, true);
  fillBanks(banksEnemy, board.enemy, false);
}

function syncInspect() {
  if (!inspectEl || !orderEl) return;
  const info = board.player ? inspectReadout(board) : null;
  if (!info) {
    inspectEl.textContent = "";
  } else {
    inspectEl.textContent = info.bonuses ? `${info.main} · ${info.bonuses}` : info.main;
  }
  const call = board.orderCallout;
  if (!call || call.until <= performance.now()) {
    if (call) board.orderCallout = null;
    orderEl.textContent = info ? info.order.text : "";
    orderEl.style.color = info ? info.order.color : "";
    return;
  }
  orderEl.textContent = call.text;
  orderEl.style.color = call.color;
}

function syncChrome() {
  const waiting = board.status === "waiting";
  const countdown = board.status === "countdown";
  const playing = board.status === "playing";
  lobby.classList.toggle("hidden", !(waiting || countdown) || Boolean(board.winner));
  lobbyLeave.classList.toggle("hidden", lobby.classList.contains("hidden"));
  if (waiting) lobbyText.textContent = lobbyMessage || "Waiting for an opponent";
  if (countdown) {
    const left = Math.max(0, Math.ceil((board.countdownEnds - Date.now()) / 1000));
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
  const showHud = Boolean(board.player) && !waiting;
  topChrome.classList.toggle("hidden", !showHud);
  if (hudEl) hudEl.classList.toggle("hidden", !showHud);
  if (upgradeBar) upgradeBar.classList.toggle("hidden", !showHud);
  if (showHud) {
    syncScore();
    syncBanks();
    syncInspect();
  }
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
  try {
    if (board.player) {
      scene.sync(board);
      syncBanks();
      syncInspect();
    }
    if (board.status === "countdown") syncChrome();
  } catch (err) {
    console.error("frame error", err);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
