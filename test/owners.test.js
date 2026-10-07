import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as ioClient } from "socket.io-client";
import { pickLeastLoaded } from "../server/owners.js";

test("pickLeastLoaded keeps the earlier worker on a tie", () => {
  assert.equal(pickLeastLoaded([0, 0, 0]), 0);
  assert.equal(pickLeastLoaded([2, 1, 4]), 1);
  assert.equal(pickLeastLoaded([3, 3, 1]), 2);
});

function once(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function startWorker(index, bases, dataDir) {
  const port = 18781 + index;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      WORKER_INDEX: String(index),
      WORKER_COUNT: "2",
      OWNER_BASES: bases.join(","),
      DATA_DIR: dataDir,
      SKIP_FORMBAR: "1",
      BOT_COUNTDOWN_MS: "200",
      COUNTDOWN_MS: "200",
      METRICS: "",
      METRICS_LOG: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`worker ${index} did not listen\n${buf}`)), 15000);
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
      reject(new Error(`worker ${index} exited ${code}\n${buf}`));
    });
  });
  return { child, port, ready, base: `http://127.0.0.1:${port}` };
}

async function session(base, name) {
  const res = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function play(base, token, mode) {
  const res = await fetch(`${base}/api/v1/play`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mode }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("two owners split bot rooms and keep a casual pair together", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-owners-"));
  const bases = ["http://127.0.0.1:18781", "http://127.0.0.1:18782"];
  const workers = [startWorker(0, bases, dataDir), startWorker(1, bases, dataDir)];
  const sockets = [];
  t.after(async () => {
    for (let i = 0; i < sockets.length; i += 1) sockets[i].close();
    for (let i = 0; i < workers.length; i += 1) workers[i].child.kill();
    await Promise.all(workers.map((worker) => new Promise((resolve) => {
      worker.child.once("exit", resolve);
    })));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await Promise.all(workers.map((worker) => worker.ready));

  const botA = await session(bases[0], "Owner Bot A");
  const playA = await play(bases[0], botA.token, "bot");
  assert.equal(playA.worker, 0);
  assert.equal(playA.owner, bases[0]);

  const botB = await session(bases[0], "Owner Bot B");
  const playB = await play(bases[0], botB.token, "bot");
  assert.equal(playB.worker, 1);
  assert.equal(playB.owner, bases[1]);

  const sockA = ioClient(playA.owner, {
    auth: { token: botA.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(sockA);
  let playingA = await once(sockA, "state");
  if (playingA.status === "waiting") playingA = await once(sockA, "state");
  assert.ok(playingA.status === "countdown" || playingA.status === "playing");

  const wrong = ioClient(bases[1], {
    auth: { token: botA.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(wrong);
  const home = await once(wrong, "go-home");
  assert.ok(home === undefined || home === null || typeof home === "object");

  const casualA = await session(bases[1], "Owner Casual A");
  const casualB = await session(bases[1], "Owner Casual B");
  const pairA = await play(bases[1], casualA.token, "casual");
  const pairB = await play(bases[0], casualB.token, "casual");
  assert.equal(pairA.worker, pairB.worker);
  assert.equal(pairA.owner, pairB.owner);

  const left = ioClient(pairA.owner, {
    auth: { token: casualA.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  const right = ioClient(pairB.owner, {
    auth: { token: casualB.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(left, right);
  function waitPaired(socket) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pair timeout")), 8000);
      function onEvent(payload) {
        if (!payload || payload.status === "waiting" || !payload.status) return;
        clearTimeout(timer);
        socket.off("lobby", onEvent);
        socket.off("state", onEvent);
        resolve(payload);
      }
      socket.on("lobby", onEvent);
      socket.on("state", onEvent);
    });
  }
  const leftState = await waitPaired(left);
  const rightState = await waitPaired(right);
  assert.equal(leftState.mode, "casual");
  assert.equal(rightState.mode, "casual");
  assert.notEqual(leftState.status, "waiting");
  assert.notEqual(rightState.status, "waiting");
});
