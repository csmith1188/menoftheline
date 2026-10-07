import assert from "node:assert/strict";
import test from "node:test";

process.env.METRICS = "1";
process.env.METRICS_LOG = "0";
process.env.STATE_MS = "100";
process.env.BOT_COUNTDOWN_MS = "400";
process.env.SKIP_FORMBAR = "1";

const { GameRoom, TICK_MS, stateIntervalMs } = await import("../server/room.js");
const { Matchmaker } = await import("../server/matchmaking.js");
const {
  ensureMetrics,
  noteRoomTick,
  report,
  startMetrics,
  stopMetrics,
} = await import("../server/metrics.js");

function fakeSocket(id) {
  const events = [];
  return {
    connected: true,
    events,
    data: { user: { id, name: id, formbarId: null, mmr: null } },
    request: { session: { save(cb) { if (typeof cb === "function") cb(); } } },
    join() {},
    leave() {},
    disconnect() {},
    emit(event, payload) {
      events.push({ event, payload, volatile: false });
    },
    volatile: {
      emit(event, payload) {
        events.push({ event, payload, volatile: true });
      },
    },
  };
}

function states(socket) {
  return socket.events.filter((event) => event.event === "state");
}

test("metrics count room ticks only when enabled", () => {
  startMetrics({ log: false });
  const before = report().roomTicks;
  noteRoomTick(1.5);
  assert.equal(report().roomTicks, before + 1);
  stopMetrics();
});

test("playing snapshots follow STATE_MS and final outcomes stay reliable", () => {
  ensureMetrics();
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const socket = fakeSocket("solo");
  room.seatHuman("a", socket);
  room.status = "countdown";
  room.beginPlay();
  const opened = states(socket);
  assert.ok(opened.length >= 1);
  assert.equal(opened[opened.length - 1].volatile, false);
  assert.equal(opened[opened.length - 1].payload.status, "playing");

  const before = states(socket).length;
  room.tick();
  assert.equal(states(socket).length, before);
  assert.ok(stateIntervalMs() >= TICK_MS * 2);
  room.tick();
  const periodic = states(socket).at(-1);
  assert.equal(periodic.volatile, true);
  assert.equal(periodic.payload.winner, null);

  room.sim.winner = "enemy";
  room.sim.winReason = "concede";
  room.tick();
  const finalState = states(socket).at(-1);
  assert.equal(finalState.volatile, false);
  assert.equal(finalState.payload.winner, "enemy");
  room.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
});

test("command burst accepts 30 orders and drops the rest and unknown types", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const socket = fakeSocket("orders");
  room.seatHuman("a", socket);
  room.status = "playing";
  for (let i = 0; i < 30; i += 1) {
    room.command(socket, { type: "order", troopId: 1, action: "forward" });
  }
  assert.equal(room.seat.a.queue.length, 30);
  room.command(socket, { type: "order", troopId: 1, action: "forward" });
  room.command(socket, { type: "not-a-command" });
  room.command(socket, null);
  assert.equal(room.seat.a.queue.length, 30);

  room.seat.a.queue = [];
  socket.data.cmdBucket = { tokens: 0, at: Date.now() - 1000 };
  for (let i = 0; i < 25; i += 1) {
    room.command(socket, { type: "order", troopId: 1, action: "back" });
  }
  assert.equal(room.seat.a.queue.length, 20);
  room.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
});

test("user id maps track rooms and queues and not both", async () => {
  const mm = new Matchmaker({});
  const botSocket = fakeSocket("bot-user");
  await mm.startBot(botSocket);
  assert.equal(mm.isBusy("bot-user"), true);
  assert.equal(mm.userQueue.has("bot-user"), false);
  const botRoom = mm.roomForUser("bot-user");
  assert.ok(botRoom);
  botRoom.destroy();
  assert.equal(mm.isBusy("bot-user"), false);
  assert.equal(mm.roomForUser("bot-user"), null);

  const a = fakeSocket("casual-a");
  const b = fakeSocket("casual-b");
  await mm.startCasual(a);
  assert.ok(mm.findQueued("casual-a"));
  assert.equal(mm.roomForUser("casual-a"), null);
  await mm.startCasual(b);
  assert.equal(mm.findQueued("casual-a"), null);
  assert.equal(mm.findQueued("casual-b"), null);
  const roomA = mm.roomForUser("casual-a");
  const roomB = mm.roomForUser("casual-b");
  assert.ok(roomA);
  assert.equal(roomA, roomB);
  assert.equal(mm.userQueue.has("casual-a"), false);
  assert.equal(mm.userRoom.has("casual-a"), true);
  roomA.destroy();
  assert.equal(mm.isBusy("casual-a"), false);
  assert.equal(mm.isBusy("casual-b"), false);
  mm.ticker.stop();
  clearInterval(mm.timer);
});

test("waiting counts are unranked and ranked queue lengths", async () => {
  const mm = new Matchmaker({});
  assert.deepEqual(mm.waitingCounts(), { unranked: 0, ranked: 0 });
  const casual = fakeSocket("wait-casual");
  await mm.startCasual(casual);
  assert.deepEqual(mm.waitingCounts(), { unranked: 1, ranked: 0 });
  const ranked = fakeSocket("wait-ranked");
  ranked.data.user.accountId = null;
  mm.enqueue(mm.ranked, {
    userId: "wait-ranked",
    name: "Ranked",
    mode: "ranked",
    socket: ranked,
  });
  const training = fakeSocket("wait-train");
  await mm.startTrainCasual(training);
  assert.deepEqual(mm.waitingCounts(), { unranked: 1, ranked: 1 });
  await mm.removeQueued(mm.findQueued("wait-casual"));
  await mm.removeQueued(mm.findQueued("wait-ranked"));
  await mm.removeQueued(mm.findQueued("wait-train"));
  mm.ticker.stop();
  clearInterval(mm.timer);
});

test("fog-off public state is the same payload for both seats", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  room.sim.fogEnabled = false;
  room.sim.player.gold += 500;
  room.sim.grantTroop(room.sim.player, "top", "troop");
  room.sim.grantTroop(room.sim.enemy, "bottom", "troop");
  const a = room.publicStateFor(room.seat.a);
  const b = room.publicStateFor(room.seat.b);
  assert.deepEqual(a, b);
  assert.equal(a.sides.player.troops.length, 1);
  assert.equal(a.sides.enemy.troops.length, 1);
  mm.ticker.stop();
  clearInterval(mm.timer);
});
