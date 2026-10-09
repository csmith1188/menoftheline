import {
  getGameById,
  insertGame,
  listAdminEvents,
  listRecentGames,
  recordMmEvent,
  refundTicket,
  writeAdminEvent,
} from "../db.js";
import { parseStoredChat } from "../chat.js";
import { logger } from "../logger.js";
import { matchSummaryJson } from "../matchSummary.js";

export function enrichActiveList(matchmaker) {
  const rows = [];
  for (const room of matchmaker.rooms.values()) {
    if (room.status === "dead") continue;
    const a = room.seat.a;
    const b = room.seat.b;
    rows.push({
      id: room.id,
      mode: room.mode,
      status: room.status,
      createdAt: room.createdAt,
      startedAt: room.startedAt || null,
      durationMs: Date.now() - (room.startedAt != null ? room.startedAt : room.createdAt),
      players: [
        {
          name: a.name || null,
          accountId: a.accountId || null,
          userId: a.userId || null,
          connected: Boolean(a.socket && a.socket.connected),
        },
        {
          name: b.name || null,
          accountId: b.accountId || null,
          userId: b.userId || null,
          connected: Boolean(b.socket && b.socket.connected),
        },
      ],
      label: [a.name, b.name].filter(Boolean).join(" vs ") || "Waiting",
    });
  }
  for (const [mode, queue] of [
    ["casual", matchmaker.casual],
    ["training", matchmaker.training],
    ["ranked", matchmaker.ranked],
  ]) {
    for (const entry of queue) {
      rows.push({
        id: entry.userId,
        mode,
        status: "searching",
        createdAt: entry.joinedAt || entry.createdAt || null,
        durationMs: entry.joinedAt ? Date.now() - entry.joinedAt : null,
        players: [{
          name: entry.name,
          accountId: entry.accountId || null,
          userId: entry.userId,
          connected: true,
        }],
        label: mode === "ranked" && entry.mmr != null
          ? `${entry.name} (${entry.mmr})`
          : entry.name,
      });
    }
  }
  return rows;
}

export function queueSnapshot(matchmaker) {
  return {
    casual: matchmaker.casual.length,
    training: matchmaker.training.length,
    ranked: matchmaker.ranked.length,
    rooms: matchmaker.rooms.size,
    lobbies: matchmaker.listLobbies(),
    waiting: matchmaker.waitingCounts(),
  };
}

/**
 * Safely terminate a live room: notify, refund charged tickets, no MMR,
 * record admin_cancel game row when appropriate.
 */
export async function terminateMatch(matchmaker, matchId, {
  reason,
  adminAccountId = null,
} = {}) {
  if (!reason || !String(reason).trim()) {
    return { ok: false, error: "reason_required" };
  }
  const room = matchmaker.rooms.get(matchId);
  if (!room || room.status === "dead") {
    return { ok: false, error: "not_found" };
  }

  const wasPlaying = room.status === "playing" || room.status === "countdown";
  const charged = Boolean(room.paid && room.charged);
  const a = room.seat.a;
  const b = room.seat.b;
  const notice = `Match ended by administrator: ${String(reason).trim()}`;

  for (const seat of [a, b]) {
    if (seat.socket) {
      try {
        seat.socket.emit("chat", {
          kind: "system",
          text: notice,
          at: Date.now(),
        });
      } catch {
        /* ignore */
      }
      try {
        seat.socket.emit("go-home");
      } catch {
        /* ignore */
      }
      if (typeof matchmaker.clearPlaySession === "function") {
        matchmaker.clearPlaySession(seat.socket);
      }
    }
  }

  if (charged) {
    if (a.accountId) await refundTicket(a.accountId);
    if (b.accountId) await refundTicket(b.accountId);
    room.charged = false;
  }

  if (wasPlaying && !room.recorded) {
    room.recorded = true;
    const endedAt = Date.now();
    try {
      await insertGame({
        id: room.id,
        mode: room.mode,
        playerA: a.userId,
        playerB: b.userId,
        nameA: a.name,
        nameB: b.name,
        formbarA: a.formbarId,
        formbarB: b.formbarId,
        accountA: a.accountId,
        accountB: b.accountId,
        winnerSide: null,
        mmrABefore: Number.isFinite(a.mmr) ? a.mmr : null,
        mmrBBefore: Number.isFinite(b.mmr) ? b.mmr : null,
        mmrAAfter: null,
        mmrBAfter: null,
        createdAt: room.createdAt,
        startedAt: room.startedAt != null ? room.startedAt : room.createdAt,
        endedAt,
        winReason: "admin",
        outcome: "admin_cancel",
        mapId: room.sim?.mapId || null,
        summaryJson: room.sim ? matchSummaryJson(room.sim) : null,
        chatJson: typeof room.chatArchiveJson === "function"
          ? room.chatArchiveJson()
          : null,
      });
    } catch (err) {
      logger.error({
        event: "admin_terminate_record_failed",
        matchId: room.id,
        err: String(err && err.message || err),
      }, "failed to record admin-cancelled game");
    }
  }

  await recordMmEvent({
    event: "admin_terminate",
    mode: room.mode,
    accountId: adminAccountId,
    matchId: room.id,
    meta: { reason: String(reason).trim(), charged, wasPlaying },
  }).catch(() => {});

  await writeAdminEvent({
    level: "warn",
    event: "match_admin_terminate",
    module: "admin",
    accountId: adminAccountId,
    matchId: room.id,
    message: String(reason).trim(),
    meta: { charged, wasPlaying },
  }).catch(() => {});

  if (typeof room.destroy === "function") {
    room.destroy();
  }
  matchmaker.remove(room);

  return { ok: true, charged, wasPlaying };
}

export async function historicalGame(gameId) {
  const game = await getGameById(gameId);
  if (!game) return null;
  const events = await listAdminEvents({ matchId: gameId, pageSize: 50 });
  return {
    game,
    events: events.rows,
    chat: parseStoredChat(game.chat_json),
  };
}

/** Live room chat for admin game detail (null when not an active room). */
export function liveGameChat(matchmaker, matchId) {
  if (!matchmaker || !matchId) return null;
  const room = matchmaker.rooms.get(matchId);
  if (!room || room.status === "dead") return null;
  if (typeof room.chatArchivePublic === "function") return room.chatArchivePublic();
  return [];
}

export { listRecentGames, getGameById };
