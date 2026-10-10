import {
  bindAccountBar,
  bootMenus,
  loadQueues,
  lobbyCreatePath,
  startPlay,
} from "./api.js";
import { isShell, playPath } from "../runtime.js";
import { installCommunityPanel } from "../community.js";

const root = document.getElementById("games-root");
const accountEl = document.getElementById("games-account");
const noticeEl = document.getElementById("games-notice");

function setNotice(text) {
  if (!noticeEl) return;
  if (!text) {
    noticeEl.classList.add("hidden");
    noticeEl.textContent = "";
    return;
  }
  noticeEl.classList.remove("hidden");
  noticeEl.textContent = text;
}

/** Match landing.css: play-split / play-thirds style form > button children. */
function cell(attrs, label) {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => (v === true ? k : `${k}="${escapeAttr(v)}"`))
    .join(" ");
  return `<form><button type="button" ${parts}>${label}</button></form>`;
}

function render(me, queues) {
  if (!root) return;
  const rejoin = Boolean(me && me.busy);
  const canTicket = Boolean(me && me.canTicket);
  const noFree = Boolean(me && me.noFree);
  const waiting = (queues && queues.waiting) || { unranked: 0, ranked: 0 };
  const lobbies = (queues && queues.lobbies) || [];
  const privileged = Boolean(me && me.account);
  const disabled = rejoin ? "disabled" : null;
  const freePlayOk = !noFree || (canTicket && !rejoin);
  const freeTip = noFree
    ? (!privileged
      ? "Log in with a free ticket to play vs bot or random unranked."
      : "A ticket is required for Play vs bot and Random unranked.")
    : "";

  let html = `<section><h2>Play</h2><div class="stack">`;
  if (rejoin) {
    html += `<a class="action" href="${playPath(false)}">Rejoin match</a>`;
  }
  if (freePlayOk) {
    html += `
    <div class="play-split play-thirds">
      ${cell({ "data-play": "bot", "data-view": "2d", disabled }, "Play vs bot")}
      ${cell({ "data-play": "trainBot", "data-view": "2d", disabled }, "Train vs bot")}
      ${cell({ "data-play": "bot", "data-view": "3d", disabled, title: "Play vs bot in 3D", "aria-label": "Play vs bot in 3D" }, "3D")}
    </div>
    <div class="play-split play-thirds">
      ${cell({ "data-play": "casual", "data-view": "2d", disabled }, "Random unranked")}
      ${cell({ "data-play": "trainCasual", "data-view": "2d", disabled }, "Train vs random")}
      ${cell({ "data-play": "casual", "data-view": "3d", disabled, title: "Random unranked in 3D", "aria-label": "Random unranked in 3D" }, "3D")}
    </div>`;
  } else {
    html += `
    <div class="play-split play-thirds">
      <span class="has-tip" title="${escapeAttr(freeTip)}"><button type="button" disabled>Play vs bot</button></span>
      ${cell({ "data-play": "trainBot", "data-view": "2d", disabled }, "Train vs bot")}
      <span class="has-tip" title="${escapeAttr(freeTip)}"><button type="button" disabled aria-label="Play vs bot in 3D">3D</button></span>
    </div>
    <div class="play-split play-thirds">
      <span class="has-tip" title="${escapeAttr(freeTip)}"><button type="button" disabled>Random unranked</button></span>
      ${cell({ "data-play": "trainCasual", "data-view": "2d", disabled }, "Train vs random")}
      <span class="has-tip" title="${escapeAttr(freeTip)}"><button type="button" disabled aria-label="Random unranked in 3D">3D</button></span>
    </div>`;
  }

  if (privileged) {
    const tip = noFree
      ? "A ticket is required for a lobby, join, ranked, bot, or random unranked."
      : "A ticket is required for a lobby, a specific join, or ranked search.";
    const rankedOk = canTicket && !rejoin;
    if (rankedOk) {
      html += `
      <div class="play-split">
        ${cell({ "data-play": "ranked", "data-view": "2d" }, "Find ranked match")}
        ${cell({ "data-play": "ranked", "data-view": "3d", title: "Find ranked match in 3D", "aria-label": "Find ranked match in 3D" }, "3D")}
      </div>
      <div class="play-split">
        <a class="action" href="${lobbyCreatePath(false)}">Create Custom Game</a>
        <a class="action" href="${lobbyCreatePath(true)}" title="Create lobby in 3D" aria-label="Create lobby in 3D">3D</a>
      </div>`;
    } else {
      html += `
      <div class="play-split">
        <span class="has-tip" title="${escapeAttr(tip)}"><button type="button" disabled>Find ranked match</button></span>
        <span class="has-tip" title="${escapeAttr(tip)}"><button type="button" disabled aria-label="Find ranked match in 3D">3D</button></span>
      </div>
      <div class="play-split">
        <span class="has-tip" title="${escapeAttr(tip)}"><button type="button" disabled>Create lobby</button></span>
        <span class="has-tip" title="${escapeAttr(tip)}"><button type="button" disabled aria-label="Create lobby in 3D">3D</button></span>
      </div>`;
    }
  }

  html += `</div></section>
    <section class="open-games">
      <h2>Open games</h2>
      <dl class="stats open-queues">
        <div><dt>Waiting unranked</dt><dd>${waiting.unranked}</dd></div>
        <div><dt>Waiting ranked</dt><dd>${waiting.ranked}</dd></div>
      </dl>
      <br>
      <h2>Custom games</h2>`;
  if (!lobbies.length) {
    html += `<p class="hint">No custom games.</p>`;
  } else {
    html += `<ul class="list">`;
    for (const lobby of lobbies) {
      const m = lobby.match || {};
      html += `<li class="card">
        <p class="title">${escape(lobby.host)}</p>
        <dl class="lobby-match">
          <div><dt>Map</dt><dd>${escape(m.mapLabel || "—")}</dd></div>
          <div><dt>Speed</dt><dd>${escape(m.speedLabel || "—")}</dd></div>
          <div><dt>Fog</dt><dd>${m.fogEnabled ? "On" : "Off"}</dd></div>
          <div><dt>Forts</dt><dd>${m.fortsEnabled ? "On" : "Off"}</dd></div>
          <div><dt>Base GPS</dt><dd>${m.baseGps != null ? m.baseGps : "—"}</dd></div>
        </dl>`;
      if (rejoin) html += `<p class="hint">You are already in a match.</p>`;
      else if (!privileged) html += `<p class="hint">Log in to join.</p>`;
      else if (!canTicket) {
        const joinTip = "A ticket is required for a lobby, a specific join, or ranked search.";
        html += `<div class="play-split">
          <span class="has-tip" title="${escapeAttr(joinTip)}"><button type="button" disabled>Join</button></span>
          <span class="has-tip" title="${escapeAttr(joinTip)}"><button type="button" disabled aria-label="Join in 3D">3D</button></span>
        </div>`;
      } else {
        html += `<div class="play-split">
          ${cell({ "data-join": lobby.id, "data-view": "2d" }, "Join")}
          ${cell({ "data-join": lobby.id, "data-view": "3d", title: "Join in 3D", "aria-label": "Join in 3D" }, "3D")}
        </div>`;
      }
      html += `</li>`;
    }
    html += `</ul>`;
  }
  html += `</section>`;
  root.innerHTML = html;
}

function escape(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escape(text).replace(/"/g, "&quot;");
}

async function refresh() {
  const me = await bootMenus();
  if (!me && !document.getElementById("motl-outdated")) {
    setNotice("Could not load session.");
  }
  // Website pages already have the site header nav; only shells need an account strip.
  if (accountEl && isShell()) bindAccountBar(accountEl, me);
  else if (accountEl) accountEl.replaceChildren();
  const queues = await loadQueues();
  render(me, queues);
}

root?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-play],[data-join]");
  if (!btn || btn.hasAttribute("disabled")) return;
  setNotice("");
  if (btn.dataset.join) {
    const result = await startPlay("join", {
      roomId: btn.dataset.join,
      view3d: btn.dataset.view === "3d",
    });
    if (!result.ok) setNotice(result.error || "Join failed.");
    return;
  }
  if (btn.dataset.play) {
    const result = await startPlay(btn.dataset.play, { view3d: btn.dataset.view === "3d" });
    if (!result.ok) setNotice(result.error || "Could not start match.");
  }
});

refresh().catch((err) => {
  console.error(err);
  setNotice("Failed to load games menu.");
});

installCommunityPanel().catch(() => {});
