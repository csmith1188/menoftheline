import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import {
  buildDiscriminatedDisplayName,
  sanitizeDisplayName,
  validateDisplayName,
} from "./auth.js";
import {
  aggregateBalanceFromSummaries,
  durationPercentiles,
  funnelAndSegments,
  matchesPerPlayerStats,
} from "./analyticsMetrics.js";
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
  await run(`CREATE TABLE IF NOT EXISTS paypal_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    amount_value TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    tickets INTEGER NOT NULL,
    paypal_order_id TEXT UNIQUE,
    paypal_capture_id TEXT UNIQUE,
    status TEXT NOT NULL,
    clawback_applied INTEGER NOT NULL DEFAULT 0,
    clawback_shortfall INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    credited_at INTEGER,
    refunded_at INTEGER
  )`);
  await run("CREATE INDEX IF NOT EXISTS paypal_purchases_account ON paypal_purchases (account_id, created_at DESC)");
  await run("CREATE INDEX IF NOT EXISTS paypal_purchases_status ON paypal_purchases (status, updated_at)");
  await run(`CREATE TABLE IF NOT EXISTS paypal_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    purchase_id INTEGER
  )`);
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
  await backfillTicketLots();
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

const ACCOUNT_SELECT = `id, formbar_id, discord_id, email, password_hash, email_verified_at, email_verified_by, email_verified_reason, name, role, mmr, tickets, held, wins, losses, tooltips, bgm_volume, news_email_opt_in, news_email_opt_in_at, news_email_opt_out_at, news_email_consent_source, news_email_consent_ip, banned_at, ban_reason, ban_expires_at, banned_by_account_id, last_login_at, last_seen_at, admin_notes, session_epoch, deleted_at, created_at, updated_at`;

export const ACCOUNT_ROLES = Object.freeze(["player", "moderator", "admin"]);

/** Public display name for soft-deleted accounts (also reserved for live users). */
export const FALLEN_SOLDIER = "Fallen Soldier";

/** Days to retain former_name for staff moderation; then cleared. */
export const DELETED_IDENTITY_RETENTION_DAYS = 730;

export const ACCOUNT_DELETE_REAUTH_MS = 10 * 60 * 1000;

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

export function isAccountDeleted(account) {
  return Boolean(account && account.deleted_at != null);
}

/** Public-facing name; never exposes former identity of deleted accounts. */
export function publicDisplayName(account, { snapshotName } = {}) {
  if (!account || isAccountDeleted(account)) return FALLEN_SOLDIER;
  const live = account.name != null ? String(account.name).trim() : "";
  if (live) return live;
  const snap = snapshotName != null ? String(snapshotName).trim() : "";
  return snap || FALLEN_SOLDIER;
}

function namesEqualInsensitive(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function isReservedDisplayName(name) {
  return namesEqualInsensitive(name, FALLEN_SOLDIER);
}

/** Scrub PII keys from admin audit JSON blobs. */
function scrubAuditJson(raw) {
  if (raw == null || raw === "") return null;
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const drop = new Set([
    "email", "password_hash", "formbar_id", "discord_id", "name",
    "admin_notes", "news_email_consent_ip", "news_email_consent_source",
  ]);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (drop.has(key)) continue;
    out[key] = value;
  }
  try {
    return JSON.stringify(out);
  } catch {
    return null;
  }
}

function anonymizeChatJson(raw, formerName) {
  if (raw == null || raw === "") return raw;
  let rows;
  try {
    rows = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return raw;
  }
  if (!Array.isArray(rows)) return raw;
  let changed = false;
  const next = rows.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const copy = { ...entry };
    if (copy.kind === "user" && copy.from != null && namesEqualInsensitive(copy.from, formerName)) {
      copy.from = FALLEN_SOLDIER;
      changed = true;
    }
    return copy;
  });
  if (!changed) return raw;
  try {
    return JSON.stringify(next);
  } catch {
    return raw;
  }
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
  await ensureAccountColumn(accountCols, "news_email_opt_in", "news_email_opt_in INTEGER NOT NULL DEFAULT 0");
  await ensureAccountColumn(accountCols, "news_email_opt_in_at", "news_email_opt_in_at INTEGER");
  await ensureAccountColumn(accountCols, "news_email_opt_out_at", "news_email_opt_out_at INTEGER");
  await ensureAccountColumn(accountCols, "news_email_consent_source", "news_email_consent_source TEXT");
  await ensureAccountColumn(accountCols, "news_email_consent_ip", "news_email_consent_ip TEXT");
  await ensureAccountColumn(accountCols, "deleted_at", "deleted_at INTEGER");
  await run("CREATE INDEX IF NOT EXISTS accounts_role ON accounts (role)");
  await run("CREATE INDEX IF NOT EXISTS accounts_banned_at ON accounts (banned_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_last_seen ON accounts (last_seen_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_name_nocase ON accounts (name COLLATE NOCASE)");
  await run("CREATE INDEX IF NOT EXISTS accounts_email_verified ON accounts (email_verified_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_news_email ON accounts (news_email_opt_in, email_verified_at)");
  await run("CREATE INDEX IF NOT EXISTS accounts_deleted_at ON accounts (deleted_at)");

  await run(`CREATE TABLE IF NOT EXISTS deleted_account_identity (
    account_id INTEGER PRIMARY KEY,
    former_name TEXT,
    deleted_at INTEGER NOT NULL,
    deleted_via TEXT NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS deleted_account_identity_deleted_at ON deleted_account_identity (deleted_at)");

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
  if (!gameCols.some((col) => col.name === "started_at")) {
    await run("ALTER TABLE games ADD COLUMN started_at INTEGER");
  }
  if (!gameCols.some((col) => col.name === "map_id")) {
    await run("ALTER TABLE games ADD COLUMN map_id TEXT");
  }
  if (!gameCols.some((col) => col.name === "summary_json")) {
    await run("ALTER TABLE games ADD COLUMN summary_json TEXT");
  }
  await run("CREATE INDEX IF NOT EXISTS games_ended_at ON games (ended_at)");
  await run("CREATE INDEX IF NOT EXISTS games_mode_ended ON games (mode, ended_at)");
  await run("CREATE INDEX IF NOT EXISTS games_map_ended ON games (map_id, ended_at)");
  await run("CREATE INDEX IF NOT EXISTS games_outcome_ended ON games (outcome, ended_at)");
  await run("CREATE INDEX IF NOT EXISTS games_win_reason_ended ON games (win_reason, ended_at)");
  await run("UPDATE games SET win_reason = 'keep' WHERE win_reason = 'capital'");

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

  await run(`CREATE TABLE IF NOT EXISTS ticket_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    tickets_total INTEGER NOT NULL,
    tickets_remaining INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS ticket_lots_account ON ticket_lots (account_id, created_at, id)");
  await run("CREATE INDEX IF NOT EXISTS ticket_lots_source ON ticket_lots (source_type, source_id)");

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
  const loginCols = await all("PRAGMA table_info(login_events)");
  if (!loginCols.some((col) => col.name === "platform")) {
    await run("ALTER TABLE login_events ADD COLUMN platform TEXT");
  }
  await run("CREATE INDEX IF NOT EXISTS login_events_platform ON login_events (platform, created_at)");

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
  const opsCols = await all("PRAGMA table_info(ops_samples)");
  if (!opsCols.some((col) => col.name === "sockets_authed")) {
    await run("ALTER TABLE ops_samples ADD COLUMN sockets_authed INTEGER");
  }

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

  await run(`CREATE TABLE IF NOT EXISTS newsletter_consent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    opted_in INTEGER NOT NULL,
    source TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS newsletter_consent_account ON newsletter_consent_events (account_id, created_at)");

  await run(`CREATE TABLE IF NOT EXISTS newsletter_unsub_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`);
  await run("CREATE INDEX IF NOT EXISTS newsletter_unsub_account ON newsletter_unsub_tokens (account_id)");

  await run(`CREATE TABLE IF NOT EXISTS newsletter_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    news_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS newsletter_campaigns_news ON newsletter_campaigns (news_id, status)");
  await run("CREATE INDEX IF NOT EXISTS newsletter_campaigns_created ON newsletter_campaigns (created_at)");

  await run(`CREATE TABLE IF NOT EXISTS newsletter_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    email_domain TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error TEXT,
    provider_message_id TEXT,
    claimed_by TEXT,
    claimed_at INTEGER,
    sent_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (campaign_id, account_id)
  )`);
  await run("CREATE INDEX IF NOT EXISTS newsletter_outbox_claim ON newsletter_outbox (status, next_attempt_at)");
  await run("CREATE INDEX IF NOT EXISTS newsletter_outbox_campaign ON newsletter_outbox (campaign_id, status)");

  await ensureCommunitySchema();
}

async function ensureCommunitySchema() {
  await run(`CREATE TABLE IF NOT EXISTS funding_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    target_tickets INTEGER NOT NULL,
    contributed_tickets INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    slot INTEGER,
    selection_deadline_at INTEGER,
    created_at INTEGER NOT NULL,
    reached_at INTEGER,
    fulfilled_at INTEGER,
    archived_at INTEGER,
    fulfillment_notes TEXT,
    fulfillment_links TEXT,
    original_target_tickets INTEGER,
    discrepancy_flag INTEGER NOT NULL DEFAULT 0
  )`);
  await run("CREATE INDEX IF NOT EXISTS funding_goals_status_slot ON funding_goals (status, slot)");

  await run(`CREATE TABLE IF NOT EXISTS dev_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'open',
    started_at INTEGER NOT NULL,
    closed_at INTEGER,
    winner_priority_id INTEGER,
    tie_break_notes TEXT,
    closed_by INTEGER
  )`);
  await run("CREATE INDEX IF NOT EXISTS dev_rounds_status ON dev_rounds (status, started_at)");

  await run(`CREATE TABLE IF NOT EXISTS dev_priorities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    contributed_tickets INTEGER NOT NULL DEFAULT 0,
    slot INTEGER,
    selection_deadline_at INTEGER,
    vote_status TEXT NOT NULL DEFAULT 'active',
    impl_status TEXT,
    impl_notes TEXT,
    public_change_explanation TEXT,
    news_links TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  )`);
  await run("CREATE INDEX IF NOT EXISTS dev_priorities_round ON dev_priorities (round_id, slot)");
  await run("CREATE INDEX IF NOT EXISTS dev_priorities_vote ON dev_priorities (vote_status, slot)");

  await run(`CREATE TABLE IF NOT EXISTS community_player_selections (
    account_id INTEGER PRIMARY KEY,
    funding_goal_id INTEGER,
    dev_priority_id INTEGER,
    updated_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS community_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    spend_ledger_id INTEGER UNIQUE,
    reversal_of_id INTEGER,
    tickets_spent INTEGER NOT NULL DEFAULT 0,
    paid_tickets INTEGER NOT NULL DEFAULT 0,
    free_tickets INTEGER NOT NULL DEFAULT 0,
    funding_goal_id INTEGER,
    funding_delta INTEGER NOT NULL DEFAULT 0,
    dev_priority_id INTEGER,
    dev_delta INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    lot_slices_json TEXT
  )`);
  await run("CREATE INDEX IF NOT EXISTS community_contrib_account ON community_contributions (account_id, created_at)");
  await run("CREATE INDEX IF NOT EXISTS community_contrib_funding ON community_contributions (funding_goal_id, created_at)");
  await run("CREATE INDEX IF NOT EXISTS community_contrib_dev ON community_contributions (dev_priority_id, created_at)");
  await run("CREATE INDEX IF NOT EXISTS community_contrib_reversal ON community_contributions (reversal_of_id)");
  await run("CREATE INDEX IF NOT EXISTS community_contrib_ref ON community_contributions (ref_type, ref_id)");
}

async function bootstrapAdminRoles() {
  const existing = await get(
    "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND deleted_at IS NULL",
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
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE formbar_id = ? AND deleted_at IS NULL`,
    [id],
  );
  return row || null;
}

export async function getAccountByEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE email = ? AND deleted_at IS NULL`,
    [key],
  );
  return row || null;
}

export async function getAccountByDiscord(discordId) {
  const key = String(discordId || "").trim();
  if (!key || key.length > 32) return null;
  const row = await get(
    `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE discord_id = ? AND deleted_at IS NULL`,
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
    `SELECT ${ACCOUNT_SELECT} FROM accounts
     WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL`,
    [key],
  );
  return row || null;
}

/** True if another live account already uses this display name (case-insensitive). */
export async function isDisplayNameTaken(name, excludeAccountId = null) {
  if (isReservedDisplayName(name)) return true;
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

/**
 * Set display name. When spendTicket is true, charges 1 free ticket in the
 * same transaction (profile self-rename). Admin renames leave spendTicket false.
 */
export async function setAccountDisplayName(accountId, name, { spendTicket = false } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  const existing = await getAccount(id);
  if (!existing) return { ok: false, error: "missing" };
  if (isAccountDeleted(existing)) return { ok: false, error: "deleted" };
  const check = validateDisplayName(name);
  if (!check.ok) return { ok: false, error: "invalid", message: check.error };
  if (isReservedDisplayName(check.name)) {
    return { ok: false, error: "reserved", message: "That display name is reserved." };
  }

  if (!spendTicket) {
    if (await isDisplayNameTaken(check.name, id)) {
      return { ok: false, error: "taken" };
    }
    const result = await run(
      "UPDATE accounts SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [check.name, Date.now(), id],
    );
    if (!result.changes) return { ok: false, error: "missing" };
    return { ok: true, name: check.name, account: await getAccount(id) };
  }

  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const taken = await execGet(
        `SELECT id FROM accounts
         WHERE name = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL LIMIT 1`,
        [check.name, id],
      );
      if (taken) {
        await execRun("ROLLBACK");
        return { ok: false, error: "taken" };
      }
      const row = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "missing" };
      }
      if (row.tickets <= row.held) {
        await execRun("ROLLBACK");
        return { ok: false, error: "no_ticket" };
      }
      const now = Date.now();
      const renamed = await execRun(
        `UPDATE accounts
         SET name = ?, tickets = tickets - 1, updated_at = ?
         WHERE id = ? AND tickets > held`,
        [check.name, now, id],
      );
      if (!renamed.changes) {
        await execRun("ROLLBACK");
        return { ok: false, error: "no_ticket" };
      }
      const slices = await consumeTicketLotsFifo(execRun, execAll, id, 1);
      const ledgerId = await insertTicketLedger(execRun, {
        accountId: id,
        delta: -1,
        balanceAfter: row.tickets - 1,
        heldAfter: row.held,
        kind: "spend",
        refType: "ticket_lot",
        refId: slices[0]?.lotId ?? null,
        reason: "display_name",
        createdAt: now,
      });
      const contrib = await applySpendContributions(execRun, execGet, {
        accountId: id,
        spendLedgerId: ledgerId,
        slices,
        ticketsSpent: 1,
        createdAt: now,
      });
      await execRun("COMMIT");
      if (contrib && !contrib.skipped && !contrib.duplicate) noteCommunityDirty();
      const account = await execGet(
        `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
        [id],
      );
      return { ok: true, name: check.name, account };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("setAccountDisplayName", rollbackErr);
      }
      throw err;
    }
  });
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
        "SELECT id, formbar_id, discord_id, email, password_hash, deleted_at FROM accounts WHERE id = ?",
        [id],
      );
      if (
        !row
        || row.deleted_at != null
        || row.formbar_id
        || row.discord_id
        || !row.email
        || !row.password_hash
      ) {
        await execRun("ROLLBACK");
        return false;
      }
      await execRun("DELETE FROM auth_tokens WHERE account_id = ?", [id]);
      await execRun("DELETE FROM newsletter_unsub_tokens WHERE account_id = ?", [id]);
      await execRun(
        `UPDATE newsletter_outbox SET status = 'cancelled', last_error = 'account_deleted'
         WHERE account_id = ? AND status IN ('pending', 'sending')`,
        [id],
      );
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

export async function getDeletedAccountIdentity(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await get(
    `SELECT account_id, former_name, deleted_at, deleted_via
     FROM deleted_account_identity WHERE account_id = ?`,
    [id],
  );
  return row || null;
}

/** Clear former_name after retention window (keeps row). */
export async function purgeExpiredDeletedIdentities(now = Date.now()) {
  const cutoff = Number(now) - DELETED_IDENTITY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = await run(
    `UPDATE deleted_account_identity
     SET former_name = NULL
     WHERE former_name IS NOT NULL AND deleted_at < ?`,
    [cutoff],
  );
  return Number(result.changes) || 0;
}

/** Best-effort wipe of express-session rows bound to an account. */
export async function destroyAccountSessions(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const table = await get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  );
  if (!table) return 0;
  const patterns = [
    `%"accountId":${id}%`,
    `%"accountId": ${id}%`,
    `%"accountId":"${id}"%`,
  ];
  let total = 0;
  for (const pattern of patterns) {
    const result = await run("DELETE FROM sessions WHERE sess LIKE ?", [pattern]);
    total += Number(result.changes) || 0;
  }
  return total;
}

/**
 * Soft-delete an account: scrub PII, anonymize public snapshots, keep id for history.
 * Idempotent when already deleted. Call destroyAccountSessions after success.
 */
export async function deleteAccountSelf(accountId, { via = "self" } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };

  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "missing" };
      }
      if (row.deleted_at != null) {
        await execRun("COMMIT");
        return { ok: true, alreadyDeleted: true, account: row };
      }
      if (isAdminRole(row.role)) {
        const admins = await execGet(
          "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND deleted_at IS NULL",
        );
        if (Number(admins?.n) <= 1) {
          await execRun("ROLLBACK");
          return { ok: false, error: "last_admin" };
        }
      }
      if (Number(row.held) > 0) {
        await execRun("ROLLBACK");
        return { ok: false, error: "held_tickets" };
      }
      const pendingPaypal = await execGet(
        `SELECT id FROM paypal_purchases
         WHERE account_id = ? AND status IN ('created', 'approved', 'captured')
         LIMIT 1`,
        [id],
      );
      if (pendingPaypal) {
        await execRun("ROLLBACK");
        return { ok: false, error: "pending_paypal" };
      }
      const pendingDigipog = await execGet(
        `SELECT id FROM ticket_purchases
         WHERE account_id = ? AND status = 'pending'
         LIMIT 1`,
        [id],
      );
      if (pendingDigipog) {
        await execRun("ROLLBACK");
        return { ok: false, error: "pending_digipog" };
      }

      const formerName = String(row.name || "").trim() || FALLEN_SOLDIER;
      const now = Date.now();
      const freeTickets = Math.max(0, Number(row.tickets) || 0);

      await execRun(
        `INSERT INTO deleted_account_identity (account_id, former_name, deleted_at, deleted_via)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           former_name = excluded.former_name,
           deleted_at = excluded.deleted_at,
           deleted_via = excluded.deleted_via`,
        [id, formerName, now, String(via || "self").slice(0, 32)],
      );

      if (freeTickets > 0) {
        await zeroTicketLotsForAccount(execRun, id);
        await insertTicketLedger(execRun, {
          accountId: id,
          delta: -freeTickets,
          balanceAfter: 0,
          heldAfter: 0,
          kind: "account_delete",
          refType: "account",
          refId: id,
          reason: "self_service_account_deletion",
          createdAt: now,
        });
      }

      await execRun(
        `UPDATE accounts SET
          email = NULL,
          password_hash = NULL,
          formbar_id = NULL,
          discord_id = NULL,
          email_verified_at = NULL,
          email_verified_by = NULL,
          email_verified_reason = NULL,
          name = ?,
          role = 'player',
          tickets = 0,
          held = 0,
          tooltips = 1,
          bgm_volume = 50,
          news_email_opt_in = 0,
          news_email_opt_in_at = NULL,
          news_email_opt_out_at = ?,
          news_email_consent_source = NULL,
          news_email_consent_ip = NULL,
          banned_at = NULL,
          ban_reason = NULL,
          ban_expires_at = NULL,
          banned_by_account_id = NULL,
          admin_notes = NULL,
          session_epoch = session_epoch + 1,
          deleted_at = ?,
          updated_at = ?
         WHERE id = ?`,
        [FALLEN_SOLDIER, now, now, now, id],
      );

      await execRun("DELETE FROM auth_tokens WHERE account_id = ?", [id]);
      await execRun("DELETE FROM newsletter_unsub_tokens WHERE account_id = ?", [id]);
      await execRun(
        `UPDATE newsletter_outbox SET status = 'cancelled', last_error = 'account_deleted'
         WHERE account_id = ? AND status IN ('pending', 'sending')`,
        [id],
      );

      await execRun(
        `UPDATE games SET name_a = ?, formbar_a = NULL WHERE account_a = ?`,
        [FALLEN_SOLDIER, id],
      );
      await execRun(
        `UPDATE games SET name_b = ?, formbar_b = NULL WHERE account_b = ?`,
        [FALLEN_SOLDIER, id],
      );

      const chatGames = await execAll(
        `SELECT id, chat_json FROM games
         WHERE (account_a = ? OR account_b = ?) AND chat_json IS NOT NULL`,
        [id, id],
      );
      for (const game of chatGames) {
        const next = anonymizeChatJson(game.chat_json, formerName);
        if (next !== game.chat_json) {
          await execRun("UPDATE games SET chat_json = ? WHERE id = ?", [next, game.id]);
        }
      }

      await execRun(
        `UPDATE player_reports SET reporter_name = ? WHERE reporter_account_id = ?`,
        [FALLEN_SOLDIER, id],
      );
      await execRun(
        `UPDATE player_reports SET reported_name = ? WHERE reported_account_id = ?`,
        [FALLEN_SOLDIER, id],
      );
      await execRun(
        `UPDATE suggestions SET name = ?, formbar_id = NULL WHERE account_id = ?`,
        [FALLEN_SOLDIER, id],
      );
      await execRun(
        `UPDATE wiki_revisions SET name = ?, formbar_id = NULL WHERE account_id = ?`,
        [FALLEN_SOLDIER, id],
      );
      await execRun(
        `UPDATE ticket_purchases SET formbar_id = NULL WHERE account_id = ?`,
        [id],
      );

      const audits = await execAll(
        `SELECT id, before_json, after_json FROM admin_audit
         WHERE target_type = 'account' AND target_id = ?`,
        [String(id)],
      );
      for (const audit of audits) {
        await execRun(
          "UPDATE admin_audit SET before_json = ?, after_json = ? WHERE id = ?",
          [scrubAuditJson(audit.before_json), scrubAuditJson(audit.after_json), audit.id],
        );
      }

      await execRun("COMMIT");
      const account = await execGet(
        `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
        [id],
      );
      return { ok: true, alreadyDeleted: false, account, formerName };
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("deleteAccountSelf", rollbackErr);
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
  if (isAccountDeleted(target)) return { ok: false, error: "deleted" };
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
  if (isAccountDeleted(target)) return { ok: false, error: "deleted" };
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
  if (isAccountDeleted(survivor) || isAccountDeleted(donor)) {
    return { ok: false, error: "deleted" };
  }

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
      await execRun(
        "UPDATE ticket_lots SET account_id = ? WHERE account_id = ?",
        [survivor.id, donor.id],
      );
      await execRun(
        "UPDATE ticket_ledger SET account_id = ? WHERE account_id = ?",
        [survivor.id, donor.id],
      );
      await execRun(
        "UPDATE paypal_purchases SET account_id = ? WHERE account_id = ?",
        [survivor.id, donor.id],
      );
      await execRun(
        "UPDATE ticket_purchases SET account_id = ? WHERE account_id = ?",
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
  const result = await exec(
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
  return result?.lastID ?? null;
}

/** Lot source types that count toward monetary funding goals. */
export const PAID_LOT_SOURCES = Object.freeze(["paypal_purchase", "ticket_purchase"]);

export function isPaidLotSource(sourceType) {
  return PAID_LOT_SOURCES.includes(String(sourceType || ""));
}

export function countPaidFromSlices(slices) {
  let paid = 0;
  for (const slice of slices || []) {
    if (isPaidLotSource(slice.sourceType)) {
      paid += Number(slice.take) || 0;
    }
  }
  return paid;
}

/** Largest-remainder percentages that sum to 100 (or all 0 when total is 0). */
export function communityPercentages(totals) {
  const nums = (totals || []).map((n) => Math.max(0, Number(n) || 0));
  const sum = nums.reduce((a, b) => a + b, 0);
  if (sum <= 0) return nums.map(() => 0);
  const raw = nums.map((n) => (n * 100) / sum);
  const floors = raw.map((n) => Math.floor(n));
  let rem = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((n, i) => ({ i, frac: n - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; k < order.length && rem > 0; k += 1) {
    out[order[k].i] += 1;
    rem -= 1;
  }
  return out;
}

const TICKET_LOTS_BACKFILL_KEY = "ticket_lots_backfill_v1";

/** Parse PayPal-style amount strings ("5.00") to integer USD cents. */
export function amountValueToCents(amountValue) {
  const s = String(amountValue ?? "").trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return 0;
  const dollars = Number(m[1]);
  const frac = (m[2] || "00").padEnd(2, "0").slice(0, 2);
  return dollars * 100 + Number(frac);
}

export function formatUsdFromCents(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

/** Remaining USD cents for one lot (half-up). */
export function lotRefundCents(remaining, amountCents, ticketsTotal) {
  const rem = Number(remaining) || 0;
  const amount = Number(amountCents) || 0;
  const total = Number(ticketsTotal) || 0;
  if (rem <= 0 || amount <= 0 || total <= 0) return 0;
  return Math.round((rem * amount) / total);
}

async function createTicketLot(exec, {
  accountId,
  sourceType,
  sourceId = null,
  tickets,
  amountCents = 0,
  currency = "USD",
  createdAt = Date.now(),
}) {
  const n = Number(tickets);
  if (!Number.isInteger(n) || n <= 0) return null;
  const cents = Math.max(0, Math.round(Number(amountCents) || 0));
  const result = await exec(
    `INSERT INTO ticket_lots (
      account_id, source_type, source_id, tickets_total, tickets_remaining,
      amount_cents, currency, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      String(sourceType),
      sourceId != null ? String(sourceId) : null,
      n,
      n,
      cents,
      currency || "USD",
      createdAt,
    ],
  );
  return result.lastID;
}

/**
 * Burn n tickets from oldest lots first.
 * Returns slices { lotId, take, amountCents, ticketsTotal }.
 */
async function consumeTicketLotsFifo(execRunFn, execAllFn, accountId, n, { excludeLotId = null } = {}) {
  const want = Number(n);
  if (!Number.isInteger(want) || want <= 0) return [];
  const lots = await execAllFn(
    `SELECT id, tickets_remaining, amount_cents, tickets_total, source_type, source_id
     FROM ticket_lots
     WHERE account_id = ? AND tickets_remaining > 0
     ORDER BY created_at ASC, id ASC`,
    [accountId],
  );
  let left = want;
  const slices = [];
  for (const lot of lots) {
    if (left <= 0) break;
    if (excludeLotId != null && Number(lot.id) === Number(excludeLotId)) continue;
    const take = Math.min(Number(lot.tickets_remaining), left);
    if (take <= 0) continue;
    await execRunFn(
      "UPDATE ticket_lots SET tickets_remaining = tickets_remaining - ? WHERE id = ?",
      [take, lot.id],
    );
    slices.push({
      lotId: lot.id,
      take,
      amountCents: lot.amount_cents,
      ticketsTotal: lot.tickets_total,
      sourceType: lot.source_type,
      sourceId: lot.source_id,
    });
    left -= take;
  }
  if (left > 0) {
    throw new Error(`ticket_lots_shortfall:${left}`);
  }
  return slices;
}

async function restoreTicketLot(execRunFn, execGetFn, lotId, n = 1) {
  const id = Number(lotId);
  const count = Number(n);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(count) || count <= 0) {
    return 0;
  }
  const lot = await execGetFn(
    "SELECT id, tickets_total, tickets_remaining FROM ticket_lots WHERE id = ?",
    [id],
  );
  if (!lot) return 0;
  const room = Math.max(0, Number(lot.tickets_total) - Number(lot.tickets_remaining));
  const add = Math.min(room, count);
  if (add <= 0) return 0;
  await execRunFn(
    "UPDATE ticket_lots SET tickets_remaining = tickets_remaining + ? WHERE id = ?",
    [add, id],
  );
  return add;
}

async function zeroTicketLotsForAccount(execRunFn, accountId) {
  await execRunFn(
    "UPDATE ticket_lots SET tickets_remaining = 0 WHERE account_id = ? AND tickets_remaining > 0",
    [accountId],
  );
}

/** One-time: rebuild lots from historical purchases, then reconcile to balances. */
async function backfillTicketLots() {
  const flag = await get(
    "SELECT value FROM site_settings WHERE key = ?",
    [TICKET_LOTS_BACKFILL_KEY],
  );
  if (flag && String(flag.value) === "1") return;

  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const again = await execGet(
        "SELECT value FROM site_settings WHERE key = ?",
        [TICKET_LOTS_BACKFILL_KEY],
      );
      if (again && String(again.value) === "1") {
        await execRun("COMMIT");
        return;
      }

      const paypalRows = await execAll(
        `SELECT id, account_id, amount_value, currency, tickets, clawback_applied,
                created_at, credited_at, status
         FROM paypal_purchases
         WHERE credited_at IS NOT NULL
            OR status IN ('credited', 'refunded', 'reversed')`,
      );
      for (const row of paypalRows) {
        const total = Number(row.tickets) || 0;
        const clawed = Math.max(0, Number(row.clawback_applied) || 0);
        const remaining = Math.max(0, total - clawed);
        if (total <= 0) continue;
        await execRun(
          `INSERT INTO ticket_lots (
            account_id, source_type, source_id, tickets_total, tickets_remaining,
            amount_cents, currency, created_at
          ) VALUES (?, 'paypal_purchase', ?, ?, ?, ?, ?, ?)`,
          [
            row.account_id,
            String(row.id),
            total,
            remaining,
            amountValueToCents(row.amount_value),
            row.currency || "USD",
            row.credited_at || row.created_at || Date.now(),
          ],
        );
      }

      const digipogRows = await execAll(
        `SELECT id, account_id, tickets, created_at FROM ticket_purchases
         WHERE status = 'completed' AND account_id IS NOT NULL AND tickets > 0`,
      );
      for (const row of digipogRows) {
        const total = Number(row.tickets) || 0;
        if (total <= 0) continue;
        await execRun(
          `INSERT INTO ticket_lots (
            account_id, source_type, source_id, tickets_total, tickets_remaining,
            amount_cents, currency, created_at
          ) VALUES (?, 'ticket_purchase', ?, ?, ?, 0, 'USD', ?)`,
          [
            row.account_id,
            String(row.id),
            total,
            total,
            row.created_at || Date.now(),
          ],
        );
      }

      const accounts = await execAll("SELECT id, tickets FROM accounts");
      for (const account of accounts) {
        const sumRow = await execGet(
          "SELECT COALESCE(SUM(tickets_remaining), 0) AS n FROM ticket_lots WHERE account_id = ?",
          [account.id],
        );
        let sum = Number(sumRow?.n) || 0;
        const balance = Math.max(0, Number(account.tickets) || 0);
        if (sum > balance) {
          let excess = sum - balance;
          const lots = await execAll(
            `SELECT id, tickets_remaining FROM ticket_lots
             WHERE account_id = ? AND tickets_remaining > 0
             ORDER BY created_at ASC, id ASC`,
            [account.id],
          );
          for (const lot of lots) {
            if (excess <= 0) break;
            const take = Math.min(Number(lot.tickets_remaining), excess);
            await execRun(
              "UPDATE ticket_lots SET tickets_remaining = tickets_remaining - ? WHERE id = ?",
              [take, lot.id],
            );
            excess -= take;
          }
          sum = balance;
        } else if (sum < balance) {
          const gap = balance - sum;
          await execRun(
            `INSERT INTO ticket_lots (
              account_id, source_type, source_id, tickets_total, tickets_remaining,
              amount_cents, currency, created_at
            ) VALUES (?, 'legacy', NULL, ?, ?, 0, 'USD', ?)`,
            [account.id, gap, gap, Date.now()],
          );
        }
      }

      const now = Date.now();
      await execRun(
        `INSERT INTO site_settings (key, value, updated_at, updated_by)
         VALUES (?, '1', ?, NULL)
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
        [TICKET_LOTS_BACKFILL_KEY, now],
      );
      await execRun("COMMIT");
      logger.info({ event: "ticket_lots_backfill" }, "ticket lots backfill complete");
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("backfillTicketLots", rollbackErr);
      }
      throw err;
    }
  });
}

export async function listTicketLotsForAccount(accountId, { limit = 100 } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return all(
    `SELECT * FROM ticket_lots WHERE account_id = ?
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    [id, Math.min(500, Math.max(1, Number(limit) || 100))],
  );
}

/** Sum remaining PayPal lot value in USD cents (FIFO inventory). */
export async function paypalRefundValueCents(accountId) {
  const lots = await listTicketLotsForAccount(accountId, { limit: 500 });
  let sum = 0;
  for (const lot of lots) {
    sum += lotRefundCents(lot.tickets_remaining, lot.amount_cents, lot.tickets_total);
  }
  return sum;
}

export const COMMUNITY_DEFAULT_FUNDING_KEY = "community_default_funding_goal_id";
export const COMMUNITY_DEFAULT_DEV_KEY = "community_default_dev_priority_id";

let communityDirtyHook = null;

/** Optional listener after community totals change (e.g. throttled socket broadcast). */
export function setCommunityDirtyHook(fn) {
  communityDirtyHook = typeof fn === "function" ? fn : null;
}

function noteCommunityDirty() {
  try {
    communityDirtyHook?.();
  } catch {
    // ignore listener errors
  }
}

const FUNDING_SELECTABLE = new Set(["active", "goal_reached"]);
const FUNDING_LIVE = new Set(["active", "goal_reached", "fulfilled"]);

function fundingSelectable(row, now = Date.now()) {
  if (!row || !FUNDING_SELECTABLE.has(row.status)) return false;
  if (row.selection_deadline_at != null && Number(row.selection_deadline_at) <= now) return false;
  return row.slot != null && Number(row.slot) >= 0 && Number(row.slot) <= 2;
}

function devSelectable(row, now = Date.now()) {
  if (!row || row.vote_status !== "active") return false;
  if (row.selection_deadline_at != null && Number(row.selection_deadline_at) <= now) return false;
  return row.slot != null && Number(row.slot) >= 0 && Number(row.slot) <= 2;
}

async function getSiteSettingValue(execGetFn, key) {
  const row = await execGetFn(
    "SELECT value FROM site_settings WHERE key = ?",
    [key],
  );
  return row?.value != null ? String(row.value) : null;
}

async function setSiteSettingExec(execRunFn, key, value, updatedBy = null, now = Date.now()) {
  await execRunFn(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [key, value != null ? String(value) : null, now, updatedBy],
  );
}

async function bumpFundingContributed(execRunFn, execGetFn, goalId, delta, now) {
  const id = Number(goalId);
  const n = Number(delta) || 0;
  if (!Number.isInteger(id) || id <= 0 || n === 0) return null;
  await execRunFn(
    "UPDATE funding_goals SET contributed_tickets = contributed_tickets + ? WHERE id = ?",
    [n, id],
  );
  const row = await execGetFn("SELECT * FROM funding_goals WHERE id = ?", [id]);
  if (!row) return null;
  if (
    row.status === "active"
    && Number(row.contributed_tickets) >= Number(row.target_tickets)
  ) {
    await execRunFn(
      `UPDATE funding_goals
       SET status = 'goal_reached', reached_at = COALESCE(reached_at, ?)
       WHERE id = ? AND status = 'active'`,
      [now, id],
    );
    return execGetFn("SELECT * FROM funding_goals WHERE id = ?", [id]);
  }
  if (
    FUNDING_LIVE.has(row.status)
    && Number(row.contributed_tickets) < Number(row.target_tickets)
    && row.status === "goal_reached"
    && !row.fulfilled_at
  ) {
    // Late reversal can drop below target while still goal_reached; leave status.
  }
  if (
    row.status === "fulfilled"
    && n < 0
    && Number(row.contributed_tickets) < Number(row.target_tickets)
  ) {
    await execRunFn(
      "UPDATE funding_goals SET discrepancy_flag = 1 WHERE id = ?",
      [id],
    );
    return execGetFn("SELECT * FROM funding_goals WHERE id = ?", [id]);
  }
  return row;
}

async function bumpDevContributed(execRunFn, priorityId, delta) {
  const id = Number(priorityId);
  const n = Number(delta) || 0;
  if (!Number.isInteger(id) || id <= 0 || n === 0) return;
  await execRunFn(
    "UPDATE dev_priorities SET contributed_tickets = contributed_tickets + ? WHERE id = ?",
    [n, id],
  );
}

async function resolveSelectionsForSpend(execGetFn, accountId, now) {
  const sel = await execGetFn(
    "SELECT * FROM community_player_selections WHERE account_id = ?",
    [accountId],
  );
  let fundingId = sel?.funding_goal_id != null ? Number(sel.funding_goal_id) : null;
  let devId = sel?.dev_priority_id != null ? Number(sel.dev_priority_id) : null;

  const defaultFundingRaw = await getSiteSettingValue(execGetFn, COMMUNITY_DEFAULT_FUNDING_KEY);
  const defaultDevRaw = await getSiteSettingValue(execGetFn, COMMUNITY_DEFAULT_DEV_KEY);
  const defaultFunding = Number(defaultFundingRaw);
  const defaultDev = Number(defaultDevRaw);

  let funding = fundingId
    ? await execGetFn("SELECT * FROM funding_goals WHERE id = ?", [fundingId])
    : null;
  if (!fundingSelectable(funding, now)) {
    funding = Number.isInteger(defaultFunding) && defaultFunding > 0
      ? await execGetFn("SELECT * FROM funding_goals WHERE id = ?", [defaultFunding])
      : null;
    if (!fundingSelectable(funding, now)) funding = null;
    fundingId = funding ? Number(funding.id) : null;
  }

  let dev = devId
    ? await execGetFn("SELECT * FROM dev_priorities WHERE id = ?", [devId])
    : null;
  if (!devSelectable(dev, now)) {
    dev = Number.isInteger(defaultDev) && defaultDev > 0
      ? await execGetFn("SELECT * FROM dev_priorities WHERE id = ?", [defaultDev])
      : null;
    if (!devSelectable(dev, now)) {
      // Fall back to any active priority in the open round.
      const open = await execGetFn(
        "SELECT id FROM dev_rounds WHERE status = 'open' ORDER BY started_at DESC LIMIT 1",
      );
      if (open) {
        dev = await execGetFn(
          `SELECT * FROM dev_priorities
           WHERE round_id = ? AND vote_status = 'active'
           ORDER BY slot ASC LIMIT 1`,
          [open.id],
        );
      } else {
        dev = null;
      }
    }
    if (!devSelectable(dev, now)) dev = null;
    devId = dev ? Number(dev.id) : null;
  }

  return { fundingGoalId: fundingId, devPriorityId: devId };
}

/**
 * Record community contributions for a successful ticket spend (same DB txn).
 * Skips quietly when goals are not configured.
 */
async function applySpendContributions(execRunFn, execGetFn, {
  accountId,
  spendLedgerId,
  slices,
  ticketsSpent = 1,
  createdAt = Date.now(),
}) {
  const id = Number(accountId);
  const ledgerId = Number(spendLedgerId);
  const n = Number(ticketsSpent);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(ledgerId) || ledgerId <= 0) return null;
  if (!Number.isInteger(n) || n <= 0) return null;

  const existing = await execGetFn(
    "SELECT id FROM community_contributions WHERE spend_ledger_id = ?",
    [ledgerId],
  );
  if (existing) return { duplicate: true, id: existing.id };

  const paid = countPaidFromSlices(slices);
  const free = Math.max(0, n - paid);
  const { fundingGoalId, devPriorityId } = await resolveSelectionsForSpend(
    execGetFn,
    id,
    createdAt,
  );

  const fundingDelta = fundingGoalId && paid > 0 ? paid : 0;
  const devDelta = devPriorityId ? n : 0;
  if (fundingDelta === 0 && devDelta === 0) {
    return { skipped: true };
  }

  if (fundingDelta > 0) {
    await bumpFundingContributed(execRunFn, execGetFn, fundingGoalId, fundingDelta, createdAt);
  }
  if (devDelta > 0) {
    await bumpDevContributed(execRunFn, devPriorityId, devDelta);
  }

  const result = await execRunFn(
    `INSERT INTO community_contributions (
      account_id, created_at, spend_ledger_id, reversal_of_id,
      tickets_spent, paid_tickets, free_tickets,
      funding_goal_id, funding_delta, dev_priority_id, dev_delta,
      reason, ref_type, ref_id, lot_slices_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'spend', NULL, NULL, ?)`,
    [
      id,
      createdAt,
      ledgerId,
      n,
      paid,
      free,
      fundingGoalId,
      fundingDelta,
      devPriorityId,
      devDelta,
      JSON.stringify((slices || []).map((s) => ({
        lotId: s.lotId,
        take: s.take,
        sourceType: s.sourceType,
        sourceId: s.sourceId,
      }))),
    ],
  );
  return { id: result.lastID, fundingDelta, devDelta, fundingGoalId, devPriorityId, paid, free };
}

/** Reverse funding+dev for a prior spend (match refund). Idempotent. */
async function reverseContributionForSpend(execRunFn, execGetFn, spendLedgerId, {
  reason = "match_refund",
  createdAt = Date.now(),
} = {}) {
  const ledgerId = Number(spendLedgerId);
  if (!Number.isInteger(ledgerId) || ledgerId <= 0) return null;

  const original = await execGetFn(
    "SELECT * FROM community_contributions WHERE spend_ledger_id = ? AND reversal_of_id IS NULL",
    [ledgerId],
  );
  if (!original) return { missing: true };

  const already = await execGetFn(
    "SELECT id FROM community_contributions WHERE reversal_of_id = ? AND reason = ?",
    [original.id, reason],
  );
  if (already) return { duplicate: true, id: already.id };

  const fundingDelta = -Number(original.funding_delta || 0);
  const devDelta = -Number(original.dev_delta || 0);
  if (original.funding_goal_id && fundingDelta !== 0) {
    await bumpFundingContributed(
      execRunFn,
      execGetFn,
      original.funding_goal_id,
      fundingDelta,
      createdAt,
    );
  }
  if (original.dev_priority_id && devDelta !== 0) {
    await bumpDevContributed(execRunFn, original.dev_priority_id, devDelta);
  }

  const result = await execRunFn(
    `INSERT INTO community_contributions (
      account_id, created_at, spend_ledger_id, reversal_of_id,
      tickets_spent, paid_tickets, free_tickets,
      funding_goal_id, funding_delta, dev_priority_id, dev_delta,
      reason, ref_type, ref_id, lot_slices_json
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    [
      original.account_id,
      createdAt,
      original.id,
      -Number(original.tickets_spent || 0),
      -Number(original.paid_tickets || 0),
      -Number(original.free_tickets || 0),
      original.funding_goal_id,
      fundingDelta,
      original.dev_priority_id,
      devDelta,
      reason,
    ],
  );
  return { id: result.lastID, fundingDelta, devDelta };
}

/**
 * Reverse funding (not dev) for contributions that spent tickets from a purchase lot.
 * Idempotent per original contribution + reason.
 */
async function reverseFundingForPurchaseLotWithAll(execRunFn, execGetFn, execAllFn, {
  sourceType,
  sourceId,
  reason = "purchase_clawback",
  createdAt = Date.now(),
}) {
  const st = String(sourceType || "");
  const sid = String(sourceId ?? "");
  if (!st || !sid) return { reversed: 0 };

  const forwards = await execAllFn(
    `SELECT * FROM community_contributions
     WHERE reversal_of_id IS NULL AND reason = 'spend'
       AND funding_delta > 0 AND lot_slices_json IS NOT NULL`,
  );
  return reverseFundingForPurchaseLotRows(execRunFn, execGetFn, forwards, {
    sourceType: st,
    sourceId: sid,
    reason,
    createdAt,
  });
}

async function reverseFundingForPurchaseLotRows(execRunFn, execGetFn, forwards, {
  sourceType,
  sourceId,
  reason,
  createdAt,
}) {
  let reversed = 0;
  for (const original of forwards || []) {
    let slices;
    try {
      slices = JSON.parse(original.lot_slices_json || "[]");
    } catch {
      continue;
    }
    let fromPurchase = 0;
    for (const slice of slices) {
      if (
        String(slice.sourceType) === sourceType
        && String(slice.sourceId ?? "") === sourceId
      ) {
        fromPurchase += Number(slice.take) || 0;
      }
    }
    if (fromPurchase <= 0) continue;

    const already = await execGetFn(
      `SELECT id FROM community_contributions
       WHERE reversal_of_id = ? AND reason = ? AND ref_type = ? AND ref_id = ?`,
      [original.id, reason, sourceType, sourceId],
    );
    if (already) continue;

    const fundingDelta = -Math.min(fromPurchase, Number(original.funding_delta) || 0);
    if (fundingDelta === 0) continue;

    if (original.funding_goal_id) {
      await bumpFundingContributed(
        execRunFn,
        execGetFn,
        original.funding_goal_id,
        fundingDelta,
        createdAt,
      );
    }

    await execRunFn(
      `INSERT INTO community_contributions (
        account_id, created_at, spend_ledger_id, reversal_of_id,
        tickets_spent, paid_tickets, free_tickets,
        funding_goal_id, funding_delta, dev_priority_id, dev_delta,
        reason, ref_type, ref_id, lot_slices_json
      ) VALUES (?, ?, NULL, ?, 0, ?, 0, ?, ?, NULL, 0, ?, ?, ?, NULL)`,
      [
        original.account_id,
        createdAt,
        original.id,
        fundingDelta,
        original.funding_goal_id,
        fundingDelta,
        reason,
        sourceType,
        sourceId,
      ],
    );
    reversed += 1;
  }
  return { reversed };
}

function publicFundingGoal(row, { percent = null } = {}) {
  if (!row) return null;
  const target = Math.max(0, Number(row.target_tickets) || 0);
  const contributed = Math.max(0, Number(row.contributed_tickets) || 0);
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    targetTickets: target,
    contributedTickets: contributed,
    percentOfTarget: target > 0 ? Math.round((contributed * 1000) / target) / 10 : 0,
    barPercent: target > 0 ? Math.min(100, Math.round((contributed * 100) / target)) : 0,
    status: row.status,
    slot: row.slot,
    selectionDeadlineAt: row.selection_deadline_at,
    createdAt: row.created_at,
    reachedAt: row.reached_at,
    fulfilledAt: row.fulfilled_at,
    archivedAt: row.archived_at,
    fulfillmentNotes: row.fulfillment_notes,
    fulfillmentLinks: row.fulfillment_links,
    originalTargetTickets: row.original_target_tickets,
    discrepancyFlag: !!row.discrepancy_flag,
    goalReached: contributed >= target && target > 0,
    percent,
  };
}

function publicDevPriority(row, { percent = 0 } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    roundId: row.round_id,
    title: row.title,
    description: row.description || "",
    contributedTickets: Math.max(0, Number(row.contributed_tickets) || 0),
    percent,
    slot: row.slot,
    selectionDeadlineAt: row.selection_deadline_at,
    voteStatus: row.vote_status,
    implStatus: row.impl_status,
    implNotes: row.impl_notes,
    publicChangeExplanation: row.public_change_explanation,
    newsLinks: row.news_links,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export async function listLiveFundingGoals() {
  return all(
    `SELECT * FROM funding_goals
     WHERE status IN ('active', 'goal_reached', 'fulfilled') AND slot IS NOT NULL
     ORDER BY slot ASC`,
  );
}

export async function getOpenDevRound() {
  return get(
    "SELECT * FROM dev_rounds WHERE status = 'open' ORDER BY started_at DESC LIMIT 1",
  );
}

export async function listActiveDevPriorities(roundId = null) {
  let rid = roundId;
  if (rid == null) {
    const open = await getOpenDevRound();
    if (!open) return [];
    rid = open.id;
  }
  return all(
    `SELECT * FROM dev_priorities
     WHERE round_id = ? AND vote_status = 'active' AND slot IS NOT NULL
     ORDER BY slot ASC`,
    [rid],
  );
}

export async function getCommunityPublicState(accountId = null) {
  const fundingRows = await listLiveFundingGoals();
  const openRound = await getOpenDevRound();
  const devRows = openRound ? await listActiveDevPriorities(openRound.id) : [];
  const slots = [0, 1, 2];
  const funding = slots.map((slot) => {
    const row = fundingRows.find((r) => Number(r.slot) === slot) || null;
    return publicFundingGoal(row);
  });
  const totals = slots.map((slot) => {
    const row = devRows.find((r) => Number(r.slot) === slot);
    return row ? Number(row.contributed_tickets) || 0 : 0;
  });
  const percents = communityPercentages(totals);
  const development = slots.map((slot, i) => {
    const row = devRows.find((r) => Number(r.slot) === slot) || null;
    return publicDevPriority(row, { percent: percents[i] });
  });
  const configured = funding.every(Boolean) && development.every(Boolean);
  let selections = null;
  if (accountId != null) {
    selections = await ensurePlayerCommunitySelections(accountId);
  }
  return {
    configured,
    funding,
    development,
    round: openRound
      ? { id: openRound.id, status: openRound.status, startedAt: openRound.started_at }
      : null,
    selections,
    disclaimer:
      "Funding progress counts eligible paid tickets spent toward a goal — not verified cash held in reserve.",
  };
}

export async function ensurePlayerCommunitySelections(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      let sel = await execGet(
        "SELECT * FROM community_player_selections WHERE account_id = ?",
        [id],
      );
      const resolved = await resolveSelectionsForSpend(execGet, id, now);
      if (!sel) {
        await execRun(
          `INSERT INTO community_player_selections
           (account_id, funding_goal_id, dev_priority_id, updated_at)
           VALUES (?, ?, ?, ?)`,
          [id, resolved.fundingGoalId, resolved.devPriorityId, now],
        );
      } else {
        const curFunding = sel.funding_goal_id
          ? await execGet("SELECT * FROM funding_goals WHERE id = ?", [sel.funding_goal_id])
          : null;
        const curDev = sel.dev_priority_id
          ? await execGet("SELECT * FROM dev_priorities WHERE id = ?", [sel.dev_priority_id])
          : null;
        const fundingOk = fundingSelectable(curFunding, now);
        const devOk = devSelectable(curDev, now);
        if (!fundingOk || !devOk) {
          await execRun(
            `UPDATE community_player_selections
             SET funding_goal_id = ?, dev_priority_id = ?, updated_at = ?
             WHERE account_id = ?`,
            [
              fundingOk ? sel.funding_goal_id : resolved.fundingGoalId,
              devOk ? sel.dev_priority_id : resolved.devPriorityId,
              now,
              id,
            ],
          );
        }
      }
      sel = await execGet(
        "SELECT * FROM community_player_selections WHERE account_id = ?",
        [id],
      );
      await execRun("COMMIT");
      return {
        fundingGoalId: sel?.funding_goal_id ?? null,
        devPriorityId: sel?.dev_priority_id ?? null,
        updatedAt: sel?.updated_at ?? null,
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("ensurePlayerCommunitySelections", rollbackErr);
      }
      throw err;
    }
  });
}

export async function setPlayerCommunitySelection(accountId, {
  fundingGoalId = undefined,
  devPriorityId = undefined,
} = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid_account" };
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      let sel = await execGet(
        "SELECT * FROM community_player_selections WHERE account_id = ?",
        [id],
      );
      let nextFunding = sel?.funding_goal_id ?? null;
      let nextDev = sel?.dev_priority_id ?? null;

      if (fundingGoalId !== undefined) {
        const fid = Number(fundingGoalId);
        if (!Number.isInteger(fid) || fid <= 0) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_funding" };
        }
        const goal = await execGet("SELECT * FROM funding_goals WHERE id = ?", [fid]);
        if (!fundingSelectable(goal, now)) {
          await execRun("ROLLBACK");
          return { ok: false, error: "funding_unavailable" };
        }
        nextFunding = fid;
      }
      if (devPriorityId !== undefined) {
        const did = Number(devPriorityId);
        if (!Number.isInteger(did) || did <= 0) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_dev" };
        }
        const pri = await execGet("SELECT * FROM dev_priorities WHERE id = ?", [did]);
        if (!devSelectable(pri, now)) {
          await execRun("ROLLBACK");
          return { ok: false, error: "dev_unavailable" };
        }
        const open = await execGet(
          "SELECT id FROM dev_rounds WHERE status = 'open' ORDER BY started_at DESC LIMIT 1",
        );
        if (!open || Number(pri.round_id) !== Number(open.id)) {
          await execRun("ROLLBACK");
          return { ok: false, error: "dev_unavailable" };
        }
        nextDev = did;
      }

      if (!sel) {
        const resolved = await resolveSelectionsForSpend(execGet, id, now);
        if (nextFunding == null) nextFunding = resolved.fundingGoalId;
        if (nextDev == null) nextDev = resolved.devPriorityId;
        await execRun(
          `INSERT INTO community_player_selections
           (account_id, funding_goal_id, dev_priority_id, updated_at)
           VALUES (?, ?, ?, ?)`,
          [id, nextFunding, nextDev, now],
        );
      } else {
        await execRun(
          `UPDATE community_player_selections
           SET funding_goal_id = ?, dev_priority_id = ?, updated_at = ?
           WHERE account_id = ?`,
          [nextFunding, nextDev, now, id],
        );
      }
      sel = await execGet(
        "SELECT * FROM community_player_selections WHERE account_id = ?",
        [id],
      );
      await execRun("COMMIT");
      return {
        ok: true,
        selections: {
          fundingGoalId: sel.funding_goal_id,
          devPriorityId: sel.dev_priority_id,
          updatedAt: sel.updated_at,
        },
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("setPlayerCommunitySelection", rollbackErr);
      }
      throw err;
    }
  });
}

async function migrateSelectionsFromFunding(execRunFn, execGetFn, oldGoalId, now) {
  const defaultRaw = await getSiteSettingValue(execGetFn, COMMUNITY_DEFAULT_FUNDING_KEY);
  const defaultId = Number(defaultRaw);
  const next = Number.isInteger(defaultId) && defaultId > 0 && defaultId !== Number(oldGoalId)
    ? defaultId
    : null;
  await execRunFn(
    `UPDATE community_player_selections
     SET funding_goal_id = ?, updated_at = ?
     WHERE funding_goal_id = ?`,
    [next, now, oldGoalId],
  );
}

async function migrateSelectionsFromDev(execRunFn, execGetFn, oldPriorityId, now) {
  const defaultRaw = await getSiteSettingValue(execGetFn, COMMUNITY_DEFAULT_DEV_KEY);
  const defaultId = Number(defaultRaw);
  const next = Number.isInteger(defaultId) && defaultId > 0 && defaultId !== Number(oldPriorityId)
    ? defaultId
    : null;
  await execRunFn(
    `UPDATE community_player_selections
     SET dev_priority_id = ?, updated_at = ?
     WHERE dev_priority_id = ?`,
    [next, now, oldPriorityId],
  );
}

/**
 * Save all three funding slots and set the default by slot index.
 * Empty slot → create. Occupied slot → archive the old goal and create a new
 * one (optional keepOverflow transfers tickets above the old target).
 * slots: [{ title, description, targetTickets, keepOverflow? }, ...] length 3
 */
export async function saveFundingSlots({
  slots,
  defaultSlot = 0,
  actorAccountId = null,
} = {}) {
  if (!Array.isArray(slots) || slots.length !== 3) {
    return { ok: false, error: "need_three" };
  }
  const def = Number(defaultSlot);
  if (!Number.isInteger(def) || def < 0 || def > 2) {
    return { ok: false, error: "invalid_default" };
  }
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const ids = [];
      for (let s = 0; s < 3; s += 1) {
        const t = String(slots[s]?.title || "").trim();
        const desc = String(slots[s]?.description || "").trim();
        const target = Number(slots[s]?.targetTickets);
        const keepOverflow = Boolean(slots[s]?.keepOverflow);
        if (!t || !Number.isInteger(target) || target <= 0) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_slot", slot: s };
        }
        const existing = await execGet(
          `SELECT * FROM funding_goals
           WHERE slot = ? AND status IN ('active', 'goal_reached', 'fulfilled')`,
          [s],
        );

        const sameContent = existing
          && String(existing.title) === t
          && String(existing.description || "") === desc
          && Number(existing.target_tickets) === target;

        if (existing && sameContent && !keepOverflow) {
          ids.push(existing.id);
          continue;
        }

        let overflow = 0;
        if (existing) {
          if (keepOverflow) {
            overflow = Math.max(
              0,
              Number(existing.contributed_tickets) - Number(existing.target_tickets),
            );
          }
          await execRun(
            `UPDATE funding_goals
             SET status = 'archived', archived_at = ?, slot = NULL
             WHERE id = ?`,
            [now, existing.id],
          );
        }

        const result = await execRun(
          `INSERT INTO funding_goals (
            title, description, target_tickets, contributed_tickets, status, slot,
            selection_deadline_at, created_at, original_target_tickets
          ) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
          [t, desc, target, overflow, s, now, target],
        );
        const newId = result.lastID;
        if (overflow > 0 && overflow >= target) {
          await execRun(
            `UPDATE funding_goals
             SET status = 'goal_reached', reached_at = ?
             WHERE id = ?`,
            [now, newId],
          );
        }
        if (existing) {
          await execRun(
            `UPDATE community_player_selections
             SET funding_goal_id = ?, updated_at = ?
             WHERE funding_goal_id = ?`,
            [newId, now, existing.id],
          );
        }
        ids.push(newId);
      }
      await setSiteSettingExec(
        execRun,
        COMMUNITY_DEFAULT_FUNDING_KEY,
        ids[def],
        actorAccountId,
        now,
      );
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, goalIds: ids, defaultSlot: def };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("saveFundingSlots", rollbackErr);
      }
      throw err;
    }
  });
}

/**
 * Upsert the three development priorities for the open round (or start a round).
 * slots: [{ title, description }, ...] length 3
 */
export async function saveDevSlots({
  slots,
  defaultSlot = 0,
  actorAccountId = null,
} = {}) {
  if (!Array.isArray(slots) || slots.length !== 3) {
    return { ok: false, error: "need_three" };
  }
  const def = Number(defaultSlot);
  if (!Number.isInteger(def) || def < 0 || def > 2) {
    return { ok: false, error: "invalid_default" };
  }
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      for (let s = 0; s < 3; s += 1) {
        const t = String(slots[s]?.title || "").trim();
        if (!t) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_slot", slot: s };
        }
      }
      let open = await execGet(
        "SELECT * FROM dev_rounds WHERE status = 'open' ORDER BY started_at DESC LIMIT 1",
      );
      let ids = [];
      if (!open) {
        const round = await execRun(
          "INSERT INTO dev_rounds (status, started_at) VALUES ('open', ?)",
          [now],
        );
        for (let s = 0; s < 3; s += 1) {
          const result = await execRun(
            `INSERT INTO dev_priorities (
              round_id, title, description, contributed_tickets, slot,
              selection_deadline_at, vote_status, created_at
            ) VALUES (?, ?, ?, 0, ?, NULL, 'active', ?)`,
            [
              round.lastID,
              String(slots[s].title).trim(),
              String(slots[s].description || "").trim(),
              s,
              now,
            ],
          );
          ids.push(result.lastID);
        }
        open = { id: round.lastID };
      } else {
        const priorities = await execAll(
          `SELECT * FROM dev_priorities
           WHERE round_id = ? AND vote_status = 'active' AND slot IS NOT NULL
           ORDER BY slot ASC`,
          [open.id],
        );
        if (priorities.length !== 3) {
          await execRun("ROLLBACK");
          return { ok: false, error: "round_incomplete" };
        }
        for (let s = 0; s < 3; s += 1) {
          const p = priorities.find((row) => Number(row.slot) === s) || priorities[s];
          await execRun(
            `UPDATE dev_priorities SET title = ?, description = ? WHERE id = ?`,
            [
              String(slots[s].title).trim(),
              String(slots[s].description || "").trim(),
              p.id,
            ],
          );
          ids.push(p.id);
        }
      }
      await setSiteSettingExec(
        execRun,
        COMMUNITY_DEFAULT_DEV_KEY,
        ids[def],
        actorAccountId,
        now,
      );
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, roundId: open.id, priorityIds: ids, defaultSlot: def };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("saveDevSlots", rollbackErr);
      }
      throw err;
    }
  });
}

export async function createFundingGoal({
  title,
  description = "",
  targetTickets,
  slot,
  selectionDeadlineAt = null,
  setAsDefault = false,
  actorAccountId = null,
}) {
  const t = String(title || "").trim();
  const target = Number(targetTickets);
  const s = Number(slot);
  if (!t || !Number.isInteger(target) || target <= 0) return { ok: false, error: "invalid" };
  if (!Number.isInteger(s) || s < 0 || s > 2) return { ok: false, error: "invalid_slot" };
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const taken = await execGet(
        `SELECT id FROM funding_goals
         WHERE slot = ? AND status IN ('active', 'goal_reached', 'fulfilled')`,
        [s],
      );
      if (taken) {
        await execRun("ROLLBACK");
        return { ok: false, error: "slot_taken" };
      }
      const result = await execRun(
        `INSERT INTO funding_goals (
          title, description, target_tickets, contributed_tickets, status, slot,
          selection_deadline_at, created_at, original_target_tickets
        ) VALUES (?, ?, ?, 0, 'active', ?, ?, ?, ?)`,
        [t, String(description || "").trim(), target, s, selectionDeadlineAt, now, target],
      );
      if (setAsDefault) {
        await setSiteSettingExec(execRun, COMMUNITY_DEFAULT_FUNDING_KEY, result.lastID, actorAccountId, now);
      }
      const row = await execGet("SELECT * FROM funding_goals WHERE id = ?", [result.lastID]);
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, goal: publicFundingGoal(row) };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("createFundingGoal", rollbackErr);
      }
      throw err;
    }
  });
}

export async function updateFundingGoal(goalId, {
  title = undefined,
  description = undefined,
  targetTickets = undefined,
  selectionDeadlineAt = undefined,
  fulfillmentNotes = undefined,
  fulfillmentLinks = undefined,
} = {}) {
  const id = Number(goalId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet("SELECT * FROM funding_goals WHERE id = ?", [id]);
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (row.status === "archived") {
        await execRun("ROLLBACK");
        return { ok: false, error: "archived" };
      }
      const nextTitle = title !== undefined ? String(title).trim() : row.title;
      const nextDesc = description !== undefined ? String(description).trim() : row.description;
      let nextTarget = row.target_tickets;
      let original = row.original_target_tickets;
      if (targetTickets !== undefined) {
        const t = Number(targetTickets);
        if (!Number.isInteger(t) || t <= 0) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_target" };
        }
        if (original == null) original = row.target_tickets;
        nextTarget = t;
      }
      const nextDeadline = selectionDeadlineAt !== undefined
        ? selectionDeadlineAt
        : row.selection_deadline_at;
      const nextNotes = fulfillmentNotes !== undefined
        ? String(fulfillmentNotes || "")
        : row.fulfillment_notes;
      const nextLinks = fulfillmentLinks !== undefined
        ? String(fulfillmentLinks || "")
        : row.fulfillment_links;
      await execRun(
        `UPDATE funding_goals SET
           title = ?, description = ?, target_tickets = ?,
           selection_deadline_at = ?, fulfillment_notes = ?, fulfillment_links = ?,
           original_target_tickets = ?
         WHERE id = ?`,
        [nextTitle, nextDesc, nextTarget, nextDeadline, nextNotes, nextLinks, original, id],
      );
      if (
        row.status === "active"
        && Number(row.contributed_tickets) >= nextTarget
      ) {
        await execRun(
          `UPDATE funding_goals
           SET status = 'goal_reached', reached_at = COALESCE(reached_at, ?)
           WHERE id = ?`,
          [now, id],
        );
      }
      const updated = await execGet("SELECT * FROM funding_goals WHERE id = ?", [id]);
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, goal: publicFundingGoal(updated), before: publicFundingGoal(row) };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("updateFundingGoal", rollbackErr);
      }
      throw err;
    }
  });
}

export async function fulfillFundingGoal(goalId, {
  notes = "",
  links = "",
} = {}) {
  const id = Number(goalId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet("SELECT * FROM funding_goals WHERE id = ?", [id]);
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (row.status === "archived" || (row.status === "fulfilled" && row.slot == null)) {
        await execRun("ROLLBACK");
        return { ok: false, error: "archived" };
      }
      await execRun(
        `UPDATE funding_goals SET
           status = 'fulfilled',
           fulfilled_at = ?,
           archived_at = ?,
           slot = NULL,
           fulfillment_notes = ?,
           fulfillment_links = ?,
           reached_at = COALESCE(reached_at, ?)
         WHERE id = ?`,
        [now, now, String(notes || ""), String(links || ""), now, id],
      );
      await migrateSelectionsFromFunding(execRun, execGet, id, now);
      const updated = await execGet("SELECT * FROM funding_goals WHERE id = ?", [id]);
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, goal: publicFundingGoal(updated), before: publicFundingGoal(row) };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("fulfillFundingGoal", rollbackErr);
      }
      throw err;
    }
  });
}

export async function replaceFundingGoal(oldGoalId, {
  title,
  description = "",
  targetTickets,
  selectionDeadlineAt = null,
  transferOverflow = false,
  setAsDefault = false,
  actorAccountId = null,
}) {
  const oldId = Number(oldGoalId);
  const t = String(title || "").trim();
  const target = Number(targetTickets);
  if (!Number.isInteger(oldId) || oldId <= 0 || !t || !Number.isInteger(target) || target <= 0) {
    return { ok: false, error: "invalid" };
  }
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const old = await execGet("SELECT * FROM funding_goals WHERE id = ?", [oldId]);
      if (!old || old.slot == null) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (old.status === "archived") {
        await execRun("ROLLBACK");
        return { ok: false, error: "archived" };
      }
      const slot = Number(old.slot);
      let overflow = 0;
      if (transferOverflow) {
        overflow = Math.max(0, Number(old.contributed_tickets) - Number(old.target_tickets));
      }
      await execRun(
        `UPDATE funding_goals
         SET status = 'archived', archived_at = ?, slot = NULL
         WHERE id = ?`,
        [now, oldId],
      );
      await migrateSelectionsFromFunding(execRun, execGet, oldId, now);
      const result = await execRun(
        `INSERT INTO funding_goals (
          title, description, target_tickets, contributed_tickets, status, slot,
          selection_deadline_at, created_at, original_target_tickets
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        [
          t,
          String(description || "").trim(),
          target,
          overflow,
          slot,
          selectionDeadlineAt,
          now,
          target,
        ],
      );
      if (overflow > 0 && overflow >= target) {
        await execRun(
          `UPDATE funding_goals
           SET status = 'goal_reached', reached_at = ?
           WHERE id = ?`,
          [now, result.lastID],
        );
      }
      if (setAsDefault) {
        await setSiteSettingExec(execRun, COMMUNITY_DEFAULT_FUNDING_KEY, result.lastID, actorAccountId, now);
      } else {
        const def = await getSiteSettingValue(execGet, COMMUNITY_DEFAULT_FUNDING_KEY);
        if (String(def) === String(oldId)) {
          await setSiteSettingExec(execRun, COMMUNITY_DEFAULT_FUNDING_KEY, result.lastID, actorAccountId, now);
        }
      }
      const neu = await execGet("SELECT * FROM funding_goals WHERE id = ?", [result.lastID]);
      await execRun("COMMIT");
      noteCommunityDirty();
      return {
        ok: true,
        old: publicFundingGoal({ ...old, status: "archived", archived_at: now, slot: null }),
        goal: publicFundingGoal(neu),
        overflowTransferred: overflow,
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("replaceFundingGoal", rollbackErr);
      }
      throw err;
    }
  });
}

export async function setCommunityDefaults({
  fundingGoalId = undefined,
  devPriorityId = undefined,
  actorAccountId = null,
} = {}) {
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      if (fundingGoalId !== undefined) {
        const fid = Number(fundingGoalId);
        const goal = await execGet("SELECT * FROM funding_goals WHERE id = ?", [fid]);
        if (!fundingSelectable(goal, now) && !(goal && FUNDING_LIVE.has(goal.status))) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_funding" };
        }
        await setSiteSettingExec(execRun, COMMUNITY_DEFAULT_FUNDING_KEY, fid, actorAccountId, now);
      }
      if (devPriorityId !== undefined) {
        const did = Number(devPriorityId);
        const pri = await execGet("SELECT * FROM dev_priorities WHERE id = ?", [did]);
        if (!devSelectable(pri, now)) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_dev" };
        }
        await setSiteSettingExec(execRun, COMMUNITY_DEFAULT_DEV_KEY, did, actorAccountId, now);
      }
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("setCommunityDefaults", rollbackErr);
      }
      throw err;
    }
  });
}

export async function startDevRound({
  priorities,
  actorAccountId = null,
} = {}) {
  if (!Array.isArray(priorities) || priorities.length !== 3) {
    return { ok: false, error: "need_three" };
  }
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const open = await execGet(
        "SELECT id FROM dev_rounds WHERE status = 'open' LIMIT 1",
      );
      if (open) {
        await execRun("ROLLBACK");
        return { ok: false, error: "round_open" };
      }
      const round = await execRun(
        "INSERT INTO dev_rounds (status, started_at) VALUES ('open', ?)",
        [now],
      );
      const created = [];
      for (let slot = 0; slot < 3; slot += 1) {
        const p = priorities[slot] || {};
        const title = String(p.title || "").trim();
        if (!title) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_priority" };
        }
        const result = await execRun(
          `INSERT INTO dev_priorities (
            round_id, title, description, contributed_tickets, slot,
            selection_deadline_at, vote_status, created_at
          ) VALUES (?, ?, ?, 0, ?, ?, 'active', ?)`,
          [
            round.lastID,
            title,
            String(p.description || "").trim(),
            slot,
            p.selectionDeadlineAt ?? null,
            now,
          ],
        );
        created.push(result.lastID);
      }
      const defaultSlot = Math.min(2, Math.max(0, Number(priorities.findIndex((p) => p.setAsDefault)) || 0));
      await setSiteSettingExec(
        execRun,
        COMMUNITY_DEFAULT_DEV_KEY,
        created[defaultSlot >= 0 ? defaultSlot : 0],
        actorAccountId,
        now,
      );
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, roundId: round.lastID, priorityIds: created };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("startDevRound", rollbackErr);
      }
      throw err;
    }
  });
}

export async function updateDevPriority(priorityId, {
  title = undefined,
  description = undefined,
  selectionDeadlineAt = undefined,
  implStatus = undefined,
  implNotes = undefined,
  publicChangeExplanation = undefined,
  newsLinks = undefined,
} = {}) {
  const id = Number(priorityId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "invalid" };
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet("SELECT * FROM dev_priorities WHERE id = ?", [id]);
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      const nextTitle = title !== undefined ? String(title).trim() : row.title;
      const nextDesc = description !== undefined ? String(description).trim() : row.description;
      const nextDeadline = selectionDeadlineAt !== undefined
        ? selectionDeadlineAt
        : row.selection_deadline_at;
      let nextImpl = implStatus !== undefined ? implStatus : row.impl_status;
      if (implStatus !== undefined && implStatus != null) {
        const allowed = ["planned", "in_progress", "completed", "delayed", "cancelled"];
        if (!allowed.includes(String(implStatus))) {
          await execRun("ROLLBACK");
          return { ok: false, error: "invalid_impl" };
        }
        nextImpl = String(implStatus);
      }
      const nextImplNotes = implNotes !== undefined ? String(implNotes || "") : row.impl_notes;
      let nextExplain = publicChangeExplanation !== undefined
        ? String(publicChangeExplanation || "")
        : row.public_change_explanation;
      if (
        (nextImpl === "cancelled" || (row.vote_status === "won" && publicChangeExplanation !== undefined))
        && nextImpl === "cancelled"
        && !String(nextExplain || "").trim()
      ) {
        await execRun("ROLLBACK");
        return { ok: false, error: "explanation_required" };
      }
      const nextNews = newsLinks !== undefined ? String(newsLinks || "") : row.news_links;
      await execRun(
        `UPDATE dev_priorities SET
           title = ?, description = ?, selection_deadline_at = ?,
           impl_status = ?, impl_notes = ?, public_change_explanation = ?, news_links = ?
         WHERE id = ?`,
        [nextTitle, nextDesc, nextDeadline, nextImpl, nextImplNotes, nextExplain, nextNews, id],
      );
      const updated = await execGet("SELECT * FROM dev_priorities WHERE id = ?", [id]);
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, priority: publicDevPriority(updated), before: publicDevPriority(row) };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("updateDevPriority", rollbackErr);
      }
      throw err;
    }
  });
}

export async function closeDevRound({
  winnerPriorityId,
  tieBreakNotes = "",
  actorAccountId = null,
} = {}) {
  const winnerId = Number(winnerPriorityId);
  if (!Number.isInteger(winnerId) || winnerId <= 0) {
    return { ok: false, error: "winner_required" };
  }
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const round = await execGet(
        "SELECT * FROM dev_rounds WHERE status = 'open' ORDER BY started_at DESC LIMIT 1",
      );
      if (!round) {
        await execRun("ROLLBACK");
        return { ok: false, error: "no_open_round" };
      }
      const priorities = await execAll(
        `SELECT * FROM dev_priorities WHERE round_id = ? AND vote_status = 'active'`,
        [round.id],
      );
      if (!priorities.some((p) => Number(p.id) === winnerId)) {
        await execRun("ROLLBACK");
        return { ok: false, error: "winner_not_in_round" };
      }
      for (const p of priorities) {
        const won = Number(p.id) === winnerId;
        await execRun(
          `UPDATE dev_priorities SET
             vote_status = ?, slot = NULL, closed_at = ?,
             impl_status = CASE WHEN ? THEN COALESCE(impl_status, 'planned') ELSE impl_status END
           WHERE id = ?`,
          [won ? "won" : "lost", now, won ? 1 : 0, p.id],
        );
        await migrateSelectionsFromDev(execRun, execGet, p.id, now);
      }
      await execRun(
        `UPDATE dev_rounds SET
           status = 'closed', closed_at = ?, winner_priority_id = ?,
           tie_break_notes = ?, closed_by = ?
         WHERE id = ?`,
        [now, winnerId, String(tieBreakNotes || ""), actorAccountId, round.id],
      );
      await execRun("COMMIT");
      noteCommunityDirty();
      return { ok: true, roundId: round.id, winnerPriorityId: winnerId };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("closeDevRound", rollbackErr);
      }
      throw err;
    }
  });
}

export async function getCommunityHistory({ limit = 20 } = {}) {
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const archivedFunding = await all(
    `SELECT * FROM funding_goals WHERE status IN ('archived', 'fulfilled')
     ORDER BY COALESCE(archived_at, fulfilled_at, created_at) DESC LIMIT ?`,
    [lim],
  );
  const rounds = await all(
    `SELECT * FROM dev_rounds WHERE status = 'closed'
     ORDER BY closed_at DESC LIMIT ?`,
    [lim],
  );
  const outRounds = [];
  for (const round of rounds) {
    const priorities = await all(
      "SELECT * FROM dev_priorities WHERE round_id = ? ORDER BY id ASC",
      [round.id],
    );
    const totals = priorities.map((p) => Number(p.contributed_tickets) || 0);
    const percents = communityPercentages(totals);
    outRounds.push({
      id: round.id,
      status: round.status,
      startedAt: round.started_at,
      closedAt: round.closed_at,
      winnerPriorityId: round.winner_priority_id,
      tieBreakNotes: round.tie_break_notes,
      priorities: priorities.map((p, i) => publicDevPriority(p, { percent: percents[i] })),
    });
  }
  return {
    funding: archivedFunding.map((r) => publicFundingGoal(r)),
    rounds: outRounds,
  };
}

export async function listCommunityContributions({
  fundingGoalId = null,
  devPriorityId = null,
  accountId = null,
  limit = 50,
} = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const clauses = [];
  const params = [];
  if (fundingGoalId != null) {
    clauses.push("funding_goal_id = ?");
    params.push(Number(fundingGoalId));
  }
  if (devPriorityId != null) {
    clauses.push("dev_priority_id = ?");
    params.push(Number(devPriorityId));
  }
  if (accountId != null) {
    clauses.push("account_id = ?");
    params.push(Number(accountId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(lim);
  return all(
    `SELECT * FROM community_contributions ${where}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  );
}

export async function listFundingGoalsAdmin() {
  return all("SELECT * FROM funding_goals ORDER BY COALESCE(slot, 99), id DESC");
}

export async function listDevRoundsAdmin() {
  const rounds = await all("SELECT * FROM dev_rounds ORDER BY started_at DESC LIMIT 50");
  const out = [];
  for (const round of rounds) {
    const priorities = await all(
      "SELECT * FROM dev_priorities WHERE round_id = ? ORDER BY COALESCE(slot, 99), id ASC",
      [round.id],
    );
    out.push({ round, priorities });
  }
  return out;
}

export async function getCommunityAdminBundle() {
  const state = await getCommunityPublicState(null);
  const defaults = await getSiteSettings([
    COMMUNITY_DEFAULT_FUNDING_KEY,
    COMMUNITY_DEFAULT_DEV_KEY,
  ]);
  const defaultMap = Object.fromEntries((defaults || []).map((r) => [r.key, r.value]));
  const discrepancies = await all(
    "SELECT * FROM funding_goals WHERE discrepancy_flag = 1 ORDER BY id DESC LIMIT 50",
  );
  const contributions = await listCommunityContributions({ limit: 40 });
  return {
    state,
    defaults: {
      fundingGoalId: defaultMap[COMMUNITY_DEFAULT_FUNDING_KEY]
        ? Number(defaultMap[COMMUNITY_DEFAULT_FUNDING_KEY])
        : null,
      devPriorityId: defaultMap[COMMUNITY_DEFAULT_DEV_KEY]
        ? Number(defaultMap[COMMUNITY_DEFAULT_DEV_KEY])
        : null,
    },
    fundingAll: (await listFundingGoalsAdmin()).map((r) => publicFundingGoal(r)),
    rounds: await listDevRoundsAdmin(),
    discrepancies: discrepancies.map((r) => publicFundingGoal(r)),
    contributions,
  };
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
      const slices = await consumeTicketLotsFifo(execRun, execAll, id, 1);
      const ledgerId = await insertTicketLedger(execRun, {
        accountId: id,
        delta: -1,
        balanceAfter: row.tickets - 1,
        heldAfter: row.held - 1,
        kind: "charge",
        refType: "ticket_lot",
        refId: slices[0]?.lotId ?? null,
        createdAt: now,
      });
      const contrib = await applySpendContributions(execRun, execGet, {
        accountId: id,
        spendLedgerId: ledgerId,
        slices,
        ticketsSpent: 1,
        createdAt: now,
      });
      await execRun("COMMIT");
      if (contrib && !contrib.skipped && !contrib.duplicate) noteCommunityDirty();
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
      const lastSpend = await execGet(
        `SELECT id, ref_id FROM ticket_ledger
         WHERE account_id = ? AND kind IN ('charge', 'spend') AND ref_type = 'ticket_lot'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [id],
      );
      let lotId = null;
      if (lastSpend?.ref_id) {
        const restored = await restoreTicketLot(execRun, execGet, lastSpend.ref_id, 1);
        if (restored > 0) lotId = Number(lastSpend.ref_id);
      }
      if (lotId == null) {
        lotId = await createTicketLot(execRun, {
          accountId: id,
          sourceType: "match_refund",
          tickets: 1,
          amountCents: 0,
          createdAt: now,
        });
      }
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: 1,
        balanceAfter: row.tickets + 1,
        heldAfter: row.held,
        kind: "refund",
        refType: "ticket_lot",
        refId: lotId,
        createdAt: now,
      });
      let reversed = null;
      if (lastSpend?.id) {
        reversed = await reverseContributionForSpend(execRun, execGet, lastSpend.id, {
          reason: "match_refund",
          createdAt: now,
        });
      }
      await execRun("COMMIT");
      if (reversed && reversed.id && !reversed.duplicate) noteCommunityDirty();
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
      const slices = await consumeTicketLotsFifo(execRun, execAll, id, 1);
      const ledgerId = await insertTicketLedger(execRun, {
        accountId: id,
        delta: -1,
        balanceAfter: row.tickets - 1,
        heldAfter: row.held,
        kind: "spend",
        refType: "ticket_lot",
        refId: slices[0]?.lotId ?? null,
        createdAt: now,
      });
      const contrib = await applySpendContributions(execRun, execGet, {
        accountId: id,
        spendLedgerId: ledgerId,
        slices,
        ticketsSpent: 1,
        createdAt: now,
      });
      await execRun("COMMIT");
      if (contrib && !contrib.skipped && !contrib.duplicate) noteCommunityDirty();
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
      await createTicketLot(execRun, {
        accountId: account,
        sourceType: "ticket_purchase",
        sourceId: id,
        tickets: count,
        amountCents: 0,
        createdAt: now,
      });
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
      await createTicketLot(execRun, {
        accountId: id,
        sourceType: purchaseId != null ? "ticket_purchase" : "grant",
        sourceId: purchaseId,
        tickets: count,
        amountCents: 0,
        createdAt: now,
      });
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
      const nextTickets = row.tickets + n;
      if (nextTickets < row.held || nextTickets < 0) {
        await execRun("ROLLBACK");
        return false;
      }
      const now = Date.now();
      await execRun(
        "UPDATE accounts SET tickets = ?, updated_at = ? WHERE id = ?",
        [nextTickets, now, id],
      );
      if (n > 0) {
        await createTicketLot(execRun, {
          accountId: id,
          sourceType: "grant",
          tickets: n,
          amountCents: 0,
          createdAt: now,
        });
      } else {
        await consumeTicketLotsFifo(execRun, execAll, id, -n);
      }
      await insertTicketLedger(execRun, {
        accountId: id,
        delta: n,
        balanceAfter: nextTickets,
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

const PAYPAL_PURCHASE_SELECT = `id, account_id, package_id, amount_value, currency, tickets,
  paypal_order_id, paypal_capture_id, status, clawback_applied, clawback_shortfall,
  created_at, updated_at, credited_at, refunded_at`;

export async function createPaypalPurchase({
  accountId,
  packageId,
  amountValue,
  currency,
  tickets,
  paypalOrderId,
}) {
  const id = Number(accountId);
  const count = Number(tickets);
  const orderId = String(paypalOrderId || "").trim();
  const pkg = String(packageId || "").trim();
  const amount = String(amountValue || "").trim();
  const cur = String(currency || "USD").trim().toUpperCase() || "USD";
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isInteger(count) || count <= 0) return null;
  if (!pkg || !amount || !orderId) return null;
  const now = Date.now();
  const result = await run(
    `INSERT INTO paypal_purchases (
      account_id, package_id, amount_value, currency, tickets,
      paypal_order_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
    [id, pkg, amount, cur, count, orderId, now, now],
  );
  return getPaypalPurchase(result.lastID);
}

export async function getPaypalPurchase(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return get(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
    [id],
  );
}

export async function getPaypalPurchaseByOrderId(orderId) {
  const oid = String(orderId || "").trim();
  if (!oid) return null;
  return get(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE paypal_order_id = ?`,
    [oid],
  );
}

export async function getPaypalPurchaseByCaptureId(captureId) {
  const cid = String(captureId || "").trim();
  if (!cid) return null;
  return get(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE paypal_capture_id = ?`,
    [cid],
  );
}

export async function listPaypalPurchasesForAccount(accountId, { limit = 50 } = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  return all(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases
     WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
    [id, size],
  );
}

export async function listStalePaypalPurchases({ olderThanMs = 120_000, limit = 50 } = {}) {
  const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  return all(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases
     WHERE status IN ('created', 'approved', 'captured')
       AND updated_at < ?
     ORDER BY updated_at ASC LIMIT ?`,
    [cutoff, size],
  );
}

export async function findPaypalPurchaseByOrderOrCapture(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  const byOrder = await getPaypalPurchaseByOrderId(q);
  if (byOrder) return byOrder;
  return getPaypalPurchaseByCaptureId(q);
}

export async function exportPaypalPurchaseRows(limit = 5000) {
  const size = Math.min(10000, Math.max(1, Number(limit) || 5000));
  return all(
    `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases
     ORDER BY created_at DESC LIMIT ?`,
    [size],
  );
}

/**
 * Mark purchase approved (buyer approved in PayPal UI).
 * No-op if already past approved.
 */
export async function markPaypalPurchaseApproved(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const now = Date.now();
  const result = await run(
    `UPDATE paypal_purchases SET status = 'approved', updated_at = ?
     WHERE id = ? AND status IN ('created', 'approved')`,
    [now, id],
  );
  return result.changes > 0;
}

/**
 * Attach capture id and move to captured (or keep credited/refunded if already settled).
 * Returns { ok, purchase, duplicate }.
 */
export async function markPaypalPurchaseCaptured(purchaseId, captureId) {
  const id = Number(purchaseId);
  const cid = String(captureId || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !cid) {
    return { ok: false, error: "invalid" };
  }
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (row.paypal_capture_id && row.paypal_capture_id !== cid) {
        await execRun("ROLLBACK");
        return { ok: false, error: "capture_mismatch", purchase: row };
      }
      if (row.status === "credited" || row.status === "refunded" || row.status === "reversed") {
        await execRun("COMMIT");
        return { ok: true, purchase: row, alreadySettled: true };
      }
      if (row.status === "captured" && row.paypal_capture_id === cid) {
        await execRun("COMMIT");
        return { ok: true, purchase: row, duplicate: true };
      }
      const now = Date.now();
      try {
        await execRun(
          `UPDATE paypal_purchases
           SET status = 'captured', paypal_capture_id = ?, updated_at = ?
           WHERE id = ? AND status IN ('created', 'approved', 'captured')`,
          [cid, now, id],
        );
      } catch (err) {
        if (String(err && err.message || "").includes("UNIQUE")) {
          await execRun("ROLLBACK");
          return { ok: false, error: "capture_taken" };
        }
        throw err;
      }
      const updated = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      await execRun("COMMIT");
      return { ok: true, purchase: updated };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("markPaypalPurchaseCaptured", rollbackErr);
      }
      throw err;
    }
  });
}

export async function markPaypalPurchaseFailed(purchaseId, reason = null) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const now = Date.now();
  const result = await run(
    `UPDATE paypal_purchases SET status = 'failed', updated_at = ?
     WHERE id = ? AND status IN ('created', 'approved', 'captured', 'denied')`,
    [now, id],
  );
  if (reason) {
    logger.info({
      event: "paypal_purchase_failed",
      purchaseId: id,
      reason: String(reason).slice(0, 200),
    }, "paypal purchase marked failed");
  }
  return result.changes > 0;
}

export async function markPaypalPurchaseDenied(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const now = Date.now();
  const result = await run(
    `UPDATE paypal_purchases SET status = 'denied', updated_at = ?
     WHERE id = ? AND status IN ('created', 'approved', 'captured', 'failed')`,
    [now, id],
  );
  return result.changes > 0;
}

/**
 * Idempotent ticket credit: CAS status captured → credited.
 * Returns { ok, credited, purchase, balance }.
 */
export async function creditPaypalPurchase(purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "invalid" };
  }
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (row.status === "credited") {
        const account = await execGet(
          "SELECT tickets, held FROM accounts WHERE id = ?",
          [row.account_id],
        );
        await execRun("COMMIT");
        return {
          ok: true,
          credited: false,
          duplicate: true,
          purchase: row,
          balance: account ? account.tickets : null,
        };
      }
      if (row.status === "refunded" || row.status === "reversed") {
        await execRun("ROLLBACK");
        return { ok: false, error: "already_refunded", purchase: row };
      }
      if (row.status !== "captured") {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_captured", purchase: row };
      }
      const marked = await execRun(
        `UPDATE paypal_purchases
         SET status = 'credited', credited_at = ?, updated_at = ?
         WHERE id = ? AND status = 'captured'`,
        [Date.now(), Date.now(), id],
      );
      if (!marked.changes) {
        await execRun("ROLLBACK");
        return { ok: false, error: "race", purchase: row };
      }
      const account = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [row.account_id],
      );
      if (!account) {
        await execRun("ROLLBACK");
        return { ok: false, error: "account_missing" };
      }
      const now = Date.now();
      const nextTickets = account.tickets + row.tickets;
      await execRun(
        "UPDATE accounts SET tickets = ?, updated_at = ? WHERE id = ?",
        [nextTickets, now, row.account_id],
      );
      await createTicketLot(execRun, {
        accountId: row.account_id,
        sourceType: "paypal_purchase",
        sourceId: id,
        tickets: row.tickets,
        amountCents: amountValueToCents(row.amount_value),
        currency: row.currency || "USD",
        createdAt: now,
      });
      await insertTicketLedger(execRun, {
        accountId: row.account_id,
        delta: row.tickets,
        balanceAfter: nextTickets,
        heldAfter: account.held,
        kind: "purchase",
        refType: "paypal_purchase",
        refId: id,
        createdAt: now,
      });
      const purchase = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      await execRun("COMMIT");
      return {
        ok: true,
        credited: true,
        purchase,
        balance: nextTickets,
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("creditPaypalPurchase", rollbackErr);
      }
      throw err;
    }
  });
}

/**
 * Refund/reversal clawback: deduct up to free tickets; record shortfall.
 * Never reduces balance below held.
 */
export async function clawbackPaypalPurchase(purchaseId, { status = "refunded", reason = null } = {}) {
  const id = Number(purchaseId);
  const nextStatus = status === "reversed" ? "reversed" : "refunded";
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "invalid" };
  }
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const row = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      if (!row) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (row.status === "refunded" || row.status === "reversed") {
        await execRun("COMMIT");
        return {
          ok: true,
          duplicate: true,
          purchase: row,
          applied: row.clawback_applied,
          shortfall: row.clawback_shortfall,
        };
      }
      const account = await execGet(
        "SELECT tickets, held FROM accounts WHERE id = ?",
        [row.account_id],
      );
      if (!account) {
        await execRun("ROLLBACK");
        return { ok: false, error: "account_missing" };
      }
      const now = Date.now();
      const free = Math.max(0, account.tickets - account.held);
      const want = row.status === "credited" || row.credited_at
        ? Number(row.tickets)
        : 0;
      let applied = 0;
      if (want > 0 && free > 0) {
        const packLot = await execGet(
          `SELECT id, tickets_remaining FROM ticket_lots
           WHERE account_id = ? AND source_type = 'paypal_purchase' AND source_id = ?
           ORDER BY id ASC LIMIT 1`,
          [row.account_id, String(id)],
        );
        let fromPack = 0;
        if (packLot && Number(packLot.tickets_remaining) > 0) {
          fromPack = Math.min(
            Number(packLot.tickets_remaining),
            want,
            free,
          );
          if (fromPack > 0) {
            await execRun(
              "UPDATE ticket_lots SET tickets_remaining = tickets_remaining - ? WHERE id = ?",
              [fromPack, packLot.id],
            );
          }
        }
        let stillWant = want - fromPack;
        let stillFree = free - fromPack;
        let fromOther = 0;
        if (stillWant > 0 && stillFree > 0) {
          const take = Math.min(stillWant, stillFree);
          await consumeTicketLotsFifo(execRun, execAll, row.account_id, take, {
            excludeLotId: packLot?.id ?? null,
          });
          fromOther = take;
        }
        applied = fromPack + fromOther;
      }
      const shortfall = Math.max(0, want - applied);
      const nextTickets = account.tickets - applied;
      if (applied > 0) {
        await execRun(
          "UPDATE accounts SET tickets = ?, updated_at = ? WHERE id = ?",
          [nextTickets, now, row.account_id],
        );
        await insertTicketLedger(execRun, {
          accountId: row.account_id,
          delta: -applied,
          balanceAfter: nextTickets,
          heldAfter: account.held,
          kind: "paypal_clawback",
          refType: "paypal_purchase",
          refId: id,
          reason: reason || nextStatus,
          createdAt: now,
        });
      }
      await execRun(
        `UPDATE paypal_purchases
         SET status = ?, clawback_applied = ?, clawback_shortfall = ?,
             refunded_at = ?, updated_at = ?
         WHERE id = ?`,
        [nextStatus, applied, shortfall, now, now, id],
      );
      const fundingRev = await reverseFundingForPurchaseLotWithAll(execRun, execGet, execAll, {
        sourceType: "paypal_purchase",
        sourceId: id,
        reason: "purchase_clawback",
        createdAt: now,
      });
      const purchase = await execGet(
        `SELECT ${PAYPAL_PURCHASE_SELECT} FROM paypal_purchases WHERE id = ?`,
        [id],
      );
      await execRun("COMMIT");
      if (fundingRev && fundingRev.reversed > 0) noteCommunityDirty();
      return {
        ok: true,
        purchase,
        applied,
        shortfall,
        balance: nextTickets,
      };
    } catch (err) {
      try { await execRun("ROLLBACK"); } catch (rollbackErr) {
        logRollbackFailed("clawbackPaypalPurchase", rollbackErr);
      }
      throw err;
    }
  });
}

/**
 * Record webhook event id for idempotency. Returns false if already seen.
 */
export async function claimPaypalWebhookEvent(eventId, eventType, purchaseId = null) {
  const eid = String(eventId || "").trim();
  const etype = String(eventType || "").trim() || "unknown";
  if (!eid) return false;
  try {
    await run(
      `INSERT INTO paypal_webhook_events (event_id, event_type, processed_at, purchase_id)
       VALUES (?, ?, ?, ?)`,
      [eid, etype, Date.now(), purchaseId != null ? Number(purchaseId) : null],
    );
    return true;
  } catch (err) {
    if (String(err && err.message || "").includes("UNIQUE") || err.code === "SQLITE_CONSTRAINT") {
      return false;
    }
    throw err;
  }
}

export async function paypalWebhookEventSeen(eventId) {
  const eid = String(eventId || "").trim();
  if (!eid) return false;
  const row = await get(
    "SELECT event_id FROM paypal_webhook_events WHERE event_id = ?",
    [eid],
  );
  return Boolean(row);
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
          created_at, started_at, ended_at, win_reason, outcome, chat_json,
          map_id, summary_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          game.startedAt ?? game.createdAt ?? null,
          game.endedAt,
          game.winReason || null,
          game.outcome || defaultGameOutcome(game.winReason),
          game.chatJson ?? null,
          game.mapId ?? null,
          game.summaryJson ?? null,
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

function defaultGameOutcome(winReason) {
  if (winReason === "admin") return "admin_cancel";
  if (
    winReason === "concede"
    || winReason === "disconnect"
    || winReason === "reconnect_spam"
  ) {
    return "forfeit";
  }
  return "completed";
}

export async function insertGame(game) {
  await run(
    `INSERT INTO games (
      id, mode, player_a, player_b, name_a, name_b, formbar_a, formbar_b,
      account_a, account_b,
      winner_side, mmr_a_before, mmr_b_before, mmr_a_after, mmr_b_after,
      created_at, started_at, ended_at, win_reason, outcome, chat_json,
      map_id, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      game.startedAt ?? game.createdAt ?? null,
      game.endedAt,
      game.winReason || null,
      game.outcome || defaultGameOutcome(game.winReason),
      game.chatJson ?? null,
      game.mapId ?? null,
      game.summaryJson ?? null,
    ],
  );
}

/** Human-readable wall-clock play duration (ms → "3h 12m"). */
export function formatPlayDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  const totalMin = Math.floor(n / 60_000);
  if (totalMin < 1) {
    const sec = Math.floor(n / 1000);
    return sec <= 0 ? "0m" : `${sec}s`;
  }
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

/** SQL expression for match length (play start → end; falls back to room create). */
const GAME_DURATION_SQL = "(ended_at - COALESCE(started_at, created_at))";

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

export function newsEmailOptedIn(account) {
  return !!(account && Number(account.news_email_opt_in) === 1);
}

/** Eligible newsletter recipients: verified email, opted in, not banned. */
export async function listNewsEmailEligibleAccounts() {
  const now = Date.now();
  const rows = await all(
    `SELECT ${ACCOUNT_SELECT} FROM accounts
     WHERE deleted_at IS NULL
       AND email IS NOT NULL AND TRIM(email) != ''
       AND email_verified_at IS NOT NULL
       AND news_email_opt_in = 1
       AND (banned_at IS NULL OR (ban_expires_at IS NOT NULL AND ban_expires_at <= ?))`,
    [now],
  );
  return rows.filter((row) => !isAccountBanned(row, now));
}

export async function countNewsEmailEligible() {
  const rows = await listNewsEmailEligibleAccounts();
  return rows.length;
}

export async function setNewsEmailOptIn(accountId, optedIn, {
  source = "profile",
  ip = null,
  userAgent = null,
} = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad_account" };
  const now = Date.now();
  const on = optedIn ? 1 : 0;
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const account = await execGet(
        `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
        [id],
      );
      if (!account) {
        await execRun("ROLLBACK");
        return { ok: false, error: "not_found" };
      }
      if (on) {
        await execRun(
          `UPDATE accounts SET
             news_email_opt_in = 1,
             news_email_opt_in_at = ?,
             news_email_consent_source = ?,
             news_email_consent_ip = ?,
             updated_at = ?
           WHERE id = ?`,
          [now, source || null, ip ? String(ip).slice(0, 64) : null, now, id],
        );
      } else {
        await execRun(
          `UPDATE accounts SET
             news_email_opt_in = 0,
             news_email_opt_out_at = ?,
             news_email_consent_source = ?,
             news_email_consent_ip = ?,
             updated_at = ?
           WHERE id = ?`,
          [now, source || null, ip ? String(ip).slice(0, 64) : null, now, id],
        );
        await execRun(
          `UPDATE newsletter_unsub_tokens SET revoked_at = ?
           WHERE account_id = ? AND revoked_at IS NULL`,
          [now, id],
        );
      }
      await execRun(
        `INSERT INTO newsletter_consent_events (account_id, opted_in, source, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          on,
          source || null,
          ip ? String(ip).slice(0, 64) : null,
          userAgent ? String(userAgent).slice(0, 200) : null,
          now,
        ],
      );
      await execRun("COMMIT");
      return { ok: true, optedIn: !!on };
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("setNewsEmailOptIn", rollbackErr);
      }
      throw err;
    }
  });
}

export async function issueNewsletterUnsubToken(accountId, tokenHash) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const now = Date.now();
  // Keep prior tokens active so older emails still unsubscribe until used or account opts out.
  await run(
    `INSERT INTO newsletter_unsub_tokens (account_id, token_hash, created_at, revoked_at)
     VALUES (?, ?, ?, NULL)`,
    [id, tokenHash, now],
  );
  return true;
}

export async function getActiveNewsletterUnsubToken(accountId) {
  return get(
    `SELECT id, account_id, token_hash, created_at FROM newsletter_unsub_tokens
     WHERE account_id = ? AND revoked_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [accountId],
  );
}

/** Non-consuming lookup; returns account if token is active. */
export async function findAccountByNewsletterUnsubToken(tokenHash) {
  const row = await get(
    `SELECT t.account_id FROM newsletter_unsub_tokens t
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    [tokenHash],
  );
  if (!row) return null;
  return getAccount(row.account_id);
}

export async function revokeNewsletterUnsubToken(tokenHash) {
  const row = await get(
    `SELECT account_id FROM newsletter_unsub_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [tokenHash],
  );
  if (!row) return false;
  const now = Date.now();
  await run(
    `UPDATE newsletter_unsub_tokens SET revoked_at = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [now, row.account_id],
  );
  return true;
}

export async function purgeNewsletterDataForAccount(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  await run("DELETE FROM newsletter_unsub_tokens WHERE account_id = ?", [id]);
  await run(
    `UPDATE newsletter_outbox SET status = 'cancelled', last_error = 'account_deleted'
     WHERE account_id = ? AND status IN ('pending', 'sending')`,
    [id],
  );
  await run(
    `UPDATE accounts SET
       news_email_opt_in = 0,
       news_email_opt_out_at = ?,
       news_email_consent_source = 'account_deleted',
       updated_at = ?
     WHERE id = ?`,
    [Date.now(), Date.now(), id],
  );
}

export async function getActiveCampaignForNews(newsId) {
  return get(
    `SELECT * FROM newsletter_campaigns
     WHERE news_id = ? AND status IN ('queued', 'sending', 'paused')
     ORDER BY id DESC LIMIT 1`,
    [String(newsId)],
  );
}

export async function getNewsletterCampaign(id) {
  return get("SELECT * FROM newsletter_campaigns WHERE id = ?", [Number(id)]);
}

export async function listNewsletterCampaigns(limit = 50) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  return all(
    `SELECT * FROM newsletter_campaigns ORDER BY id DESC LIMIT ?`,
    [n],
  );
}

export async function createNewsletterCampaign({
  newsId,
  subject,
  createdBy,
  recipients,
}) {
  const now = Date.now();
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      const active = await execGet(
        `SELECT id FROM newsletter_campaigns
         WHERE news_id = ? AND status IN ('queued', 'sending', 'paused')
         LIMIT 1`,
        [String(newsId)],
      );
      if (active) {
        await execRun("ROLLBACK");
        return { ok: false, error: "campaign_active", campaignId: active.id };
      }
      const list = Array.isArray(recipients) ? recipients : [];
      const insert = await execRun(
        `INSERT INTO newsletter_campaigns (
          news_id, subject, status, created_by, started_at, completed_at,
          total, sent, failed, pending, skipped, error_summary, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, NULL, ?, 0, 0, ?, 0, NULL, ?, ?)`,
        [
          String(newsId),
          String(subject || "").slice(0, 200),
          createdBy ?? null,
          now,
          list.length,
          list.length,
          now,
          now,
        ],
      );
      const campaignId = insert.lastID;
      for (const row of list) {
        const domain = row.email && String(row.email).includes("@")
          ? String(row.email).split("@").pop()
          : null;
        await execRun(
          `INSERT INTO newsletter_outbox (
            campaign_id, account_id, email_domain, status, attempts,
            next_attempt_at, last_error, provider_message_id, claimed_by, claimed_at, sent_at, created_at
          ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
          [campaignId, row.id, domain, now, now],
        );
      }
      await execRun("COMMIT");
      return { ok: true, campaignId, total: list.length };
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("createNewsletterCampaign", rollbackErr);
      }
      throw err;
    }
  });
}

export async function updateNewsletterCampaignStatus(campaignId, status, extra = {}) {
  const now = Date.now();
  const fields = ["status = ?", "updated_at = ?"];
  const params = [status, now];
  if (extra.completedAt != null) {
    fields.push("completed_at = ?");
    params.push(extra.completedAt);
  }
  if (extra.startedAt != null) {
    fields.push("started_at = ?");
    params.push(extra.startedAt);
  }
  if (extra.errorSummary !== undefined) {
    fields.push("error_summary = ?");
    params.push(extra.errorSummary);
  }
  params.push(Number(campaignId));
  await run(
    `UPDATE newsletter_campaigns SET ${fields.join(", ")} WHERE id = ?`,
    params,
  );
}

export async function refreshNewsletterCampaignCounts(campaignId) {
  const id = Number(campaignId);
  const row = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'pending' OR status = 'sending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'skipped' OR status = 'cancelled' THEN 1 ELSE 0 END), 0) AS skipped,
       COUNT(*) AS total
     FROM newsletter_outbox WHERE campaign_id = ?`,
    [id],
  );
  const now = Date.now();
  await run(
    `UPDATE newsletter_campaigns SET
       sent = ?, failed = ?, pending = ?, skipped = ?, total = ?, updated_at = ?
     WHERE id = ?`,
    [
      Number(row?.sent || 0),
      Number(row?.failed || 0),
      Number(row?.pending || 0),
      Number(row?.skipped || 0),
      Number(row?.total || 0),
      now,
      id,
    ],
  );
  return row;
}

export async function pauseNewsletterCampaign(campaignId) {
  await updateNewsletterCampaignStatus(campaignId, "paused");
}

export async function resumeNewsletterCampaign(campaignId) {
  const now = Date.now();
  await run(
    `UPDATE newsletter_outbox SET next_attempt_at = ?
     WHERE campaign_id = ? AND status = 'pending'`,
    [now, Number(campaignId)],
  );
  await updateNewsletterCampaignStatus(campaignId, "queued");
}

export async function cancelNewsletterCampaign(campaignId) {
  const now = Date.now();
  await run(
    `UPDATE newsletter_outbox SET status = 'cancelled'
     WHERE campaign_id = ? AND status IN ('pending', 'sending')`,
    [Number(campaignId)],
  );
  await updateNewsletterCampaignStatus(campaignId, "cancelled", {
    completedAt: now,
  });
  await refreshNewsletterCampaignCounts(campaignId);
}

/**
 * Claim one pending outbox row for a sending/queued campaign.
 * Returns row + account email or null.
 */
export async function claimNewsletterOutboxRow(workerId, {
  staleClaimMs = 5 * 60 * 1000,
} = {}) {
  const now = Date.now();
  const claimer = String(workerId || `pid-${process.pid}`).slice(0, 64);
  return withDb(async () => {
    await execRun("BEGIN IMMEDIATE");
    try {
      // Reclaim stale sending rows
      await execRun(
        `UPDATE newsletter_outbox SET status = 'pending', claimed_by = NULL, claimed_at = NULL
         WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ?`,
        [now - staleClaimMs],
      );
      const candidate = await execGet(
        `SELECT o.* FROM newsletter_outbox o
         JOIN newsletter_campaigns c ON c.id = o.campaign_id
         WHERE o.status = 'pending'
           AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
           AND c.status IN ('queued', 'sending')
         ORDER BY o.id ASC
         LIMIT 1`,
        [now],
      );
      if (!candidate) {
        await execRun("COMMIT");
        return null;
      }
      const upd = await execRun(
        `UPDATE newsletter_outbox
         SET status = 'sending', claimed_by = ?, claimed_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
        [claimer, now, candidate.id],
      );
      if (!upd.changes) {
        await execRun("COMMIT");
        return null;
      }
      await execRun(
        `UPDATE newsletter_campaigns SET status = 'sending', updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [now, candidate.campaign_id],
      );
      const account = await execGet(
        `SELECT ${ACCOUNT_SELECT} FROM accounts WHERE id = ?`,
        [candidate.account_id],
      );
      await execRun("COMMIT");
      return { outbox: { ...candidate, status: "sending", claimed_by: claimer, claimed_at: now }, account };
    } catch (err) {
      try {
        await execRun("ROLLBACK");
      } catch (rollbackErr) {
        logRollbackFailed("claimNewsletterOutboxRow", rollbackErr);
      }
      throw err;
    }
  });
}

export async function completeNewsletterOutboxSent(outboxId, campaignId, messageId) {
  const now = Date.now();
  await run(
    `UPDATE newsletter_outbox
     SET status = 'sent', sent_at = ?, provider_message_id = ?, last_error = NULL,
         claimed_by = NULL, claimed_at = NULL
     WHERE id = ?`,
    [now, messageId || null, Number(outboxId)],
  );
  await refreshNewsletterCampaignCounts(campaignId);
  await maybeCompleteNewsletterCampaign(campaignId);
}

export async function completeNewsletterOutboxSkipped(outboxId, campaignId, reason) {
  await run(
    `UPDATE newsletter_outbox
     SET status = 'skipped', last_error = ?, claimed_by = NULL, claimed_at = NULL
     WHERE id = ?`,
    [String(reason || "skipped").slice(0, 200), Number(outboxId)],
  );
  await refreshNewsletterCampaignCounts(campaignId);
  await maybeCompleteNewsletterCampaign(campaignId);
}

export async function completeNewsletterOutboxFailed(outboxId, campaignId, error, {
  retryAt = null,
  permanent = false,
} = {}) {
  const msg = String(error || "error").slice(0, 300);
  if (permanent || retryAt == null) {
    await run(
      `UPDATE newsletter_outbox
       SET status = 'failed', last_error = ?, claimed_by = NULL, claimed_at = NULL
       WHERE id = ?`,
      [msg, Number(outboxId)],
    );
  } else {
    await run(
      `UPDATE newsletter_outbox
       SET status = 'pending', last_error = ?, next_attempt_at = ?,
           claimed_by = NULL, claimed_at = NULL
       WHERE id = ?`,
      [msg, retryAt, Number(outboxId)],
    );
  }
  await refreshNewsletterCampaignCounts(campaignId);
  if (permanent || retryAt == null) {
    await maybeCompleteNewsletterCampaign(campaignId);
  }
}

export async function pauseCampaignForQuota(campaignId, resumeAt, summary) {
  await run(
    `UPDATE newsletter_outbox SET next_attempt_at = ?
     WHERE campaign_id = ? AND status = 'pending'`,
    [resumeAt, Number(campaignId)],
  );
  await updateNewsletterCampaignStatus(campaignId, "paused", {
    errorSummary: String(summary || "SMTP quota exceeded; paused").slice(0, 500),
  });
}

async function maybeCompleteNewsletterCampaign(campaignId) {
  const campaign = await getNewsletterCampaign(campaignId);
  if (!campaign) return;
  if (campaign.status !== "queued" && campaign.status !== "sending") return;
  const counts = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END), 0) AS open_count,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
       COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent
     FROM newsletter_outbox WHERE campaign_id = ?`,
    [Number(campaignId)],
  );
  if (Number(counts?.open_count || 0) > 0) return;
  const now = Date.now();
  const status = Number(counts?.sent || 0) === 0 && Number(counts?.failed || 0) > 0
    ? "failed"
    : "completed";
  await updateNewsletterCampaignStatus(campaignId, status, { completedAt: now });
  await refreshNewsletterCampaignCounts(campaignId);
}

export async function listNewsletterOutboxErrors(campaignId, limit = 20) {
  return all(
    `SELECT id, account_id, email_domain, status, last_error, attempts
     FROM newsletter_outbox
     WHERE campaign_id = ? AND last_error IS NOT NULL
     ORDER BY id DESC LIMIT ?`,
    [Number(campaignId), Math.max(1, Math.min(100, limit))],
  );
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
     FROM accounts WHERE deleted_at IS NULL`,
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
  // Net USD kept: credited sales only (refunded/reversed leave this set).
  const paypal = await get(
    `SELECT COALESCE(SUM(CAST(amount_value AS REAL)), 0) AS income_usd
     FROM paypal_purchases WHERE status = 'credited'`,
  );
  const roles = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS admins,
       COALESCE(SUM(CASE WHEN role = 'moderator' THEN 1 ELSE 0 END), 0) AS moderators
     FROM accounts WHERE deleted_at IS NULL`,
  );
  return {
    accounts: accounts.accounts,
    tickets: accounts.tickets,
    held: accounts.held,
    finished: games.finished,
    ranked: games.ranked,
    digipogs: spent.digipogs,
    paypalIncomeUsd: Number(paypal.income_usd) || 0,
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
  const row = await get(
    "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND deleted_at IS NULL",
  );
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
      if (n > 0) {
        await createTicketLot(execRun, {
          accountId: id,
          sourceType: "admin_adjust",
          tickets: n,
          amountCents: 0,
          createdAt: now,
        });
      } else {
        await consumeTicketLotsFifo(execRun, execAll, id, -n);
      }
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

export async function touchAccountLogin(accountId, provider = null, platform = null) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const plat = platform != null ? String(platform).toLowerCase().trim() || null : null;
  await run(
    "UPDATE accounts SET last_login_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
    [now, now, now, id],
  );
  await run(
    "INSERT OR IGNORE INTO activity_day (account_id, day) VALUES (?, ?)",
    [id, day],
  );
  await run(
    "INSERT INTO login_events (account_id, provider, ok, created_at, platform) VALUES (?, ?, 1, ?, ?)",
    [id, provider, now, plat],
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

export async function recordLoginFailure(provider = null, accountId = null, platform = null) {
  const plat = platform != null ? String(platform).toLowerCase().trim() || null : null;
  await run(
    "INSERT INTO login_events (account_id, provider, ok, created_at, platform) VALUES (?, ?, 0, ?, ?)",
    [accountId, provider, Date.now(), plat],
  );
}

const platformSightDebounce = new Map();

/** Record a client platform sighting for an authenticated account (debounced). */
export async function recordAccountPlatform(accountId, platform, debounceMs = 24 * 60 * 60 * 1000) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return;
  const plat = String(platform || "").toLowerCase().trim();
  if (!plat || plat === "unknown") return;
  const key = `${id}:${plat}`;
  const now = Date.now();
  const prev = platformSightDebounce.get(key) || 0;
  if (now - prev < debounceMs) return;
  platformSightDebounce.set(key, now);
  await run(
    "INSERT INTO login_events (account_id, provider, ok, created_at, platform) VALUES (?, ?, 1, ?, ?)",
    [id, "session", now, plat],
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
  socketsAuthed = null,
  queueCasual = 0,
  queueRanked = 0,
  queueTraining = 0,
} = {}) {
  await run(
    `INSERT INTO ops_samples (
      rooms, sockets, sockets_authed, queue_casual, queue_ranked, queue_training, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      rooms,
      sockets,
      socketsAuthed != null ? Number(socketsAuthed) || 0 : null,
      queueCasual,
      queueRanked,
      queueTraining,
      Date.now(),
    ],
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
  } else if (filter === "deleted") {
    where.push("deleted_at IS NOT NULL");
  }
  // Hide tombstones by default; exact id search and filter=deleted still find them.
  if (filter !== "deleted" && !(/^\d+$/.test(query))) {
    where.push("deleted_at IS NULL");
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

/** Total wall-clock play time across finished games for a profile. */
export async function accountPlayStats(accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) {
    return { games: 0, totalMs: 0 };
  }
  const row = await get(
    `SELECT
       COUNT(*) AS games,
       COALESCE(SUM(CASE
         WHEN ended_at > COALESCE(started_at, created_at)
         THEN ${GAME_DURATION_SQL}
         ELSE 0
       END), 0) AS total_ms
     FROM games
     WHERE account_a = ? OR account_b = ?`,
    [id, id],
  );
  return {
    games: Number(row?.games) || 0,
    totalMs: Number(row?.total_ms) || 0,
  };
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
  const opponentIds = [...new Set(
    raw.map((g) => {
      const isA = Number(g.account_a) === id;
      return isA ? g.account_b : g.account_a;
    }).filter((oid) => oid != null),
  )];
  const opponentNames = new Map();
  for (const oid of opponentIds) {
    const opp = await getAccount(oid);
    const snap = raw.find((g) => Number(g.account_a) === oid || Number(g.account_b) === oid);
    const snapshotName = snap
      ? (Number(snap.account_a) === oid ? snap.name_a : snap.name_b)
      : null;
    opponentNames.set(oid, publicDisplayName(opp, { snapshotName }));
  }
  const rows = raw.map((g) => {
    const isA = Number(g.account_a) === id;
    const mmrBefore = isA ? g.mmr_a_before : g.mmr_b_before;
    const mmrAfter = isA ? g.mmr_a_after : g.mmr_b_after;
    const won = isA ? g.winner_side === "player" : g.winner_side === "enemy";
    const opponentAccountId = isA ? g.account_b : g.account_a;
    const snapshotName = isA ? g.name_b : g.name_a;
    return {
      gameId: g.id,
      endedAt: g.ended_at,
      opponentName: opponentAccountId != null
        ? (opponentNames.get(opponentAccountId) || publicDisplayName(null, { snapshotName }))
        : (snapshotName || "Unknown"),
      opponentAccountId,
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
     FROM accounts WHERE deleted_at IS NULL`,
    [since || 0],
  );

  const gamesByMode = await all(
    `SELECT mode, COUNT(*) AS n,
            AVG(${GAME_DURATION_SQL}) AS avg_ms
     FROM games
     WHERE 1=1 ${endedClause}
     GROUP BY mode
     ORDER BY n DESC`,
    sinceParams,
  );

  const durations = await all(
    `SELECT ${GAME_DURATION_SQL} AS ms FROM games
     WHERE ended_at > COALESCE(started_at, created_at) ${endedClause}
     ORDER BY ms`,
    sinceParams,
  );
  const durationMs = durations.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n > 0);
  const medianMs = durationMs.length
    ? durationMs[Math.floor(durationMs.length / 2)]
    : null;
  const totalDurationMs = durationMs.length
    ? durationMs.reduce((a, b) => a + b, 0)
    : 0;
  const durationPct = durationPercentiles(durationMs);

  const sideWins = await all(
    `SELECT winner_side AS side, COUNT(*) AS n FROM games
     WHERE winner_side IS NOT NULL ${endedClause}
     GROUP BY winner_side`,
    sinceParams,
  );

  const outcomeRows = await all(
    `SELECT COALESCE(outcome, 'unknown') AS outcome, COUNT(*) AS n FROM games
     WHERE 1=1 ${endedClause}
     GROUP BY outcome`,
    sinceParams,
  );
  const winReasonRows = await all(
    `SELECT COALESCE(win_reason, 'unknown') AS win_reason, COUNT(*) AS n FROM games
     WHERE 1=1 ${endedClause}
     GROUP BY win_reason`,
    sinceParams,
  );
  const outcomes = {
    completed: 0,
    forfeit: 0,
    admin_cancel: 0,
    unknown: 0,
    byWinReason: {},
    n: 0,
  };
  for (const row of outcomeRows) {
    const key = row.outcome;
    const n = Number(row.n) || 0;
    outcomes.n += n;
    if (key === "completed" || key === "forfeit" || key === "admin_cancel") {
      outcomes[key] += n;
    } else {
      outcomes.unknown += n;
    }
  }
  for (const row of winReasonRows) {
    const key = row.win_reason === "capital" ? "keep" : row.win_reason;
    outcomes.byWinReason[key] = (outcomes.byWinReason[key] || 0) + (Number(row.n) || 0);
  }

  const winByMode = await all(
    `SELECT mode, winner_side AS side, COUNT(*) AS n FROM games
     WHERE winner_side IS NOT NULL ${endedClause}
     GROUP BY mode, winner_side
     ORDER BY mode, side`,
    sinceParams,
  );

  const winByMap = await all(
    `SELECT COALESCE(map_id, 'unknown') AS map_id, winner_side AS side, COUNT(*) AS n
     FROM games
     WHERE winner_side IS NOT NULL ${endedClause}
     GROUP BY COALESCE(map_id, 'unknown'), winner_side
     ORDER BY n DESC`,
    sinceParams,
  );

  const summaryRows = await all(
    `SELECT winner_side, summary_json FROM games
     WHERE summary_json IS NOT NULL ${endedClause}`,
    sinceParams,
  );
  const balanceAgg = aggregateBalanceFromSummaries(summaryRows);

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

  const spendByDay = await all(
    `SELECT date(created_at / 1000, 'unixepoch') AS day,
            COALESCE(SUM(CASE WHEN kind = 'spend' THEN -delta ELSE 0 END), 0) AS spent,
            COALESCE(SUM(CASE WHEN kind = 'charge' THEN -delta ELSE 0 END), 0) AS charged
     FROM ticket_ledger
     WHERE 1=1 ${sinceClause}
     GROUP BY day ORDER BY day`,
    sinceParams,
  );

  const paypalGross = await get(
    `SELECT
       COALESCE(SUM(CASE WHEN credited_at IS NOT NULL THEN CAST(amount_value AS REAL) ELSE 0 END), 0) AS gross,
       COALESCE(SUM(CASE WHEN refunded_at IS NOT NULL THEN CAST(amount_value AS REAL) ELSE 0 END), 0) AS refunds,
       COUNT(DISTINCT CASE WHEN status = 'credited' THEN account_id END) AS paying_accounts,
       COUNT(CASE WHEN credited_at IS NOT NULL THEN 1 END) AS credited_rows
     FROM paypal_purchases
     WHERE 1=1 ${sinceClause}`,
    sinceParams,
  );
  const paypalByPackage = await all(
    `SELECT package_id,
            COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN credited_at IS NOT NULL THEN CAST(amount_value AS REAL) ELSE 0 END), 0) AS gross,
            COALESCE(SUM(CASE WHEN refunded_at IS NOT NULL THEN CAST(amount_value AS REAL) ELSE 0 END), 0) AS refunds
     FROM paypal_purchases
     WHERE 1=1 ${sinceClause}
     GROUP BY package_id
     ORDER BY gross DESC`,
    sinceParams,
  );
  const paypalGrossUsd = Number(paypalGross?.gross) || 0;
  const paypalRefundsUsd = Number(paypalGross?.refunds) || 0;
  const paypalNetUsd = paypalGrossUsd - paypalRefundsUsd;
  const payingAccounts = Number(paypalGross?.paying_accounts) || 0;

  const dayStart = since != null
    ? new Date(since).toISOString().slice(0, 10)
    : null;
  const activity = dayStart
    ? await get(
      `SELECT COUNT(DISTINCT account_id) AS active FROM activity_day WHERE day >= ?`,
      [dayStart],
    )
    : await get("SELECT COUNT(DISTINCT account_id) AS active FROM activity_day");
  const activeInRange = Number(activity?.active) || 0;

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

  const platformActives = await all(
    `SELECT COALESCE(platform, 'unknown') AS platform,
            COUNT(DISTINCT account_id) AS n
     FROM login_events
     WHERE ok = 1 AND account_id IS NOT NULL ${sinceClause}
     GROUP BY COALESCE(platform, 'unknown')
     ORDER BY n DESC`,
    sinceParams,
  );

  const peak = await get(
    `SELECT MAX(sockets) AS peak_sockets, MAX(rooms) AS peak_rooms,
            MAX(sockets_authed) AS peak_authed
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
  const waitRows = await all(
    `SELECT wait_ms AS ms FROM mm_events
     WHERE event = 'paired' AND wait_ms IS NOT NULL AND wait_ms > 0 ${sinceClause}
     ORDER BY wait_ms`,
    sinceParams,
  );
  const waitMs = waitRows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n > 0);
  const waitPct = durationPercentiles(waitMs);

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

  const uniquePlayersPerDay = await all(
    `SELECT day, COUNT(DISTINCT account_id) AS unique_players FROM (
       SELECT date(ended_at / 1000, 'unixepoch') AS day, account_a AS account_id
       FROM games WHERE account_a IS NOT NULL ${endedClause}
       UNION
       SELECT date(ended_at / 1000, 'unixepoch') AS day, account_b AS account_id
       FROM games WHERE account_b IS NOT NULL ${endedClause}
     ) GROUP BY day ORDER BY day`,
    [...sinceParams, ...sinceParams],
  );
  const uniqueByDay = new Map(
    uniquePlayersPerDay.map((r) => [r.day, Number(r.unique_players) || 0]),
  );
  const daily = gamesPerDay.map((r) => ({
    day: r.day,
    games: Number(r.n) || 0,
    uniquePlayers: uniqueByDay.get(r.day) || 0,
  }));

  const playsInRange = await all(
    `SELECT account_id, COUNT(*) AS n FROM (
       SELECT account_a AS account_id FROM games
       WHERE account_a IS NOT NULL ${endedClause}
       UNION ALL
       SELECT account_b AS account_id FROM games
       WHERE account_b IS NOT NULL ${endedClause}
     ) GROUP BY account_id`,
    [...sinceParams, ...sinceParams],
  );
  const matchesPerActive = matchesPerPlayerStats(playsInRange.map((r) => Number(r.n) || 0));

  const lifetimeRows = dayStart
    ? await all(
      `SELECT a.account_id AS id, COALESCE(g.n, 0) AS n
       FROM (SELECT DISTINCT account_id FROM activity_day WHERE day >= ?) a
       LEFT JOIN (
         SELECT account_id, COUNT(*) AS n FROM (
           SELECT account_a AS account_id FROM games WHERE account_a IS NOT NULL
           UNION ALL
           SELECT account_b AS account_id FROM games WHERE account_b IS NOT NULL
         ) GROUP BY account_id
       ) g ON g.account_id = a.account_id`,
      [dayStart],
    )
    : await all(
      `SELECT a.account_id AS id, COALESCE(g.n, 0) AS n
       FROM (SELECT DISTINCT account_id FROM activity_day) a
       LEFT JOIN (
         SELECT account_id, COUNT(*) AS n FROM (
           SELECT account_a AS account_id FROM games WHERE account_a IS NOT NULL
           UNION ALL
           SELECT account_b AS account_id FROM games WHERE account_b IS NOT NULL
         ) GROUP BY account_id
       ) g ON g.account_id = a.account_id`,
    );
  const lifetimeCounts = lifetimeRows.map((r) => Number(r.n) || 0);
  const { funnel, segments } = funnelAndSegments(lifetimeCounts);

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

  const rateOrNull = (num, den) => (den > 0 ? num / den : null);

  return {
    range,
    since,
    trackingNote: "DAU/WAU/MAU are calendar windows (not the range filter). Retention excludes cohorts younger than 30 days. Balance tables need summary_json (new matches only). Platform is unknown until clients send auth.platform. Associations are not causation.",
    accounts: accountTotals,
    activity: {
      activeInRange,
      dau: Number(dau?.n) || 0,
      wau: Number(wau?.n) || 0,
      mau: Number(mau?.n) || 0,
    },
    logins,
    games: {
      byMode: gamesByMode,
      totalDurationMs,
      avgDurationMs: durationMs.length
        ? totalDurationMs / durationMs.length
        : null,
      medianDurationMs: medianMs,
      durationCount: durationMs.length,
      durationPercentiles: durationPct,
      sideWins,
      perDay: gamesPerDay,
      daily,
    },
    engagement: {
      matchesPerActive,
      funnel,
      segments,
      outcomes: {
        ...outcomes,
        completionRate: rateOrNull(outcomes.completed, outcomes.n - outcomes.admin_cancel),
        forfeitRate: rateOrNull(outcomes.forfeit, outcomes.n - outcomes.admin_cancel),
        adminCancelRate: rateOrNull(outcomes.admin_cancel, outcomes.n),
      },
      daily,
    },
    balance: {
      sideWins,
      winByMode,
      winByMap,
      units: balanceAgg.units,
      upgrades: balanceAgg.upgrades,
      withSummary: balanceAgg.withSummary,
      note: "Win rates when a unit/upgrade appears are associational, not causal. n = side-match samples with summary_json.",
    },
    mmrBuckets,
    economy: {
      purchases,
      ledger,
      spendByDay,
      paypal: {
        gross: paypalGrossUsd,
        refunds: paypalRefundsUsd,
        net: paypalNetUsd,
        payingAccounts,
        creditedRows: Number(paypalGross?.credited_rows) || 0,
        byPackage: paypalByPackage,
        conversion: rateOrNull(payingAccounts, activeInRange),
        arpu: rateOrNull(paypalNetUsd, activeInRange),
        arppu: rateOrNull(paypalNetUsd, payingAccounts),
      },
    },
    matchmaking: {
      ...mm,
      waitPercentiles: waitPct,
    },
    peak: {
      peak_sockets: peak?.peak_sockets ?? null,
      peak_rooms: peak?.peak_rooms ?? null,
      peak_authed: peak?.peak_authed ?? null,
    },
    platform: {
      actives: platformActives,
    },
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

export async function listOpenBugsForAccount(accountId) {
  const match = await authorMatch(accountId);
  if (!match) return [];
  return all(
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at, reward_status
     FROM suggestions
     WHERE archived_at IS NULL AND is_bug = 1 AND ${match.sql}
     ORDER BY created_at DESC, id DESC`,
    match.params,
  );
}

export async function deleteOwnBug(accountId, suggestionId) {
  const id = Number(suggestionId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const match = await authorMatch(accountId);
  if (!match) return false;
  const result = await run(
    `UPDATE suggestions SET archived_at = ?
     WHERE id = ? AND archived_at IS NULL AND is_bug = 1 AND ${match.sql}`,
    [Date.now(), id, ...match.params],
  );
  return result.changes > 0;
}

export async function listOpenSuggestionsForAccount(accountId) {
  const match = await authorMatch(accountId);
  if (!match) return [];
  return all(
    `SELECT id, formbar_id, account_id, name, body, is_bug, repro, created_at, archived_at, rewarded_at, reward_status
     FROM suggestions
     WHERE archived_at IS NULL AND is_bug = 0 AND ${match.sql}
     ORDER BY created_at DESC, id DESC`,
    match.params,
  );
}

export async function deleteOwnSuggestion(accountId, suggestionId) {
  const id = Number(suggestionId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const match = await authorMatch(accountId);
  if (!match) return false;
  const result = await run(
    `UPDATE suggestions SET archived_at = ?
     WHERE id = ? AND archived_at IS NULL AND is_bug = 0 AND ${match.sql}`,
    [Date.now(), id, ...match.params],
  );
  return result.changes > 0;
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
