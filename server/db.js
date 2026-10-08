import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import {
  buildDiscriminatedDisplayName,
  sanitizeDisplayName,
  validateDisplayName,
} from "./auth.js";
import { asErr, logger } from "./logger.js";
import { metricsEnabled, noteSqliteBusy, noteSqliteWrite } from "./metrics.js";
import { ownerBase, pickLeastLoaded, workerCount } from "./owners.js";

function logRollbackFailed(op, rollbackErr) {
  logger.error({
    event: "db_rollback_failed",
    op,
    err: asErr(rollbackErr),
  }, "SQLite rollback failed");
}

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
    account_id INTEGER,
    digipogs INTEGER NOT NULL,
    tickets INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed'
  )`);
  const purchaseCols = await all("PRAGMA table_info(ticket_purchases)");
  if (!purchaseCols.some((col) => col.name === "account_id")) {
    await run("ALTER TABLE ticket_purchases ADD COLUMN account_id INTEGER");
  }
  if (!purchaseCols.some((col) => col.name === "status")) {
    await run("ALTER TABLE ticket_purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
  }
  await run("CREATE INDEX IF NOT EXISTS ticket_purchases_formbar ON ticket_purchases (formbar_id)");
  await run("CREATE INDEX IF NOT EXISTS ticket_purchases_pending ON ticket_purchases (account_id, status)");
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
    rewarded_at INTEGER,
    reward_status TEXT
  )`);
  const suggestionCols = await all("PRAGMA table_info(suggestions)");
  if (!suggestionCols.some((col) => col.name === "rewarded_at")) {
    await run("ALTER TABLE suggestions ADD COLUMN rewarded_at INTEGER");
  }
  if (!suggestionCols.some((col) => col.name === "account_id")) {
    await run("ALTER TABLE suggestions ADD COLUMN account_id INTEGER");
  }
  if (!suggestionCols.some((col) => col.name === "reward_status")) {
    await run("ALTER TABLE suggestions ADD COLUMN reward_status TEXT");
  }
  await run(
    `UPDATE suggestions SET reward_status = 'completed'
     WHERE rewarded_at IS NOT NULL AND (reward_status IS NULL OR reward_status = '')`,
  );
  await run("CREATE INDEX IF NOT EXISTS suggestions_open_account ON suggestions (account_id, archived_at, is_bug)");
  await run(`CREATE TABLE IF NOT EXISTS player_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_account_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    reported_account_id INTEGER NOT NULL,
    reported_name TEXT NOT NULL,
    match_id TEXT,
    match_mode TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at INTEGER,
    resolved_by INTEGER,
    resolution_note TEXT,
    UNIQUE(reporter_account_id, reported_account_id)
  )`);
  await run("CREATE INDEX IF NOT EXISTS player_reports_open ON player_reports (status, created_at)");
  await run("CREATE INDEX IF NOT EXISTS player_reports_reported ON player_reports (reported_account_id, status)");
  await run("CREATE INDEX IF NOT EXISTS player_reports_reporter ON player_reports (reporter_account_id)");
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
    rewarded_at INTEGER,
    reward_status TEXT
  )`);
  const wikiRevCols = await all("PRAGMA table_info(wiki_revisions)");
  if (!wikiRevCols.some((col) => col.name === "account_id")) {
    await run("ALTER TABLE wiki_revisions ADD COLUMN account_id INTEGER");
  }
  if (!wikiRevCols.some((col) => col.name === "reward_status")) {
    await run("ALTER TABLE wiki_revisions ADD COLUMN reward_status TEXT");
  }
  await run(
    `UPDATE wiki_revisions SET reward_status = 'completed'
     WHERE rewarded_at IS NOT NULL AND (reward_status IS NULL OR reward_status = '')`,
  );
  await run("CREATE INDEX IF NOT EXISTS wiki_revisions_open_account ON wiki_revisions (account_id, confirmed_at, undone_at)");
  await ensureAdminSchema();
  await run("UPDATE accounts SET held = 0");
  const userCols = await all("PRAGMA table_info(users)");
  if (!userCols.some((col) => col.name === "tooltips")) {
    await run("ALTER TABLE users ADD COLUMN tooltips INTEGER NOT NULL DEFAULT 1");
  }
  if (!userCols.some((col) => col.name === "bgm_volume")) {
    await run("ALTER TABLE users ADD COLUMN bgm_volume INTEGER NOT NULL DEFAULT 50");
  }
  await seedWikiHome();
  await bootstrapAdminRoles();
  logger.info({ event: "db_ready", dbFile: path.basename(dbFile) }, "database ready");
}

const ACCOUNT_SELECT = `id, formbar_id, discord_id, email, password_hash, email_verified_at, email_verified_by, email_verified_reason, name, role, mmr, tickets, held, wins, losses, tooltips, bgm_volume, banned_at, ban_reason, ban_expires_at, banned_by_account_id, last_login_at, last_seen_at, admin_notes, session_epoch, created_at, updated_at`;

export const ACCOUNT_ROLES = Object.freeze(["player", "moderator", "admin"]);

export function normalizeAccountRole(role) {
  const value = String(role || "player").trim().toLowerCase();
  return ACCOUNT_ROLES.includes(value) ? value : "player";
}

export function isStaffRole(role) {
  const r = normalizeAccountRole(role);
  return r === "admin" || r === "moderator";
}

export function isAdminRole(role) {
  return normalizeAccountRole(role) === "admin";
}

export function isAccountBanned(account, now = Date.now()) {
  if (!account || account.banned_at == null) return false;
  const expires = account.ban_expires_at;
  if (expires != null && Number(expires) > 0 && Number(expires) <= now) return false;
  return true;
}

async function ensureAccountColumn(cols, name, ddl) {
  if (!cols.some((col) => col.name === name)) {
    await run(`ALTER TABLE accounts ADD COLUMN ${ddl}`);
  }
}

async function ensureAdminSchema() {
  const accountCols = await all("PRAGMA table_info(accounts)");
  await ensureAccountColumn(accountCols, "role", "role TEXT NOT NULL DEFAULT 'player'");
  await ensureAccountColumn(accountCols, "banned_at", "banned_at INTEGER");
  await ensureAccountColumn(accountCols, "ban_reason", "ban_reason TEXT");
  await ensureAccountColumn(accountCols, "ban_expires_at", "ban_expires_at INTEGER");
  await ensureAccountColumn(accountCols, "banned_by_account_id", "banned_by_account_id INTEGER");
  await ensureAccountColumn(accountCols, "last_login_at", "last_login_at INTEGER");
  await ensureAccountColumn(accountCols, "last_seen_at", "last_seen_at INTEGER");
  await ensureAccountColumn(accountCols, "admin_notes", "admin_notes TEXT");
  await ensureAccountColumn(accountCols, "session_epoch", "session_epoch INTEGER NOT NULL DEFAULT 0");
  await ensureAccountColumn(accountCols, "email_verified_by", "email_verified_by INTEGER");
  await ensureAccountColumn(accountCols, "email_verified_reason", "email_verified_reason TEXT");
  await run("CREATE INDEX IF NOT EXISTS accounts_role ON accounts (role)");
  await run("CREATE INDEX IF NOT EXISTS accounts_banned_at ON accounts (banned_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_last_seen ON accounts (last_seen_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_name_nocase ON accounts (name COLLATE NOCASE)");
  await run("CREATE INDEX IF NOT EXISTS accounts_email_verified ON accounts (email_verified_at)");

  const gameCols = await all("PRAGMA table_info(games)");
  if (!gameCols.some((col) => col.name === "win_reason")) {
    await run("ALTER TABLE games ADD COLUMN win_reason TEXT");
  }
  if (!gameCols.some((col) => col.name === "outcome")) {
    await run("ALTER TABLE games ADD COLUMN outcome TEXT");
  }
  if (!gameCols.some((col) => col.name === "chat_json")) {
    await run("ALTER TABLE games ADD COLUMN chat_json TEXT");
  }
  await run("CREATE INDEX IF NOT EXISTS games_ended_at ON games (ended_at)");
  await run("CREATE INDEX IF NOT EXISTS games_mode_ended ON games (mode, ended_at)");

  await run(`CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_account_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    reason TEXT,
    before_json TEXT,
    after_json TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit (created_at)");
  await run("CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit (target_type, target_id)");
  await run("CREATE INDEX IF NOT EXISTS admin_audit_admin ON admin_audit (admin_account_id, created_at)");

  await run(`CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS ticket_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    held_after INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    actor_account_id INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS ticket_ledger_account ON ticket_ledger (account_id, created_at)");
  await run("CREATE INDEX IF NOT EXISTS ticket_ledger_created ON ticket_ledger (created_at, kind)");

  await run(`CREATE TABLE IF NOT EXISTS activity_day (
    account_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (account_id, day)
  )`);
  await run("CREATE INDEX IF NOT EXISTS activity_day_day ON activity_day (day)");

  await run(`CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    provider TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS login_events_created ON login_events (created_at)");
  await run("CREATE INDEX IF NOT EXISTS login_events_account ON login_events (account_id, created_at)");

  await run(`CREATE TABLE IF NOT EXISTS ops_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rooms INTEGER NOT NULL DEFAULT 0,
    sockets INTEGER NOT NULL DEFAULT 0,
    queue_casual INTEGER NOT NULL DEFAULT 0,
    queue_ranked INTEGER NOT NULL DEFAULT 0,
    queue_training INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS ops_samples_created ON ops_samples (created_at)");

  await run(`CREATE TABLE IF NOT EXISTS mm_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    mode TEXT,
    account_id INTEGER,
    match_id TEXT,
    wait_ms INTEGER,
    meta_json TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS mm_events_created ON mm_events (created_at, event)");

  await run(`CREATE TABLE IF NOT EXISTS admin_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    module TEXT,
    account_id INTEGER,
    match_id TEXT,
    request_id TEXT,
    message TEXT,
    meta_json TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS admin_events_created ON admin_events (created_at)");
  await run("CREATE INDEX IF NOT EXISTS admin_events_level ON admin_events (level, created_at)");
  await run("CREATE INDEX IF NOT EXISTS admin_events_event ON admin_events (event, created_at)");
  await run("CREATE INDEX IF NOT EXISTS admin_events_match ON admin_events (match_id)");
  await run("CREATE INDEX IF NOT EXISTS admin_events_account ON admin_events (account_id, created_at)");
}

async function bootstrapAdminRoles() {
  const existing = await get(
    "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'",
  );
  if (existing && Number(existing.n) > 0) return;

  let accountId = null;
  let source = null;
  const bootstrapId = Number(process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID);
  if (Number.isInteger(bootstrapId) && bootstrapId > 0) {
    const account = await getAccount(bootstrapId);
    if (account) {
      accountId = account.id;
      source = "ADMIN_BOOTSTRAP_ACCOUNT_ID";
    }
  }
  if (accountId == null) {
    const formbarId = Number(process.env.ADMIN_USER_ID);
    if (Number.isInteger(formbarId) && formbarId > 0) {
      const account = await getAccountByFormbar(formbarId);
      if (account) {
        accountId = account.id;
        source = "ADMIN_USER_ID";
      }
    }
  }
  if (accountId == null) {
    logger.warn({
      event: "admin_bootstrap_missing",
    }, "no admin role accounts; set ADMIN_BOOTSTRAP_ACCOUNT_ID or link ADMIN_USER_ID formbar account");
    return;
  }
  await run(
    "UPDATE accounts SET role = 'admin', updated_at = ? WHERE id = ?",
    [Date.now(), accountId],
  );
  await writeAdminAudit({
    adminAccountId: null,
    action: "role_bootstrap",
    targetType: "account",
    targetId: String(accountId),
    reason: `bootstrap via ${source}`,
    before: { role: "player" },
    after: { role: "admin" },
  });
  logger.info({
    event: "admin_bootstrap",
    accountId,
    source,
  }, "promoted bootstrap admin account");
}

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
      email_verified_by INTEGER,
      email_verified_reason TEXT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'player',
      mmr INTEGER NOT NULL,
      tickets INTEGER NOT NULL DEFAULT 0,
      held INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      tooltips INTEGER NOT NULL DEFAULT 1,
      bgm_volume INTEGER NOT NULL DEFAULT 50,
      banned_at INTEGER,
      ban_reason TEXT,
      ban_expires_at INTEGER,
      banned_by_account_id INTEGER,
      last_login_at INTEGER,
      last_seen_at INTEGER,
      admin_notes TEXT,
      session_epoch INTEGER NOT NULL DEFAULT 0,
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

export async function getAccountByName(name) {
  const key = String(name || "").trim();
  if (!key) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE name = ? COLLATE NOCASE`,
    [key],
  );
  return row || null;
}

/** True if another account already uses this display name (case-insensitive). */
export async function isDisplayNameTaken(name, excludeAccountId = null) {
  const existing = await getAccountByName(name);
  if (!existing) return false;
  if (excludeAccountId != null && Number(existing.id) === Number(excludeAccountId)) {
    return false;
  }
  return true;
}

/**
 * Pick a free MOTL display name from a preferred provider/local name.
 * Adds " 2", " 3", … when taken. Returns `{ name, adjusted }`.
 */
export async function allocateUniqueDisplayName(desired, options = {}) {
  const excludeAccountId = options.excludeAccountId != null
    ? Number(options.excludeAccountId)
    : null;
  const preferredCheck = validateDisplayName(desired);
  const preferred = preferredCheck.ok
    ? preferredCheck.name
    : (sanitizeDisplayName(desired) || "Player");
  const baseCheck = validateDisplayName(preferred);
  const base = baseCheck.ok ? baseCheck.name : "Player";

  for (let n = 1; n <= 9999; n += 1) {
    const candidate = buildDiscriminatedDisplayName(base, n);
    if (!candidate) continue;
    if (!(await isDisplayNameTaken(candidate, excludeAccountId))) {
      return {
        name: candidate,
        adjusted: !preferredCheck.ok || candidate !== preferredCheck.name,
      };
    }
  }
  const fallback = `Player ${Date.now().toString(36).slice(-6)}`;
  return { name: fallback, adjusted: true };
}

export async function setAccountDisplayName(accountId, name) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  const check = validateDisplayName(name);
  if (!check.ok) return { ok: false, error: "invalid", message: check.error };
  if (await isDisplayNameTaken(check.name, id)) {
    return { ok: false, error: "taken" };
  }
  const result = await run(
    "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?",
    [check.name, Date.now(), id],
  );
  if (!result.changes) return { ok: false, error: "missing" };
  return { ok: true, name: check.name, account: await getAccount(id) };
}

export async function upsertAccount(formbarId, name) {
  const fid = Number(formbarId);
  if (!Number.isInteger(fid) || fid <= 0) return null;
  const existing = await getAccountByFormbar(fid);
  if (existing) return existing;
  const now = Date.now();
  const { name: uniqueName } = await allocateUniqueDisplayName(name);
  const result = await run(
    `INSERT INTO accounts (
      formbar_id, name, mmr, tickets, held, wins, losses, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [fid, uniqueName, startingMmr(), now, now],
  );
  return getAccount(result.lastID);
}

export async function upsertDiscordAccount(discordId, name) {
  const did = String(discordId || "").trim();
  if (!did || did.length > 32) return null;
  const existing = await getAccountByDiscord(did);
  if (existing) return existing;
  const now = Date.now();
  const { name: uniqueName } = await allocateUniqueDisplayName(name);
  const result = await run(
    `INSERT INTO accounts (
      discord_id, name, mmr, tickets, held, wins, losses, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [did, uniqueName, startingMmr(), now, now],
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
  const { name: uniqueName } = await allocateUniqueDisplayName(name);
  const result = await run(
    `INSERT INTO accounts (
      email, password_hash, email_verified_at, name, mmr, tickets, held, wins, losses,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
    [email, passwordHash, verifiedAt, uniqueName, startingMmr(), now, now],
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

export async function setEmailVerified(accountId, at = Date.now(), extras = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const when = Number(at);
  if (!Number.isFinite(when) || when < 1_000_000_000_000) {
    throw new Error("email_verified_at must be a millisecond timestamp");
  }
  const by = extras.verifiedBy != null ? Number(extras.verifiedBy) : null;
  const reason = extras.reason != null ? String(extras.reason).slice(0, 500) : null;
  const result = await run(
    `UPDATE accounts
     SET email_verified_at = ?, email_verified_by = ?, email_verified_reason = ?, updated_at = ?
     WHERE id = ?`,
    [
      when,
      Number.isInteger(by) && by > 0 ? by : null,
      reason,
      Date.now(),
      id,
    ],
  );
  return result.changes > 0;
}

/** Remove a brand-new local account when verification email fails to send. */
export async function deleteLocalAccount(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT id, formbar_id, discord_id, email, password_hash FROM accounts WHERE id = ?",
        [id],
      );
      if (!row || row.formbar_id || row.discord_id || !row.email || !row.password_hash) {
        await execRun("ROLLBACK");
        return false;
      }
      await execRun("DELETE FROM auth_tokens WHERE account_id = ?", [id]);
      const result = await execRun("DELETE FROM accounts WHERE id = ?", [id]);
      await execRun("COMMIT");
      return result.changes > 0;
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("deleteLocalAccount", rollbackErr);
      }
      throw err;
    }
  });
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
    return { ok: true, account: target, merged: false };
  }
  if (target.formbar_id) return { ok: false, error: "already_linked" };
  const other = await getAccountByFormbar(fid);
  if (other && other.id !== id) {
    const merged = await mergeAccounts(id, other.id, { formbarId: fid });
    if (!merged.ok) return merged;
    return { ok: true, account: merged.account, merged: true };
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
  return { ok: true, account: await getAccount(id), merged: false };
}

export async function linkDiscordToAccount(accountId, discordId) {
  const id = Number(accountId);
  const did = String(discordId || "").trim();
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  if (!did || did.length > 32) return { ok: false, error: "bad_discord" };
  const target = await getAccount(id);
  if (!target) return { ok: false, error: "missing" };
  if (target.discord_id && String(target.discord_id) === did) {
    return { ok: true, account: target, merged: false };
  }
  if (target.discord_id) return { ok: false, error: "already_linked" };
  const other = await getAccountByDiscord(did);
  if (other && other.id !== id) {
    const merged = await mergeAccounts(id, other.id, { discordId: did });
    if (!merged.ok) return merged;
    return { ok: true, account: merged.account, merged: true };
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
  return { ok: true, account: await getAccount(id), merged: false };
}

/**
 * Merge donor into survivor (logged-in account). Unions Formbar / Discord / email
 * when only one side has each; refuses if both have different values for the same
 * provider. Sums tickets/wins/losses; MMR is the max; keeps survivor name.
 */
export async function mergeAccounts(survivorId, donorId, options = {}) {
  const survivor = await getAccount(survivorId);
  const donor = await getAccount(donorId);
  if (!survivor || !donor) return { ok: false, error: "missing" };
  if (survivor.id === donor.id) return { ok: true, account: survivor };

  const survivorFormbar = survivor.formbar_id != null ? Number(survivor.formbar_id) : null;
  const donorFormbar = donor.formbar_id != null ? Number(donor.formbar_id) : null;
  if (
    survivorFormbar
    && donorFormbar
    && survivorFormbar !== donorFormbar
  ) {
    return { ok: false, error: "conflict_formbar" };
  }

  const survivorDiscord = survivor.discord_id ? String(survivor.discord_id) : null;
  const donorDiscord = donor.discord_id ? String(donor.discord_id) : null;
  if (survivorDiscord && donorDiscord && survivorDiscord !== donorDiscord) {
    return { ok: false, error: "conflict_discord" };
  }

  const survivorEmail = survivor.email ? String(survivor.email) : null;
  const donorEmail = donor.email ? String(donor.email) : null;
  if (survivorEmail && donorEmail && survivorEmail !== donorEmail) {
    return { ok: false, error: "conflict_email" };
  }

  let formbarId = survivorFormbar || donorFormbar || null;
  if (options.formbarId != null) formbarId = Number(options.formbarId);

  let discordId = survivorDiscord || donorDiscord || null;
  if (options.discordId != null) discordId = String(options.discordId).trim() || null;

  let email = survivorEmail || donorEmail || null;
  if (options.email != null) email = options.email;

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
      await execRun(
        "UPDATE suggestions SET account_id = ? WHERE account_id = ?",
        [survivor.id, donor.id],
      );
      await execRun(
        "UPDATE wiki_revisions SET account_id = ? WHERE account_id = ?",
        [survivor.id, donor.id],
      );
      await execRun("DELETE FROM auth_tokens WHERE account_id = ?", [donor.id]);
      await execRun("DELETE FROM accounts WHERE id = ?", [donor.id]);
      await execRun("COMMIT");
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("mergeAccounts", rollbackErr);
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

async function insertTicketLedger(exec, {
  accountId,
  delta,
  balanceAfter,
  heldAfter,
  kind,
  refType = null,
  refId = null,
  actorAccountId = null,
  reason = null,
  createdAt = Date.now(),
}) {
  await exec(
    `INSERT INTO ticket_ledger (
      account_id, delta, balance_after, held_after, kind,
      ref_type, ref_id, actor_account_id, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      delta,
      balanceAfter,
      heldAfter,
      kind,
      refType,
      refId != null ? String(refId) : null,
      actorAccountId,
      reason,
      createdAt,
    ],
  );
}

export async function holdTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row || row.tickets <= row.held) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET held = held + 1, updated_at = ? WHERE id = ?",
        [now, id],
      );
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: 0,
        balanceAfter: row.tickets,
        heldAfter: row.held + 1,
        kind: "hold",
        createdAt: now,
      });
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("holdTicket", rollbackErr);
      }
      throw err;
    }
  });
}

export async function releaseHold(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row || row.held <= 0) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET held = held - 1, updated_at = ? WHERE id = ?",
        [now, id],
      );
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: 0,
        balanceAfter: row.tickets,
        heldAfter: row.held - 1,
        kind: "release",
        createdAt: now,
      });
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("releaseHold", rollbackErr);
      }
      throw err;
    }
  });
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
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row || row.tickets <= 0 || row.held <= 0) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      const result = await execRun(
        `UPDATE accounts
         SET tickets = tickets - 1, held = held - 1, updated_at = ?
         WHERE id = ? AND tickets > 0 AND held > 0`,
        [now, id],
      );
      if (!result.changes) {
        await execRun("ROLLBACK");
        return false;
      }
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: -1,
        balanceAfter: row.tickets - 1,
        heldAfter: row.held - 1,
        kind: "charge",
        createdAt: now,
      });
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("chargeHeld", rollbackErr);
      }
      throw err;
    }
  });
}

export async function refundTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return;
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET tickets = tickets + 1, updated_at = ? WHERE id = ?",
        [now, id],
      );
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: 1,
        balanceAfter: row.tickets + 1,
        heldAfter: row.held,
        kind: "refund",
        createdAt: now,
      });
      await execRun("COMMIT");
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("refundTicket", rollbackErr);
      }
      throw err;
    }
  });
}

/** Spend one unused ticket (not held for a match). */
export async function spendFreeTicket(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row || row.tickets <= row.held) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      const result = await execRun(
        `UPDATE accounts
         SET tickets = tickets - 1, updated_at = ?
         WHERE id = ? AND tickets > held`,
        [now, id],
      );
      if (!result.changes) {
        await execRun("ROLLBACK");
        return false;
      }
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: -1,
        balanceAfter: row.tickets - 1,
        heldAfter: row.held,
        kind: "spend",
        createdAt: now,
      });
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("spendFreeTicket", rollbackErr);
      }
      throw err;
    }
  });
}

const ticketPurchaseLocks = new Set();

/** One in-flight purchase per account, in addition to the pending database row. */
export function tryLockTicketPurchase(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (ticketPurchaseLocks.has(id)) return false;
  ticketPurchaseLocks.add(id);
  return true;
}

export function unlockTicketPurchase(accountId) {
  ticketPurchaseLocks.delete(Number(accountId));
}

/**
 * Insert a pending purchase. Returns null when this account already has one.
 * A pending row is not retried: Formbar has no idempotency id, so an unknown
 * outcome must stay pending instead of charging again.
 */
export async function beginTicketPurchase({ accountId, formbarId, tickets, digipogs }) {
  const id = Number(accountId);
  const fid = Number(formbarId);
  const count = Number(tickets);
  const cost = Number(digipogs);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(fid) || fid <= 0) return null;
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const pending = await get(
    "SELECT id FROM ticket_purchases WHERE account_id = ? AND status = 'pending'",
    [id],
  );
  if (pending) return null;
  const result = await run(
    `INSERT INTO ticket_purchases (formbar_id, account_id, digipogs, tickets, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [fid, id, cost, count, Date.now()],
  );
  return result.lastID;
}

export async function failTicketPurchase(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE ticket_purchases SET status = 'failed' WHERE id = ? AND status = 'pending'",
    [id],
  );
  return result.changes > 0;
}

/** Credit tickets and mark the pending purchase completed in one transaction. */
export async function completeTicketPurchase(purchaseId, accountId, tickets) {
  const id = Number(purchaseId);
  const account = Number(accountId);
  const count = Number(tickets);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!Number.isInteger(account) || account <= 0) return false;
  if (!Number.isInteger(count) || count <= 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const marked = await execRun(
        "UPDATE ticket_purchases SET status = 'completed' WHERE id = ? AND status = 'pending'",
        [id],
      );
      if (!marked.changes) {
        await execRun("ROLLBACK");
        return false;
      }
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [account],
      );
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE id = ?",
        [count, now, account],
      );
      if (row) {
        await insertTicketLedger(execRun, {
          accountId: account,
          delta: count,
          balanceAfter: row.tickets + count,
          heldAfter: row.held,
          kind: "purchase",
          refType: "ticket_purchase",
          refId: id,
          createdAt: now,
        });
      }
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("completeTicketPurchase", rollbackErr);
      }
      throw err;
    }
  });
}

/** Credit tickets after Digipog payment; records a completed purchase. */
export async function addTickets(accountId, tickets, digipogs, formbarId) {
  const id = Number(accountId);
  const fid = Number(formbarId);
  const count = Number(tickets);
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      await execRun(
        "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE id = ?",
        [count, now, id],
      );
      let purchaseId = null;
      if (Number.isInteger(fid) && fid > 0) {
        const inserted = await execRun(
          `INSERT INTO ticket_purchases (formbar_id, account_id, digipogs, tickets, created_at, status)
           VALUES (?, ?, ?, ?, ?, 'completed')`,
          [fid, id, digipogs, count, now],
        );
        purchaseId = inserted.lastID;
      }
      if (row) {
        await insertTicketLedger(execRun, {
          accountId: id,
          delta: count,
          balanceAfter: row.tickets + count,
          heldAfter: row.held,
          kind: "purchase",
          refType: purchaseId != null ? "ticket_purchase" : null,
          refId: purchaseId,
          createdAt: now,
        });
      }
      await execRun("COMMIT");
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("addTickets", rollbackErr);
      }
      throw err;
    }
  });
}

/** Dev/test helper: grant tickets without Digipog purchase. */
export async function grantTickets(accountId, tickets) {
  const id = Number(accountId);
  const n = Number(tickets);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n === 0) return false;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET tickets = tickets + ?, updated_at = ? WHERE id = ?",
        [n, now, id],
      );
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: n,
        balanceAfter: row.tickets + n,
        heldAfter: row.held,
        kind: "grant",
        createdAt: now,
      });
      await execRun("COMMIT");
      return true;
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("grantTickets", rollbackErr);
      }
      throw err;
    }
  });
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
        logRollbackFailed("assignOwner", rollbackErr);
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
          created_at, ended_at, win_reason, outcome, chat_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          game.winReason || null,
          game.outcome || (game.winReason === "concede" ? "forfeit" : "completed"),
          game.chatJson ?? null,
        ],
      );
      await execRun("COMMIT");
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("recordMatchResult", rollbackErr);
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
      created_at, ended_at, win_reason, outcome, chat_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      game.winReason || null,
      game.outcome || (game.winReason === "concede" ? "forfeit" : "completed"),
      game.chatJson ?? null,
    ],
  );
}

/** Persist in-match gesture tooltip preference for a logged-in account. Guests use cookies. */
export async function setPlayerTooltips(player, on) {
  const value = on ? 1 : 0;
  if (!player || !player.accountId) return false;
  const id = Number(player.accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET tooltips = ?, updated_at = ? WHERE id = ?",
    [value, Date.now(), id],
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

/** Persist match BGM volume preference for a logged-in account. Guests use cookies. */
export async function setPlayerBgmVolume(player, percent) {
  const value = clampBgmVolumePercent(percent);
  if (!player || !player.accountId) return false;
  const id = Number(player.accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET bgm_volume = ?, updated_at = ? WHERE id = ?",
    [value, Date.now(), id],
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
    `SELECT COUNT(*) AS accounts,
            COALESCE(SUM(tickets), 0) AS tickets,
            COALESCE(SUM(held), 0) AS held
     FROM accounts`,
  );
  const games = await get(
    `SELECT COUNT(*) AS finished,
            COALESCE(SUM(CASE WHEN mode = 'ranked' THEN 1 ELSE 0 END), 0) AS ranked
     FROM games`,
  );
  const spent = await get(
    `SELECT COALESCE(SUM(digipogs), 0) AS digipogs
     FROM ticket_purchases WHERE status = 'completed'`,
  );
  const roles = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS admins,
       COALESCE(SUM(CASE WHEN role = 'moderator' THEN 1 ELSE 0 END), 0) AS moderators
     FROM accounts`,
  );
  return {
    accounts: accounts.accounts,
    tickets: accounts.tickets,
    held: accounts.held,
    finished: games.finished,
    ranked: games.ranked,
    digipogs: spent.digipogs,
    admins: roles.admins,
    moderators: roles.moderators,
  };
}

export async function writeAdminAudit({
  adminAccountId = null,
  action,
  targetType = null,
  targetId = null,
  reason = null,
  before = null,
  after = null,
  ip = null,
  createdAt = Date.now(),
}) {
  if (!action) return null;
  const result = await run(
    `INSERT INTO admin_audit (
      admin_account_id, action, target_type, target_id, reason,
      before_json, after_json, ip, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adminAccountId,
      String(action),
      targetType,
      targetId != null ? String(targetId) : null,
      reason,
      before != null ? JSON.stringify(before) : null,
      after != null ? JSON.stringify(after) : null,
      ip,
      createdAt,
    ],
  );
  return result.lastID;
}

export async function listAdminAudit({
  page = 1,
  pageSize = 50,
  targetType = null,
  targetId = null,
  adminAccountId = null,
} = {}) {
  const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const offset = Math.max(0, ((Number(page) || 1) - 1) * size);
  const where = [];
  const params = [];
  if (targetType) {
    where.push("target_type = ?");
    params.push(targetType);
  }
  if (targetId != null) {
    where.push("target_id = ?");
    params.push(String(targetId));
  }
  if (adminAccountId != null) {
    where.push("admin_account_id = ?");
    params.push(Number(adminAccountId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await get(
    `SELECT COUNT(*) AS n FROM admin_audit ${clause}`,
    params,
  );
  const rows = await all(
    `SELECT * FROM admin_audit ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return {
    rows,
    total: Number(totalRow?.n) || 0,
    page: Math.floor(offset / size) + 1,
    pageSize: size,
  };
}

export async function countAdmins() {
  const row = await get("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'");
  return Number(row?.n) || 0;
}

export async function setAccountRole(accountId, role) {
  const id = Number(accountId);
  const next = normalizeAccountRole(role);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  const account = await getAccount(id);
  if (!account) return { ok: false, error: "not_found" };
  const prev = normalizeAccountRole(account.role);
  if (prev === "admin" && next !== "admin") {
    const n = await countAdmins();
    if (n <= 1) return { ok: false, error: "last_admin" };
  }
  await run(
    "UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?",
    [next, Date.now(), id],
  );
  return { ok: true, before: prev, after: next, account: await getAccount(id) };
}

export async function banAccount(accountId, {
  reason,
  expiresAt = null,
  bannedBy = null,
} = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  const account = await getAccount(id);
  if (!account) return { ok: false, error: "not_found" };
  if (isAdminRole(account.role) && (await countAdmins()) <= 1) {
    return { ok: false, error: "last_admin" };
  }
  const now = Date.now();
  const exp = expiresAt != null ? Number(expiresAt) : null;
  await run(
    `UPDATE accounts
     SET banned_at = ?, ban_reason = ?, ban_expires_at = ?, banned_by_account_id = ?,
         session_epoch = session_epoch + 1, updated_at = ?
     WHERE id = ?`,
    [
      now,
      String(reason || "").slice(0, 500) || "Banned",
      Number.isFinite(exp) && exp > now ? exp : null,
      bannedBy,
      now,
      id,
    ],
  );
  return { ok: true, account: await getAccount(id) };
}

export async function unbanAccount(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  await run(
    `UPDATE accounts
     SET banned_at = NULL, ban_reason = NULL, ban_expires_at = NULL,
         banned_by_account_id = NULL, updated_at = ?
     WHERE id = ?`,
    [Date.now(), id],
  );
  return { ok: true, account: await getAccount(id) };
}

export async function bumpSessionEpoch(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = ?",
    [Date.now(), id],
  );
  return result.changes > 0;
}

export async function setAdminNotes(accountId, notes) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await run(
    "UPDATE accounts SET admin_notes = ?, updated_at = ? WHERE id = ?",
    [String(notes || "").slice(0, 4000), Date.now(), id],
  );
  return result.changes > 0;
}

export async function adjustTicketsAdmin(accountId, delta, {
  actorAccountId = null,
  reason = null,
} = {}) {
  const id = Number(accountId);
  const n = Number(delta);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(n) || n === 0) {
    return { ok: false, error: "invalid" };
  }
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      const nextTickets = row.tickets + n;
      if (nextTickets < row.held) {
        await execRun("ROLLBACK");
        return { ok: false, error: "below_held", held: row.held, tickets: row.tickets };
      }
      if (nextTickets < 0) {
        await execRun("ROLLBACK");
        return { ok: false, error: "below_zero" };
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET tickets = ?, updated_at = ? WHERE id = ?",
        [nextTickets, now, id],
      );
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: n,
        balanceAfter: nextTickets,
        heldAfter: row.held,
        kind: "admin_adjust",
        actorAccountId,
        reason,
        createdAt: now,
      });
      await execRun("COMMIT");
      return {
        ok: true,
        before: row.tickets,
        after: nextTickets,
        held: row.held,
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("adjustTicketsAdmin", rollbackErr);
      }
      throw err;
    }
  });
}

export async function touchAccountLogin(accountId, provider = null) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  await run(
    "UPDATE accounts SET last_login_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
    [now, now, now, id],
  );
  await run(
    "INSERT OR IGNORE INTO activity_day (account_id, day) VALUES (?, ?)",
    [id, day],
  );
  await run(
    "INSERT INTO login_events (account_id, provider, ok, created_at) VALUES (?, ?, 1, ?)",
    [id, provider, now],
  );
}

const lastSeenDebounce = new Map();

export async function touchAccountSeen(accountId, debounceMs = 5 * 60 * 1000) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  const now = Date.now();
  const prev = lastSeenDebounce.get(id) || 0;
  if (now - prev < debounceMs) return;
  lastSeenDebounce.set(id, now);
  const day = new Date(now).toISOString().slice(0, 10);
  await run(
    "UPDATE accounts SET last_seen_at = ? WHERE id = ?",
    [now, id],
  );
  await run(
    "INSERT OR IGNORE INTO activity_day (account_id, day) VALUES (?, ?)",
    [id, day],
  );
}

export async function recordLoginFailure(provider = null, accountId = null) {
  await run(
    "INSERT INTO login_events (account_id, provider, ok, created_at) VALUES (?, ?, 0, ?)",
    [accountId, provider, Date.now()],
  );
}

export async function recordMmEvent({
  event,
  mode = null,
  accountId = null,
  matchId = null,
  waitMs = null,
  meta = null,
}) {
  await run(
    `INSERT INTO mm_events (event, mode, account_id, match_id, wait_ms, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      event,
      mode,
      accountId,
      matchId,
      waitMs,
      meta != null ? JSON.stringify(meta) : null,
      Date.now(),
    ],
  );
}

export async function recordOpsSample({
  rooms = 0,
  sockets = 0,
  queueCasual = 0,
  queueRanked = 0,
  queueTraining = 0,
} = {}) {
  await run(
    `INSERT INTO ops_samples (
      rooms, sockets, queue_casual, queue_ranked, queue_training, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [rooms, sockets, queueCasual, queueRanked, queueTraining, Date.now()],
  );
}

export async function writeAdminEvent({
  level = "info",
  event,
  module = null,
  accountId = null,
  matchId = null,
  requestId = null,
  message = null,
  meta = null,
}) {
  if (!event) return null;
  const result = await run(
    `INSERT INTO admin_events (
      level, event, module, account_id, match_id, request_id, message, meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(level || "info"),
      String(event),
      module,
      accountId,
      matchId,
      requestId,
      message != null ? String(message).slice(0, 2000) : null,
      meta != null ? JSON.stringify(meta) : null,
      Date.now(),
    ],
  );
  return result.lastID;
}

export async function purgeAdminEvents(retainDays = 14) {
  const days = Math.max(1, Number(retainDays) || 14);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await run(
    "DELETE FROM admin_events WHERE created_at < ?",
    [cutoff],
  );
  return result.changes || 0;
}

export async function listAdminEvents({
  page = 1,
  pageSize = 50,
  level = null,
  event = null,
  module = null,
  accountId = null,
  matchId = null,
  since = null,
  until = null,
} = {}) {
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = Math.max(0, ((Number(page) || 1) - 1) * size);
  const where = [];
  const params = [];
  if (level) { where.push("level = ?"); params.push(level); }
  if (event) { where.push("event = ?"); params.push(event); }
  if (module) { where.push("module = ?"); params.push(module); }
  if (accountId != null) { where.push("account_id = ?"); params.push(Number(accountId)); }
  if (matchId) { where.push("match_id = ?"); params.push(String(matchId)); }
  if (since != null) { where.push("created_at >= ?"); params.push(Number(since)); }
  if (until != null) { where.push("created_at <= ?"); params.push(Number(until)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await get(`SELECT COUNT(*) AS n FROM admin_events ${clause}`, params);
  const rows = await all(
    `SELECT * FROM admin_events ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return {
    rows,
    total: Number(totalRow?.n) || 0,
    page: Math.floor(offset / size) + 1,
    pageSize: size,
  };
}

export async function getSiteSetting(key) {
  const row = await get("SELECT key, value, updated_at, updated_by FROM site_settings WHERE key = ?", [key]);
  return row || null;
}

export async function setSiteSetting(key, value, updatedBy = null) {
  const now = Date.now();
  await run(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [String(key), value != null ? String(value) : null, now, updatedBy],
  );
}

export async function getSiteSettings(keys = []) {
  if (!keys.length) {
    return all("SELECT key, value, updated_at, updated_by FROM site_settings");
  }
  const placeholders = keys.map(() => "?").join(", ");
  return all(
    `SELECT key, value, updated_at, updated_by FROM site_settings WHERE key IN (${placeholders})`,
    keys,
  );
}

export async function searchAccounts({
  q = "",
  filter = "",
  sort = "created_desc",
  page = 1,
  pageSize = 25,
} = {}) {
  const size = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const offset = Math.max(0, ((Number(page) || 1) - 1) * size);
  const where = [];
  const params = [];
  const query = String(q || "").trim();
  if (query) {
    if (/^\d+$/.test(query)) {
      where.push("(id = ? OR formbar_id = ? OR discord_id = ? OR email = ? OR name LIKE ? COLLATE NOCASE)");
      params.push(Number(query), Number(query), query, query.toLowerCase(), `%${query}%`);
    } else {
      where.push("(name LIKE ? COLLATE NOCASE OR email LIKE ? OR discord_id = ?)");
      params.push(`%${query}%`, `%${query.toLowerCase()}%`, query);
    }
  }
  const now = Date.now();
  if (filter === "banned") {
    where.push("banned_at IS NOT NULL AND (ban_expires_at IS NULL OR ban_expires_at > ?)");
    params.push(now);
  } else if (filter === "verified") {
    where.push("email IS NOT NULL AND email_verified_at IS NOT NULL");
  } else if (filter === "unverified") {
    where.push("email IS NOT NULL AND email_verified_at IS NULL");
  } else if (filter === "recent") {
    where.push("last_seen_at IS NOT NULL AND last_seen_at >= ?");
    params.push(now - 7 * 24 * 60 * 60 * 1000);
  } else if (filter === "local") {
    where.push("email IS NOT NULL");
  } else if (filter === "formbar") {
    where.push("formbar_id IS NOT NULL");
  } else if (filter === "discord") {
    where.push("discord_id IS NOT NULL");
  } else if (filter === "multi") {
    where.push(`(
      (CASE WHEN email IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN formbar_id IS NOT NULL THEN 1 ELSE 0 END) +
      (CASE WHEN discord_id IS NOT NULL THEN 1 ELSE 0 END)
    ) >= 2`);
  } else if (filter === "admin" || filter === "moderator" || filter === "player") {
    where.push("role = ?");
    params.push(filter);
  }
  let order = "created_at DESC";
  if (sort === "name") order = "name COLLATE NOCASE ASC";
  else if (sort === "mmr") order = "mmr DESC";
  else if (sort === "tickets") order = "tickets DESC";
  else if (sort === "last_seen") order = "last_seen_at DESC NULLS LAST";
  else if (sort === "created_asc") order = "created_at ASC";
  // SQLite lacks NULLS LAST on older builds — emulate
  if (sort === "last_seen") order = "CASE WHEN last_seen_at IS NULL THEN 1 ELSE 0 END, last_seen_at DESC";

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await get(`SELECT COUNT(*) AS n FROM accounts ${clause}`, params);
  const rows = await all(
    `SELECT ${ACCOUNT_SELECT} FROM accounts ${clause}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  return {
    rows: rows.map((row) => {
      const { password_hash: _ph, ...safe } = row;
      return safe;
    }),
    total: Number(totalRow?.n) || 0,
    page: Math.floor(offset / size) + 1,
    pageSize: size,
  };
}

export async function listTicketLedger(accountId, { limit = 50 } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return all(
    `SELECT * FROM ticket_ledger WHERE account_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [id, Math.min(200, Math.max(1, Number(limit) || 50))],
  );
}

export async function listAccountGames(accountId, { limit = 20 } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return all(
    `SELECT * FROM games
     WHERE account_a = ? OR account_b = ?
     ORDER BY ended_at DESC LIMIT ?`,
    [id, id, Math.min(100, Math.max(1, Number(limit) || 20))],
  );
}

/** Paginated ranked MMR deltas for a profile (seat-centric rows). */
export async function listAccountMmrHistory(accountId, { page = 1, pageSize = 20 } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) {
    return { rows: [], total: 0, page: 1, pageSize: 20 };
  }
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const offset = Math.max(0, ((Number(page) || 1) - 1) * size);
  const where = `mode = 'ranked' AND (
    (account_a = ? AND mmr_a_after IS NOT NULL)
    OR (account_b = ? AND mmr_b_after IS NOT NULL)
  )`;
  const params = [id, id];
  const totalRow = await get(`SELECT COUNT(*) AS n FROM games WHERE ${where}`, params);
  const raw = await all(
    `SELECT * FROM games WHERE ${where}
     ORDER BY ended_at DESC
     LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  const rows = raw.map((g) => {
    const isA = Number(g.account_a) === id;
    const mmrBefore = isA ? g.mmr_a_before : g.mmr_b_before;
    const mmrAfter = isA ? g.mmr_a_after : g.mmr_b_after;
    const won = isA ? g.winner_side === "player" : g.winner_side === "enemy";
    return {
      gameId: g.id,
      endedAt: g.ended_at,
      opponentName: isA ? g.name_b : g.name_a,
      opponentAccountId: isA ? g.account_b : g.account_a,
      won,
      mmrBefore,
      mmrAfter,
      delta: Number(mmrAfter) - Number(mmrBefore),
      outcome: g.outcome || null,
      winReason: g.win_reason || null,
    };
  });
  return {
    rows,
    total: Number(totalRow?.n) || 0,
    page: Math.floor(offset / size) + 1,
    pageSize: size,
  };
}

export async function getGameById(gameId) {
  if (!gameId) return null;
  const row = await get("SELECT * FROM games WHERE id = ?", [String(gameId)]);
  return row || null;
}

export async function listRecentGames({ mode = null, limit = 50, offset = 0 } = {}) {
  const size = Math.min(100, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  if (mode) {
    return all(
      `SELECT * FROM games WHERE mode = ? ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
      [mode, size, off],
    );
  }
  return all(
    `SELECT * FROM games ORDER BY ended_at DESC LIMIT ? OFFSET ?`,
    [size, off],
  );
}

/** Allowlisted columns for CSV export (never password_hash). */
export async function exportAccountsRows(limit = 5000) {
  const size = Math.min(10000, Math.max(1, Number(limit) || 5000));
  return all(
    `SELECT id, name, role, email, formbar_id, discord_id, mmr, tickets, held,
            wins, losses, email_verified_at, banned_at, created_at, last_seen_at
     FROM accounts ORDER BY id ASC LIMIT ?`,
    [size],
  );
}

export async function exportGamesRows(limit = 5000) {
  const size = Math.min(10000, Math.max(1, Number(limit) || 5000));
  return all(
    `SELECT id, mode, name_a, name_b, account_a, account_b, winner_side,
            win_reason, outcome, created_at, ended_at
     FROM games ORDER BY ended_at DESC LIMIT ?`,
    [size],
  );
}

export async function exportLedgerRows(limit = 5000) {
  const size = Math.min(10000, Math.max(1, Number(limit) || 5000));
  return all(
    `SELECT id, account_id, delta, balance_after, held_after, kind,
            ref_type, ref_id, actor_account_id, reason, created_at
     FROM ticket_ledger ORDER BY created_at DESC LIMIT ?`,
    [size],
  );
}

function rangeStartMs(range) {
  const now = Date.now();
  if (range === "24h") return now - 24 * 60 * 60 * 1000;
  if (range === "7d") return now - 7 * 24 * 60 * 60 * 1000;
  if (range === "30d") return now - 30 * 24 * 60 * 60 * 1000;
  if (range === "90d") return now - 90 * 24 * 60 * 60 * 1000;
  return null;
}

export async function analyticsSnapshot(range = "30d") {
  const since = rangeStartMs(range);
  const sinceClause = since != null ? "AND created_at >= ?" : "";
  const endedClause = since != null ? "AND ended_at >= ?" : "";
  const sinceParams = since != null ? [since] : [];

  const accountTotals = await get(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN created_at >= COALESCE(?, 0) THEN 1 ELSE 0 END), 0) AS new_in_range,
       COALESCE(SUM(CASE WHEN email IS NOT NULL AND email_verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verified,
       COALESCE(SUM(CASE WHEN email IS NOT NULL AND email_verified_at IS NULL THEN 1 ELSE 0 END), 0) AS unverified,
       COALESCE(SUM(CASE WHEN banned_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS banned,
       COALESCE(SUM(CASE WHEN formbar_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS formbar,
       COALESCE(SUM(CASE WHEN discord_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS discord,
       COALESCE(SUM(CASE WHEN email IS NOT NULL THEN 1 ELSE 0 END), 0) AS local_email,
       COALESCE(SUM(tickets), 0) AS tickets,
       COALESCE(SUM(held), 0) AS held
     FROM accounts`,
    [since || 0],
  );

  const gamesByMode = await all(
    `SELECT mode, COUNT(*) AS n,
            AVG(ended_at - created_at) AS avg_ms
     FROM games
     WHERE 1=1 ${endedClause}
     GROUP BY mode
     ORDER BY n DESC`,
    sinceParams,
  );

  const durations = await all(
    `SELECT (ended_at - created_at) AS ms FROM games
     WHERE ended_at > created_at ${endedClause}
     ORDER BY ms`,
    sinceParams,
  );
  const durationMs = durations.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n > 0);
  const medianMs = durationMs.length
    ? durationMs[Math.floor(durationMs.length / 2)]
    : null;

  const sideWins = await all(
    `SELECT winner_side AS side, COUNT(*) AS n FROM games
     WHERE winner_side IS NOT NULL ${endedClause}
     GROUP BY winner_side`,
    sinceParams,
  );

  const mmrBuckets = await all(
    `SELECT CAST(mmr / 100 AS INTEGER) * 100 AS bucket, COUNT(*) AS n
     FROM accounts GROUP BY bucket ORDER BY bucket`,
  );

  const purchases = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'completed' THEN tickets ELSE 0 END), 0) AS tickets_bought,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN digipogs ELSE 0 END), 0) AS digipogs,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COUNT(*) AS rows
     FROM ticket_purchases
     WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );

  const ledger = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'charge' THEN -delta ELSE 0 END), 0) AS charged,
       COALESCE(SUM(CASE WHEN kind = 'refund' THEN delta ELSE 0 END), 0) AS refunded,
       COALESCE(SUM(CASE WHEN kind = 'admin_adjust' THEN delta ELSE 0 END), 0) AS adjusted,
       COALESCE(SUM(CASE WHEN kind = 'spend' THEN -delta ELSE 0 END), 0) AS spent,
       COALESCE(SUM(CASE WHEN kind = 'purchase' OR kind = 'grant' THEN delta ELSE 0 END), 0) AS issued
     FROM ticket_ledger
     WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );

  const dayStart = since != null
    ? new Date(since).toISOString().slice(0, 10)
    : null;
  const activity = dayStart
    ? await get(
      `SELECT COUNT(DISTINCT account_id) AS active FROM activity_day WHERE day >= ?`,
      [dayStart],
    )
    : await get("SELECT COUNT(DISTINCT account_id) AS active FROM activity_day");

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dau = await get("SELECT COUNT(*) AS n FROM activity_day WHERE day = ?", [today]);
  const wau = await get("SELECT COUNT(DISTINCT account_id) AS n FROM activity_day WHERE day >= ?", [weekAgo]);
  const mau = await get("SELECT COUNT(DISTINCT account_id) AS n FROM activity_day WHERE day >= ?", [monthAgo]);

  const logins = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS ok,
       COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed
     FROM login_events WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );

  const peak = await get(
    `SELECT MAX(sockets) AS peak_sockets, MAX(rooms) AS peak_rooms
     FROM ops_samples WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );

  const mm = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN event = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
       COALESCE(SUM(CASE WHEN event = 'paired' THEN 1 ELSE 0 END), 0) AS paired,
       COALESCE(SUM(CASE WHEN event = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
       COALESCE(SUM(CASE WHEN event = 'abandoned' THEN 1 ELSE 0 END), 0) AS abandoned,
       AVG(CASE WHEN event = 'paired' AND wait_ms IS NOT NULL THEN wait_ms END) AS avg_wait_ms
     FROM mm_events WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );

  const registrations = await all(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
     FROM accounts
     WHERE 1=1 ${sinceClause}
     GROUP BY day ORDER BY day`,
    sinceParams,
  );

  const gamesPerDay = await all(
    `SELECT date(ended_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
     FROM games
     WHERE 1=1 ${endedClause}
     GROUP BY day ORDER BY day`,
    sinceParams,
  );

  // Retention: cohort registered in range, active on D1/D7/D30
  const retention = { d1: null, d7: null, d30: null, cohort: 0 };
  if (since != null) {
    const cohort = await all(
      `SELECT id, date(created_at / 1000, 'unixepoch') AS day FROM accounts
       WHERE created_at >= ? AND created_at < ?`,
      [since, Date.now() - 30 * 24 * 60 * 60 * 1000],
    );
    retention.cohort = cohort.length;
    if (cohort.length) {
      let d1 = 0;
      let d7 = 0;
      let d30 = 0;
      for (const row of cohort) {
        const base = row.day;
        const a1 = await get(
          "SELECT 1 AS ok FROM activity_day WHERE account_id = ? AND day = date(?, '+' || ? || ' days')",
          [row.id, base, 1],
        );
        const a7 = await get(
          "SELECT 1 AS ok FROM activity_day WHERE account_id = ? AND day = date(?, '+' || ? || ' days')",
          [row.id, base, 7],
        );
        const a30 = await get(
          "SELECT 1 AS ok FROM activity_day WHERE account_id = ? AND day = date(?, '+' || ? || ' days')",
          [row.id, base, 30],
        );
        if (a1) d1 += 1;
        if (a7) d7 += 1;
        if (a30) d30 += 1;
      }
      retention.d1 = d1 / cohort.length;
      retention.d7 = d7 / cohort.length;
      retention.d30 = d30 / cohort.length;
    }
  }

  const firstMatch = await get(
    `SELECT COUNT(*) AS n FROM accounts a
     WHERE a.created_at >= COALESCE(?, 0)
       AND EXISTS (
         SELECT 1 FROM games g
         WHERE g.account_a = a.id OR g.account_b = a.id
       )`,
    [since || 0],
  );
  const newAccounts = Number(accountTotals.new_in_range) || 0;

  return {
    range,
    since,
    trackingNote: "DAU, ledger, queue, CCU, and win_reason metrics only cover data since those tables were deployed.",
    accounts: accountTotals,
    activity: {
      activeInRange: Number(activity?.active) || 0,
      dau: Number(dau?.n) || 0,
      wau: Number(wau?.n) || 0,
      mau: Number(mau?.n) || 0,
    },
    logins,
    games: {
      byMode: gamesByMode,
      avgDurationMs: durationMs.length
        ? durationMs.reduce((a, b) => a + b, 0) / durationMs.length
        : null,
      medianDurationMs: medianMs,
      durationCount: durationMs.length,
      sideWins,
      perDay: gamesPerDay,
    },
    mmrBuckets,
    economy: { purchases, ledger },
    matchmaking: mm,
    peak,
    registrations,
    retention,
    conversion: {
      newAccounts,
      withFirstMatch: Number(firstMatch?.n) || 0,
      rate: newAccounts > 0 ? (Number(firstMatch?.n) || 0) / newAccounts : null,
    },
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
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at, reward_status
     FROM suggestions
     WHERE id = ?`,
    [suggestionId],
  );
}

export async function listSuggestions({ archived = false } = {}) {
  if (archived) {
    return all(
      `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at, reward_status
       FROM suggestions
       WHERE archived_at IS NOT NULL
       ORDER BY archived_at DESC, id DESC`,
    );
  }
  return all(
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at, reward_status
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

/**
 * unclaimed -> pending. Only one caller wins. rewarded_at stays unset until
 * the Formbar transfer is confirmed. A pending row is not claimed again:
 * an unknown Formbar outcome must not be paid twice.
 */
export async function claimSuggestionReward(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const result = await run(
    `UPDATE suggestions
     SET reward_status = 'pending', archived_at = ?
     WHERE id = ? AND archived_at IS NULL AND rewarded_at IS NULL
       AND (reward_status IS NULL OR reward_status = 'unclaimed')`,
    [Date.now(), suggestionId],
  );
  return result.changes > 0;
}

export async function completeSuggestionReward(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const result = await run(
    `UPDATE suggestions
     SET reward_status = 'completed', rewarded_at = ?
     WHERE id = ? AND reward_status = 'pending' AND rewarded_at IS NULL`,
    [Date.now(), suggestionId],
  );
  return result.changes > 0;
}

/** Confirmed Formbar failure only. Returns the row to unclaimed so it can be retried. */
export async function releaseSuggestionReward(id) {
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) return false;
  const result = await run(
    `UPDATE suggestions
     SET reward_status = 'unclaimed', archived_at = NULL, rewarded_at = NULL
     WHERE id = ? AND reward_status = 'pending' AND rewarded_at IS NULL`,
    [suggestionId],
  );
  return result.changes > 0;
}

export async function reopenSuggestion(id) {
  return releaseSuggestionReward(id);
}

export const REPORT_BODY_MAX = 1000;

/** True when reporter has already filed a report against reported (any status). */
export async function hasPlayerReport(reporterAccountId, reportedAccountId) {
  if (!db) return false;
  const reporter = Number(reporterAccountId);
  const reported = Number(reportedAccountId);
  if (!Number.isInteger(reporter) || reporter <= 0) return false;
  if (!Number.isInteger(reported) || reported <= 0) return false;
  const row = await get(
    `SELECT id FROM player_reports
     WHERE reporter_account_id = ? AND reported_account_id = ?
     LIMIT 1`,
    [reporter, reported],
  );
  return Boolean(row);
}

/**
 * One report per reporter→reported pair forever (unique constraint).
 * @returns {{ ok: true, id: number } | { ok: false, error: string }}
 */
export async function createPlayerReport({
  reporterAccountId,
  reporterName,
  reportedAccountId,
  reportedName,
  matchId = null,
  matchMode = null,
  body,
}) {
  const reporter = Number(reporterAccountId);
  const reported = Number(reportedAccountId);
  if (!Number.isInteger(reporter) || reporter <= 0) {
    return { ok: false, error: "reporter_required" };
  }
  if (!Number.isInteger(reported) || reported <= 0) {
    return { ok: false, error: "reported_required" };
  }
  if (reporter === reported) return { ok: false, error: "self_report" };
  const text = sanitizeUserText(body, { max: REPORT_BODY_MAX, allowNewlines: true });
  if (!text) return { ok: false, error: "body_required" };
  const nameA = sanitizeUserText(reporterName, { max: 80, allowNewlines: false }) || "Player";
  const nameB = sanitizeUserText(reportedName, { max: 80, allowNewlines: false }) || "Player";
  try {
    const result = await run(
      `INSERT INTO player_reports (
         reporter_account_id, reporter_name, reported_account_id, reported_name,
         match_id, match_mode, body, created_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      [
        reporter,
        nameA,
        reported,
        nameB,
        matchId ? String(matchId).slice(0, 80) : null,
        matchMode ? String(matchMode).slice(0, 40) : null,
        text,
        Date.now(),
      ],
    );
    return { ok: true, id: result.lastID };
  } catch (err) {
    if (err && (err.code === "SQLITE_CONSTRAINT" || /UNIQUE/i.test(String(err.message || "")))) {
      return { ok: false, error: "already_reported" };
    }
    throw err;
  }
}

export async function getPlayerReport(id) {
  const reportId = Number(id);
  if (!Number.isInteger(reportId) || reportId <= 0) return null;
  return get(
    `SELECT id, reporter_account_id, reporter_name, reported_account_id, reported_name,
            match_id, match_mode, body, created_at, status, resolved_at, resolved_by, resolution_note
     FROM player_reports
     WHERE id = ?`,
    [reportId],
  );
}

export async function listPlayerReports({
  status = "open",
  reportedAccountId = null,
  reporterAccountId = null,
  limit = 100,
} = {}) {
  const clauses = [];
  const params = [];
  if (status && status !== "all") {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const reported = Number(reportedAccountId);
  if (Number.isInteger(reported) && reported > 0) {
    clauses.push("reported_account_id = ?");
    params.push(reported);
  }
  const reporter = Number(reporterAccountId);
  if (Number.isInteger(reporter) && reporter > 0) {
    clauses.push("reporter_account_id = ?");
    params.push(reporter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return all(
    `SELECT id, reporter_account_id, reporter_name, reported_account_id, reported_name,
            match_id, match_mode, body, created_at, status, resolved_at, resolved_by, resolution_note
     FROM player_reports
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ${lim}`,
    params,
  );
}

export async function countOpenPlayerReports(reportedAccountId = null) {
  const reported = Number(reportedAccountId);
  if (Number.isInteger(reported) && reported > 0) {
    const row = await get(
      `SELECT COUNT(*) AS n FROM player_reports
       WHERE status = 'open' AND reported_account_id = ?`,
      [reported],
    );
    return row ? Number(row.n) || 0 : 0;
  }
  const row = await get(`SELECT COUNT(*) AS n FROM player_reports WHERE status = 'open'`);
  return row ? Number(row.n) || 0 : 0;
}

/**
 * Resolve or dismiss one open report.
 * @param {"resolved"|"dismissed"} status
 */
export async function resolvePlayerReport(id, {
  status = "resolved",
  resolvedBy = null,
  note = null,
} = {}) {
  const reportId = Number(id);
  if (!Number.isInteger(reportId) || reportId <= 0) return false;
  const next = status === "dismissed" ? "dismissed" : "resolved";
  const noteText = note == null
    ? null
    : sanitizeUserText(note, { max: 500, allowNewlines: false }) || null;
  const by = Number(resolvedBy);
  const result = await run(
    `UPDATE player_reports
     SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?
     WHERE id = ? AND status = 'open'`,
    [
      next,
      Date.now(),
      Number.isInteger(by) && by > 0 ? by : null,
      noteText,
      reportId,
    ],
  );
  return result.changes > 0;
}

/** Resolve/dismiss every open report against one account. */
export async function resolvePlayerReportsForUser(reportedAccountId, {
  status = "resolved",
  resolvedBy = null,
  note = null,
} = {}) {
  const reported = Number(reportedAccountId);
  if (!Number.isInteger(reported) || reported <= 0) return 0;
  const next = status === "dismissed" ? "dismissed" : "resolved";
  const noteText = note == null
    ? null
    : sanitizeUserText(note, { max: 500, allowNewlines: false }) || null;
  const by = Number(resolvedBy);
  const result = await run(
    `UPDATE player_reports
     SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?
     WHERE reported_account_id = ? AND status = 'open'`,
    [
      next,
      Date.now(),
      Number.isInteger(by) && by > 0 ? by : null,
      noteText,
      reported,
    ],
  );
  return result.changes || 0;
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
  await upsertSystemWikiPage({
    slug: "home",
    title: "Home",
    body: HOME_SEED_BODY,
  });
}

/**
 * Create or replace a wiki page as a confirmed System revision (no reward queue).
 * Used by scripts/seed-wiki.js to load wikidocs/ into the live DB.
 */
export async function upsertSystemWikiPage({ slug, title, body }) {
  const key = wikiSlug(slug || title);
  const pageTitle = sanitizeUserText(title, { max: WIKI_TITLE_MAX, allowNewlines: false });
  const trimmedBody = sanitizeUserText(body, { max: WIKI_BODY_MAX, allowNewlines: true });
  if (!pageTitle) {
    return { ok: false, error: "Page title is required.", slug: key };
  }
  if (!trimmedBody) {
    return { ok: false, error: "Page text is required.", slug: key };
  }

  const existing = await getWikiPageBySlug(key);
  const now = Date.now();

  if (existing) {
    const currentBody = existing.revision ? existing.revision.body : "";
    const titleSame = existing.page.title === pageTitle;
    const bodySame = currentBody === trimmedBody;
    if (titleSame && bodySame) {
      return { ok: true, slug: key, action: "unchanged" };
    }
    if (!titleSame) {
      await run("UPDATE wiki_pages SET title = ? WHERE id = ?", [pageTitle, existing.page.id]);
    }
    if (!bodySame) {
      const rev = await run(
        `INSERT INTO wiki_revisions (page_id, formbar_id, name, body, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [existing.page.id, 0, "System", trimmedBody, now, now],
      );
      await run(
        "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
        [rev.lastID, existing.page.id],
      );
      return { ok: true, slug: key, action: "updated" };
    }
    return { ok: true, slug: key, action: "renamed" };
  }

  const clash = await get("SELECT id FROM wiki_pages WHERE slug = ?", [key]);
  if (clash) {
    return { ok: false, error: "A page with that slug already exists.", slug: key };
  }
  const page = await run(
    `INSERT INTO wiki_pages (slug, title, current_revision_id, created_at, created_by)
     VALUES (?, ?, NULL, ?, ?)`,
    [key, pageTitle, now, 0],
  );
  const rev = await run(
    `INSERT INTO wiki_revisions (page_id, formbar_id, name, body, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [page.lastID, 0, "System", trimmedBody, now, now],
  );
  await run(
    "UPDATE wiki_pages SET current_revision_id = ? WHERE id = ?",
    [rev.lastID, page.lastID],
  );
  return { ok: true, slug: key, action: "created" };
}

export async function closeDb() {
  if (!db) return;
  const database = db;
  db = null;
  await withDb(
    () => new Promise((resolve, reject) => {
      database.close((err) => (err ? reject(err) : resolve()));
    }),
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
              confirmed_at, undone_at, rewarded_at, reward_status
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
            r.confirmed_at, r.undone_at, r.rewarded_at, r.reward_status,
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
            r.confirmed_at, r.undone_at, r.rewarded_at, r.reward_status,
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

/** unclaimed -> pending. A second claim does not call Formbar. */
export async function claimWikiReward(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return false;
  const result = await run(
    `UPDATE wiki_revisions
     SET reward_status = 'pending'
     WHERE id = ? AND undone_at IS NULL AND rewarded_at IS NULL
       AND (reward_status IS NULL OR reward_status = 'unclaimed')`,
    [revisionId],
  );
  return result.changes > 0;
}

export async function completeWikiReward(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return false;
  const result = await run(
    `UPDATE wiki_revisions
     SET reward_status = 'completed', rewarded_at = ?
     WHERE id = ? AND reward_status = 'pending' AND rewarded_at IS NULL AND undone_at IS NULL`,
    [Date.now(), revisionId],
  );
  return result.changes > 0;
}

/** Confirmed Formbar failure only. Ambiguous results stay pending. */
export async function releaseWikiReward(id) {
  const revisionId = Number(id);
  if (!Number.isInteger(revisionId) || revisionId <= 0) return false;
  const result = await run(
    `UPDATE wiki_revisions
     SET reward_status = 'unclaimed'
     WHERE id = ? AND reward_status = 'pending' AND rewarded_at IS NULL`,
    [revisionId],
  );
  return result.changes > 0;
}

export async function setWikiRevisionRewarded(id) {
  return completeWikiReward(id);
}
