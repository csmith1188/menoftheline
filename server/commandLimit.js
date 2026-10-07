import { CONFIG } from "../shared/config.js";

const COMMAND_TYPES = new Set([
  "buy",
  "bank",
  "targeting",
  "townProduce",
  "upgrade",
  "order",
]);

function burstSize() {
  return CONFIG.commandBurst || 30;
}

function refillRate() {
  return CONFIG.commandRefillPerSec || 20;
}

function maxBytes() {
  return CONFIG.commandMaxBytes || 4096;
}

/**
 * Per-socket token bucket. A full burst matches the seat queue cap so a
 * line of orders still lands. Unknown or oversized payloads never queue.
 */
export function allowCommand(socket, cmd, now = Date.now()) {
  if (!socket || !socket.data) return false;
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return false;
  if (typeof cmd.type !== "string" || !COMMAND_TYPES.has(cmd.type)) return false;
  let size = 0;
  try {
    size = JSON.stringify(cmd).length;
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
