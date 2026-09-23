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
  await run("UPDATE accounts SET held = 0");
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
