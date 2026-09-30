/** Isolated knobs for training matches. Does not alter shared CONFIG. */

export const TRAINING_KEEP_HP = 100;
export const TRAINING_SPEED = 0.6;
export const TRAINING_BOT_START_SEC = 30;
export const TRAINING_BOT_BUY_INTERVAL_SEC = 10;

/**
 * Apply keep HP and fixed speed once a training room is constructed.
 * Safe to call only when room.mode === "training".
 */
export function applyTrainingRules(room) {
  if (!room || room.mode !== "training") return;
  room.speedScale = TRAINING_SPEED;
  room.speedAccum = 0;
  if (room.sim && room.sim.player) {
    room.sim.player.capitalHP = TRAINING_KEEP_HP;
  }
  if (room.sim && room.sim.enemy) {
    room.sim.enemy.capitalHP = TRAINING_KEEP_HP;
  }
}
