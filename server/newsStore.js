import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { asErr, logger } from "./logger.js";

const DEFAULT_NEWS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "news.json",
);

export const NEWS_CATEGORIES = Object.freeze([
  "patch",
  "balance",
  "feature",
  "announcement",
  "other",
]);

const KNOWN_FIELDS = new Set([
  "id",
  "date",
  "title",
  "category",
  "emailSubject",
  "summary",
  "body",
  "items",
]);

/** @type {string} */
let newsFilePath = process.env.NEWS_JSON_PATH
  ? path.resolve(process.env.NEWS_JSON_PATH)
  : DEFAULT_NEWS_FILE;

/** Test helper: point the store at a temp file. */
export function setNewsFilePath(filePath) {
  newsFilePath = filePath ? path.resolve(filePath) : DEFAULT_NEWS_FILE;
}

export function getNewsFilePath() {
  return newsFilePath;
}

export function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "news";
}

export function makeNewsId(date, title, used = new Set()) {
  const day = String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const base = `${day}-${slugifyTitle(title)}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Normalize and validate one entry. Preserves unknown keys.
 * @returns {{ ok: true, entry: object } | { ok: false, error: string }}
 */
export function validateNewsEntry(raw, { usedIds = new Set(), requireId = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "entry must be an object" };
  }
  const title = String(raw.title || "").trim();
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > 200) return { ok: false, error: "title too long (max 200)" };

  let date = String(raw.date || "").trim() || todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }

  let id = String(raw.id || "").trim();
  if (id) {
    if (!/^[a-z0-9][a-z0-9-]{0,120}$/i.test(id)) {
      return { ok: false, error: "id must be a short slug (letters, numbers, hyphens)" };
    }
    id = id.toLowerCase();
    if (usedIds.has(id)) return { ok: false, error: `duplicate id: ${id}` };
    usedIds.add(id);
  } else if (requireId) {
    return { ok: false, error: "id is required" };
  } else {
    id = makeNewsId(date, title, usedIds);
  }

  let category = raw.category != null && String(raw.category).trim()
    ? String(raw.category).trim().toLowerCase()
    : "";
  if (category && !NEWS_CATEGORIES.includes(category)) {
    return {
      ok: false,
      error: `category must be one of: ${NEWS_CATEGORIES.join(", ")}`,
    };
  }

  const summary = raw.summary != null ? String(raw.summary).slice(0, 8000) : "";
  const body = raw.body != null ? String(raw.body).slice(0, 50000) : "";
  const emailSubject = raw.emailSubject != null
    ? String(raw.emailSubject).trim().slice(0, 200)
    : "";

  let items = [];
  if (raw.items != null) {
    if (!Array.isArray(raw.items)) {
      return { ok: false, error: "items must be an array of strings" };
    }
    items = raw.items.map((line) => String(line).slice(0, 500)).slice(0, 50);
  }

  const entry = { ...raw };
  entry.id = id;
  entry.date = date;
  entry.title = title;
  entry.summary = summary;
  entry.items = items;
  if (category) entry.category = category;
  else delete entry.category;
  if (body) entry.body = body;
  else delete entry.body;
  if (emailSubject) entry.emailSubject = emailSubject;
  else delete entry.emailSubject;

  return { ok: true, entry };
}

export function validateNewsArray(items) {
  if (!Array.isArray(items)) {
    return { ok: false, error: "news must be a JSON array", entries: [] };
  }
  const usedIds = new Set();
  const entries = [];
  for (let i = 0; i < items.length; i += 1) {
    const result = validateNewsEntry(items[i], { usedIds });
    if (!result.ok) {
      return { ok: false, error: `entry ${i + 1}: ${result.error}`, entries: [] };
    }
    entries.push(result.entry);
  }
  return { ok: true, entries, error: null };
}

function sortByDateDesc(entries) {
  return entries
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function readRawArray() {
  try {
    const text = fs.readFileSync(newsFilePath, "utf8");
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.filter((item) => item && item.title);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      logger.error({ event: "news_load_failed", err: asErr(err) }, "failed to load news.json");
    }
    return [];
  }
}

/** Load news for the site (validated + sorted). Missing ids are filled in-memory only. */
export function loadNews() {
  const raw = readRawArray();
  const usedIds = new Set();
  const entries = [];
  for (const item of raw) {
    const result = validateNewsEntry(item, { usedIds });
    if (result.ok) entries.push(result.entry);
  }
  return sortByDateDesc(entries);
}

export function getNewsById(id) {
  const want = String(id || "").trim().toLowerCase();
  if (!want) return null;
  return loadNews().find((e) => e.id === want) || null;
}

export function defaultEmailSubject(entry) {
  if (entry && entry.emailSubject) return String(entry.emailSubject);
  const title = entry && entry.title ? String(entry.title) : "News";
  return `Men Of The Line — ${title}`;
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy wait for short lock retries only */
  }
}

function withFileLock(fn) {
  const lockPath = `${newsFilePath}.lock`;
  const dir = path.dirname(newsFilePath);
  fs.mkdirSync(dir, { recursive: true });
  let fd = null;
  let attempts = 0;
  while (attempts < 40) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err && err.code !== "EEXIST") throw err;
      attempts += 1;
      sleepSync(25 + Math.floor(Math.random() * 25));
    }
  }
  if (fd == null) throw new Error("could not acquire news.json lock");
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

function writeArrayAtomic(entries) {
  const tmp = `${newsFilePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, newsFilePath);
}

/**
 * Ensure every entry on disk has a stable id. Returns the loaded array.
 * Writes only when ids were missing.
 */
export function ensureNewsIds({ updatedBy = null } = {}) {
  return withFileLock(() => {
    const raw = readRawArray();
    const usedIds = new Set();
    let changed = false;
    const entries = [];
    for (const item of raw) {
      const beforeId = item && item.id;
      const result = validateNewsEntry(item, { usedIds });
      if (!result.ok) continue;
      if (!beforeId || String(beforeId) !== result.entry.id) changed = true;
      entries.push(result.entry);
    }
    if (changed) {
      writeArrayAtomic(entries);
      logger.info({
        event: "news_ids_ensured",
        count: entries.length,
        updatedBy,
      }, "news.json ids ensured");
    }
    return sortByDateDesc(entries);
  });
}

/** Replace the full news array (raw JSON editor). Preserves unknown keys via validate. */
export function saveNewsArray(items, updatedBy = null) {
  const validated = validateNewsArray(items);
  if (!validated.ok) {
    const err = new Error(validated.error || "invalid news");
    err.code = "NEWS_INVALID";
    throw err;
  }
  return withFileLock(() => {
    // Re-read and merge unknown keys from disk for matching ids when possible
    const onDisk = readRawArray();
    const diskById = new Map();
    const used = new Set();
    for (const item of onDisk) {
      const r = validateNewsEntry(item, { usedIds: used });
      if (r.ok) diskById.set(r.entry.id, item);
    }
    const merged = validated.entries.map((entry) => {
      const prev = diskById.get(entry.id);
      if (!prev) return entry;
      const out = { ...prev };
      for (const key of Object.keys(entry)) {
        out[key] = entry[key];
      }
      // Drop known optional fields cleared by validation
      for (const key of KNOWN_FIELDS) {
        if (!(key in entry) && key !== "id" && key !== "date" && key !== "title" && key !== "summary" && key !== "items") {
          delete out[key];
        }
      }
      if (!entry.category) delete out.category;
      if (!entry.body) delete out.body;
      if (!entry.emailSubject) delete out.emailSubject;
      out.id = entry.id;
      out.date = entry.date;
      out.title = entry.title;
      out.summary = entry.summary;
      out.items = entry.items;
      if (entry.category) out.category = entry.category;
      if (entry.body) out.body = entry.body;
      if (entry.emailSubject) out.emailSubject = entry.emailSubject;
      return out;
    });
    writeArrayAtomic(merged);
    logger.info({
      event: "news_saved",
      count: merged.length,
      updatedBy,
    }, "news.json updated");
    return sortByDateDesc(merged);
  });
}

/** Create or update a single entry by id. */
export function upsertNewsEntry(input, updatedBy = null) {
  return withFileLock(() => {
    const raw = readRawArray();
    const usedIds = new Set();
    const current = [];
    for (const item of raw) {
      const r = validateNewsEntry(item, { usedIds: new Set([...usedIds]) });
      if (!r.ok) continue;
      usedIds.add(r.entry.id);
      current.push({ raw: item, entry: r.entry });
    }

    const wantId = input && input.id ? String(input.id).trim().toLowerCase() : "";
    const existingIdx = wantId
      ? current.findIndex((c) => c.entry.id === wantId)
      : -1;

    const usedForValidate = new Set(
      current
        .filter((_, i) => i !== existingIdx)
        .map((c) => c.entry.id),
    );
    const result = validateNewsEntry(input, { usedIds: usedForValidate });
    if (!result.ok) {
      const err = new Error(result.error);
      err.code = "NEWS_INVALID";
      throw err;
    }

    let nextRaw;
    if (existingIdx >= 0) {
      const prev = current[existingIdx].raw;
      nextRaw = { ...prev, ...result.entry };
      if (!result.entry.category) delete nextRaw.category;
      if (!result.entry.body) delete nextRaw.body;
      if (!result.entry.emailSubject) delete nextRaw.emailSubject;
      current[existingIdx] = { raw: nextRaw, entry: result.entry };
    } else {
      nextRaw = { ...result.entry };
      current.unshift({ raw: nextRaw, entry: result.entry });
    }

    const toWrite = current.map((c) => c.raw);
    writeArrayAtomic(toWrite);
    logger.info({
      event: "news_upserted",
      newsId: result.entry.id,
      updatedBy,
    }, "news entry upserted");
    return result.entry;
  });
}

export function deleteNewsEntry(id, updatedBy = null) {
  const want = String(id || "").trim().toLowerCase();
  if (!want) {
    const err = new Error("id required");
    err.code = "NEWS_INVALID";
    throw err;
  }
  return withFileLock(() => {
    const raw = readRawArray();
    const used = new Set();
    const kept = [];
    let removed = null;
    for (const item of raw) {
      const r = validateNewsEntry(item, { usedIds: used });
      if (!r.ok) continue;
      if (r.entry.id === want) {
        removed = r.entry;
        continue;
      }
      kept.push(item);
    }
    if (!removed) {
      const err = new Error("news entry not found");
      err.code = "NEWS_NOT_FOUND";
      throw err;
    }
    writeArrayAtomic(kept);
    logger.info({
      event: "news_deleted",
      newsId: want,
      updatedBy,
    }, "news entry deleted");
    return removed;
  });
}

/** Prepend a new entry (patch-notes). Assigns id; leaves other entries untouched. */
export function prependNewsEntry(input, updatedBy = null) {
  const payload = { ...input };
  delete payload.id;
  return withFileLock(() => {
    const raw = readRawArray();
    const usedIds = new Set();
    for (const item of raw) {
      const r = validateNewsEntry(item, { usedIds: new Set([...usedIds]) });
      if (r.ok) usedIds.add(r.entry.id);
    }
    const result = validateNewsEntry(payload, { usedIds });
    if (!result.ok) {
      const err = new Error(result.error);
      err.code = "NEWS_INVALID";
      throw err;
    }
    // Ensure existing entries keep their shape; only add ids if missing
    const next = [];
    const ensureUsed = new Set([result.entry.id]);
    next.push(result.entry);
    for (const item of raw) {
      const r = validateNewsEntry(item, { usedIds: ensureUsed });
      if (r.ok) next.push({ ...item, id: r.entry.id });
    }
    writeArrayAtomic(next);
    logger.info({
      event: "news_prepended",
      newsId: result.entry.id,
      updatedBy,
    }, "news entry prepended");
    return result.entry;
  });
}
