import assert from "node:assert/strict";
import test from "node:test";
import { allowedMmrSpread, nextMmr, pickRankedPair } from "../server/rating.js";
import { resolveEloK } from "../server/db.js";

test("nextMmr moves winner up and loser down symmetrically at equal rating", () => {
  const win = nextMmr(1000, 1000, 1, 32);
  const loss = nextMmr(1000, 1000, 0, 32);
  assert.equal(win, 1016);
  assert.equal(loss, 984);
});

test("nextMmr floors at 0", () => {
  assert.equal(nextMmr(10, 10, 0, 32), 0);
});

test("resolveEloK uses provisional then soft rematch K", () => {
  assert.equal(resolveEloK({ placementsDone: false, rematchCountInWindow: 0 }), 48);
  assert.equal(resolveEloK({ placementsDone: true, rematchCountInWindow: 0 }), 32);
  assert.equal(resolveEloK({ placementsDone: true, rematchCountInWindow: 2 }), 16);
  assert.equal(resolveEloK({ placementsDone: false, rematchCountInWindow: 5 }), 16);
});

test("allowedMmrSpread expands with wait up to cap", () => {
  assert.equal(allowedMmrSpread(0, { maxSpread: 200, expandPerMs: 0.003333, expandCap: 800 }), 200);
  const afterMin = allowedMmrSpread(60_000, { maxSpread: 200, expandPerMs: 0.003333, expandCap: 800 });
  assert.ok(afterMin > 200);
  assert.ok(afterMin <= 800);
  assert.equal(
    allowedMmrSpread(1_000_000, { maxSpread: 200, expandPerMs: 0.003333, expandCap: 800 }),
    800,
  );
});

test("pickRankedPair prefers close MMR inside expanding window", () => {
  const now = 1_000_000;
  const entries = [
    { mmr: 1000, joinedAt: now - 1000, accountId: 1 },
    { mmr: 1010, joinedAt: now - 1000, accountId: 2 },
    { mmr: 1400, joinedAt: now - 1000, accountId: 3 },
  ];
  const pair = pickRankedPair(entries, now, { maxSpread: 200, waitMs: 60_000 });
  assert.ok(pair);
  assert.equal(pair.spread, 10);
  assert.equal(pair.a.accountId + pair.b.accountId, 3);
});

test("pickRankedPair deprioritizes rematches until long wait", () => {
  const now = 1_000_000;
  const entries = [
    { mmr: 1000, joinedAt: now - 5_000, accountId: 1, recentOpponentIds: new Set([2]) },
    { mmr: 1005, joinedAt: now - 5_000, accountId: 2, recentOpponentIds: new Set([1]) },
    { mmr: 1020, joinedAt: now - 5_000, accountId: 3 },
  ];
  const early = pickRankedPair(entries, now, { maxSpread: 200, waitMs: 60_000 });
  assert.ok(early);
  assert.ok(
    (early.a.accountId === 1 && early.b.accountId === 3)
    || (early.a.accountId === 3 && early.b.accountId === 1)
    || (early.a.accountId === 2 && early.b.accountId === 3)
    || (early.a.accountId === 3 && early.b.accountId === 2),
  );

  const lateEntries = [
    { mmr: 1000, joinedAt: now - 70_000, accountId: 1, recentOpponentIds: new Set([2]) },
    { mmr: 1005, joinedAt: now - 70_000, accountId: 2, recentOpponentIds: new Set([1]) },
  ];
  const late = pickRankedPair(lateEntries, now, { maxSpread: 200, waitMs: 60_000 });
  assert.ok(late);
  assert.equal(Math.abs(late.a.accountId - late.b.accountId), 1);
});
