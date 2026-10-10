/**
 * Daily UTC officer-rank recalculation with SQLite job lease (multi-worker safe).
 */
import {
  applyOfficerRankAssignments,
  claimOfficerRankJob,
  finishOfficerRankJob,
  listEligibleRankedAccounts,
  rankActiveDays,
  rankSmallPop,
} from "./db.js";
import { asErr, child as childLogger, safeLog } from "./logger.js";
import { assignOfficerRanks } from "../shared/ranks.js";
import { workerIndex } from "./owners.js";

const log = childLogger({ component: "rankJob" });

let tickTimer = null;

export function utcDayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runOfficerRankJob(day = utcDayKey()) {
  const owner = `w${workerIndex()}:${process.pid}`;
  const claimed = await claimOfficerRankJob(day, owner);
  if (!claimed) {
    safeLog(log, "debug", { event: "rank_job_skip", day, owner }, "rank job not claimed");
    return { ok: false, skipped: true, day };
  }
  try {
    const since = Date.now() - rankActiveDays() * 24 * 60 * 60 * 1000;
    const eligible = await listEligibleRankedAccounts(since);
    const sorted = eligible.map((row) => ({
      id: row.id,
      mmr: row.mmr,
      officerRank: row.officer_rank,
      highestRank: row.highest_rank,
      rankedGames: row.ranked_games,
    }));
    const assignments = assignOfficerRanks(sorted, { smallPop: rankSmallPop() });
    const result = await applyOfficerRankAssignments(day, assignments, {
      clearIneligiblePercentile: true,
      since,
    });
    await finishOfficerRankJob(day, owner, true);
    safeLog(log, "info", {
      event: "rank_job_ok",
      day,
      owner,
      eligible: sorted.length,
      changes: result.changes,
    }, "officer ranks recalculated");
    return { ok: true, day, eligible: sorted.length, changes: result.changes };
  } catch (err) {
    await finishOfficerRankJob(day, owner, false).catch(() => {});
    safeLog(log, "error", { event: "rank_job_failed", day, err: asErr(err) }, "rank job failed");
    throw err;
  }
}

export function startOfficerRankJob({ intervalMs = 60 * 1000 } = {}) {
  if (tickTimer) return;
  const tick = () => {
    runOfficerRankJob().catch(() => {});
  };
  tick();
  tickTimer = setInterval(tick, intervalMs);
  if (tickTimer.unref) tickTimer.unref();
}

export function stopOfficerRankJob() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
