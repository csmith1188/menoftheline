import {
  bindAccountBar,
  bootMenus,
  buyTickets,
  loadQueues,
  lobbyCreatePath,
  startPlay,
} from "./api.js";

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

function render(me, queues) {
  if (!root) return;
  const rejoin = Boolean(me && me.busy);
  const canTicket = Boolean(me && me.canTicket);
  const waiting = (queues && queues.waiting) || { unranked: 0, ranked: 0 };
  const lobbies = (queues && queues.lobbies) || [];
  const privileged = Boolean(me && me.account);

  let html = `<section><h2>Play</h2><div class="stack">`;
  if (rejoin) {
    html += `<a class="action" href="${me && me.busy ? (window.MOTL_SHELL ? "/app/play.html" : "/play") : "#"}">Rejoin match</a>`;
  }
  html += `
    <div class="play-split play-thirds">
      <button type="button" class="action" data-play="bot" data-view="2d" ${rejoin ? "disabled" : ""}>Play vs bot</button>
      <button type="button" class="action" data-play="trainBot" data-view="2d" ${rejoin ? "disabled" : ""}>Train vs bot</button>
      <button type="button" class="action" data-play="bot" data-view="3d" ${rejoin ? "disabled" : ""}>3D</button>
    </div>
    <div class="play-split play-thirds">
      <button type="button" class="action" data-play="casual" data-view="2d" ${rejoin ? "disabled" : ""}>Random unranked</button>
      <button type="button" class="action" data-play="trainCasual" data-view="2d" ${rejoin ? "disabled" : ""}>Train vs random</button>
      <button type="button" class="action" data-play="casual" data-view="3d" ${rejoin ? "disabled" : ""}>3D</button>
    </div>`;

  if (privileged) {
    const tip = "A ticket is required for ranked or custom games.";
    html += `
      <div class="play-split">
        <button type="button" class="action" data-play="ranked" data-view="2d" ${canTicket && !rejoin ? "" : "disabled"} title="${tip}">Find ranked match</button>
        <button type="button" class="action" data-play="ranked" data-view="3d" ${canTicket && !rejoin ? "" : "disabled"}>3D</button>
      </div>
      <div class="play-split">
        <a class="action" href="${lobbyCreatePath(false)}" ${canTicket && !rejoin ? "" : 'aria-disabled="true"'}>Create Custom Game</a>
        <a class="action" href="${lobbyCreatePath(true)}">3D</a>
      </div>
      <div class="ticket-buy">
        <label>Buy Digipog tickets <input id="ticket-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN"></label>
        <button type="button" class="action" data-act="tickets">Buy pack</button>
      </div>`;
  }

  html += `</div></section>
    <section class="open-games">
      <h2>Open games</h2>
      <dl class="stats open-queues">
        <div><dt>Waiting unranked</dt><dd>${waiting.unranked}</dd></div>
        <div><dt>Waiting ranked</dt><dd>${waiting.ranked}</dd></div>
      </dl>
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
      else if (!canTicket) html += `<p class="hint">A ticket is required to join.</p>`;
      else {
        html += `<div class="play-split">
          <button type="button" class="action" data-join="${escapeAttr(lobby.id)}" data-view="2d">Join</button>
          <button type="button" class="action" data-join="${escapeAttr(lobby.id)}" data-view="3d">3D</button>
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
  bindAccountBar(accountEl, me);
  const queues = await loadQueues();
  render(me, queues);
}

root?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-play],[data-join],[data-act]");
  if (!btn) return;
  if (btn.hasAttribute("disabled")) return;
  setNotice("");
  if (btn.dataset.act === "tickets") {
    const pin = document.getElementById("ticket-pin")?.value || "";
    const result = await buyTickets(pin);
    if (!result.ok) {
      setNotice(result.data?.error || "Ticket purchase failed.");
      return;
    }
    setNotice("Tickets purchased.");
    await refresh();
    return;
  }
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
