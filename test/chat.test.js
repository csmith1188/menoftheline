import assert from "node:assert/strict";
import test from "node:test";

process.env.SKIP_FORMBAR = "1";
process.env.MATCH_CHAT = "1";

const { GameRoom } = await import("../server/room.js");
const { Matchmaker } = await import("../server/matchmaking.js");
const {
  sanitizeChatText,
  allowChat,
  encodeChatJson,
  parseStoredChat,
} = await import("../server/chat.js");
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

/** Two logged-in humans in a casual room. */
function loggedInPair() {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("a", "Alice", 1);
  const b = fakeSocket("b", "Bob", 2);
  room.seatHuman("a", a);
  room.seatHuman("b", b);
  return { mm, room, a, b };
}

function cleanup(mm, room) {
  room.destroy();
  mm.ticker.stop();
  clearInterval(mm.timer);
}

function chatEvents(socket) {
  return socket.events.filter((event) => event.event === "chat").map((event) => event.payload);
}

test("sanitizeChatText strips newlines and empties", () => {
  assert.equal(sanitizeChatText("  hi\nthere  "), "hi there");
  assert.equal(sanitizeChatText("   "), "");
  assert.equal(sanitizeChatText(null), "");
});

test("room chat broadcasts user messages and keeps history", () => {
  const { mm, room, a, b } = loggedInPair();
  a.events.length = 0;
  b.events.length = 0;

  room.chat(a, { text: "Hello line" });
  const fromA = chatEvents(a);
  const fromB = chatEvents(b);
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 1);
  assert.equal(fromA[0].kind, "user");
  assert.equal(fromA[0].text, "Hello line");
  assert.equal(fromA[0].from.name, "Alice");
  assert.equal(fromA[0].id, fromB[0].id);
  assert.ok(room.chatLog.some((msg) => msg.id === fromA[0].id));
  assert.ok(room.adminChatLog.some((msg) => msg.id === fromA[0].id));

  const lobby = room.lobbyFor(room.seat.b);
  assert.equal(lobby.chatEnabled, true);
  assert.ok(lobby.chatHistory.some((msg) => msg.text === "Hello line"));

  const archive = room.chatArchivePublic();
  assert.ok(archive.some((msg) => msg.text === "Hello line" && msg.from === "Alice"));
  const json = room.chatArchiveJson();
  assert.ok(json);
  assert.ok(parseStoredChat(json).some((msg) => msg.text === "Hello line"));

  cleanup(mm, room);
});

test("encodeChatJson / parseStoredChat round-trip", () => {
  const json = encodeChatJson([
    { id: "m1", kind: "system", text: "joined", at: 100 },
    { id: "m2", kind: "user", from: { name: "Alice" }, text: "hi", at: 200 },
  ]);
  const rows = parseStoredChat(json);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "system");
  assert.equal(rows[1].from, "Alice");
  assert.equal(parseStoredChat(null).length, 0);
  assert.equal(parseStoredChat("not-json").length, 0);
});

test("empty chat is dropped", () => {
  const { mm, room, a } = loggedInPair();
  a.events.length = 0;

  room.chat(a, { text: "   " });
  room.chat(a, { text: "" });
  assert.equal(chatEvents(a).length, 0);

  cleanup(mm, room);
});

test("chat rate limit drops after burst", () => {
  const { mm, room, a } = loggedInPair();
  a.events.length = 0;

  const burst = CONFIG.chatBurst || 5;
  for (let i = 0; i < burst + 3; i += 1) {
    room.chat(a, { text: `msg ${i}` });
  }
  assert.equal(chatEvents(a).length, burst);

  cleanup(mm, room);
});

test("chat rate limit is per seat across reconnect sockets", () => {
  const { mm, room, a } = loggedInPair();
  a.events.length = 0;

  const burst = CONFIG.chatBurst || 5;
  for (let i = 0; i < burst; i += 1) {
    room.chat(a, { text: `msg ${i}` });
  }
  assert.equal(chatEvents(a).length, burst);

  const again = fakeSocket("a", "Alice", 1);
  room.seatHuman("a", again);
  again.events.length = 0;
  room.chat(again, { text: "after reconnect" });
  assert.equal(chatEvents(again).length, 0);

  cleanup(mm, room);
});

test("systemChat emits system lines when both accounts seated", () => {
  const { mm, room, a } = loggedInPair();
  a.events.length = 0;
  room.systemChat("Match started");
  const lines = chatEvents(a);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "system");
  assert.equal(lines[0].text, "Match started");

  cleanup(mm, room);
});

test("seatHuman skips joined chat when the other seat was already waiting", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("join-a", "Alice", 1);
  room.seatHuman("a", a);
  assert.equal(chatEvents(a).length, 0);

  const b = fakeSocket("join-b", "Bob", 2);
  room.seatHuman("b", b);
  // Completing a lobby must not spam the waiter with "X joined".
  assert.equal(
    chatEvents(a).filter((msg) => msg.kind === "system" && String(msg.text).includes("joined")).length,
    0,
  );
  assert.equal(
    chatEvents(b).filter((msg) => msg.kind === "system" && String(msg.text).includes("joined")).length,
    0,
  );
  assert.ok(!room.chatLog.some((msg) => msg.kind === "system" && String(msg.text).includes("joined")));

  cleanup(mm, room);
});

test("chat disabled for guests", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "casual");
  const a = fakeSocket("a", "Alice", 1);
  const b = fakeSocket("b", "GuestBob", null);
  room.seatHuman("a", a);
  room.seatHuman("b", b);
  a.events.length = 0;
  b.events.length = 0;

  assert.equal(room.roomChatActive(), false);
  assert.equal(room.lobbyFor(room.seat.a).chatEnabled, false);
  room.chat(a, { text: "nope" });
  room.chat(b, { text: "nope" });
  assert.equal(chatEvents(a).length, 0);
  assert.equal(chatEvents(b).length, 0);

  cleanup(mm, room);
});

test("chat disabled against bots", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "bot");
  const a = fakeSocket("a", "Alice", 1);
  room.seatHuman("a", a);
  room.seatBot("b");
  a.events.length = 0;

  assert.equal(room.roomChatActive(), false);
  assert.equal(room.lobbyFor(room.seat.a).chatEnabled, false);
  room.chat(a, { text: "hi bot" });
  assert.equal(chatEvents(a).length, 0);

  cleanup(mm, room);
});

test("chat disabled when lobby has only one seat filled", () => {
  const mm = new Matchmaker({});
  const room = new GameRoom(mm, {}, "listed");
  const a = fakeSocket("a", "Alice", 1);
  room.seatHuman("a", a);
  a.events.length = 0;

  assert.equal(room.roomChatActive(), false);
  assert.equal(room.lobbyFor(room.seat.a).chatEnabled, false);
  room.chat(a, { text: "alone" });
  assert.equal(chatEvents(a).length, 0);

  cleanup(mm, room);
});

test("allowChat refills over time", () => {
  const seat = { key: "a", chatBucket: null };
  const burst = CONFIG.chatBurst || 5;
  const now = 1_000_000;
  for (let i = 0; i < burst; i += 1) {
    assert.equal(allowChat(seat, now), true);
  }
  assert.equal(allowChat(seat, now), false);
  assert.equal(allowChat(seat, now + 2000), true);
});
