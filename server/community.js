/**
 * Community Funding & Development Priorities — orchestration helpers.
 * Accounting lives in db.js; this module handles broadcast throttling and
 * thin re-exports for routes.
 */

import { communityFundingEnabled } from "./auth.js";
import {
  communityPercentages,
  getCommunityHistory,
  getCommunityPublicState,
  setCommunityDirtyHook,
  setPlayerCommunitySelection,
} from "./db.js";

let ioRef = null;
let broadcastTimer = null;
let pendingBroadcast = false;
const BROADCAST_MS = 2000;

setCommunityDirtyHook(() => {
  scheduleCommunityBroadcast();
});

export function attachCommunityIo(io) {
  ioRef = io || null;
}

export function scheduleCommunityBroadcast() {
  if (!communityFundingEnabled()) return;
  pendingBroadcast = true;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    if (!pendingBroadcast || !ioRef) return;
    pendingBroadcast = false;
    try {
      const state = await getCommunityPublicState(null);
      ioRef.emit("community", { enabled: true, ...state });
    } catch {
      // Ignore broadcast failures; clients can poll.
    }
  }, BROADCAST_MS);
  if (typeof broadcastTimer.unref === "function") broadcastTimer.unref();
}

export {
  communityFundingEnabled,
  communityPercentages,
  getCommunityHistory,
  getCommunityPublicState,
  setPlayerCommunitySelection,
};
