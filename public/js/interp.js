/** Display-only motion between authoritative snapshots. */

/** Moves larger than this (pixels) snap instead of gliding. */
export const SNAP_PX = 80;
/** Shells travel faster; allow a longer glide before snapping. */
export const SHOT_SNAP_PX = 160;

/**
 * 0 at the moment a snapshot arrives, 1 after the server elapsed gap.
 * A missing gap shows the newest sample immediately.
 */
export function lerpAlpha(now, receivedAt, gapMs) {
  if (!(gapMs > 0)) return 1;
  const t = (now - receivedAt) / gapMs;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/**
 * Glide from the previous sample toward the newest one.
 * No previous sample or a large jump snaps to `next`.
 */
export function lerpPoint(prev, next, alpha, snapPx = SNAP_PX) {
  if (!next) return { x: 0, y: 0, snapped: true };
  if (!prev) return { x: next.x, y: next.y, snapped: true };
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const limit = snapPx > 0 ? snapPx : SNAP_PX;
  if (dx * dx + dy * dy > limit * limit) {
    return { x: next.x, y: next.y, snapped: true };
  }
  const t = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
  return {
    x: prev.x + dx * t,
    y: prev.y + dy * t,
    snapped: false,
  };
}

/**
 * Glide from the previous sample toward the newest one.
 * No previous sample, a row change, or a large jump snaps to `next`.
 */
export function lerpTroop(prev, next, alpha, snapPx = SNAP_PX) {
  if (!next) return { x: 0, y: 0, snapped: true };
  if (!prev || prev.lane !== next.lane || prev.sublane !== next.sublane) {
    return { x: next.x, y: next.y, snapped: true };
  }
  return lerpPoint(prev, next, alpha, snapPx);
}
