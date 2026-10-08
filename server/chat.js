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

/** Admin / persisted match log (longer than client history). */
export function chatAdminHistoryMax() {
  return CONFIG.chatAdminHistoryMax || 200;
}

/**
 * Lean JSON-safe chat lines for games.chat_json / admin UI.
 * @param {object[]} messages
 */
export function serializeChatLog(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const kind = msg.kind === "user" ? "user" : "system";
    const entry = {
      kind,
      text: String(msg.text || "").slice(0, 500),
      at: Number(msg.at) || 0,
    };
    if (msg.id != null) entry.id = String(msg.id).slice(0, 80);
    if (kind === "user" && msg.from != null) {
      const name = typeof msg.from === "string"
        ? msg.from
        : (msg.from.name != null ? String(msg.from.name) : "");
      if (name) entry.from = name.slice(0, 80);
    }
    out.push(entry);
  }
  return out;
}

/** Parse games.chat_json; returns [] on missing/invalid. */
export function parseStoredChat(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return serializeChatLog(raw);
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return serializeChatLog(parsed);
  } catch {
    return [];
  }
}

export function encodeChatJson(messages) {
  const rows = serializeChatLog(messages);
  if (!rows.length) return null;
  try {
    return JSON.stringify(rows);
  } catch {
    return null;
  }
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
