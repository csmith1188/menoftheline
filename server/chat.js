import { CONFIG } from "../shared/config.js";
import { matchChatEnabled, isProfaneName } from "./auth.js";
import { sanitizeUserText } from "./db.js";

export { matchChatEnabled };

function burstSize() {
  return CONFIG.chatBurst || 5;
}

function refillRate() {
  return CONFIG.chatRefillPerSec || 1;
}

function maxChars() {
  return CONFIG.chatMaxChars || 200;
}

export function chatHistoryMax() {
  return CONFIG.chatHistoryMax || 50;
}

/**
 * Sanitize a chat line. Returns "" when empty or unsuitable.
 */
export function sanitizeChatText(raw) {
  const text = sanitizeUserText(raw, { max: maxChars(), allowNewlines: false });
  if (!text) return "";
  if (isProfaneName(text)) return "";
  return text;
}

/**
 * Token bucket for chat (separate from sim commands).
 * Prefer a seat object so the limit survives socket reconnect; falls back to
 * socket.data for callers that only have a socket.
 */
export function allowChat(carrier, now = Date.now()) {
  if (!carrier) return false;
  const bucketHost = carrier.chatBucket !== undefined || carrier.key
    ? carrier
    : (carrier.data || null);
  if (!bucketHost) return false;
  const burst = burstSize();
  const rate = refillRate();
  if (!bucketHost.chatBucket) {
    bucketHost.chatBucket = { tokens: burst, at: now };
  }
  const bucket = bucketHost.chatBucket;
  const elapsed = Math.max(0, (now - bucket.at) / 1000);
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
