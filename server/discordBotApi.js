/**
 * Authenticated Discord bot HTTP helpers (status / profile / war effort payloads).
 * Used by /api/v1/bot/* on the game process; the bot runs separately.
 */

import { configHealth } from "./admin/ops.js";
import { accountEmailVerified, communityFundingEnabled } from "./auth.js";
import {
  accountPlayStats,
  getAccountByDiscord,
  getCommunityPublicState,
  listDiscordLinkedEmailAccounts,
  publicDisplayName,
} from "./db.js";
import { workerIndex } from "./owners.js";

/** Linked Discord + non-empty email + MOTL email verified (site rules). */
export function discordVerifiedRoleEligible(account) {
  if (!account || !account.discord_id) return false;
  const email = account.email != null ? String(account.email).trim() : "";
  if (!email) return false;
  return accountEmailVerified(account);
}

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

/**
 * Public War Effort snapshot (funding + development). No player selections.
 * Matches fields shown on /games community panel.
 */
export async function buildWarEffortPayload() {
  if (!communityFundingEnabled()) {
    return { enabled: false };
  }
  const state = await getCommunityPublicState(null);
  return {
    enabled: true,
    configured: Boolean(state.configured),
    disclaimer: state.disclaimer || "",
    round: state.round
      ? { status: state.round.status, startedAt: state.round.startedAt }
      : null,
    funding: (state.funding || []).map((g) => {
      if (!g) return null;
      return {
        title: g.title,
        description: g.description || "",
        targetTickets: g.targetTickets,
        contributedTickets: g.contributedTickets,
        percentOfTarget: g.percentOfTarget,
        status: g.status,
        goalReached: Boolean(g.goalReached),
      };
    }),
    development: (state.development || []).map((d) => {
      if (!d) return null;
      return {
        title: d.title,
        description: d.description || "",
        contributedTickets: d.contributedTickets,
        percent: d.percent,
        voteStatus: d.voteStatus,
        implStatus: d.implStatus,
      };
    }),
  };
}

/**
 * Discord snowflakes that should hold the verified role.
 * Optional discordId query: { eligible: boolean } for a single member check.
 */
export async function buildDiscordVerifiedPayload({ discordId = null } = {}) {
  const key = discordId != null ? String(discordId).trim() : "";
  if (key) {
    const account = await getAccountByDiscord(key);
    return { eligible: discordVerifiedRoleEligible(account) };
  }
  const rows = await listDiscordLinkedEmailAccounts();
  const discordIds = [];
  for (const row of rows) {
    if (discordVerifiedRoleEligible(row)) {
      discordIds.push(String(row.discord_id));
    }
  }
  return { discordIds };
}
