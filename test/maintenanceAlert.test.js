import assert from "node:assert/strict";
import test from "node:test";

process.env.SKIP_FORMBAR = "1";
process.env.MATCH_CHAT = "1";

const { GameRoom } = await import("../server/room.js");
const { Matchmaker } = await import("../server/matchmaking.js");

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

function chatTexts(socket) {
  return socket.events
    .filter((event) => event.event === "chat")
    .map((event) => event.payload.text);
}

function cleanup(mm, room) {
  room.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
}

test("maintenance notice alerts both seats in a human match", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("a", "Alice", 1);
  const b = fakeSocket("b", "Bob", 2);
  room.seatHuman("a", a);
  room.seatHuman("b", b);
  room.status = "playing";
  room.playSnapshotSent = true;
  a.events.length = 0;
  b.events.length = 0;

  room.announceMaintenance("Servers restart at 22:00 UTC");

  assert.ok(chatTexts(a).some((text) => text.includes("Servers restart")));
  assert.ok(chatTexts(b).some((text) => text.includes("Servers restart")));
  assert.equal(room.lobbyFor(room.seat.a).pauseAlert, true);
  assert.equal(room.lobbyFor(room.seat.b).pauseAlert, true);
  assert.equal(room.lobbyFor(room.seat.a).chatEnabled, true);

  room.pauseSeen(a);
  assert.equal(room.lobbyFor(room.seat.a).pauseAlert, false);
  assert.equal(room.lobbyFor(room.seat.b).pauseAlert, true);

  cleanup(mm, room);
});

test("maintenance notice reaches bot matches and shows chat chrome", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "bot");
  const a = fakeSocket("a", "Alice", 1);
  room.seatHuman("a", a);
  room.seatBot("b");
  room.status = "playing";
  room.playSnapshotSent = true;
  a.events.length = 0;

  assert.equal(room.roomChatActive(), false);
  room.announceMaintenance("Brief downtime soon");

  assert.ok(chatTexts(a).some((text) => /Maintenance:.*Brief downtime/.test(text)));
  const lobby = room.lobbyFor(room.seat.a);
  assert.equal(lobby.chatEnabled, true);
  assert.equal(lobby.pauseAlert, true);
  assert.ok(lobby.chatHistory.some((msg) => msg.kind === "system"));

  cleanup(mm, room);
});

test("matchmaker.announceMaintenance hits every live room", () => {
  const mm = new Matchmaker({});
  const human = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("a", "Alice", 1);
  const b = fakeSocket("b", "Bob", 2);
  human.seatHuman("a", a);
  human.seatHuman("b", b);
  human.status = "playing";
  mm.rooms.set(human.id, human);

  const bot = new GameRoom(mm, {}, "bot");
  const c = fakeSocket("c", "Carol", 3);
  bot.seatHuman("a", c);
  bot.seatBot("b");
  bot.status = "playing";
  mm.rooms.set(bot.id, bot);

  a.events.length = 0;
  b.events.length = 0;
  c.events.length = 0;

  const n = mm.announceMaintenance("Patch in 10 minutes");
  assert.equal(n, 2);
  assert.ok(chatTexts(a).length);
  assert.ok(chatTexts(c).length);
  assert.equal(human.lobbyFor(human.seat.a).pauseAlert, true);
  assert.equal(bot.lobbyFor(bot.seat.a).pauseAlert, true);

  human.destroy();
  bot.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
});
