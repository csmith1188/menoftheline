/** Pure helpers for website client asset-version update decisions. */

/** True while seated in a live room (do not auto-reload client assets). */
export function matchSeatBusy(status, winner) {
  if (winner) return false;
  return status === "waiting" || status === "countdown" || status === "playing";
}

/**
 * Decide how a website tab should react to a new server assetVersion.
 * @returns {"ignore" | "prompt" | "reload"}
 */
export function shouldApplyAssetUpdate(localVersion, serverVersion, { busy = false, shell = false } = {}) {
  if (shell) return "ignore";
  const local = String(localVersion || "").trim();
  const remote = String(serverVersion || "").trim();
  if (!local || !remote) return "ignore";
  if (local === remote) return "ignore";
  return busy ? "prompt" : "reload";
}
