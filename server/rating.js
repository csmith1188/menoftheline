export function nextMmr(self, opponent, score, k) {
  const expected = 1 / (1 + Math.pow(10, (opponent - self) / 400));
  const value = Math.round(self + k * (score - expected));
  return value < 0 ? 0 : value;
}

/**
 * Closest MMR pair. When that spread is inside maxSpread, take it.
 * Otherwise pair the longest searcher who has waited waitMs with their
 * closest opponent, however wide the gap.
 */
export function pickRankedPair(entries, now, maxSpread, waitMs) {
  if (!entries || entries.length < 2) return null;
  let closest = null;
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const spread = Math.abs(entries[i].mmr - entries[j].mmr);
      if (!closest || spread < closest.spread) {
        closest = { a: entries[i], b: entries[j], spread };
      }
    }
  }
  if (!closest) return null;
  if (closest.spread <= maxSpread) return closest;

  let waiter = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (now - entry.joinedAt < waitMs) continue;
    if (!waiter || entry.joinedAt < waiter.joinedAt) waiter = entry;
  }
  if (!waiter) return null;

  let opponent = null;
  let best = Infinity;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === waiter) continue;
    const spread = Math.abs(entry.mmr - waiter.mmr);
    if (spread < best) {
      best = spread;
      opponent = entry;
    }
  }
  if (!opponent) return null;
  return { a: waiter, b: opponent, spread: best };
}
