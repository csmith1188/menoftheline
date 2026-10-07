import { CONFIG } from "../shared/config.js";
import { UNIT_STATS } from "../shared/units.js";

const COMMAND_TYPES = new Set([
  "buy",
  "bank",
  "targeting",
  "townProduce",
  "upgrade",
  "order",
]);

const ORDER_ACTIONS = new Set([
  "reform",
  "restore",
  "speedUp",
  "speedDown",
  "cycle",
  "charge",
  "fallback",
  "forward",
  "back",
  "shift",
  "lane",
  "switch",
]);

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const EVENT_LIMITS = {
  botSettings: { max: 8, windowMs: 10000 },
  debugPlay: { max: 5, windowMs: 10000 },
  tooltips: { max: 4, windowMs: 10000 },
  bgmVolume: { max: 8, windowMs: 10000 },
  concede: { max: 2, windowMs: 10000 },
  leave: { max: 4, windowMs: 10000 },
};

function burstSize() {
  const fromEnv = Number(process.env.COMMAND_BURST);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return CONFIG.commandBurst || 30;
}

function refillRate() {
  const fromEnv = Number(process.env.COMMAND_REFILL_PER_SEC);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return CONFIG.commandRefillPerSec || 20;
}

function maxBytes() {
  return CONFIG.commandMaxBytes || 4096;
}

function eventMax(fallback) {
  const fromEnv = Number(process.env.SOCKET_EVENT_LIMIT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return fallback;
}

function badKeys(obj) {
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i += 1) {
    if (BAD_KEYS.has(keys[i])) return true;
  }
  return false;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function maxSublane() {
  return Math.max(CONFIG.topSublaneCount || 1, CONFIG.bottomSublaneCount || 1);
}

/**
 * Copy only the fields the current client sends. Reject non-finite numbers,
 * nested objects, arrays, and prototype-sensitive keys. Unknown keys are dropped.
 */
export function sanitizeCommand(cmd) {
  if (!plainObject(cmd) || badKeys(cmd)) return null;
  if (typeof cmd.type !== "string" || !COMMAND_TYPES.has(cmd.type)) return null;
  const type = cmd.type;
  if (type === "buy") {
    if (cmd.lane !== "top" && cmd.lane !== "bottom") return null;
    if (typeof cmd.unit !== "string" || !Object.prototype.hasOwnProperty.call(UNIT_STATS, cmd.unit)) {
      return null;
    }
    return { type, lane: cmd.lane, unit: cmd.unit };
  }
  if (type === "bank") return { type };
  if (type === "targeting") {
    if (cmd.lane != null && cmd.lane !== "top" && cmd.lane !== "bottom") return null;
    if (cmd.mode != null && typeof cmd.mode !== "string") return null;
    if (cmd.mode != null && cmd.mode.length > 32) return null;
    const out = { type };
    if (cmd.lane != null) out.lane = cmd.lane;
    if (cmd.mode != null) out.mode = cmd.mode;
    return out;
  }
  if (type === "townProduce" || type === "upgrade") {
    const checkpointId = integer(cmd.checkpointId);
    if (checkpointId == null || checkpointId < 0) return null;
    return { type, checkpointId };
  }
  if (type === "order") {
    const troopId = integer(cmd.troopId);
    if (troopId == null || troopId < 0) return null;
    if (typeof cmd.action !== "string" || !ORDER_ACTIONS.has(cmd.action)) return null;
    const out = { type, troopId, action: cmd.action, solo: Boolean(cmd.solo) };
    if (cmd.dir != null && cmd.dir !== "") {
      const dir = Number(cmd.dir);
      if (dir !== 1 && dir !== -1) return null;
      out.dir = dir;
    }
    if (cmd.sublane != null && cmd.sublane !== "") {
      const sublane = integer(cmd.sublane);
      if (sublane == null || sublane < 0 || sublane >= maxSublane()) return null;
      out.sublane = sublane;
    }
    return out;
  }
  return null;
}

/**
 * Per-socket token bucket. A full burst matches the seat queue cap so a
 * line of orders still lands. Unknown or oversized payloads never queue.
 */
export function allowCommand(socket, cmd, now = Date.now()) {
  if (!socket || !socket.data) return false;
  const clean = sanitizeCommand(cmd);
  if (!clean) return false;
  let size = 0;
  try {
    size = JSON.stringify(clean).length;
  } catch {
    return false;
  }
  if (size > maxBytes()) return false;

  const burst = burstSize();
  const rate = refillRate();
  if (!socket.data.cmdBucket) {
    socket.data.cmdBucket = { tokens: burst, at: now };
  }
  const bucket = socket.data.cmdBucket;
  const elapsed = Math.max(0, (now - bucket.at) / 1000);
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Cheap per-socket cap for non-command events. Checked before any game work. */
export function allowSocketEvent(socket, name, now = Date.now()) {
  const spec = EVENT_LIMITS[name];
  if (!spec || !socket || !socket.data) return false;
  const max = eventMax(spec.max);
  if (!socket.data.eventBuckets) socket.data.eventBuckets = {};
  let bucket = socket.data.eventBuckets[name];
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + spec.windowMs };
    socket.data.eventBuckets[name] = bucket;
  }
  bucket.count += 1;
  return bucket.count <= max;
}
