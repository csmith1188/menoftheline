import { performance } from "node:perf_hooks";
import { noteAggregateTick } from "./metrics.js";

/**
 * One wall-clock loop for every playing room.
 * If a frame runs long, the next frame waits until this one finishes.
 * Missed intervals are recorded and not replayed as a burst of ticks.
 */
export class MatchTicker {
  constructor(intervalMs = 50) {
    this.intervalMs = intervalMs;
    this.rooms = new Set();
    this.timer = null;
    this.stopped = false;
    this.overrunMs = 0;
    this.lastTickMs = 0;
  }

  add(room) {
    this.rooms.add(room);
    this.stopped = false;
    if (!this.timer) this.arm(this.intervalMs);
  }

  remove(room) {
    this.rooms.delete(room);
    if (this.rooms.size === 0) this.stop();
  }

  arm(wait) {
    this.timer = setTimeout(() => this.frame(), wait);
    if (this.timer.unref) this.timer.unref();
  }

  frame() {
    this.timer = null;
    if (this.stopped || this.rooms.size === 0) return;
    const started = performance.now();
    for (const room of this.rooms) {
      room.tick();
    }
    const spent = performance.now() - started;
    this.lastTickMs = spent;
    if (spent > this.intervalMs) this.overrunMs += spent - this.intervalMs;
    noteAggregateTick(spent, this.overrunMs);
    if (this.stopped || this.rooms.size === 0) return;
    this.arm(Math.max(0, this.intervalMs - spent));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
