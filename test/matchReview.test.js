import assert from "node:assert/strict";
import test from "node:test";
import { GameSim } from "../server/sim.js";
import { GameRoom } from "../server/room.js";
import { Matchmaker } from "../server/matchmaking.js";
import { buildMatchSummary } from "../server/matchSummary.js";
import { viewMatchReview } from "../shared/matchReview.js";

test("viewMatchReview swaps sides for seat b perspective", () => {
  const raw = {
    mapId: "classic",
    sides: {
      player: { bought: { troop: 1 }, dmgDealt: 10 },
      enemy: { bought: { cannon: 1 }, dmgDealt: 20 },
    },
  };
  const viewed = viewMatchReview(raw, "enemy");
  assert.equal(viewed.sides.player.dmgDealt, 20);
  assert.equal(viewed.sides.enemy.dmgDealt, 10);
  assert.equal(viewMatchReview(raw, "player").sides.player.dmgDealt, 10);
});

test("public state includes matchReview after a win", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "bot");
  room.status = "countdown";
  room.beginPlay();
  room.sim.player.bought = { troop: 2 };
  room.sim.player.dmgDealt = 30;
  room.sim.player.dmgDealtByType = { troop: 30 };
  room.sim.winner = "player";
  room.sim.winReason = "keep";
  const seat = room.seat.a;
  seat.userId = "u1";
  seat.name = "Alice";
  const snap = room.publicStateFor(seat);
  assert.ok(snap.matchReview);
  assert.equal(snap.matchReview.mapId, room.sim.mapId);
  assert.equal(snap.matchReview.sides.player.bought.troop, 2);
  assert.equal(snap.matchReview.sides.player.dmgDealt, 30);
  const built = buildMatchSummary(room.sim);
  assert.deepEqual(snap.matchReview.sides.player.bought, built.sides.player.bought);
  room.destroy();
});

test("buildMatchSummary matches GameSim counters", () => {
  const sim = new GameSim();
  sim.enemy.bought = { skirmisher: 1 };
  sim.enemy.kills = 2;
  sim.enemy.killsByType = { skirmisher: 2 };
  const summary = buildMatchSummary(sim);
  assert.equal(summary.sides.enemy.bought.skirmisher, 1);
  assert.equal(summary.sides.enemy.kills, 2);
});
