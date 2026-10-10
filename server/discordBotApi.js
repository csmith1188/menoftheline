/**
 * Authenticated Discord bot HTTP helpers (status / profile payloads).
 * Used by /api/v1/bot/* on the game process; the bot runs separately.
 */

import { configHealth } from "./admin/ops.js";
import { accountPlayStats, getAccountByDiscord, publicDisplayName } from "./db.js";
import { workerIndex } from "./owners.js";

export function discordBotApiToken() {
  return String(process.env.DISCORD_BOT_API_TOKEN || "").trim();
}

export function discordBotApiEnabled() {
  return Boolean(discordBotApiToken());
}

/**
 * Live matchmaking / process snapshot for this worker only.
 * @param {object} matchmaker
 * @param {object|null} io Socket.IO server
 * @param {{ health?: object }} [opts] — pass health to avoid a second configHealth() call
 */
export async function buildStatusSnapshot(matchmaker, io, { health } = {}) {
  const h = health || await configHealth();
  let playing = 0;
  let waiting = 0;
  let countdown = 0;
  let other = 0;
  const rooms = matchmaker?.rooms;
  if (rooms && typeof rooms.values === "function") {
    for (const room of rooms.values()) {
      const status = room?.status;
      if (status === "playing") playing += 1;
      else if (status === "waiting") waiting += 1;
      else if (status === "countdown") countdown += 1;
      else other += 1;
    }
  }

  const casual = matchmaker?.casual?.length || 0;
  const ranked = matchmaker?.ranked?.length || 0;
  const training = matchmaker?.training?.length || 0;
  let lobbies = 0;
  if (typeof matchmaker?.listLobbies === "function") {
    try {
      lobbies = matchmaker.listLobbies().length;
    } catch {
      lobbies = 0;
    }
  }

  const sockets = io?.engine?.clientsCount != null
    ? Number(io.engine.clientsCount) || 0
    : 0;

  return {
    version: h.version,
    nodeEnv: h.nodeEnv,
    uptimeSec: h.uptimeSec,
    matchmakingPaused: Boolean(h.matchmakingPaused),
    maintenanceMessage: h.maintenanceMessage || "",
    rooms: rooms?.size || 0,
    playing,
    waiting,
    countdown,
    other,
    queues: { casual, ranked, training },
    lobbies,
    sockets,
    workerIndex: workerIndex(),
    pid: process.pid,
  };
}

/**
 * Public MOTL profile for a Discord snowflake, or { linked: false }.
 * Tickets/held only when self is true.
 */
export async function buildProfilePayload(discordId, { self = false } = {}) {
  const key = String(discordId || "").trim();
  if (!key || key.length > 32) {
    return { linked: false };
  }
  const account = await getAccountByDiscord(key);
  if (!account) {
    return { linked: false };
  }
  const play = await accountPlayStats(account.id);
  const wins = Number(account.wins) || 0;
  const losses = Number(account.losses) || 0;
  const payload = {
    linked: true,
    id: account.id,
    name: publicDisplayName(account),
    mmr: Number(account.mmr) || 0,
    wins,
    losses,
    rankedGames: wins + losses,
    timePlayedMs: play.totalMs,
    profilePath: `/profile/${account.id}`,
  };
  if (self) {
    payload.tickets = Number(account.tickets) || 0;
    payload.held = Number(account.held) || 0;
  }
  return payload;
}
