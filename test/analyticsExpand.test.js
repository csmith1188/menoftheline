import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-analytics-"));
process.env.DATA_DIR = dataDir;

const {
  initDb,
  createLocalAccount,
  getAccount,
  recordMatchResult,
  analyticsSnapshot,
  recordMmEvent,
  recordOpsSample,
  touchAccountLogin,
  createPaypalPurchase,
  markPaypalPurchaseCaptured,
  creditPaypalPurchase,
  clawbackPaypalPurchase,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const {
  percentileSorted,
  matchesPerPlayerStats,
  funnelAndSegments,
  aggregateBalanceFromSummaries,
  durationPercentiles,
} = await import("../server/analyticsMetrics.js");
const {
  outcomeFromWinReason,
  normalizeClientPlatform,
  buildMatchSummary,
} = await import("../server/matchSummary.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  const account = await createLocalAccount({
    email: `an${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
  return getAccount(account.id);
}

async function recordGame(opts) {
  const {
    id,
    a,
    b = null,
    createdAt,
    startedAt,
    endedAt,
    mode = "bot",
    outcome = "completed",
    winReason = "capital",
    winnerSide = "player",
    mapId = null,
    summaryJson = null,
  } = opts;
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
      winnerSide,
      mmrABefore: null,
      mmrBBefore: null,
      mmrAAfter: null,
      mmrBAfter: null,
      createdAt,
      startedAt: startedAt ?? createdAt,
      endedAt,
      winReason,
      outcome,
      mapId,
      summaryJson,
      chatJson: null,
    },
  });
}

test("percentileSorted and matchesPerPlayerStats", () => {
  assert.equal(percentileSorted([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentileSorted([], 50), null);
  const stats = matchesPerPlayerStats([1, 1, 3, 10]);
  assert.equal(stats.n, 4);
  assert.equal(stats.median, 1);
  assert.ok(stats.avg > 3);
  assert.equal(stats.buckets[0].n, 2);
  assert.equal(stats.buckets[3].n, 1);
});

test("funnelAndSegments and outcome helpers", () => {
  const { funnel, segments } = funnelAndSegments([0, 1, 2, 5, 12]);
  assert.equal(funnel.g1, 4);
  assert.equal(funnel.g2, 3);
  assert.equal(funnel.g5, 2);
  assert.equal(segments.oneTime, 1);
  assert.equal(segments.occasional, 2);
  assert.equal(segments.regular, 1);
  assert.equal(segments.zeroGames, 1);
  assert.equal(outcomeFromWinReason("disconnect"), "forfeit");
  assert.equal(outcomeFromWinReason("capital"), "completed");
  assert.equal(normalizeClientPlatform("Android"), "android");
});

test("aggregateBalanceFromSummaries counts unit wins with sample size", () => {
  const summary = JSON.stringify({
    mapId: "classic",
    sides: {
      player: {
        bought: { troop: 2 },
        survived: { troop: 1 },
        upgrades: { speed: 1, armor: 0, damage: 0 },
        dmgDealtByType: { troop: 40 },
        dmgTakenByType: { troop: 10 },
        killsByType: { troop: 1 },
      },
      enemy: {
        bought: { cannon: 1 },
        survived: {},
        upgrades: { speed: 0, armor: 0, damage: 0 },
        dmgDealtByType: {},
        dmgTakenByType: {},
        killsByType: {},
      },
    },
  });
  const agg = aggregateBalanceFromSummaries([
    { winner_side: "player", summary_json: summary },
  ]);
  assert.equal(agg.withSummary, 1);
  const troop = agg.units.find((u) => u.type === "troop");
  assert.ok(troop);
  assert.equal(troop.n, 1);
  assert.equal(troop.wins, 1);
  assert.equal(troop.winRate, 1);
  assert.ok(agg.upgrades.some((u) => u.kind === "speed" && u.wins === 1));
});

test("analyticsSnapshot engagement outcomes and duration percentiles", async () => {
  const a = await makeAccount("EngA");
  const b = await makeAccount("EngB");
  const t0 = Date.now();
  await touchAccountLogin(a.id, "local", "web");
  await touchAccountLogin(b.id, "local", "electron");
  await recordGame({
    id: `ae-c-${a.id}`,
    a,
    b,
    createdAt: t0 - 120_000,
    startedAt: t0 - 100_000,
    endedAt: t0 - 40_000,
    outcome: "completed",
    winReason: "capital",
    mapId: "classic",
  });
  await recordGame({
    id: `ae-f-${a.id}`,
    a,
    b,
    createdAt: t0 - 80_000,
    startedAt: t0 - 70_000,
    endedAt: t0 - 10_000,
    outcome: "forfeit",
    winReason: "disconnect",
    winnerSide: "enemy",
  });
  await recordMmEvent({
    event: "paired",
    mode: "ranked",
    accountId: a.id,
    waitMs: 5_000,
  });
  await recordMmEvent({
    event: "paired",
    mode: "ranked",
    accountId: b.id,
    waitMs: 15_000,
  });
  await recordOpsSample({ rooms: 2, sockets: 10, socketsAuthed: 4 });

  const snap = await analyticsSnapshot("all");
  assert.ok(snap.engagement.outcomes.n >= 2);
  assert.ok(snap.engagement.outcomes.completed >= 1);
  assert.ok(snap.engagement.outcomes.forfeit >= 1);
  assert.ok(snap.engagement.outcomes.byWinReason.disconnect >= 1);
  assert.ok(snap.games.durationPercentiles.n >= 2);
  assert.ok(snap.matchmaking.waitPercentiles.n >= 2);
  assert.ok(snap.engagement.funnel.n >= 2);
  assert.ok(snap.peak.peak_authed === 4 || snap.peak.peak_sockets === 10);
  assert.ok((snap.platform.actives || []).length >= 1);
  assert.ok((snap.balance.winByMap || []).some((r) => r.map_id === "classic"));
});

test("analyticsSnapshot paypal gross net and package breakdown", async () => {
  const a = await makeAccount("PayA");
  await touchAccountLogin(a.id, "local", "web");
  const purchase = await createPaypalPurchase({
    accountId: a.id,
    packageId: "pack_5",
    amountValue: "5.00",
    currency: "USD",
    tickets: 20,
    paypalOrderId: `order-${a.id}`,
  });
  await markPaypalPurchaseCaptured(purchase.id, `cap-${a.id}`);
  const credit = await creditPaypalPurchase(purchase.id);
  assert.equal(credit.ok, true);
  assert.equal(credit.credited, true);

  const refunded = await createPaypalPurchase({
    accountId: a.id,
    packageId: "pack_20",
    amountValue: "20.00",
    currency: "USD",
    tickets: 100,
    paypalOrderId: `order-ref-${a.id}`,
  });
  await markPaypalPurchaseCaptured(refunded.id, `cap-ref-${a.id}`);
  await creditPaypalPurchase(refunded.id);
  await clawbackPaypalPurchase(refunded.id, { status: "refunded", reason: "test" });

  const snap = await analyticsSnapshot("all");
  assert.ok(snap.economy.paypal.gross >= 5);
  assert.ok(snap.economy.paypal.refunds >= 20);
  assert.ok(snap.economy.paypal.payingAccounts >= 1);
  assert.ok((snap.economy.paypal.byPackage || []).length >= 1);
  assert.ok(Number.isFinite(snap.economy.paypal.net));
});

test("durationPercentiles empty is nulls not zeros", () => {
  const empty = durationPercentiles([]);
  assert.equal(empty.p50, null);
  assert.equal(empty.n, 0);
});

test("buildMatchSummary reads side bought and combat counters", async () => {
  const { GameSim } = await import("../server/sim.js");
  const sim = new GameSim();
  sim.player.bought = { troop: 2 };
  sim.player.dmgDealt = 12;
  sim.player.dmgDealtByType = { troop: 12 };
  sim.player.kills = 1;
  sim.player.killsByType = { troop: 1 };
  sim.player.upgrades.speed = 1;
  const summary = buildMatchSummary(sim);
  assert.equal(summary.mapId, sim.mapId);
  assert.equal(summary.sides.player.bought.troop, 2);
  assert.equal(summary.sides.player.dmgDealt, 12);
  assert.equal(summary.sides.player.upgrades.speed, 1);
});

test("summary_json persisted on recordMatchResult", async () => {
  const a = await makeAccount("SumA");
  const t0 = Date.now();
  const summaryJson = JSON.stringify({
    mapId: "classic",
    sides: {
      player: {
        bought: { troop: 1 },
        survived: { troop: 1 },
        upgrades: { speed: 0, armor: 0, damage: 0 },
        dmgDealtByType: { troop: 5 },
        dmgTakenByType: {},
        killsByType: {},
      },
      enemy: {
        bought: {},
        survived: {},
        upgrades: { speed: 0, armor: 0, damage: 0 },
        dmgDealtByType: {},
        dmgTakenByType: {},
        killsByType: {},
      },
    },
  });
  await recordGame({
    id: `sum-${a.id}`,
    a,
    createdAt: t0 - 60_000,
    endedAt: t0,
    mapId: "classic",
    summaryJson,
  });
  const snap = await analyticsSnapshot("all");
  assert.ok(snap.balance.withSummary >= 1);
  assert.ok(snap.balance.units.some((u) => u.type === "troop"));
});
