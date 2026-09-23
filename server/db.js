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

export async function initDb() {
  db = open();
  await run("PRAGMA journal_mode = WAL");
  await run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`);
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
export async function ensureUser(session) {
  if (session.userId) {
    const existing = await getUser(session.userId);
    if (existing) return existing;
  }
  const user = await createGuest();
  session.userId = user.id;
  return user;
}
