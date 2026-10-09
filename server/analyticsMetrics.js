/**
 * Pure helpers for /admin/analytics aggregates (no DB I/O).
 */
import { UNIT_STATS } from "../shared/units.js";

/** Percentile from a sorted ascending numeric array. p in 0–100. */
export function percentileSorted(sorted, p) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  const pct = Number(p);
  if (!Number.isFinite(pct)) return null;
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return sorted[rank];
}

export function durationPercentiles(durationMs) {
  const sorted = (durationMs || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return { p50: null, p90: null, p99: null, n: 0 };
  }
  return {
    p50: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p99: percentileSorted(sorted, 99),
    n: sorted.length,
  };
}

/** Histogram buckets for matches-per-player counts. */
export function matchesPerPlayerStats(counts) {
  const arr = (counts || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const n = arr.length;
  if (!n) {
    return {
      avg: null,
      median: null,
      n: 0,
      buckets: [
        { label: "1", n: 0 },
        { label: "2-4", n: 0 },
        { label: "5-9", n: 0 },
        { label: "10+", n: 0 },
      ],
    };
  }
  const sum = arr.reduce((a, b) => a + b, 0);
  const buckets = [
    { label: "1", n: 0 },
    { label: "2-4", n: 0 },
    { label: "5-9", n: 0 },
    { label: "10+", n: 0 },
  ];
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr[i];
    if (c <= 1) buckets[0].n += 1;
    else if (c <= 4) buckets[1].n += 1;
    else if (c <= 9) buckets[2].n += 1;
    else buckets[3].n += 1;
  }
  return {
    avg: sum / n,
    median: percentileSorted(arr, 50),
    n,
    buckets,
  };
}

/**
 * Lifetime game counts for active accounts → funnel + segments.
 * @param {number[]} lifetimeCounts
 */
export function funnelAndSegments(lifetimeCounts) {
  const counts = (lifetimeCounts || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  const n = counts.length;
  let g1 = 0;
  let g2 = 0;
  let g5 = 0;
  let oneTime = 0;
  let occasional = 0;
  let regular = 0;
  let zeroGames = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const c = counts[i];
    if (c >= 1) g1 += 1;
    if (c >= 2) g2 += 1;
    if (c >= 5) g5 += 1;
    if (c <= 0) zeroGames += 1;
    else if (c === 1) oneTime += 1;
    else if (c <= 9) occasional += 1;
    else regular += 1;
  }
  return {
    funnel: { g1, g2, g5, n },
    segments: { oneTime, occasional, regular, zeroGames, n },
  };
}

/**
 * Aggregate unit/upgrade balance from games rows with summary_json + winner_side.
 * Associational only — callers should show sample sizes.
 */
export function aggregateBalanceFromSummaries(rows) {
  const units = new Map();
  const upgrades = new Map();
  let withSummary = 0;

  function unitRow(type) {
    const key = String(type || "?");
    let row = units.get(key);
    if (!row) {
      row = {
        type: key,
        deploys: 0,
        wins: 0,
        n: 0,
        bought: 0,
        survived: 0,
        dmgDealt: 0,
        dmgTaken: 0,
        kills: 0,
        goldSpent: 0,
      };
      units.set(key, row);
    }
    return row;
  }

  function touchUpgrade(kind, won) {
    const key = String(kind || "?");
    let row = upgrades.get(key);
    if (!row) {
      row = { kind: key, used: 0, wins: 0, n: 0 };
      upgrades.set(key, row);
    }
    row.used += 1;
    row.n += 1;
    if (won) row.wins += 1;
  }

  for (let i = 0; i < (rows || []).length; i += 1) {
    const g = rows[i];
    let summary;
    try {
      summary = typeof g.summary_json === "string"
        ? JSON.parse(g.summary_json)
        : g.summary_json;
    } catch {
      continue;
    }
    if (!summary || !summary.sides) continue;
    withSummary += 1;
    const winner = g.winner_side;
    for (const sideId of ["player", "enemy"]) {
      const side = summary.sides[sideId];
      if (!side) continue;
      const won = winner === sideId;
      const bought = side.bought || {};
      const types = Object.keys(bought);
      for (let t = 0; t < types.length; t += 1) {
        const type = types[t];
        const count = Number(bought[type]) || 0;
        if (count <= 0) continue;
        const u = unitRow(type);
        u.deploys += 1;
        u.n += 1;
        u.bought += count;
        u.survived += Number(side.survived?.[type]) || 0;
        u.dmgDealt += Number(side.dmgDealtByType?.[type]) || 0;
        u.dmgTaken += Number(side.dmgTakenByType?.[type]) || 0;
        u.kills += Number(side.killsByType?.[type]) || 0;
        const cost = Number(UNIT_STATS[type]?.cost) || 0;
        u.goldSpent += cost * count;
        if (won) u.wins += 1;
      }
      const ups = side.upgrades || {};
      for (const kind of ["speed", "armor", "damage"]) {
        if ((Number(ups[kind]) || 0) > 0) touchUpgrade(kind, won);
      }
    }
  }

  const unitRows = [...units.values()]
    .map((u) => ({
      ...u,
      winRate: u.n > 0 ? u.wins / u.n : null,
      avgSurvived: u.n > 0 ? u.survived / u.n : null,
      costEfficiency: u.goldSpent > 0 ? u.dmgDealt / u.goldSpent : null,
    }))
    .sort((a, b) => b.n - a.n);

  const upgradeRows = [...upgrades.values()]
    .map((u) => ({
      ...u,
      winRate: u.n > 0 ? u.wins / u.n : null,
    }))
    .sort((a, b) => b.n - a.n);

  return { units: unitRows, upgrades: upgradeRows, withSummary };
}
