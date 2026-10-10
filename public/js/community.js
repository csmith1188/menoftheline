/**
 * Community Funding & Development Priorities — /games site UI.
 * Match clients (/play) are intentionally untouched.
 */

import { apiFetch } from "./runtime.js";

const SLOT_CLASS = ["slot-blue", "slot-green", "slot-red"];

let root = null;
let fundingEl = null;
let devEl = null;
let disclaimerEl = null;
let historyBtn = null;
let historyDlg = null;
let historyBody = null;
let historyClose = null;
let state = null;
let canSelect = false;

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedFundingId() {
  return state?.selections?.fundingGoalId ?? null;
}

function selectedDevId() {
  return state?.selections?.devPriorityId ?? null;
}

function renderCell(kind, cell, slot) {
  if (!cell) {
    return `<div class="community-cell ${SLOT_CLASS[slot]} empty" role="listitem">
      <p class="community-cell-title">Not configured</p>
    </div>`;
  }
  const selected = kind === "funding"
    ? Number(selectedFundingId()) === Number(cell.id)
    : Number(selectedDevId()) === Number(cell.id);
  const bar = kind === "funding"
    ? Number(cell.barPercent) || 0
    : Number(cell.percent) || 0;
  const summary = kind === "funding"
    ? `${cell.contributedTickets}/${cell.targetTickets} tickets`
      + (cell.percentOfTarget != null ? ` (${cell.percentOfTarget}%)` : "")
    : `${cell.percent}%`
      + (cell.contributedTickets != null ? ` · ${cell.contributedTickets} tickets` : "");
  const badges = [];
  if (selected) badges.push('<span class="community-badge selected-mark" aria-hidden="true">✓</span>');
  if (kind === "funding" && cell.goalReached) {
    badges.push('<span class="community-badge reached">Goal reached</span>');
  }
  if (kind === "funding" && cell.status === "fulfilled") {
    badges.push('<span class="community-badge fulfilled">Fulfilled</span>');
  }
  const interactive = canSelect && state?.configured;
  const tag = interactive ? "button" : "div";
  const attrs = interactive
    ? `type="button" data-kind="${kind}" data-id="${cell.id}" aria-pressed="${selected ? "true" : "false"}`
    : `role="listitem"`;
  return `<${tag} class="community-cell ${SLOT_CLASS[slot]}${selected ? " selected" : ""}${interactive ? " pickable" : ""}" ${attrs}>
    <div class="community-cell-head">
      <p class="community-cell-title">${esc(cell.title)}</p>
      <span class="community-badges">${badges.join("")}</span>
    </div>
    <p class="community-cell-desc">${esc(cell.description)}</p>
    <div class="community-track" aria-hidden="true"><div class="community-fill" style="width:${bar}%"></div></div>
    <p class="community-cell-summary">${esc(summary)}</p>
  </${tag}>`;
}

function render() {
  if (!root || !state) return;
  root.hidden = false;
  if (disclaimerEl) {
    disclaimerEl.textContent = state.disclaimer
      || "Funding progress counts eligible paid tickets spent — not verified cash held in reserve.";
  }
  if (fundingEl) {
    fundingEl.innerHTML = [0, 1, 2]
      .map((slot) => renderCell("funding", state.funding?.[slot], slot))
      .join("");
  }
  if (devEl) {
    devEl.innerHTML = [0, 1, 2]
      .map((slot) => renderCell("dev", state.development?.[slot], slot))
      .join("");
  }
}

async function loadState() {
  const res = await apiFetch("/api/v1/community");
  if (!res.ok) return;
  state = await res.json();
  if (!state || state.enabled === false) {
    if (root) root.hidden = true;
    return;
  }
  canSelect = Boolean(state.selections);
  render();
}

async function select(kind, id) {
  if (!canSelect) return;
  const body = kind === "funding"
    ? { fundingGoalId: Number(id) }
    : { devPriorityId: Number(id) };
  const res = await apiFetch("/api/v1/community/select", { method: "POST", json: body });
  if (!res.ok) return;
  const data = await res.json();
  if (data.state) state = data.state;
  else if (data.selections && state) state.selections = data.selections;
  canSelect = Boolean(state?.selections);
  render();
}

async function openHistory() {
  if (!historyDlg || !historyBody) return;
  historyBody.innerHTML = "<p class=\"hint\">Loading…</p>";
  historyDlg.classList.remove("hidden");
  const res = await apiFetch("/api/v1/community/history");
  if (!res.ok) {
    historyBody.innerHTML = "<p class=\"hint\">Could not load history.</p>";
    return;
  }
  const data = await res.json();
  const funding = (data.funding || []).map((g) => {
    const reached = g.goalReached ? "Target reached" : "Target not reached";
    const fulfilled = g.status === "fulfilled" || g.fulfilledAt
      ? `Fulfilled${g.fulfillmentNotes ? `: ${esc(g.fulfillmentNotes)}` : ""}`
      : "Not yet fulfilled";
    return `<article class="community-history-item">
      <h3>${esc(g.title)}</h3>
      <p>${esc(g.description)}</p>
      <p>${g.contributedTickets}/${g.targetTickets || g.originalTargetTickets || "?"} tickets — ${reached}. ${fulfilled}</p>
    </article>`;
  }).join("") || "<p class=\"hint\">No funding history yet.</p>";

  const rounds = (data.rounds || []).map((r) => {
    const rows = (r.priorities || []).map((p) => {
      const mark = Number(p.id) === Number(r.winnerPriorityId) ? " (winner)" : "";
      return `<li>${esc(p.title)} — ${p.percent}%${mark}${p.implStatus ? ` · ${esc(p.implStatus)}` : ""}</li>`;
    }).join("");
    return `<article class="community-history-item">
      <h3>Round #${r.id}</h3>
      <p>Closed ${r.closedAt ? new Date(r.closedAt).toLocaleDateString() : "—"}</p>
      <ul>${rows}</ul>
    </article>`;
  }).join("") || "<p class=\"hint\">No development rounds yet.</p>";

  historyBody.innerHTML = `
    <h3 class="community-history-section">Funding</h3>
    ${funding}
    <h3 class="community-history-section">Development</h3>
    ${rounds}`;
}

function closeHistory() {
  historyDlg?.classList.add("hidden");
}

function onClick(ev) {
  const cell = ev.target.closest(".community-cell.pickable");
  if (cell) {
    select(cell.dataset.kind, cell.dataset.id);
  }
}

/** Mount War Effort UI on the /games page (#community-root). No-op when gated off. */
export function installCommunityPanel(mountRoot = null) {
  root = mountRoot || document.getElementById("community-root");
  if (!root) return;

  if (!root.querySelector("#community-funding")) {
    root.innerHTML = `
      <section class="community-panel" aria-label="Community funding and development">
        <div class="community-panel-head">
          <h2>War Effort</h2>
          <a href="#community-history" id="community-history-btn" class="community-history-link">History</a>
        </div>
        <p class="hint" id="community-disclaimer"></p>
        <section class="community-row" aria-labelledby="community-funding-heading">
          <h3 id="community-funding-heading" class="community-row-title">Fund the War Effort</h3>
          <div id="community-funding" class="community-grid" role="list"></div>
        </section>
        <section class="community-row" aria-labelledby="community-dev-heading">
          <h3 id="community-dev-heading" class="community-row-title">Shape the Future</h3>
          <div id="community-dev" class="community-grid" role="list"></div>
        </section>
      </section>
      <div id="community-history" class="community-history hidden" role="dialog" aria-modal="true" aria-labelledby="community-history-title">
        <div class="community-history-card">
          <div class="community-history-head">
            <h2 id="community-history-title">Past campaigns</h2>
            <button type="button" id="community-history-close" class="action">Close</button>
          </div>
          <div id="community-history-body" class="community-history-body"></div>
        </div>
      </div>`;
  }

  fundingEl = document.getElementById("community-funding");
  devEl = document.getElementById("community-dev");
  disclaimerEl = document.getElementById("community-disclaimer");
  historyBtn = document.getElementById("community-history-btn");
  historyDlg = document.getElementById("community-history");
  historyBody = document.getElementById("community-history-body");
  historyClose = document.getElementById("community-history-close");

  historyBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    openHistory();
  });
  historyClose?.addEventListener("click", () => closeHistory());
  historyDlg?.addEventListener("click", (ev) => {
    if (ev.target === historyDlg) closeHistory();
  });
  root.addEventListener("click", onClick);

  return loadState().catch(() => {});
}

export function refreshCommunityPanel() {
  return loadState().catch(() => {});
}
