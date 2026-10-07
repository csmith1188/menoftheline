import assert from "node:assert/strict";
import test from "node:test";

process.env.SKIP_FORMBAR = "1";
process.env.MATCH_CHAT = "1";
process.env.UNPAUSE_MS = "60000";
process.env.DISCONNECT_GRACE_MS = "30";
process.env.RECONNECT_WAIT_MS = "40";

const {
  GameRoom,
  UNPAUSE_MS,
  DISCONNECT_GRACE_MS,
  RECONNECT_WAIT_MS,
} = await import("../server/room.js");
const { Matchmaker } = await import("../server/matchmaking.js");
const { CONFIG } = await import("../shared/config.js");

function fakeSocket(id, name = id, accountId = null) {
  const events = [];
  return {
    connected: true,
    events,
    data: {
      user: {
        id,
        name,
        formbarId: null,
        mmr: null,
        accountId,
      },
    },
    request: { session: { save(cb) { if (typeof cb === "function") cb(); } } },
    join() {},
    leave() {},
    disconnect() {},
    emit(event, payload) {
      events.push({ event, payload });
    },
    volatile: {
      emit(event, payload) {
        events.push({ event, payload, volatile: true });
      },
    },
  };
}

function loggedInPair() {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("a", "Alice", 1);
  const b = fakeSocket("b", "Bob", 2);
  room.seatHuman("a", a);
  room.seatHuman("b", b);
  room.status = "playing";
  room.playSnapshotSent = true;
  return { mm, room, a, b };
}

function botGame() {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "bot");
  const a = fakeSocket("a", "Alice", 1);
  room.seatHuman("a", a);
  room.seatBot("b");
  room.status = "playing";
  room.playSnapshotSent = true;
  return { mm, room, a };
}

function cleanup(mm, room) {
  room.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
}

function chatTexts(socket) {
  return socket.events
    .filter((event) => event.event === "chat")
    .map((event) => event.payload.text);
}

test("pause request posts chat and alerts the other seat", () => {
  const { mm, room, a, b } = loggedInPair();
  a.events.length = 0;
  b.events.length = 0;

  room.pause(a);
  assert.equal(room.paused, false);
  assert.equal(room.pauseWant.a, true);
  assert.equal(room.pauseAlertSeat, "b");
  assert.ok(chatTexts(b).some((text) => text.includes("requested a pause")));
  assert.equal(room.lobbyFor(room.seat.b).pauseAlert, true);
  assert.equal(room.lobbyFor(room.seat.a).pauseAlert, false);
  assert.equal(room.lobbyFor(room.seat.a).pauseWant, true);

  cleanup(mm, room);
});

test("both pause votes freeze the match", () => {
  const { mm, room, a, b } = loggedInPair();
  const goldBefore = room.sim.player.gold;

  room.pause(a);
  room.pause(b);
  assert.equal(room.paused, true);
  assert.equal(room.pauseAlertSeat, null);
  assert.equal(room.simFrozen(), true);

  room.command(a, { type: "bank" });
  room.tick();
  assert.equal(room.sim.player.gold, goldBefore);
  assert.equal(room.lobbyFor(room.seat.a).paused, true);

  cleanup(mm, room);
});

test("cancel solo pause request clears the alert", () => {
  const { mm, room, a, b } = loggedInPair();
  room.pause(a);
  room.pause(a);
  assert.equal(room.pauseWant.a, false);
  assert.equal(room.pauseAlertSeat, null);
  assert.equal(room.lobbyFor(room.seat.b).pauseAlert, false);
  assert.ok(chatTexts(b).some((text) => text.includes("cancelled")));

  cleanup(mm, room);
});

test("pauseSeen clears the red chat alert", () => {
  const { mm, room, a, b } = loggedInPair();
  room.pause(a);
  assert.equal(room.pauseAlertSeat, "b");
  room.pauseSeen(b);
  assert.equal(room.pauseAlertSeat, null);
  assert.equal(room.pauseWant.a, true);

  cleanup(mm, room);
});

test("unpause starts a countdown and resumes when both vote", () => {
  const { mm, room, a, b } = loggedInPair();
  room.pause(a);
  room.pause(b);
  assert.equal(room.paused, true);

  room.pause(a);
  assert.ok(room.unpauseEnds);
  assert.equal(room.unpauseWant.a, true);
  assert.equal(room.unpauseWant.b, false);
  const left = room.unpauseLeftMs();
  assert.ok(left > UNPAUSE_MS - 2000);
  assert.ok(left <= UNPAUSE_MS);

  room.pause(b);
  assert.equal(room.paused, false);
  assert.equal(room.unpauseEnds, null);
  assert.equal(room.simFrozen(), false);

  cleanup(mm, room);
});

test("unpause countdown timer resumes the match", async () => {
  const { mm, room, a, b } = loggedInPair();
  room.pause(a);
  room.pause(b);
  room.cancelUnpauseCountdown();
  room.unpauseEnds = Date.now() + 20;
  room.unpauseWant.a = true;
  room.unpauseTimer = setTimeout(() => room.resumePlay(), 20);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.paused, false);
  assert.equal(room.unpauseEnds, null);

  cleanup(mm, room);
});

test("bot settingsOpen freezes and thaws the sim", () => {
  const { mm, room, a } = botGame();
  const goldBefore = room.sim.player.gold;

  room.settingsOpen(a, true);
  assert.equal(room.menuPaused, true);
  assert.equal(room.simFrozen(), true);
  room.command(a, { type: "bank" });
  room.tick();
  assert.equal(room.sim.player.gold, goldBefore);

  room.settingsOpen(a, false);
  assert.equal(room.menuPaused, false);
  assert.equal(room.simFrozen(), false);

  cleanup(mm, room);
});

test("pause button is unavailable against a bot", () => {
  const { mm, room, a } = botGame();
  room.pause(a);
  assert.equal(room.paused, false);
  assert.equal(room.lobbyFor(room.seat.a).canPause, false);

  cleanup(mm, room);
});

test("disconnect grace keeps the sim running until reconnect wait", async () => {
  const { mm, room, a, b } = loggedInPair();

  room.disconnect(a);
  assert.equal(room.disconnectGraceSeat, "a");
  assert.equal(room.reconnectWaitEnds, null);
  assert.equal(room.simFrozen(), false);

  const elapsedBefore = room.sim.elapsed;
  room.tick();
  assert.ok(room.sim.elapsed > elapsedBefore);

  await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS + 20));
  assert.ok(room.reconnectWaitEnds);
  assert.equal(room.reconnectWaitSeat, "a");
  assert.equal(room.simFrozen(), true);
  assert.equal(room.lobbyFor(room.seat.b).reconnectWaiting, true);
  const frozenElapsed = room.sim.elapsed;
  room.tick();
  assert.equal(room.sim.elapsed, frozenElapsed);

  cleanup(mm, room);
});

test("reconnect during grace cancels the wait", async () => {
  const { mm, room, a } = loggedInPair();
  room.disconnect(a);
  assert.equal(room.disconnectGraceSeat, "a");

  const again = fakeSocket("a", "Alice", 1);
  room.attach(again);
  assert.equal(room.disconnectGraceSeat, null);
  assert.equal(room.reconnectWaitEnds, null);
  assert.equal(room.simFrozen(), false);
  assert.equal(room.seat.a.socket, again);

  await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS + 20));
  assert.equal(room.reconnectWaitEnds, null);

  cleanup(mm, room);
});

test("reconnect during reconnect wait resumes the match", async () => {
  const { mm, room, a } = loggedInPair();
  room.disconnect(a);
  await new Promise((resolve) => setTimeout(resolve, DISCONNECT_GRACE_MS + 20));
  assert.equal(room.simFrozen(), true);

  const again = fakeSocket("a", "Alice", 1);
  room.attach(again);
  assert.equal(room.reconnectWaitEnds, null);
  assert.equal(room.simFrozen(), false);

  cleanup(mm, room);
});

test("reconnect wait timeout concedes for the disconnected player", async () => {
  const { mm, room, a } = loggedInPair();
  room.disconnect(a);
  await new Promise((resolve) => {
    setTimeout(resolve, DISCONNECT_GRACE_MS + RECONNECT_WAIT_MS + 40);
  });
  assert.equal(room.sim.winner, "enemy");
  assert.equal(room.sim.winReason, "concede");
  assert.equal(room.reconnectWaitEnds, null);

  cleanup(mm, room);
});

test("reconnect spam force-concedes the spammer", () => {
  const { mm, room, b } = loggedInPair();
  const max = CONFIG.reconnectSpamMax;
  for (let i = 0; i < max; i += 1) {
    const next = fakeSocket(`a-${i}`, "Alice", 1);
    room.seatHuman("a", next);
  }
  assert.equal(room.sim.winner, "enemy");
  assert.equal(room.sim.winReason, "concede");
  assert.ok(room.seat.b.socket === b);

  cleanup(mm, room);
});
