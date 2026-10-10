import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-play-time-"));
process.env.DATA_DIR = dataDir;

const {
  initDb,
  createLocalAccount,
  getAccount,
  recordMatchResult,
  accountPlayStats,
  analyticsSnapshot,
  formatPlayDuration,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  const account = await createLocalAccount({
    email: `play${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
  return getAccount(account.id);
}

async function recordGame({
  id,
  a,
  b = null,
  createdAt,
  startedAt,
  endedAt,
  mode = "bot",
}) {
  await recordMatchResult({
    ranked: null,
    game: {
      id,
      mode,
      playerA: `u${a.id}`,
      playerB: b ? `u${b.id}` : "bot",
      nameA: a.name,
      nameB: b ? b.name : "Bot",
      formbarA: null,
      formbarB: null,
      accountA: a.id,
      accountB: b ? b.id : null,
      winnerSide: "player",
      mmrABefore: null,
      mmrBBefore: null,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt,
      startedAt,
      endedAt,
      winReason: "keep",
      outcome: "completed",
      chatJson: null,
    },
  });
}

test("formatPlayDuration formats hours and minutes", () => {
  assert.equal(formatPlayDuration(45_000), "45s");
  assert.equal(formatPlayDuration(90_000), "1m");
  assert.equal(formatPlayDuration(3_720_000), "1h 2m");
  assert.equal(formatPlayDuration(0), "0m");
});

test("accountPlayStats sums play durations using started_at", async () => {
  const a = await makeAccount("Timer");
  const t0 = Date.now();
  await recordGame({
    id: `pt-a-${a.id}`,
    a,
    createdAt: t0 - 120_000,
    startedAt: t0 - 60_000,
    endedAt: t0,
  });
  await recordGame({
    id: `pt-b-${a.id}`,
    a,
    createdAt: t0 - 200_000,
    startedAt: t0 - 30_000,
    endedAt: t0,
  });

  const stats = await accountPlayStats(a.id);
  assert.equal(stats.games, 2);
  assert.equal(stats.totalMs, 90_000);
});

test("analyticsSnapshot reports total and average duration", async () => {
  const a = await makeAccount("Anal");
  const t0 = Date.now();
  await recordGame({
    id: `an-a-${a.id}`,
    a,
    createdAt: t0 - 10_000,
    startedAt: t0 - 10_000,
    endedAt: t0,
    mode: "casual",
  });
  await recordGame({
    id: `an-b-${a.id}`,
    a,
    createdAt: t0 - 30_000,
    startedAt: t0 - 30_000,
    endedAt: t0,
    mode: "casual",
  });

  const snap = await analyticsSnapshot("all");
  assert.ok(snap.games.totalDurationMs >= 40_000);
  assert.ok(snap.games.avgDurationMs != null);
  assert.ok(snap.games.avgDurationMs >= 10_000);
});
