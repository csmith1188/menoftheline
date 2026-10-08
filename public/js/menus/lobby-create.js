import { bindAccountBar, bootMenus, startPlay } from "./api.js";
import { gamesPath, isShell } from "../runtime.js";

const form = document.getElementById("lobby-create-form");
const accountEl = document.getElementById("games-account");
const noticeEl = document.getElementById("games-notice");
const cancel = document.getElementById("lobby-cancel");

function setNotice(text) {
  if (!noticeEl) return;
  noticeEl.classList.toggle("hidden", !text);
  noticeEl.textContent = text || "";
}

async function fillOptions() {
  const { apiFetch } = await import("../runtime.js");
  const res = await apiFetch("/api/v1/match-options");
  if (!res.ok) return;
  const data = await res.json();
  const speed = form?.querySelector("#speed");
  const mapId = form?.querySelector("#mapId");
  const fog = form?.querySelector("#fogEnabled");
  const forts = form?.querySelector("#fortsEnabled");
  const gps = form?.querySelector("#baseGps");
  const defaults = data.defaults || {};
  if (speed && Array.isArray(data.speeds)) {
    speed.innerHTML = data.speeds.map((s) => {
      const sel = Number(defaults.speed) === Number(s) ? " selected" : "";
      return `<option value="${s}"${sel}>${s}×</option>`;
    }).join("");
  }
  if (mapId && Array.isArray(data.maps)) {
    mapId.innerHTML = data.maps.map((m) => {
      const id = m.id;
      const label = m.label || id;
      const sel = defaults.mapId === id ? " selected" : "";
      return `<option value="${id}"${sel}>${label}</option>`;
    }).join("");
  }
  if (fog) fog.value = defaults.fogEnabled ? "1" : "0";
  if (forts) forts.value = defaults.fortsEnabled ? "1" : "0";
  if (gps) {
    if (data.baseGpsMin != null) gps.min = data.baseGpsMin;
    if (data.baseGpsMax != null) gps.max = data.baseGpsMax;
    if (defaults.baseGps != null) gps.value = defaults.baseGps;
  }
  const params = new URLSearchParams(window.location.search);
  const view = form?.querySelector("#view");
  if (view && params.get("view") === "3d") view.value = "3d";
}

(async () => {
  const me = await bootMenus();
  if (accountEl && isShell()) bindAccountBar(accountEl, me);
  else if (accountEl) accountEl.replaceChildren();
  if (cancel) cancel.setAttribute("href", gamesPath());
  await fillOptions();
  if (form) {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      setNotice("");
      const fd = new FormData(form);
      const view3d = fd.get("view") === "3d";
      const result = await startPlay("listed", {
        view3d,
        matchOptions: {
          speed: Number(fd.get("speed")),
          fogEnabled: fd.get("fogEnabled") === "1",
          mapId: String(fd.get("mapId") || ""),
          fortsEnabled: fd.get("fortsEnabled") === "1",
          baseGps: Number(fd.get("baseGps")),
        },
      });
      if (!result.ok) setNotice(result.error || "Could not create lobby.");
    });
  }
})().catch((err) => {
  console.error(err);
  setNotice("Failed to load lobby form.");
});
