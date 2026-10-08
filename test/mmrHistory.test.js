import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-mmr-history-"));
process.env.DATA_DIR = dataDir;

const {
  initDb,
  createLocalAccount,
  getAccount,
  recordMatchResult,
  listAccountMmrHistory,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  const account = await createLocalAccount({
    email: `mmr${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
  return getAccount(account.id);
}

async function recordRanked({
  id,
  a,
  b,
  winnerSide,
  mmrABefore,
  mmrBBefore,
  mmrAAfter,
  mmrBAfter,
  endedAt,
}) {
  await recordMatchResult({
    ranked: [
      { accountId: a.id, mmr: mmrAAfter, won: winnerSide === "player" },
      { accountId: b.id, mmr: mmrBAfter, won: winnerSide === "enemy" },
    ],
    game: {
      id,
      mode: "ranked",
      playerA: `u${a.id}`,
      playerB: `u${b.id}`,
      nameA: a.name,
      nameB: b.name,
      formbarA: null,
      formbarB: null,
      accountA: a.id,
      accountB: b.id,
      winnerSide,
      mmrABefore,
      mmrBBefore,
      mmrAAfter,
      mmrBAfter,
      createdAt: endedAt - 60_000,
      endedAt,
      winReason: "capital",
      outcome: "completed",
      chatJson: null,
    },
  });
}

test("listAccountMmrHistory returns seat-centric deltas newest first", async () => {
  const a = await makeAccount("Alpha");
  const b = await makeAccount("Beta");
  const t0 = Date.now();
  await recordRanked({
    id: `g-old-${a.id}`,
    a,
    b,
    winnerSide: "player",
    mmrABefore: 1000,
    mmrBBefore: 1000,
    mmrAAfter: 1016,
    mmrBAfter: 984,
    endedAt: t0 - 10_000,
  });
  await recordRanked({
    id: `g-new-${a.id}`,
    a: await getAccount(a.id),
    b: await getAccount(b.id),
    winnerSide: "enemy",
    mmrABefore: 1016,
    mmrBBefore: 984,
    mmrAAfter: 1000,
    mmrBAfter: 1000,
    endedAt: t0,
  });

  const hist = await listAccountMmrHistory(a.id, { page: 1, pageSize: 20 });
  assert.equal(hist.total, 2);
  assert.equal(hist.rows.length, 2);
  assert.equal(hist.rows[0].opponentName, "Beta");
  assert.equal(hist.rows[0].opponentAccountId, b.id);
  assert.equal(hist.rows[0].won, false);
  assert.equal(hist.rows[0].delta, -16);
  assert.equal(hist.rows[0].mmrAfter, 1000);
  assert.equal(hist.rows[1].won, true);
  assert.equal(hist.rows[1].delta, 16);
  assert.equal(hist.rows[1].mmrAfter, 1016);

  const bHist = await listAccountMmrHistory(b.id, { page: 1, pageSize: 20 });
  assert.equal(bHist.rows[0].won, true);
  assert.equal(bHist.rows[0].delta, 16);
  assert.equal(bHist.rows[0].opponentName, "Alpha");
});

test("listAccountMmrHistory paginates and skips non-ranked / null after", async () => {
  const a = await makeAccount("Pager");
  const b = await makeAccount("Rival");
  const t0 = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await recordRanked({
      id: `page-${a.id}-${i}`,
      a,
      b,
      winnerSide: i % 2 === 0 ? "player" : "enemy",
      mmrABefore: 1000 + i,
      mmrBBefore: 1000 - i,
      mmrAAfter: 1000 + i + 1,
      mmrBAfter: 1000 - i - 1,
      endedAt: t0 + i * 1000,
    });
  }
  await recordMatchResult({
    ranked: null,
    game: {
      id: `bot-${a.id}`,
      mode: "bot",
      playerA: `u${a.id}`,
      playerB: "bot",
      nameA: a.name,
      nameB: "Bot",
      formbarA: null,
      formbarB: null,
      accountA: a.id,
      accountB: null,
      winnerSide: "player",
      mmrABefore: 1000,
      mmrBBefore: null,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt: t0,
      endedAt: t0 + 50_000,
      winReason: "capital",
      outcome: "completed",
      chatJson: null,
    },
  });

  const page1 = await listAccountMmrHistory(a.id, { page: 1, pageSize: 2 });
  assert.equal(page1.total, 3);
  assert.equal(page1.page, 1);
  assert.equal(page1.pageSize, 2);
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.rows[0].gameId, `page-${a.id}-2`);

  const page2 = await listAccountMmrHistory(a.id, { page: 2, pageSize: 2 });
  assert.equal(page2.page, 2);
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.rows[0].gameId, `page-${a.id}-0`);
});
