import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_RANK_BANDS,
  SMALL_POP_RANK_BANDS,
  assignOfficerRanks,
  bandsForPopulation,
  isHigherRank,
  isProvisional,
  placementProgress,
  rankOfIndex,
  percentileOfIndex,
} from "../shared/ranks.js";

test("placementProgress tracks commission pending", () => {
  const p = placementProgress(6, 10);
  assert.equal(p.done, false);
  assert.equal(p.current, 6);
  assert.equal(p.total, 10);
  assert.match(p.label, /6\/10/);
  assert.equal(placementProgress(10, 10).done, true);
  assert.equal(isProvisional(false), true);
  assert.equal(isProvisional(true), false);
});

test("rankOfIndex covers full bands and tail", () => {
  const n = 100;
  assert.equal(rankOfIndex(0, n, FULL_RANK_BANDS), "general");
  assert.equal(rankOfIndex(n - 1, n, FULL_RANK_BANDS), "ensign");
  // Every index maps to some band
  for (let i = 0; i < n; i += 1) {
    assert.ok(rankOfIndex(i, n, FULL_RANK_BANDS));
  }
});

test("small population uses Major / Lt Col / Colonel", () => {
  assert.equal(bandsForPopulation(50, 100), SMALL_POP_RANK_BANDS);
  assert.equal(bandsForPopulation(100, 100), FULL_RANK_BANDS);
  const n = 4;
  const ranks = [0, 1, 2, 3].map((i) => rankOfIndex(i, n, SMALL_POP_RANK_BANDS));
  assert.ok(ranks.includes("colonel"));
  assert.ok(ranks.includes("major"));
  assert.ok(ranks.every((r) => ["colonel", "lieutenant_colonel", "major"].includes(r)));
});

test("assignOfficerRanks is deterministic with ties broken by input order", () => {
  const sorted = [
    { id: 1, mmr: 1200, officerRank: "ensign", highestRank: "ensign" },
    { id: 2, mmr: 1100, officerRank: "ensign", highestRank: "ensign" },
    { id: 3, mmr: 1000, officerRank: "ensign", highestRank: "ensign" },
    { id: 4, mmr: 900, officerRank: "ensign", highestRank: "ensign" },
  ];
  const a = assignOfficerRanks(sorted, { smallPop: 100 });
  const b = assignOfficerRanks(sorted, { smallPop: 100 });
  assert.deepEqual(a.map((r) => r.officerRank), b.map((r) => r.officerRank));
  assert.equal(a[0].officerRank, "colonel");
  assert.equal(a[a.length - 1].officerRank, "major");
  assert.ok(isHigherRank(a[0].officerRank, a[a.length - 1].officerRank));
});

test("highest rank is monotonic in assignOfficerRanks", () => {
  const sorted = [
    { id: 1, mmr: 1500, officerRank: "major", highestRank: "colonel" },
  ];
  const [row] = assignOfficerRanks(sorted, { smallPop: 100 });
  assert.equal(row.highestRank, "colonel");
});

test("percentileOfIndex extremes", () => {
  assert.equal(percentileOfIndex(0, 1), 100);
  assert.equal(percentileOfIndex(0, 11), 100);
  assert.equal(percentileOfIndex(10, 11), 0);
});
