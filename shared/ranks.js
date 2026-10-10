/**
 * Napoleonic officer ranks for ranked ladder (not in-match officer units).
 * Shared by server (assignment) and clients (dossier / lobby display).
 */

/** Lowest → highest order index. */
export const OFFICER_RANKS = Object.freeze([
  Object.freeze({ id: "ensign", label: "Ensign", order: 0 }),
  Object.freeze({ id: "lieutenant", label: "Lieutenant", order: 1 }),
  Object.freeze({ id: "captain", label: "Captain", order: 2 }),
  Object.freeze({ id: "major", label: "Major", order: 3 }),
  Object.freeze({ id: "lieutenant_colonel", label: "Lieutenant Colonel", order: 4 }),
  Object.freeze({ id: "colonel", label: "Colonel", order: 5 }),
  Object.freeze({ id: "major_general", label: "Major General", order: 6 }),
  Object.freeze({ id: "lieutenant_general", label: "Lieutenant General", order: 7 }),
  Object.freeze({ id: "general", label: "General", order: 8 }),
]);

const BY_ID = new Map(OFFICER_RANKS.map((r) => [r.id, r]));

/**
 * Full population bands: share of eligible players from top (General) to bottom (Ensign).
 * Shares sum to 1.0.
 */
export const FULL_RANK_BANDS = Object.freeze([
  Object.freeze({ id: "general", share: 0.01 }),
  Object.freeze({ id: "lieutenant_general", share: 0.03 }),
  Object.freeze({ id: "major_general", share: 0.06 }),
  Object.freeze({ id: "colonel", share: 0.15 }),
  Object.freeze({ id: "lieutenant_colonel", share: 0.25 }),
  Object.freeze({ id: "major", share: 0.25 }),
  Object.freeze({ id: "captain", share: 0.15 }),
  Object.freeze({ id: "lieutenant", share: 0.07 }),
  Object.freeze({ id: "ensign", share: 0.03 }),
]);

/** Small population (< RANK_SMALL_POP): Major / Lt Col / Colonel = 25% / 50% / 25%. */
export const SMALL_POP_RANK_BANDS = Object.freeze([
  Object.freeze({ id: "colonel", share: 0.25 }),
  Object.freeze({ id: "lieutenant_colonel", share: 0.50 }),
  Object.freeze({ id: "major", share: 0.25 }),
]);

export function rankById(id) {
  return BY_ID.get(id) || null;
}

export function rankLabel(id) {
  const r = rankById(id);
  return r ? r.label : "Ensign";
}

export function rankOrder(id) {
  const r = rankById(id);
  return r ? r.order : 0;
}

export function isHigherRank(a, b) {
  return rankOrder(a) > rankOrder(b);
}

export function normalizeRankId(id) {
  return rankById(id) ? id : "ensign";
}

/** True while placements incomplete (hidden MMR). */
export function isProvisional(placementsDone) {
  return !placementsDone;
}

/**
 * @param {number} rankedGames
 * @param {number} placementMatches
 * @returns {{ done: boolean, current: number, total: number, label: string }}
 */
export function placementProgress(rankedGames, placementMatches = 10) {
  const total = Math.max(1, Math.round(Number(placementMatches) || 10));
  const current = Math.min(total, Math.max(0, Math.round(Number(rankedGames) || 0)));
  const done = current >= total;
  return {
    done,
    current,
    total,
    label: done
      ? "Commissioned"
      : `Commission Pending: ${current}/${total} Battles`,
  };
}

/**
 * Map sorted index i (0 = highest MMR) into a band id.
 * Uses floor cutoffs; remaining tail goes to the last band.
 *
 * @param {number} index
 * @param {number} n
 * @param {ReadonlyArray<{ id: string, share: number }>} bands
 */
export function rankOfIndex(index, n, bands) {
  if (!Number.isInteger(n) || n <= 0) return "ensign";
  if (!Number.isInteger(index) || index < 0) return bands[bands.length - 1]?.id || "ensign";
  if (index >= n) return bands[bands.length - 1]?.id || "ensign";
  if (n === 1) return bands[0]?.id || "ensign";

  let cumulative = 0;
  for (let b = 0; b < bands.length; b += 1) {
    const isLast = b === bands.length - 1;
    if (isLast) return bands[b].id;
    const count = Math.floor(n * bands[b].share);
    const end = cumulative + count;
    if (index < end) return bands[b].id;
    cumulative = end;
  }
  return bands[bands.length - 1].id;
}

/**
 * Percentile standing: 100 = top, approaching 0 at bottom.
 * Deterministic from sorted index.
 */
export function percentileOfIndex(index, n) {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (n === 1) return 100;
  const i = Math.max(0, Math.min(n - 1, index));
  return Math.round(((n - 1 - i) / (n - 1)) * 1000) / 10;
}

export function bandsForPopulation(n, smallPopThreshold = 100) {
  const threshold = Math.max(1, Math.round(Number(smallPopThreshold) || 100));
  return n < threshold ? SMALL_POP_RANK_BANDS : FULL_RANK_BANDS;
}

/** Short tag for lobby / HUD: "Captain" or "Ensign (placing)". */
export function formatOfficerTag(identity) {
  if (!identity) return "";
  const label = rankLabel(identity.officerRank || "ensign");
  if (identity.placementsDone === false || identity.mmrHidden) {
    return `${label} · placing`;
  }
  if (identity.mmr != null && Number.isFinite(Number(identity.mmr))) {
    return `${label} · ${identity.mmr}`;
  }
  return label;
}

/**
 * Assign ranks to a sorted eligible list (highest MMR first).
 * @param {Array<{ id: number, mmr: number, officerRank?: string, highestRank?: string }>} sorted
 * @param {{ smallPop?: number }} [opts]
 */
export function assignOfficerRanks(sorted, opts = {}) {
  const n = sorted.length;
  const bands = bandsForPopulation(n, opts.smallPop);
  return sorted.map((row, index) => {
    const officerRank = rankOfIndex(index, n, bands);
    const percentile = percentileOfIndex(index, n);
    const prevHighest = normalizeRankId(row.highestRank || row.officerRank || "ensign");
    const highestRank = isHigherRank(officerRank, prevHighest) ? officerRank : prevHighest;
    return {
      accountId: row.id,
      mmr: row.mmr,
      officerRank,
      highestRank,
      percentile,
      previousRank: normalizeRankId(row.officerRank || "ensign"),
    };
  });
}
