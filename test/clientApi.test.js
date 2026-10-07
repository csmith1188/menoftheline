import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { io as ioClient } from "socket.io-client";

process.env.BOT_COUNTDOWN_MS = "50";
process.env.COUNTDOWN_MS = "50";
process.env.SKIP_FORMBAR = "1";

const { listen, httpServer, io } = await import("../server.js");
const { disconnectFormbar } = await import("../server/formbar.js");
const { getAccountByFormbar, grantTickets } = await import("../server/db.js");

await listen(0);
const address = httpServer.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

test.after(async () => {
  disconnectFormbar();
  await new Promise((resolve) => {
    io.close(() => {
      httpServer.close(() => resolve());
    });
  });
});

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

async function createSession(name = "Api Tester") {
  const sessionRes = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(sessionRes.status, 200);
  return sessionRes.json();
}

function openSocket(token) {
  return ioClient(base, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
}

test("client API starts a bot game and accepts a buy", async (t) => {
  const session = await createSession();
  assert.ok(session.token);
  assert.match(session.player.name, /^Api Tester(?: \d+)?$/);

  const meRes = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
  });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.player.id, session.player.id);
  assert.equal(me.busy, false);
  assert.equal(me.account, null);
  assert.equal(me.canTicket, false);

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

  const socket = openSocket(session.token);
  t.after(() => {
    socket.emit("leave");
    socket.removeAllListeners();
    socket.close();
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

test("client API Formbar login unlocks ranked and listed lobbies", async (t) => {
  const hostId = 800000 + Math.floor(Math.random() * 100000);
  const joinerId = hostId + 1;
  const session = await createSession("Formbar Tester");
  const formbarJwt = jwt.sign(
    { id: hostId, displayName: "Formbar Tester" },
    "test-secret",
  );

  const loginRes = await fetch(`${base}/api/v1/login/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ token: formbarJwt }),
  });
  assert.equal(loginRes.status, 200);
  const loggedIn = await loginRes.json();
  assert.equal(loggedIn.player.formbarId, hostId);
  assert.equal(loggedIn.account.formbarId, hostId);

  const noTicket = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ mode: "ranked" }),
  });
  assert.equal(noTicket.status, 403);
  assert.equal((await noTicket.json()).error, "no_ticket");

  const hostAccount = await getAccountByFormbar(hostId);
  assert.ok(hostAccount);
  await grantTickets(hostAccount.id, 2);

  const meRes = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
  });
  const me = await meRes.json();
  assert.equal(me.canTicket, true);
  assert.equal(me.account.tickets, 2);

  const optsRes = await fetch(`${base}/api/v1/match-options`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
  });
  assert.equal(optsRes.status, 200);
  const opts = await optsRes.json();
  assert.ok(Array.isArray(opts.speeds));
  assert.ok(opts.maps.some((m) => m.id === "default"));

  const listedRes = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({
      mode: "listed",
      speed: 1.5,
      fogEnabled: false,
      mapId: "default",
      fortsEnabled: true,
      baseGps: 8,
    }),
  });
  assert.equal(listedRes.status, 200);
  assert.equal((await listedRes.json()).mode, "listed");

  const hostSocket = openSocket(session.token);
  t.after(() => {
    hostSocket.emit("leave");
    hostSocket.removeAllListeners();
    hostSocket.close();
  });
  await onceEvent(hostSocket, "connect");
  const lobby = await onceEvent(hostSocket, "lobby");
  assert.equal(lobby.status, "waiting");

  const lobbiesRes = await fetch(`${base}/api/v1/lobbies`, {
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json" },
  });
  assert.equal(lobbiesRes.status, 200);
  const { lobbies } = await lobbiesRes.json();
  assert.equal(lobbies.length, 1);
  assert.equal(lobbies[0].match.speed, 1.5);
  assert.equal(lobbies[0].match.fogEnabled, false);

  const joinerSession = await createSession("Joiner");
  const joinerJwt = jwt.sign({ id: joinerId, displayName: "Joiner" }, "test-secret");
  const joinerLogin = await fetch(`${base}/api/v1/login/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${joinerSession.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ token: joinerJwt }),
  });
  assert.equal(joinerLogin.status, 200);
  const joinerAccount = await getAccountByFormbar(joinerId);
  assert.ok(joinerAccount);
  await grantTickets(joinerAccount.id, 1);

  const joinRes = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${joinerSession.token}`,
      accept: "application/json",
    },
    body: JSON.stringify({ mode: "join", roomId: lobbies[0].id }),
  });
  assert.equal(joinRes.status, 200);

  const joinerSocket = openSocket(joinerSession.token);
  t.after(() => {
    joinerSocket.emit("leave");
    joinerSocket.removeAllListeners();
    joinerSocket.close();
  });
  await onceEvent(joinerSocket, "connect");
  await onceEvent(joinerSocket, "lobby");
  await waitForPlaying(joinerSocket);
});
