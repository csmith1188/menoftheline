/**
 * Allowed MMR spread for a pair given the shorter queue wait.
 */
export function allowedMmrSpread(minWaitMs, {
  maxSpread = 200,
  expandPerMs = 0.003333,
  expandCap = 800,
} = {}) {
  const wait = Math.max(0, Number(minWaitMs) || 0);
  const base = Number.isFinite(maxSpread) ? maxSpread : 200;
  const per = Number.isFinite(expandPerMs) ? expandPerMs : 0.003333;
  const cap = Number.isFinite(expandCap) ? expandCap : 800;
  return Math.min(cap, base + Math.floor(wait * per));
}

export function nextMmr(self, opponent, score, k) {
  const expected = 1 / (1 + Math.pow(10, (opponent - self) / 400));
  const value = Math.round(self + k * (score - expected));
  return value < 0 ? 0 : value;
}

/**
 * Pick a ranked pair by expanding MMR window and rematch penalty.
 *
 * @param {Array<{ mmr: number, joinedAt: number, accountId?: number, recentOpponentIds?: Set<number>|number[] }>} entries
 * @param {number} now
 * @param {object} opts
 */
export function pickRankedPair(entries, now, maxSpreadOrOpts, waitMsMaybe) {
  // Back-compat: pickRankedPair(entries, now, maxSpread, waitMs)
  const opts = maxSpreadOrOpts && typeof maxSpreadOrOpts === "object"
    ? maxSpreadOrOpts
    : {
      maxSpread: maxSpreadOrOpts,
      waitMs: waitMsMaybe,
    };
  const maxSpread = Number.isFinite(opts.maxSpread) ? opts.maxSpread : 200;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 60000;
  const expandPerMs = Number.isFinite(opts.expandPerMs) ? opts.expandPerMs : 0.003333;
  const expandCap = Number.isFinite(opts.expandCap) ? opts.expandCap : 800;
  const rematchPenalty = Number.isFinite(opts.rematchPenalty) ? opts.rematchPenalty : 10000;

  if (!entries || entries.length < 2) return null;

  let best = null;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      const spread = Math.abs(a.mmr - b.mmr);
      const minWait = Math.min(now - a.joinedAt, now - b.joinedAt);
      const allowed = allowedMmrSpread(minWait, { maxSpread, expandPerMs, expandCap });
      const rematch = isRecentRematch(a, b);
      const longWait = minWait >= waitMs;
      // Within window, or forced after long wait (even rematches / large spreads).
      if (spread > allowed && !longWait) continue;
      if (rematch && !longWait) continue;

      const score = spread + (rematch ? rematchPenalty : 0);
      if (!best || score < best.score) {
        best = { a, b, spread, score, rematch };
      }
    }
  }
  return best;
}

function opponentIdSet(entry) {
  if (!entry) return null;
  if (entry.recentOpponentIds instanceof Set) return entry.recentOpponentIds;
  if (Array.isArray(entry.recentOpponentIds)) return new Set(entry.recentOpponentIds);
  return null;
}

function isRecentRematch(a, b) {
  const aId = a.accountId;
  const bId = b.accountId;
  if (!Number.isInteger(aId) || !Number.isInteger(bId)) return false;
  const aSet = opponentIdSet(a);
  const bSet = opponentIdSet(b);
  if (aSet && aSet.has(bId)) return true;
  if (bSet && bSet.has(aId)) return true;
  return false;
}
