/**
 * Shared match-review helpers (viewer remap). UI formatting stays in public/js.
 */

/**
 * Remap absolute sim sides so `player` is always the local seat.
 * @param {object|null} raw
 * @param {"player"|"enemy"} mine
 */
export function viewMatchReview(raw, mine) {
  if (!raw || !raw.sides) return null;
  if (mine !== "enemy") return raw;
  return {
    ...raw,
    sides: {
      player: raw.sides.enemy,
      enemy: raw.sides.player,
    },
  };
}
