import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataPath = path.join(root, "data");
export const dbFile = path.join(dataPath, "Men Of The Line.sqlite");

const ADJECTIVES = ["Ash", "Bold", "Bright", "Calm", "Coral", "Dusk", "Fair", "Gold", "Keen", "Lone", "Mist", "Noble", "Quick", "Red", "Silver", "Storm", "Swift", "Wild"];
const NOUNS = ["Badger", "Crane", "Falcon", "Fox", "Heron", "Lynx", "Otter", "Pike", "Raven", "Seal", "Stag", "Wolf"];

let db;

function open() {
  fs.mkdirSync(dataPath, { recursive: true });
  const database = new sqlite3.Database(dbFile);
  database.configure("busyTimeout", 5000);
  return database;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

export function startingMmr() {
  const n = Number(process.env.STARTING_MMR);
  return Number.isFinite(n) ? Math.round(n) : 1000;
}

export function ticketPack() {
  const size = Number(process.env.TICKET_PACK_SIZE);
  const cost = Number(process.env.TICKET_PACK_COST);
  return {
    size: Number.isInteger(size) && size > 0 ? size : 5,
    cost: Number.isInteger(cost) && cost > 0 ? cost : 100,
  };
}

export function eloK() {
  const n = Number(process.env.ELO_K);
  return Number.isFinite(n) && n > 0 ? n : 32;
}

export async function initDb() {
  db = open();
  await run("PRAGMA journal_mode = WAL");
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS accounts (
    formbar_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    mmr INTEGER NOT NULL,
    tickets INTEGER NOT NULL DEFAULT 0,
    held INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    player_a TEXT,
    player_b TEXT,
    name_a TEXT,
    name_b TEXT,
    formbar_a INTEGER,
    formbar_b INTEGER,
    winner_side TEXT,
    mmr_a_before INTEGER,
    mmr_b_before INTEGER,
    mmr_a_after INTEGER,
    mmr_b_after INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS ticket_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    formbar_id INTEGER NOT NULL,
    digipogs INTEGER NOT NULL,
    tickets INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    formbar_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    is_bug INTEGER NOT NULL DEFAULT 0,
    repro TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS wiki_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    current_revision_id INTEGER,
    created_at INTEGER NOT NULL,
    created_by INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS wiki_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    formbar_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    undone_at INTEGER,
    rewarded_at INTEGER
  )`);
  await run("UPDATE accounts SET held = 0");
  await seedWikiHome();
}

function pickName() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${adjective} ${noun} ${n}`;
}

export async function createGuest() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const user = {
      id: crypto.randomUUID(),
      name: pickName(),
    };
    try {
      await run(
        "INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)",
        [user.id, user.name, Date.now()],
      );
      return user;
    } catch (err) {
      if (err && err.code === "SQLITE_CONSTRAINT") continue;
      throw err;
    }
  }
  throw new Error("Could not create a guest identity");
}

export async function getUser(id) {
  if (!id) return null;
  const row = await get("SELECT id, name FROM users WHERE id = ?", [id]);
  return row || null;
}

/** Session guest, or a new one when the cookie is missing or stale. */
export async function ensureGuest(session) {
  if (session.guestId) {
    const existing = await getUser(session.guestId);
    if (existing) return existing;
  }
  if (session.userId) {
    const existing = await getUser(session.userId);
    if (existing) {
      session.guestId = existing.id;
      return existing;
    }
  }
  const user = await createGuest();
  session.guestId = user.id;
  return user;
}

export async function getAccount(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await get(
    "SELECT formbar_id, name, mmr, tickets, held, wins, losses FROM accounts WHERE formbar_id = ?",
    [id],
  );
  return row || null;
}

export async function upsertAccount(formbarId, name) {
  const id = Number(formbarId);
  const existing = await getAccount(id);
  const now = Date.now();
  if (existing) {
    await run(
      "UPDATE accounts SET name = ?, updated_at = ? WHERE formbar_id = ?",
      [name, now, id],
    );
    existing.name = name;
    return existing;
  }
  await run(
    `INSERT INTO accounts (
      formbar_id, name, mmr, tickets, held, wins, losses, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [id, name, startingMmr(), now, now],
  );
  return getAccount(id);
}

export async function holdTicket(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET held = held + 1, updated_at = ? WHERE formbar_id = ? AND tickets > held",
    [Date.now(), id],
  );
  return result.changes > 0;
}

export async function releaseHold(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET held = held - 1, updated_at = ? WHERE formbar_id = ? AND held > 0",
    [Date.now(), id],
  );
  return result.changes > 0;
}

/** True when this account already has a hold, or a new one was taken. */
export async function ensureHold(formbarId) {
  const account = await getAccount(formbarId);
  if (!account) return false;
  if (account.held > 0) return true;
  return holdTicket(account.formbar_id);
}

export async function chargeHeld(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    `UPDATE accounts
     SET tickets = tickets - 1, held = held - 1, updated_at = ?
     WHERE formbar_id = ? AND tickets > 0 AND held > 0`,
    [Date.now(), id],
  );
  return result.changes > 0;
}

export async function refundTicket(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return;
  await run(
    "UPDATE accounts SET tickets = tickets + 1, updated_at = ? WHERE formbar_id = ?",
    [Date.now(), id],
  );
}

export async function addTickets(formbarId, tickets, digipogs) {
  const id = Number(formbarId);
  const now = Date.now();
  await run(
    "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE formbar_id = ?",
    [tickets, now, id],
  );
  await run(
    "INSERT INTO ticket_purchases (formbar_id, digipogs, tickets, created_at) VALUES (?, ?, ?, ?)",
    [id, digipogs, tickets, now],
  );
}

export async function setRankedResult(formbarId, mmr, won) {
  const column = won ? "wins" : "losses";
  await run(
    `UPDATE accounts SET mmr = ?, ${column} = ${column} + 1, updated_at = ? WHERE formbar_id = ?`,
    [mmr, Date.now(), formbarId],
  );
}

export async function insertGame(game) {
  await run(
    `INSERT INTO games (
      id, mode, player_a, player_b, name_a, name_b, formbar_a, formbar_b,
      winner_side, mmr_a_before, mmr_b_before, mmr_a_after, mmr_b_after,
      created_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      game.id,
      game.mode,
      game.playerA,
      game.playerB,
      game.nameA,
      game.nameB,
      game.formbarA,
      game.formbarB,
      game.winnerSide,
      game.mmrABefore,
      game.mmrBBefore,
      game.mmrAAfter,
      game.mmrBAfter,
      game.createdAt,
      game.endedAt,
    ],
  );
}

export async function topAccounts(limit = 10) {
  return all(
    `SELECT formbar_id, name, mmr, wins, losses
     FROM accounts
     WHERE wins + losses > 0
     ORDER BY mmr DESC, wins DESC, name ASC
     LIMIT ?`,
    [limit],
  );
}

export async function systemStats() {
  const accounts = await get(
    "SELECT COUNT(*) AS accounts, COALESCE(SUM(tickets), 0) AS tickets FROM accounts",
  );
  const games = await get(
    `SELECT COUNT(*) AS finished,
            COALESCE(SUM(CASE WHEN mode = 'ranked' THEN 1 ELSE 0 END), 0) AS ranked
     FROM games`,
  );
  const spent = await get(
    "SELECT COALESCE(SUM(digipogs), 0) AS digipogs FROM ticket_purchases",
  );
  return {
    accounts: accounts.accounts,
    tickets: accounts.tickets,
    finished: games.finished,
    ranked: games.ranked,
    digipogs: spent.digipogs,
  };
}

export async function createSuggestion({ formbarId, name, body, isBug, repro }) {
  const result = await run(
    `INSERT INTO suggestions (formbar_id, name, body, is_bug, repro, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      formbarId,
      name,
      body,
      isBug ? 1 : 0,
      isBug ? repro : null,
      Date.now(),
    ],
  );
  return result.lastID;
}

export async function listSuggestions({ archived = false } = {}) {
  if (archived) {
    return all(
      `SELECT id, formbar_id, name, body, is_bug, repro, created_at, archived_at
       FROM suggestions
       WHERE archived_at IS NOT NULL
       ORDER BY archived_at DESC, id DESC`,
    );
  }
  return all(
    `SELECT id, formbar_id, name, body, is_bug, repro, created_at, archived_at
     FROM suggestions
     WHERE archived_at IS NULL
     ORDER BY created_at DESC, id DESC`,
  );
}

export async function archiveSuggestion(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const result = await run(
    "UPDATE suggestions SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
    [Date.now(), suggestionId],
  );
  return result.changes > 0;
}

export const WIKI_TITLE_MAX = 80;
export const WIKI_BODY_MAX = 20000;

const HOME_SEED_BODY = `Destroy the enemy keep. Buy from the bottom bar: drag up for the top lane, down for the bottom, sideways for an alternate.

- Click a unit: Halt → Reform → Advance.
- Long-press: select that unit alone.
- Swipe forward / back: charge or fall back.
- Swipe up / down: change row.
- Click a town you own to invest land in its upgrade.
- Broken units ignore orders until they rally.

Players can edit this wiki to document rules and strategies. Use [[Page Title]] to link to other pages.`;

export function wikiSlug(title) {
  const slug = String(title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, WIKI_TITLE_MAX);
  return slug || "page";
}

export function wikiRewardAmount() {
  const n = Number(process.env.WIKI_REWARD_DIGIPOGS);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

export async function canEditWiki(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const played = await get(
    `SELECT 1 AS ok FROM games
     WHERE formbar_a = ? OR formbar_b = ?
     LIMIT 1`,
    [id, id],
  );
  if (!played) return false;
  const bought = await get(
    "SELECT 1 AS ok FROM ticket_purchases WHERE formbar_id = ? LIMIT 1",
    [id],
  );
  if (!bought) return false;
  const spent = await get(
    `SELECT 1 AS ok FROM games
     WHERE mode = 'ranked' AND (formbar_a = ? OR formbar_b = ?)
     LIMIT 1`,
    [id, id],
  );
  return Boolean(spent);
}

async function seedWikiHome() {
  const count = await get("SELECT COUNT(*) AS n FROM wiki_pages");
  if (count && count.n > 0) return;
  const now = Date.now();
  const page = await run(
    `INSERT INTO wiki_pages (slug, title, current_revision_id, created_at, created_by)
     VALUES (?, ?, NULL, ?, ?)`,
    ["home", "Home", now, 0],
  );
  const rev = await run(
    `INSERT INTO wiki_revisions (page_id, formbar_id, name, body, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [page.lastID, 0, "System", HOME_SEED_BODY, now, now],
  );
  await run(
    "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
    [rev.lastID, page.lastID],
  );
}

export async function listWikiSlugs() {
  const rows = await all("SELECT slug FROM wiki_pages ORDER BY slug ASC");
  return rows.map((row) => row.slug);
}

export async function listWikiPages() {
  return all(
    `SELECT p.id, p.slug, p.title, p.created_at,
            r.name AS editor_name, r.formbar_id AS editor_id, r.created_at AS edited_at
     FROM wiki_pages p
     LEFT JOIN wiki_revisions r ON r.id = p.current_revision_id
     ORDER BY CASE WHEN p.slug = 'home' THEN 0 ELSE 1 END, p.title COLLATE NOCASE ASC`,
  );
}

export async function getWikiPageBySlug(slug) {
  const key = wikiSlug(slug);
  const page = await get(
    `SELECT id, slug, title, current_revision_id, created_at, created_by
     FROM wiki_pages WHERE slug = ?`,
    [key],
  );
  if (!page) return null;
  let revision = null;
  if (page.current_revision_id) {
    revision = await get(
      `SELECT id, page_id, formbar_id, name, body, created_at,
              confirmed_at, undone_at, rewarded_at
       FROM wiki_revisions WHERE id = ?`,
      [page.current_revision_id],
    );
  }
  return { page, revision };
}

export async function getWikiRevision(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return null;
  return get(
    `SELECT r.id, r.page_id, r.formbar_id, r.name, r.body, r.created_at,
            r.confirmed_at, r.undone_at, r.rewarded_at,
            p.slug, p.title, p.current_revision_id
     FROM wiki_revisions r
     JOIN wiki_pages p ON p.id = r.page_id
     WHERE r.id = ?`,
    [revisionId],
  );
}

export async function saveWikiPage({ slug, title, body, formbarId, name }) {
  const trimmedBody = String(body || "").trim().slice(0, WIKI_BODY_MAX);
  if (!trimmedBody) {
    return { ok: false, error: "Page text is required." };
  }
  const existing = await getWikiPageBySlug(slug);
  const now = Date.now();
  const authorId = Number(formbarId);
  const authorName = String(name || "").trim().slice(0, 80) || `Player ${authorId}`;

  if (existing) {
    const rev = await run(
      `INSERT INTO wiki_revisions (page_id, formbar_id, name, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [existing.page.id, authorId, authorName, trimmedBody, now],
    );
    await run(
      "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
      [rev.lastID, existing.page.id],
    );
    return { ok: true, slug: existing.page.slug, created: false };
  }

  const pageTitle = String(title || "").trim().slice(0, WIKI_TITLE_MAX);
  if (!pageTitle) {
    return { ok: false, error: "Page title is required." };
  }
  const newSlug = wikiSlug(pageTitle);
  const clash = await get("SELECT id FROM wiki_pages WHERE slug = ?", [newSlug]);
  if (clash) {
    return { ok: false, error: "A page with that title already exists." };
  }
  const page = await run(
    `INSERT INTO wiki_pages (slug, title, current_revision_id, created_at, created_by)
     VALUES (?, ?, NULL, ?, ?)`,
    [newSlug, pageTitle, now, authorId],
  );
  const rev = await run(
    `INSERT INTO wiki_revisions (page_id, formbar_id, name, body, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [page.lastID, authorId, authorName, trimmedBody, now],
  );
  await run(
    "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
    [rev.lastID, page.lastID],
  );
  return { ok: true, slug: newSlug, created: true };
}

export async function listOpenWikiRevisions() {
  return all(
    `SELECT r.id, r.page_id, r.formbar_id, r.name, r.body, r.created_at,
            r.confirmed_at, r.undone_at, r.rewarded_at,
            p.slug, p.title,
            (
              SELECT prev.body FROM wiki_revisions prev
              WHERE prev.page_id = r.page_id AND prev.id < r.id
              ORDER BY prev.id DESC
              LIMIT 1
            ) AS previous_body
     FROM wiki_revisions r
     JOIN wiki_pages p ON p.id = r.page_id
     WHERE r.confirmed_at IS NULL AND r.undone_at IS NULL
     ORDER BY r.created_at DESC, r.id DESC`,
  );
}

export async function confirmWikiRevision(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return false;
  const result = await run(
    `UPDATE wiki_revisions
     SET confirmed_at = ?
     WHERE id = ? AND confirmed_at IS NULL AND undone_at IS NULL`,
    [Date.now(), revisionId],
  );
  return result.changes > 0;
}

export async function undoWikiRevision(id) {
  const revision = await getWikiRevision(id);
  if (!revision || revision.undone_at) {
    return { ok: false, error: "Revision not found." };
  }
  const now = Date.now();
  const first = await get(
    `SELECT id FROM wiki_revisions
     WHERE page_id = ?
     ORDER BY id ASC
     LIMIT 1`,
    [revision.page_id],
  );
  const isCreate = first && first.id === revision.id;

  if (isCreate) {
    await run("DELETE FROM wiki_revisions WHERE page_id = ?", [revision.page_id]);
    await run("DELETE FROM wiki_pages WHERE id = ?", [revision.page_id]);
    return { ok: true, deleted: true };
  }

  await run(
    "UPDATE wiki_revisions SET undone_at = ?, confirmed_at = COALESCE(confirmed_at, ?) WHERE id = ?",
    [now, now, revision.id],
  );

  if (revision.current_revision_id === revision.id) {
    const previous = await get(
      `SELECT id FROM wiki_revisions
       WHERE page_id = ? AND id < ? AND undone_at IS NULL
       ORDER BY id DESC
       LIMIT 1`,
      [revision.page_id, revision.id],
    );
    if (previous) {
      await run(
        "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
        [previous.id, revision.page_id],
      );
    }
  }
  return { ok: true, deleted: false };
}

export async function setWikiRevisionRewarded(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return false;
  const result = await run(
    "UPDATE wiki_revisions SET rewarded_at = ? WHERE id = ? AND rewarded_at IS NULL AND undone_at IS NULL",
    [Date.now(), revisionId],
  );
  return result.changes > 0;
}
