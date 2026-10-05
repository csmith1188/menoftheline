import test from "node:test";
import assert from "node:assert/strict";
import { io as ioClient } from "socket.io-client";

process.env.BOT_COUNTDOWN_MS = "50";
process.env.SKIP_FORMBAR = "1";

const { listen, httpServer, io } = await import("../server.js");
const { disconnectFormbar } = await import("../server/formbar.js");

function onceEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, onEvent);
  });
}

async function waitForPlaying(socket, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await onceEvent(socket, "state", Math.max(100, deadline - Date.now()));
    if (state && state.status === "playing") return state;
  }
  throw new Error("timed out waiting for playing state");
}

test("client API starts a bot game and accepts a buy", async (t) => {
  await listen(0);
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  let socket;
  t.after(async () => {
    if (socket) {
      socket.emit("leave");
      socket.removeAllListeners();
      socket.close();
    }
    disconnectFormbar();
    await new Promise((resolve) => {
      io.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  const sessionRes = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: "Api Tester" }),
  });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.ok(session.token);
  assert.match(session.player.name, /^Api Tester(?: \d+)?$/);

  const meRes = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
  });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.player.id, session.player.id);
  assert.equal(me.busy, false);

  const rankedRes = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ mode: "ranked" }),
  });
  assert.equal(rankedRes.status, 403);
  assert.equal((await rankedRes.json()).error, "login_required");

  const playRes = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ mode: "bot" }),
  });
  assert.equal(playRes.status, 200);
  const play = await playRes.json();
  assert.equal(play.ok, true);
  assert.equal(play.mode, "bot");

  socket = ioClient(base, {
    auth: { token: session.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await onceEvent(socket, "connect");
  await onceEvent(socket, "lobby");
  await waitForPlaying(socket);

  socket.emit("command", { type: "buy", lane: "top", unit: "troop" });

  const deadline = Date.now() + 5000;
  let bought = false;
  while (Date.now() < deadline) {
    const state = await onceEvent(socket, "state", Math.max(100, deadline - Date.now()));
    const troops = state?.sides?.player?.troops || [];
    if (troops.some((troop) => troop.type === "troop" && troop.lane === "top")) {
      bought = true;
      break;
    }
  }
  assert.equal(bought, true);
});
