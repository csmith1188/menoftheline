import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import { metricsEnabled, noteSqliteBusy, noteSqliteWrite } from "./metrics.js";
import { ownerBase, pickLeastLoaded, workerCount } from "./owners.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataPath = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(root, "data");
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

let dbTail = Promise.resolve();

/** One app connection: keep statements and transactions from interleaving. */
function withDb(fn) {
  const job = dbTail.then(fn, fn);
  dbTail = job.then(() => {}, () => {});
  return job;
}

function noteWrite(sql, err) {
  if (!metricsEnabled()) return;
  const head = String(sql).trim().slice(0, 6).toUpperCase();
  if (head === "INSERT" || head === "UPDATE" || head === "DELETE") noteSqliteWrite();
  if (err && (err.code === "SQLITE_BUSY" || err.errno === 5)) noteSqliteBusy();
}

function execRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      noteWrite(sql, err);
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function execGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function execAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function run(sql, params = []) {
  return withDb(() => execRun(sql, params));
}

function get(sql, params = []) {
  return withDb(() => execGet(sql, params));
}

function all(sql, params = []) {
  return withDb(() => execAll(sql, params));
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
    tooltips INTEGER NOT NULL DEFAULT 1,
    bgm_volume INTEGER NOT NULL DEFAULT 50,
    created_at INTEGER NOT NULL
  )`);
  await ensureAccountsTable();
  await run(`CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS auth_tokens_account ON auth_tokens (account_id, purpose)");
  await run(`CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    player_a TEXT,
    player_b TEXT,
    name_a TEXT,
    name_b TEXT,
    formbar_a INTEGER,
    formbar_b INTEGER,
    account_a INTEGER,
    account_b INTEGER,
    winner_side TEXT,
    mmr_a_before INTEGER,
    mmr_b_before INTEGER,
    mmr_a_after INTEGER,
    mmr_b_after INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS games_formbar_a ON games (formbar_a)");
  await run("CREATE INDEX IF NOT EXISTS games_formbar_b ON games (formbar_b)");
  const gameCols = await all("PRAGMA table_info(games)");
  if (!gameCols.some((col) => col.name === "account_a")) {
    await run("ALTER TABLE games ADD COLUMN account_a INTEGER");
  }
  if (!gameCols.some((col) => col.name === "account_b")) {
    await run("ALTER TABLE games ADD COLUMN account_b INTEGER");
  }
  await run("CREATE INDEX IF NOT EXISTS games_account_a ON games (account_a)");
  await run("CREATE INDEX IF NOT EXISTS games_account_b ON games (account_b)");
  await run(`CREATE TABLE IF NOT EXISTS ticket_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    formbar_id INTEGER NOT NULL,
    digipogs INTEGER NOT NULL,
    tickets INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS ticket_purchases_formbar ON ticket_purchases (formbar_id)");
  await run(`CREATE TABLE IF NOT EXISTS match_assignments (
    user_id TEXT PRIMARY KEY,
    worker INTEGER NOT NULL,
    mode TEXT NOT NULL,
    pair_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS match_assignments_mode ON match_assignments (mode, pair_id)");
  await run(`CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    formbar_id INTEGER NOT NULL,
    account_id INTEGER,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    is_bug INTEGER NOT NULL DEFAULT 0,
    repro TEXT,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    rewarded_at INTEGER
  )`);
  const suggestionCols = await all("PRAGMA table_info(suggestions)");
  if (!suggestionCols.some((col) => col.name === "rewarded_at")) {
    await run("ALTER TABLE suggestions ADD COLUMN rewarded_at INTEGER");
  }
  if (!suggestionCols.some((col) => col.name === "account_id")) {
    await run("ALTER TABLE suggestions ADD COLUMN account_id INTEGER");
  }
  await run("CREATE INDEX IF NOT EXISTS suggestions_open_account ON suggestions (account_id, archived_at, is_bug)");
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
    account_id INTEGER,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    undone_at INTEGER,
    rewarded_at INTEGER
  )`);
  const wikiRevCols = await all("PRAGMA table_info(wiki_revisions)");
  if (!wikiRevCols.some((col) => col.name === "account_id")) {
    await run("ALTER TABLE wiki_revisions ADD COLUMN account_id INTEGER");
  }
  await run("CREATE INDEX IF NOT EXISTS wiki_revisions_open_account ON wiki_revisions (account_id, confirmed_at, undone_at)");
  await run("UPDATE accounts SET held = 0");
  const userCols = await all("PRAGMA table_info(users)");
  if (!userCols.some((col) => col.name === "tooltips")) {
    await run("ALTER TABLE users ADD COLUMN tooltips INTEGER NOT NULL DEFAULT 1");
  }
  if (!userCols.some((col) => col.name === "bgm_volume")) {
    await run("ALTER TABLE users ADD COLUMN bgm_volume INTEGER NOT NULL DEFAULT 50");
  }
  await seedWikiHome();
}

const ACCOUNT_SELECT = `id, formbar_id, discord_id, email, password_hash, email_verified_at, name, mmr, tickets, held, wins, losses, tooltips, bgm_volume, created_at, updated_at`;

async function ensureAccountsTable() {
  const existing = await get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
  );
  if (!existing) {
    await run(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formbar_id INTEGER UNIQUE,
      discord_id TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      email_verified_at INTEGER,
      name TEXT NOT NULL,
      mmr INTEGER NOT NULL,
      tickets INTEGER NOT NULL DEFAULT 0,
      held INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      tooltips INTEGER NOT NULL DEFAULT 1,
      bgm_volume INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    return;
  }
  const accountCols = await all("PRAGMA table_info(accounts)");
  const hasId = accountCols.some((col) => col.name === "id");
  if (!hasId) {
    await run(`CREATE TABLE accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formbar_id INTEGER UNIQUE,
      discord_id TEXT UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      email_verified_at INTEGER,
      name TEXT NOT NULL,
      mmr INTEGER NOT NULL,
      tickets INTEGER NOT NULL DEFAULT 0,
      held INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      tooltips INTEGER NOT NULL DEFAULT 1,
      bgm_volume INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    const hasTooltips = accountCols.some((col) => col.name === "tooltips");
    const hasBgm = accountCols.some((col) => col.name === "bgm_volume");
    await run(
      `INSERT INTO accounts_new (
        formbar_id, discord_id, email, password_hash, email_verified_at, name, mmr, tickets, held,
        wins, losses, tooltips, bgm_volume, created_at, updated_at
      )
      SELECT formbar_id, NULL, NULL, NULL, NULL, name, mmr, tickets, held, wins, losses,
        ${hasTooltips ? "tooltips" : "1"},
        ${hasBgm ? "bgm_volume" : "50"},
        created_at, updated_at
      FROM accounts`,
    );
    await run("DROP TABLE accounts");
    await run("ALTER TABLE accounts_new RENAME TO accounts");
    await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts (email)");
    await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_formbar ON accounts (formbar_id)");
    await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_discord ON accounts (discord_id)");
    return;
  }
  if (!accountCols.some((col) => col.name === "email")) {
    await run("ALTER TABLE accounts ADD COLUMN email TEXT");
  }
  if (!accountCols.some((col) => col.name === "password_hash")) {
    await run("ALTER TABLE accounts ADD COLUMN password_hash TEXT");
  }
  if (!accountCols.some((col) => col.name === "email_verified_at")) {
    await run("ALTER TABLE accounts ADD COLUMN email_verified_at INTEGER");
  }
  if (!accountCols.some((col) => col.name === "tooltips")) {
    await run("ALTER TABLE accounts ADD COLUMN tooltips INTEGER NOT NULL DEFAULT 1");
  }
  if (!accountCols.some((col) => col.name === "bgm_volume")) {
    await run("ALTER TABLE accounts ADD COLUMN bgm_volume INTEGER NOT NULL DEFAULT 50");
  }
  if (!accountCols.some((col) => col.name === "discord_id")) {
    await run("ALTER TABLE accounts ADD COLUMN discord_id TEXT");
  }
  await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_email ON accounts (email)");
  await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_formbar ON accounts (formbar_id)");
  await run("CREATE UNIQUE INDEX IF NOT EXISTS accounts_discord ON accounts (discord_id)");
}

function pickName() {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${adjective} ${noun} ${n}`;
}

function sanitizeGuestName(raw) {
  const text = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 32);
  return text || null;
}

export async function createGuest(preferredName) {
  const base = sanitizeGuestName(preferredName);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = base
      ? (attempt === 0 ? base : `${base} ${Math.floor(Math.random() * 90) + 10}`)
      : pickName();
    const user = {
      id: crypto.randomUUID(),
      name,
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
  const row = await get("SELECT id, name, tooltips, bgm_volume FROM users WHERE id = ?", [id]);
  return row || null;
}

/** Session guest, or a new one when the cookie is missing or stale. */
export async function ensureGuest(session, options = {}) {
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
  const user = await createGuest(options.name);
  session.guestId = user.id;
  return user;
}

export async function getAccount(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
    [id],
  );
  return row || null;
}

export async function getAccountByFormbar(formbarId) {
  const id = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE formbar_id = ?`,
    [id],
  );
  return row || null;
}

export async function getAccountByEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE email = ?`,
    [key],
  );
  return row || null;
}

export async function getAccountByDiscord(discordId) {
  const key = String(discordId || "").trim();
  if (!key || key.length > 32) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE discord_id = ?`,
    [key],
  );
  return row || null;
}

/** Resolve profile URL id: internal account id, else legacy Formbar id. */
export async function findAccountForProfile(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const byId = await getAccount(id);
  if (byId) return byId;
  return getAccountByFormbar(id);
}

export async function upsertAccount(formbarId, name) {
  const fid = Number(formbarId);
  if (!Number.isInteger(fid) || fid <= 0) return null;
  const existing = await getAccountByFormbar(fid);
  const now = Date.now();
  if (existing) {
    await run(
      "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?",
      [name, now, existing.id],
    );
    existing.name = name;
    return existing;
  }
  const result = await run(
    `INSERT INTO accounts (
      formbar_id, name, mmr, tickets, held, wins, losses, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [fid, name, startingMmr(), now, now],
  );
  return getAccount(result.lastID);
}

export async function upsertDiscordAccount(discordId, name) {
  const did = String(discordId || "").trim();
  if (!did || did.length > 32) return null;
  const existing = await getAccountByDiscord(did);
  const now = Date.now();
  if (existing) {
    await run(
      "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?",
      [name, now, existing.id],
    );
    existing.name = name;
    return existing;
  }
  const result = await run(
    `INSERT INTO accounts (
      discord_id, name, mmr, tickets, held, wins, losses, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [did, name, startingMmr(), now, now],
  );
  return getAccount(result.lastID);
}

export async function createLocalAccount({
  email,
  passwordHash,
  name,
  verifiedAt = null,
}) {
  const now = Date.now();
  const result = await run(
    `INSERT INTO accounts (
      email, password_hash, email_verified_at, name, mmr, tickets, held, wins, losses,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [email, passwordHash, verifiedAt, name, startingMmr(), now, now],
  );
  return getAccount(result.lastID);
}

export async function setAccountPassword(accountId, passwordHash) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
    [passwordHash, Date.now(), id],
  );
  return result.changes > 0;
}

export async function setEmailVerified(accountId, at = Date.now()) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET email_verified_at = ?, updated_at = ? WHERE id = ?",
    [at, Date.now(), id],
  );
  return result.changes > 0;
}

export async function setLocalCredentials(accountId, { email, passwordHash, verifiedAt }) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    `UPDATE accounts
     SET email = ?, password_hash = ?, email_verified_at = ?, updated_at = ?
     WHERE id = ?`,
    [email, passwordHash, verifiedAt, Date.now(), id],
  );
  return result.changes > 0;
}

export async function linkFormbarToAccount(accountId, formbarId) {
  const id = Number(accountId);
  const fid = Number(formbarId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  if (!Number.isInteger(fid) || fid <= 0) return { ok: false, error: "bad_formbar" };
  const target = await getAccount(id);
  if (!target) return { ok: false, error: "missing" };
  if (target.formbar_id && Number(target.formbar_id) === fid) {
    return { ok: true, account: target };
  }
  if (target.formbar_id) return { ok: false, error: "already_linked" };
  const other = await getAccountByFormbar(fid);
  if (other && other.id !== id) {
    return mergeAccounts(id, other.id, { formbarId: fid });
  }
  try {
    await run(
      "UPDATE accounts SET formbar_id = ?, updated_at = ? WHERE id = ?",
      [fid, Date.now(), id],
    );
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT") {
      return { ok: false, error: "conflict" };
    }
    throw err;
  }
  return { ok: true, account: await getAccount(id) };
}

export async function linkDiscordToAccount(accountId, discordId) {
  const id = Number(accountId);
  const did = String(discordId || "").trim();
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  if (!did || did.length > 32) return { ok: false, error: "bad_discord" };
  const target = await getAccount(id);
  if (!target) return { ok: false, error: "missing" };
  if (target.discord_id && String(target.discord_id) === did) {
    return { ok: true, account: target };
  }
  if (target.discord_id) return { ok: false, error: "already_linked" };
  const other = await getAccountByDiscord(did);
  if (other && other.id !== id) {
    return mergeAccounts(id, other.id, { discordId: did });
  }
  try {
    await run(
      "UPDATE accounts SET discord_id = ?, updated_at = ? WHERE id = ?",
      [did, Date.now(), id],
    );
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT") {
      return { ok: false, error: "conflict" };
    }
    throw err;
  }
  return { ok: true, account: await getAccount(id) };
}

/**
 * Merge donor into survivor (logged-in account). Sums tickets/wins/losses;
 * MMR is the max; keeps survivor name.
 */
export async function mergeAccounts(survivorId, donorId, options = {}) {
  const survivor = await getAccount(survivorId);
  const donor = await getAccount(donorId);
  if (!survivor || !donor) return { ok: false, error: "missing" };
  if (survivor.id === donor.id) return { ok: true, account: survivor };

  const formbarId = options.formbarId != null
    ? Number(options.formbarId)
    : (survivor.formbar_id || donor.formbar_id || null);
  const discordId = options.discordId != null
    ? String(options.discordId).trim()
    : (survivor.discord_id || donor.discord_id || null);
  const email = options.email != null
    ? options.email
    : (survivor.email || donor.email || null);
  const passwordHash = options.passwordHash != null
    ? options.passwordHash
    : (survivor.password_hash || donor.password_hash || null);
  let verifiedAt = survivor.email_verified_at || donor.email_verified_at || null;
  if (options.verifiedAt !== undefined) verifiedAt = options.verifiedAt;

  if (formbarId) {
    const clash = await getAccountByFormbar(formbarId);
    if (clash && clash.id !== survivor.id && clash.id !== donor.id) {
      return { ok: false, error: "conflict" };
    }
  }
  if (discordId) {
    const clash = await getAccountByDiscord(discordId);
    if (clash && clash.id !== survivor.id && clash.id !== donor.id) {
      return { ok: false, error: "conflict" };
    }
  }
  if (email) {
    const clash = await getAccountByEmail(email);
    if (clash && clash.id !== survivor.id && clash.id !== donor.id) {
      return { ok: false, error: "conflict" };
    }
  }

  const tickets = survivor.tickets + donor.tickets;
  const held = survivor.held + donor.held;
  const wins = survivor.wins + donor.wins;
  const losses = survivor.losses + donor.losses;
  const mmr = Math.max(survivor.mmr, donor.mmr);
  const now = Date.now();

  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      await execRun(
        "UPDATE accounts SET formbar_id = NULL, discord_id = NULL, email = NULL, updated_at = ? WHERE id = ?",
        [now, donor.id],
      );
      await execRun(
        `UPDATE accounts SET
          formbar_id = ?, discord_id = ?, email = ?, password_hash = ?, email_verified_at = ?,
          tickets = ?, held = ?, wins = ?, losses = ?, mmr = ?, updated_at = ?
         WHERE id = ?`,
        [
          formbarId,
          discordId,
          email,
          passwordHash,
          verifiedAt,
          tickets,
          held,
          wins,
          losses,
          mmr,
          now,
          survivor.id,
        ],
      );
      await execRun(
        "UPDATE games SET account_a = ? WHERE account_a = ?",
        [survivor.id, donor.id],
      );
      await execRun(
        "UPDATE games SET account_b = ? WHERE account_b = ?",
        [survivor.id, donor.id],
      );
      await execRun("DELETE FROM auth_tokens WHERE account_id = ?", [donor.id]);
      await execRun("DELETE FROM accounts WHERE id = ?", [donor.id]);
      await execRun("COMMIT");
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        console.error(rollbackErr);
      }
      if (err && err.code === "SQLITE_CONSTRAINT") {
        return { ok: false, error: "conflict" };
      }
      throw err;
    }
    const account = await execGet(
      `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
      [survivor.id],
    );
    return { ok: true, account: account || null };
  });
}

export async function createAuthToken(accountId, purpose, tokenHash, expiresAt) {
  await run("DELETE FROM auth_tokens WHERE account_id = ? AND purpose = ?", [
    accountId,
    purpose,
  ]);
  await run(
    `INSERT INTO auth_tokens (account_id, purpose, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [accountId, purpose, tokenHash, expiresAt, Date.now()],
  );
}

export async function consumeAuthToken(purpose, tokenHash) {
  const row = await get(
    `SELECT id, account_id, expires_at FROM auth_tokens
     WHERE purpose = ? AND token_hash = ?`,
    [purpose, tokenHash],
  );
  if (!row) return null;
  await run("DELETE FROM auth_tokens WHERE id = ?", [row.id]);
  if (Number(row.expires_at) < Date.now()) return null;
  return getAccount(row.account_id);
}

export async function holdTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET held = held + 1, updated_at = ? WHERE id = ? AND tickets > held",
    [Date.now(), id],
  );
  return result.changes > 0;
}

export async function releaseHold(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET held = held - 1, updated_at = ? WHERE id = ? AND held > 0",
    [Date.now(), id],
  );
  return result.changes > 0;
}

/** True when this account already has a hold, or a new one was taken. */
export async function ensureHold(accountId) {
  const account = await getAccount(accountId);
  if (!account) return false;
  if (account.held > 0) return true;
  return holdTicket(account.id);
}

export async function chargeHeld(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    `UPDATE accounts
     SET tickets = tickets - 1, held = held - 1, updated_at = ?
     WHERE id = ? AND tickets > 0 AND held > 0`,
    [Date.now(), id],
  );
  return result.changes > 0;
}

export async function refundTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  await run(
    "UPDATE accounts SET tickets = tickets + 1, updated_at = ? WHERE id = ?",
    [Date.now(), id],
  );
}

/** Spend one unused ticket (not held for a match). */
export async function spendFreeTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    `UPDATE accounts
     SET tickets = tickets - 1, updated_at = ?
     WHERE id = ? AND tickets > held`,
    [Date.now(), id],
  );
  return result.changes > 0;
}

/** Credit tickets after Digipog payment; records purchase against Formbar id. */
export async function addTickets(accountId, tickets, digipogs, formbarId) {
  const id = Number(accountId);
  const fid = Number(formbarId);
  const now = Date.now();
  await run(
    "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE id = ?",
    [tickets, now, id],
  );
  if (Number.isInteger(fid) && fid > 0) {
    await run(
      "INSERT INTO ticket_purchases (formbar_id, digipogs, tickets, created_at) VALUES (?, ?, ?, ?)",
      [fid, digipogs, tickets, now],
    );
  }
}

/** Dev/test helper: grant tickets without Digipog purchase. */
export async function grantTickets(accountId, tickets) {
  const id = Number(accountId);
  const n = Number(tickets);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n === 0) return false;
  const result = await run(
    "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE id = ?",
    [n, Date.now(), id],
  );
  return result.changes > 0;
}

function workerFromCounts(rows) {
  const count = workerCount();
  const loads = [];
  for (let i = 0; i < count; i += 1) loads.push(0);
  for (let i = 0; i < rows.length; i += 1) {
    const worker = Number(rows[i].worker);
    if (worker >= 0 && worker < loads.length) loads[worker] = Number(rows[i].n) || 0;
  }
  return pickLeastLoaded(loads);
}

/**
 * Pin a player to one sim process. Bot rooms spread across the least
 * loaded owners. Queue modes share one owner so the pair meets there.
 * A single process skips the table.
 */
export async function assignOwner(userId, mode) {
  if (workerCount() < 2) return { worker: 0, owner: "" };
  if (!userId) return { worker: 0, owner: "" };
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const existing = await execGet(
        "SELECT worker FROM match_assignments WHERE user_id = ?",
        [userId],
      );
      if (existing) {
        await execRun("COMMIT");
        return { worker: existing.worker, owner: ownerBase(existing.worker) };
      }
      const queued = mode === "casual" || mode === "trainCasual" || mode === "ranked";
      let worker = 0;
      let pairId = null;
      if (queued) {
        const open = await execGet(
          `SELECT pair_id, worker FROM match_assignments
           WHERE mode = ? AND pair_id IS NOT NULL
           GROUP BY pair_id
           HAVING COUNT(*) = 1
           ORDER BY MIN(created_at)
           LIMIT 1`,
          [mode],
        );
        if (open) {
          worker = open.worker;
          pairId = open.pair_id;
        } else {
          const rows = await execAll("SELECT worker, COUNT(*) AS n FROM match_assignments GROUP BY worker");
          worker = workerFromCounts(rows);
          pairId = crypto.randomUUID();
        }
      } else {
        const rows = await execAll("SELECT worker, COUNT(*) AS n FROM match_assignments GROUP BY worker");
        worker = workerFromCounts(rows);
      }
      await execRun(
        "INSERT INTO match_assignments (user_id, worker, mode, pair_id, created_at) VALUES (?, ?, ?, ?, ?)",
        [userId, worker, mode, pairId, Date.now()],
      );
      await execRun("COMMIT");
      return { worker, owner: ownerBase(worker) };
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        console.error(rollbackErr);
      }
      throw err;
    }
  });
}

export async function ownerForUser(userId) {
  if (workerCount() < 2 || !userId || !db) return null;
  const row = await get("SELECT worker FROM match_assignments WHERE user_id = ?", [userId]);
  return row ? row.worker : null;
}

export async function clearOwner(userId) {
  if (workerCount() < 2 || !userId || !db) return;
  await run("DELETE FROM match_assignments WHERE user_id = ?", [userId]);
}

/** Ranked MMR updates and the game row, or just the game row, in one transaction. */
export async function recordMatchResult({ ranked, game }) {
  if (!db) return;
  return withDb(async () => {
    await execRun("BEGIN");
    try {
      if (ranked && ranked.length) {
        for (let i = 0; i < ranked.length; i += 1) {
          const row = ranked[i];
          const column = row.won ? "wins" : "losses";
          await execRun(
            `UPDATE accounts SET mmr = ?, ${column} = ${column} + 1, updated_at = ? WHERE id = ?`,
            [row.mmr, Date.now(), row.accountId],
          );
        }
      }
      await execRun(
        `INSERT INTO games (
          id, mode, player_a, player_b, name_a, name_b, formbar_a, formbar_b,
          account_a, account_b,
          winner_side, mmr_a_before, mmr_b_before, mmr_a_after, mmr_b_after,
          created_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          game.id,
          game.mode,
          game.playerA,
          game.playerB,
          game.nameA,
          game.nameB,
          game.formbarA,
          game.formbarB,
          game.accountA,
          game.accountB,
          game.winnerSide,
          game.mmrABefore,
          game.mmrBBefore,
          game.mmrAAfter,
          game.mmrBAfter,
          game.createdAt,
          game.endedAt,
        ],
      );
      await execRun("COMMIT");
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        console.error(rollbackErr);
      }
      throw err;
    }
  });
}

export async function setRankedResult(accountId, mmr, won) {
  const column = won ? "wins" : "losses";
  await run(
    `UPDATE accounts SET mmr = ?, ${column} = ${column} + 1, updated_at = ? WHERE id = ?`,
    [mmr, Date.now(), accountId],
  );
}

export async function insertGame(game) {
  await run(
    `INSERT INTO games (
      id, mode, player_a, player_b, name_a, name_b, formbar_a, formbar_b,
      account_a, account_b,
      winner_side, mmr_a_before, mmr_b_before, mmr_a_after, mmr_b_after,
      created_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      game.id,
      game.mode,
      game.playerA,
      game.playerB,
      game.nameA,
      game.nameB,
      game.formbarA,
      game.formbarB,
      game.accountA ?? null,
      game.accountB ?? null,
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

/** Persist in-match gesture tooltip preference for an account or guest. */
export async function setPlayerTooltips(player, on) {
  const value = on ? 1 : 0;
  if (!player) return false;
  if (player.accountId) {
    const id = Number(player.accountId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const result = await run(
      "UPDATE accounts SET tooltips = ?, updated_at = ? WHERE id = ?",
      [value, Date.now(), id],
    );
    return result.changes > 0;
  }
  if (!player.id) return false;
  const result = await run(
    "UPDATE users SET tooltips = ? WHERE id = ?",
    [value, player.id],
  );
  return result.changes > 0;
}

export function tooltipsEnabled(row) {
  if (!row || row.tooltips == null) return true;
  return Number(row.tooltips) !== 0;
}

/** Clamp a music slider percent (0–100) for storage. */
export function clampBgmVolumePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Music slider percent (0–100) stored on an account or guest row. Default 50. */
export function bgmVolumePercent(row) {
  if (!row || row.bgm_volume == null) return 50;
  return clampBgmVolumePercent(row.bgm_volume);
}

/** Persist match BGM volume preference for an account or guest. */
export async function setPlayerBgmVolume(player, percent) {
  const value = clampBgmVolumePercent(percent);
  if (!player) return false;
  if (player.accountId) {
    const id = Number(player.accountId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const result = await run(
      "UPDATE accounts SET bgm_volume = ?, updated_at = ? WHERE id = ?",
      [value, Date.now(), id],
    );
    return result.changes > 0;
  }
  if (!player.id) return false;
  const result = await run(
    "UPDATE users SET bgm_volume = ? WHERE id = ?",
    [value, player.id],
  );
  return result.changes > 0;
}

export async function topAccounts(limit = 10) {
  return all(
    `SELECT id, formbar_id, name, mmr, wins, losses
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

export const SUGGESTION_BODY_MAX = 2000;
export const SUGGESTION_REPRO_MAX = 2000;
export const MAX_OPEN_BUGS = 5;
export const MAX_OPEN_WIKI_REVISIONS = 5;
export const FREE_OPEN_SUGGESTIONS = 1;

/**
 * Normalize and clamp user-authored text. Strips C0/C1 controls (keeps \\n/\\t when
 * allowNewlines), collapses other whitespace when not, trims, and enforces max length.
 */
export function sanitizeUserText(raw, { max = SUGGESTION_BODY_MAX, allowNewlines = true } = {}) {
  let text = String(raw ?? "");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (allowNewlines) {
    // Keep \\n and \\t; drop other C0/C1 controls (incl. null).
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  } else {
    // Titles: turn breaks into spaces, then strip remaining controls and collapse.
    text = text.replace(/[\n\t]/g, " ");
    text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    text = text.replace(/\s+/g, " ");
  }
  text = text.trim();
  const limit = Number.isInteger(max) && max > 0 ? max : SUGGESTION_BODY_MAX;
  if (text.length > limit) text = text.slice(0, limit);
  return text;
}

/** Match rows for this account, including legacy rows keyed only by formbar_id. */
async function authorMatch(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const account = await getAccount(id);
  if (!account) return null;
  if (account.formbar_id) {
    return {
      sql: "(account_id = ? OR (account_id IS NULL AND formbar_id = ?))",
      params: [account.id, account.formbar_id],
    };
  }
  return { sql: "account_id = ?", params: [account.id] };
}

export async function countOpenSuggestions(accountId) {
  const match = await authorMatch(accountId);
  if (!match) return 0;
  const row = await get(
    `SELECT COUNT(*) AS n FROM suggestions
     WHERE archived_at IS NULL AND is_bug = 0 AND ${match.sql}`,
    match.params,
  );
  return row ? Number(row.n) || 0 : 0;
}

export async function countOpenBugs(accountId) {
  const match = await authorMatch(accountId);
  if (!match) return 0;
  const row = await get(
    `SELECT COUNT(*) AS n FROM suggestions
     WHERE archived_at IS NULL AND is_bug = 1 AND ${match.sql}`,
    match.params,
  );
  return row ? Number(row.n) || 0 : 0;
}

export async function countOpenWikiRevisions(accountId) {
  const match = await authorMatch(accountId);
  if (!match) return 0;
  const row = await get(
    `SELECT COUNT(*) AS n FROM wiki_revisions
     WHERE confirmed_at IS NULL AND undone_at IS NULL AND ${match.sql}`,
    match.params,
  );
  return row ? Number(row.n) || 0 : 0;
}

export async function createSuggestion({ accountId, formbarId, name, body, isBug, repro }) {
  const result = await run(
    `INSERT INTO suggestions (formbar_id, account_id, name, body, is_bug, repro, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      formbarId,
      Number.isInteger(Number(accountId)) && Number(accountId) > 0 ? Number(accountId) : null,
      name,
      body,
      isBug ? 1 : 0,
      isBug ? repro : null,
      Date.now(),
    ],
  );
  return result.lastID;
}

export async function getSuggestion(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return null;
  return get(
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at
     FROM suggestions
     WHERE id = ?`,
    [suggestionId],
  );
}

export async function listSuggestions({ archived = false } = {}) {
  if (archived) {
    return all(
      `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at
       FROM suggestions
       WHERE archived_at IS NOT NULL
       ORDER BY archived_at DESC, id DESC`,
    );
  }
  return all(
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at
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

export async function claimSuggestionReward(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const now = Date.now();
  const result = await run(
    `UPDATE suggestions
     SET archived_at = ?, rewarded_at = ?
     WHERE id = ? AND archived_at IS NULL AND rewarded_at IS NULL`,
    [now, now, suggestionId],
  );
  return result.changes > 0;
}

export async function reopenSuggestion(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const result = await run(
    "UPDATE suggestions SET archived_at = NULL, rewarded_at = NULL WHERE id = ?",
    [suggestionId],
  );
  return result.changes > 0;
}

export const WIKI_TITLE_MAX = 80;
export const WIKI_BODY_MAX = 20000;

const HOME_SEED_BODY = `Destroy the enemy keep. Buy from the bottom bar: drag up for the top lane, down for the bottom, sideways to cycle an alternate.

- Click a unit to Halt. Click a Halted unit to Advance.
- Long-press or right-click: select that unit alone.
- Swipe forward to Charge. Swipe back to Fall Back.
- Swipe up or down to move the line one row. Switching onto a matching unit in line Reforms.
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
  return Number.isInteger(n) && n > 0 ? n : 200;
}

/** Logged-in accounts that have finished a ranked game may edit the wiki. */
export async function canEditWiki(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const spent = await get(
    `SELECT 1 AS ok FROM games
     WHERE mode = 'ranked' AND (account_a = ? OR account_b = ?)
     LIMIT 1`,
    [id, id],
  );
  if (spent) return true;
  // Legacy Formbar-only rows before account_a/b existed.
  const account = await getAccount(id);
  if (!account || !account.formbar_id) return false;
  const legacy = await get(
    `SELECT 1 AS ok FROM games
     WHERE mode = 'ranked' AND (formbar_a = ? OR formbar_b = ?)
     LIMIT 1`,
    [account.formbar_id, account.formbar_id],
  );
  return Boolean(legacy);
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
      `SELECT id, page_id, formbar_id, account_id, name, body, created_at,
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
    `SELECT r.id, r.page_id, r.formbar_id, r.account_id, r.name, r.body, r.created_at,
            r.confirmed_at, r.undone_at, r.rewarded_at,
            p.slug, p.title, p.current_revision_id
     FROM wiki_revisions r
     JOIN wiki_pages p ON p.id = r.page_id
     WHERE r.id = ?`,
    [revisionId],
  );
}

export async function saveWikiPage({ slug, title, body, formbarId, accountId, name }) {
  const trimmedBody = sanitizeUserText(body, { max: WIKI_BODY_MAX, allowNewlines: true });
  if (!trimmedBody) {
    return { ok: false, error: "Page text is required." };
  }
  const authorAccountId = Number(accountId);
  if (Number.isInteger(authorAccountId) && authorAccountId > 0) {
    const open = await countOpenWikiRevisions(authorAccountId);
    if (open >= MAX_OPEN_WIKI_REVISIONS) {
      return {
        ok: false,
        error: `You already have ${MAX_OPEN_WIKI_REVISIONS} unapproved wiki changes. Wait for review before editing more.`,
      };
    }
  }
  const existing = await getWikiPageBySlug(slug);
  const now = Date.now();
  const authorId = Number(formbarId) || 0;
  const authorName = sanitizeUserText(name, { max: 80, allowNewlines: false })
    || `Player ${authorId || authorAccountId || "?"}`;
  const storedAccountId = Number.isInteger(authorAccountId) && authorAccountId > 0
    ? authorAccountId
    : null;

  if (existing) {
    const rev = await run(
      `INSERT INTO wiki_revisions (page_id, formbar_id, account_id, name, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [existing.page.id, authorId, storedAccountId, authorName, trimmedBody, now],
    );
    await run(
      "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
      [rev.lastID, existing.page.id],
    );
    return { ok: true, slug: existing.page.slug, created: false };
  }

  const pageTitle = sanitizeUserText(title, { max: WIKI_TITLE_MAX, allowNewlines: false });
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
    `INSERT INTO wiki_revisions (page_id, formbar_id, account_id, name, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [page.lastID, authorId, storedAccountId, authorName, trimmedBody, now],
  );
  await run(
    "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
    [rev.lastID, page.lastID],
  );
  return { ok: true, slug: newSlug, created: true };
}

export async function deleteWikiPageBySlug(slug) {
  const existing = await getWikiPageBySlug(slug);
  if (!existing) {
    return { ok: false, error: "Page not found." };
  }
  if (existing.page.slug === "home") {
    return { ok: false, error: "The home page cannot be deleted." };
  }
  await run("DELETE FROM wiki_revisions WHERE page_id = ?", [existing.page.id]);
  await run("DELETE FROM wiki_pages WHERE id = ?", [existing.page.id]);
  return { ok: true, slug: existing.page.slug };
}

export async function listOpenWikiRevisions() {
  return all(
    `SELECT r.id, r.page_id, r.formbar_id, r.account_id, r.name, r.body, r.created_at,
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
