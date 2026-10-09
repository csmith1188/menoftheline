/**
 * Website deploy freshness: poll /api/v1/version and reload when safe.
 * Kept as its own module so entry scripts can import it without relying on
 * a possibly HTTP-cached older runtime.js (unversioned ESM URL).
 */
import { matchSeatBusy, shouldApplyAssetUpdate } from "../shared/assetUpdate.js";
import { checkVersion, isShell } from "./runtime.js";

export { matchSeatBusy, shouldApplyAssetUpdate };

export function localAssetVersion() {
  if (typeof window === "undefined") return "";
  return String(window.MOTL_ASSET_VERSION || "").trim();
}

export function showAssetUpdateBanner() {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("motl-asset-update");
  if (el) return el;
  el = document.createElement("div");
  el.id = "motl-asset-update";
  el.className = "motl-asset-update";
  el.setAttribute("role", "status");
  el.innerHTML =
    "<p>New version available. Refresh after this match.</p>" +
    '<button type="button" id="motl-asset-update-btn">Refresh</button>';
  document.body.appendChild(el);
  const btn = document.getElementById("motl-asset-update-btn");
  if (btn) {
    btn.onclick = () => {
      window.location.reload();
    };
  }
  return el;
}

const ASSET_POLL_MS = 60_000;

/**
 * Poll /api/v1/version and reload when safe, or prompt during a live seat.
 * No-op for packaged shells (local bundle does not change with website deploys).
 * @returns {() => void} stop
 */
export function watchAssetUpdates({ getBusy = () => false, intervalMs = ASSET_POLL_MS } = {}) {
  if (typeof window === "undefined" || isShell()) return () => {};
  const local = localAssetVersion();
  if (!local) return () => {};

  let stopped = false;

  async function tick() {
    if (stopped) return;
    const ver = await checkVersion().catch(() => null);
    if (!ver || stopped) return;
    const action = shouldApplyAssetUpdate(local, ver.assetVersion, {
      busy: Boolean(typeof getBusy === "function" && getBusy()),
      shell: false,
    });
    if (action === "reload") {
      window.location.reload();
      return;
    }
    if (action === "prompt") showAssetUpdateBanner();
  }

  const onVis = () => {
    if (document.visibilityState === "visible") tick();
  };
  document.addEventListener("visibilitychange", onVis);
  const id = setInterval(tick, intervalMs);
  tick();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVis);
    clearInterval(id);
  };
}
