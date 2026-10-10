import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-discord-bot-"));
process.env.DATA_DIR = dataDir;
process.env.SKIP_FORMBAR = "1";
process.env.METRICS = "";
process.env.METRICS_LOG = "0";

const {
  initDb,
  upsertDiscordAccount,
  dbFile,
} = await import("../server/db.js");
const {
  buildStatusSnapshot,
  buildProfilePayload,
} = await import("../server/discordBotApi.js");
const { default: sqlite3 } = await import("sqlite3");

await initDb();

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.run(sql, params, function onRun(err) {
      db.close();
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function fakeMatchmaker({ rooms = [], casual = 0, ranked = 0, training = 0, lobbies = [] } = {}) {
  const map = new Map();
  for (const room of rooms) {
    map.set(room.id || `r${map.size}`, room);
  }
  return {
    rooms: map,
    casual: Array.from({ length: casual }),
    ranked: Array.from({ length: ranked }),
    training: Array.from({ length: training }),
    listLobbies: () => lobbies,
  };
}

test("buildStatusSnapshot counts rooms by status and queues", async () => {
  const mm = fakeMatchmaker({
    rooms: [
      { id: "a", status: "playing" },
      { id: "b", status: "playing" },
      { id: "c", status: "waiting" },
      { id: "d", status: "countdown" },
      { id: "e", status: "dead" },
    ],
    casual: 2,
    ranked: 1,
    training: 3,
    lobbies: [{ id: "L1" }],
  });
  const io = { engine: { clientsCount: 7 } };
  const health = {
    version: "0.1.0-test",
    nodeEnv: "test",
    uptimeSec: 120,
    matchmakingPaused: true,
    maintenanceMessage: "patching",
  };
  const snap = await buildStatusSnapshot(mm, io, { health });
  assert.equal(snap.rooms, 5);
  assert.equal(snap.playing, 2);
  assert.equal(snap.waiting, 1);
  assert.equal(snap.countdown, 1);
  assert.equal(snap.other, 1);
  assert.deepEqual(snap.queues, { casual: 2, ranked: 1, training: 3 });
  assert.equal(snap.lobbies, 1);
  assert.equal(snap.sockets, 7);
  assert.equal(snap.version, "0.1.0-test");
  assert.equal(snap.matchmakingPaused, true);
  assert.equal(snap.maintenanceMessage, "patching");
  assert.equal(typeof snap.pid, "number");
  assert.equal(typeof snap.workerIndex, "number");
});

test("buildProfilePayload returns unlinked and public vs self fields", async () => {
  const missing = await buildProfilePayload("999888777666");
  assert.deepEqual(missing, { linked: false });

  const account = await upsertDiscordAccount("112233445566", "Bot Profile");
  await runSql(
    "UPDATE accounts SET mmr = 1234, tickets = 9, held = 2, wins = 4, losses = 1 WHERE id = ?",
    [account.id],
  );

  const publicView = await buildProfilePayload("112233445566", { self: false });
  assert.equal(publicView.linked, true);
  assert.equal(publicView.name, "Bot Profile");
  assert.equal(publicView.mmr, 1234);
  assert.equal(publicView.wins, 4);
  assert.equal(publicView.losses, 1);
  assert.equal(publicView.rankedGames, 5);
  assert.equal(publicView.profilePath, `/profile/${account.id}`);
  assert.equal(publicView.tickets, undefined);
  assert.equal(publicView.held, undefined);

  const selfView = await buildProfilePayload("112233445566", { self: true });
  assert.equal(selfView.tickets, 9);
  assert.equal(selfView.held, 2);
});

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-bot-http-"));
  const port = 19110 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ["app.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      SKIP_FORMBAR: "1",
      METRICS: "",
      METRICS_LOG: "0",
      LOCAL_ACCOUNTS: "1",
      FORMBAR_LOGIN: "0",
      DISCORD_LOGIN: "1",
      AUTH_EMAIL: "0",
      SESSION_SECRET: "test-bot-api-secret",
      NODE_ENV: "test",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`server did not listen\n${buf}`)), 20000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (/listening on/.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${buf}`));
    });
  });
  return { child, base: `http://127.0.0.1:${port}`, dataDir: dir, ready };
}

async function stopServer(server) {
  server.child.kill();
  await new Promise((resolve) => server.child.once("exit", resolve));
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

test("bot API routes require Bearer token and return status/profile", async (t) => {
  const token = "bot-api-test-token";
  const server = startServer({ DISCORD_BOT_API_TOKEN: token });
  t.after(() => stopServer(server));
  await server.ready;

  const hidden = await fetch(`${server.base}/api/v1/bot/status`);
  assert.equal(hidden.status, 404);

  const wrong = await fetch(`${server.base}/api/v1/bot/status`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 404);

  const statusRes = await fetch(`${server.base}/api/v1/bot/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(statusRes.status, 200);
  const status = await statusRes.json();
  assert.equal(typeof status.rooms, "number");
  assert.ok(status.queues);
  assert.equal(typeof status.queues.casual, "number");
  assert.equal(typeof status.uptimeSec, "number");

  const noId = await fetch(`${server.base}/api/v1/bot/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(noId.status, 400);

  const unlinked = await fetch(
    `${server.base}/api/v1/bot/profile?discordId=555444333222`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(unlinked.status, 200);
  assert.deepEqual(await unlinked.json(), { linked: false });
});
