import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-rank-job-"));
process.env.DATA_DIR = dataDir;
process.env.PLACEMENT_MATCHES = "10";
process.env.RANK_SMALL_POP = "100";
process.env.RANK_ACTIVE_DAYS = "30";

const {
  initDb,
  createLocalAccount,
  getAccount,
  recordMatchResult,
  claimOfficerRankJob,
  finishOfficerRankJob,
  listEligibleRankedAccounts,
  rankedDossier,
  setAccountRankedState,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const { runOfficerRankJob, utcDayKey } = await import("../server/rankJob.js");

await initDb();

let seq = 0;
async function makeAccount(name, { mmr = 1000 } = {}) {
  seq += 1;
  const account = await createLocalAccount({
    email: `rank${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
  if (mmr !== 1000) {
    return setAccountRankedState(account.id, { mmr });
  }
  return getAccount(account.id);
}

async function finishRanked(a, b, { winnerSide = "player", endedAt = Date.now() } = {}) {
  const id = `g-${a.id}-${b.id}-${endedAt}-${Math.random().toString(16).slice(2)}`;
  await recordMatchResult({
    ranked: [
      { accountId: a.id, mmrBefore: a.mmr, score: winnerSide === "player" ? 1 : 0 },
      { accountId: b.id, mmrBefore: b.mmr, score: winnerSide === "enemy" ? 1 : 0 },
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
      mmrABefore: a.mmr,
      mmrBBefore: b.mmr,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt: endedAt - 60_000,
      endedAt,
      winReason: "keep",
      outcome: "completed",
    },
  });
  return {
    a: await getAccount(a.id),
    b: await getAccount(b.id),
  };
}

test("placements hide MMR until threshold; casual does not count", async () => {
  let a = await makeAccount("PlaceA");
  let b = await makeAccount("PlaceB");
  assert.equal(rankedDossier(a).mmrHidden, true);
  assert.match(rankedDossier(a).placementProgress.label, /0\/10/);

  await recordMatchResult({
    ranked: null,
    game: {
      id: `casual-${a.id}`,
      mode: "casual",
      playerA: `u${a.id}`,
      playerB: `u${b.id}`,
      nameA: a.name,
      nameB: b.name,
      formbarA: null,
      formbarB: null,
      accountA: a.id,
      accountB: b.id,
      winnerSide: "player",
      mmrABefore: null,
      mmrBBefore: null,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt: Date.now(),
      endedAt: Date.now(),
      winReason: "keep",
      outcome: "completed",
    },
  });
  a = await getAccount(a.id);
  assert.equal(a.ranked_games, 0);
  assert.equal(a.mmr, 1000);

  for (let i = 0; i < 10; i += 1) {
    ({ a, b } = await finishRanked(a, b, {
      winnerSide: i % 2 === 0 ? "player" : "enemy",
      endedAt: Date.now() + i,
    }));
  }
  assert.equal(a.placements_done, 1);
  assert.equal(rankedDossier(a).mmrHidden, false);
  assert.ok(a.ranked_games >= 10);
});

test("duplicate recordMatchResult does not double W/L", async () => {
  let a = await makeAccount("DupA");
  let b = await makeAccount("DupB");
  const endedAt = Date.now();
  const payload = {
    ranked: [
      { accountId: a.id, mmrBefore: 1000, score: 1 },
      { accountId: b.id, mmrBefore: 1000, score: 0 },
    ],
    game: {
      id: `dup-${a.id}`,
      mode: "ranked",
      playerA: `u${a.id}`,
      playerB: `u${b.id}`,
      nameA: a.name,
      nameB: b.name,
      formbarA: null,
      formbarB: null,
      accountA: a.id,
      accountB: b.id,
      winnerSide: "player",
      mmrABefore: 1000,
      mmrBBefore: 1000,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt: endedAt,
      endedAt,
      winReason: "keep",
      outcome: "completed",
    },
  };
  const first = await recordMatchResult(payload);
  const second = await recordMatchResult(payload);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  a = await getAccount(a.id);
  assert.equal(a.wins, 1);
  assert.equal(a.ranked_games, 1);
});

test("job lease allows only one successful day run", async () => {
  const day = utcDayKey();
  const claimed1 = await claimOfficerRankJob(day, "w0:1");
  assert.equal(claimed1, true);
  await finishOfficerRankJob(day, "w0:1", true);
  const claimed2 = await claimOfficerRankJob(day, "w0:2");
  assert.equal(claimed2, false);
});

test("daily job assigns small-pop ranks and clears inactive percentile", async () => {
  // Unique day key so lease from prior test does not block
  const day = "2099-01-02";
  const now = Date.now();
  // Isolate eligibility to only these accounts (prior tests leave placed actives).
  const prior = await listEligibleRankedAccounts(now - 30 * 24 * 60 * 60 * 1000);
  for (const row of prior) {
    await setAccountRankedState(row.id, {
      lastRankedAt: now - 40 * 24 * 60 * 60 * 1000,
    });
  }

  const players = [];
  for (let i = 0; i < 4; i += 1) {
    players.push(await makeAccount(`Off${i}`, { mmr: 1400 - i * 50 }));
  }
  for (const p of players) {
    await setAccountRankedState(p.id, {
      placementsDone: 1,
      rankedGames: 10,
      lastRankedAt: now,
      wins: 5,
      losses: 5,
    });
  }
  const inactive = await makeAccount("Inactive", { mmr: 2000 });
  await setAccountRankedState(inactive.id, {
    placementsDone: 1,
    rankedGames: 20,
    lastRankedAt: now - 40 * 24 * 60 * 60 * 1000,
    rankPercentile: 99,
    officerRank: "general",
    highestRank: "general",
  });

  const eligible = await listEligibleRankedAccounts(now - 30 * 24 * 60 * 60 * 1000);
  assert.equal(eligible.length, 4);
  assert.ok(!eligible.some((r) => r.id === inactive.id));

  const result = await runOfficerRankJob(day);
  assert.equal(result.ok, true);

  const top = await getAccount(players[0].id);
  const bottom = await getAccount(players[3].id);
  assert.equal(top.officer_rank, "colonel");
  assert.equal(bottom.officer_rank, "major");
  assert.ok(top.rank_percentile != null);

  const inactiveAfter = await getAccount(inactive.id);
  assert.equal(inactiveAfter.officer_rank, "general");
  assert.equal(inactiveAfter.rank_percentile, null);
  assert.equal(inactiveAfter.mmr, 2000);
});
