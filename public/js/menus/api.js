import {
  PROTOCOL_VERSION,
  apiFetch,
  clearToken,
  consumeAuthQuery,
  ensureSession,
  goPlay,
  isShell,
  lobbyCreatePath,
  loginUrl,
  openExternal,
  showOutdated,
} from "../runtime.js";

export async function bootMenus() {
  consumeAuthQuery();
  await ensureSession().catch(() => {});
  const verRes = await apiFetch("/api/v1/version");
  if (verRes.ok) {
    const ver = await verRes.json();
    if (isShell() && Number(ver.minProtocol) > PROTOCOL_VERSION) {
      showOutdated(ver);
      return null;
    }
  }
  return loadMe();
}

export async function loadMe() {
  const res = await apiFetch("/api/v1/me");
  if (!res.ok) return null;
  return res.json();
}

export async function loadQueues() {
  const res = await apiFetch("/api/v1/queues");
  if (!res.ok) return { waiting: { unranked: 0, ranked: 0 }, lobbies: [] };
  return res.json();
}

export async function startPlay(mode, { view3d = false, roomId = null, matchOptions = null } = {}) {
  const body = { mode, protocol: PROTOCOL_VERSION };
  if (roomId) body.roomId = roomId;
  if (matchOptions) body.matchOptions = matchOptions;
  if (view3d) body.view = "3d";
  const res = await apiFetch("/api/v1/play", { method: "POST", json: body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 426 || data.error === "client_outdated") {
    showOutdated(data);
    return { ok: false, error: data.error || "client_outdated" };
  }
  if (!res.ok) return { ok: false, error: data.error || "play_failed", status: res.status };
  goPlay(view3d);
  return { ok: true };
}

export async function buyTickets(pin) {
  const res = await apiFetch("/api/v1/tickets", { method: "POST", json: { pin } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function logout() {
  await apiFetch("/api/v1/logout", { method: "POST", json: {} }).catch(() => {});
  clearToken();
  if (isShell()) {
    window.location.reload();
    return;
  }
  window.location.assign("/logout");
}

/** Compact shell nav (site pages use views/header.ejs instead). */
export function bindAccountBar(el, me) {
  if (!el) return;
  const player = me && me.player;
  const account = me && me.account;
  const name = (account && account.name) || (player && player.name) || "Guest";
  const tickets = account && account.tickets != null ? account.tickets : null;
  const parts = [];
  parts.push(`<a href="/app/games.html" class="active"> [ Games ]</a>`);
  if (account) {
    parts.push(`<button type="button" class="nav-link" data-act="buy">[ ${tickets != null ? tickets : 0} tickets ]</button>`);
    parts.push(`<span class="account-name">[ ${escapeHtml(name)} ]</span>`);
    parts.push(`<button type="button" class="nav-link" data-act="wiki">[ Rules ]</button>`);
    parts.push(`<button type="button" class="nav-link" data-act="logout">[ Log out ]</button>`);
  } else {
    parts.push(`<button type="button" class="nav-link" data-act="login-formbar">[ Log in ]</button>`);
    parts.push(`<button type="button" class="nav-link" data-act="signup">[ Register ]</button>`);
    parts.push(`<button type="button" class="nav-link" data-act="wiki">[ Rules ]</button>`);
  }
  el.classList.add("site-nav");
  el.innerHTML = parts.join("");
  el.onclick = (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "logout") logout();
    else if (act === "login-formbar") openExternal(loginUrl("formbar"));
    else if (act === "login-discord") openExternal(loginUrl("discord"));
    else if (act === "signup") openExternal("/signup");
    else if (act === "wiki") openExternal("/rules");
    else if (act === "buy") openExternal("/buy");
  };
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { lobbyCreatePath, openExternal };
