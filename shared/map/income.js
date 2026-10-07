/**
 * Lane resource payout helpers.
 *
 * Control share per lane is player push in [0, 1].
 * - shared: average shares in a group, then one lerp(min, max, share)
 * - cumulative: sum lerp(min, max, ownShare) per lane
 */

function clamp01(t) {
  if (!(t > 0)) return 0;
  if (t > 1) return 1;
  return t;
}

export function lerpResource(min, max, share) {
  const t = clamp01(share);
  return min + (max - min) * t;
}

/**
 * Variable gold/land from lane control (excludes baseIncome and banks).
 * @param {Array} lanes normalized lane defs
 * @param {Record<string, number>} sharesByLaneId player shares
 * @returns {{ player: { gold: number, land: number }, enemy: { gold: number, land: number } }}
 */
export function computeResourceIncomes(lanes, sharesByLaneId = {}) {
  const player = { gold: 0, land: 0 };
  const enemy = { gold: 0, land: 0 };
  const list = Array.isArray(lanes) ? lanes : [];

  /** @type {Map<string, { type: string, min: number, max: number, shares: number[] }>} */
  const sharedGroups = new Map();

  for (const lane of list) {
    const r = lane && lane.resource;
    if (!r || r.type == null) continue;
    const type = r.type;
    if (type !== "gold" && type !== "land") continue;
    const share = clamp01(sharesByLaneId[lane.id]);

    if (r.mode === "cumulative") {
      player[type] += lerpResource(r.min, r.max, share);
      enemy[type] += lerpResource(r.min, r.max, 1 - share);
      continue;
    }

    // shared (default)
    const key = `${type}:${r.group}`;
    let g = sharedGroups.get(key);
    if (!g) {
      g = { type, min: r.min, max: r.max, shares: [] };
      sharedGroups.set(key, g);
    }
    g.shares.push(share);
  }

  for (const g of sharedGroups.values()) {
    const combined = g.shares.reduce((a, b) => a + b, 0) / g.shares.length;
    player[g.type] += lerpResource(g.min, g.max, combined);
    enemy[g.type] += lerpResource(g.min, g.max, 1 - combined);
  }

  return { player, enemy };
}
