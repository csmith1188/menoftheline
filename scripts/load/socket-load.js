/**
 * Socket.IO load for Men of the Line.
 *
 *   node scripts/load/socket-load.js bot
 *   node scripts/load/socket-load.js pvp
 *   node scripts/load/socket-load.js mixed
 *
 * Spawns one server with METRICS=1 and LOAD_TEST=1 unless LOAD_BASE is set.
 * Duration defaults to 20s. The 10 minute gate is LOAD_DURATION_MS=600000.
 * Results go to scripts/load/results/ (gitignored).
 *
 * Run the harness on another machine when measuring CPU. This process's
 * sockets share the server's cores if both are local.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioClient } from "socket.io-client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenario = process.argv[2] || "bot";
const durationMs = Number(process.env.LOAD_DURATION_MS) || 20000;
const port = Number(process.env.LOAD_PORT) || 18765;
const label = process.env.LOAD_LABEL || "baseline";
const resultsDir = path.join(root, "scripts", "load", "results");

const SCENARIOS = {
  bot: { bot: 100, casual: 0 },
  pvp: { bot: 0, casual: 100 },
  mixed: { bot: 70, casual: 30 },
};

function plan() {
  const base = SCENARIOS[scenario];
  if (!base) {
    console.error(`Unknown scenario "${scenario}". Use bot, pvp, or mixed.`);
    process.exit(1);
  }
  const scale = Number(process.env.LOAD_SCALE);
  if (Number.isFinite(scale) && scale > 0 && scale < 1) {
    return {
      bot: Math.round(base.bot * scale),
      casual: Math.round(base.casual * scale),
    };
  }
  if (process.env.LOAD_BOTS || process.env.LOAD_CASUAL) {
    return {
      bot: Number(process.env.LOAD_BOTS) || 0,
      casual: Number(process.env.LOAD_CASUAL) || 0,
    };
  }
  return base;
}

function waitForLine(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`server did not become ready\n${buf}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(buf);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code} before ready\n${buf}`));
    });
  });
}

async function jsonPost(url, body, token) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`${url} ${res.status} ${text}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function jsonPostRetry(url, body, token) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await jsonPost(url, body, token);
    } catch (err) {
      last = err;
      if (err.status !== 500) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw last;
}

function once(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitPlaying(socket) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await once(socket, "state", Math.max(200, deadline - Date.now()));
    if (state && state.status === "playing") return state;
  }
  throw new Error("timed out waiting for playing");
}

const BUY = [
  { type: "buy", lane: "top", unit: "troop" },
  { type: "buy", lane: "top", unit: "skirmisher" },
  { type: "buy", lane: "bottom", unit: "troop" },
  { type: "buy", lane: "bottom", unit: "officer" },
];
const ORDERS = ["forward", "charge", "cycle", "back"];

async function bootClient(base, index, mode) {
  const session = await jsonPostRetry(`${base}/api/v1/session`, { name: `Load ${mode} ${index}` });
  await jsonPostRetry(`${base}/api/v1/play`, { mode }, session.token);
  const socket = ioClient(base, {
    auth: { token: session.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  await once(socket, "connect", 8000);
  await waitPlaying(socket);
  socket.emit("tooltips", index % 2 === 0);
  socket.emit("bgmVolume", 20 + (index % 5));
  let n = 0;
  const timer = setInterval(() => {
    if (n < BUY.length * 5) {
      socket.emit("command", BUY[n % BUY.length]);
    } else {
      const troopId = (n % 12) + 1;
      socket.emit("command", {
        type: "order",
        troopId,
        action: ORDERS[n % ORDERS.length],
      });
    }
    n += 1;
  }, 250);
  if (timer.unref) timer.unref();
  return { socket, timer, mode };
}

function summarize(series) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  const agg = series.map((row) => row.aggregateTickMs && row.aggregateTickMs.p95).filter((n) => n != null);
  const loops = series.map((row) => row.eventLoopDelayMs && row.eventLoopDelayMs.p99).filter((n) => n != null);
  const maxOf = (values) => values.reduce((m, n) => Math.max(m, n), 0);
  return {
    samples: series.length,
    end: last,
    maxAggregateP95: maxOf(agg),
    maxLoopP99: maxOf(loops),
    maxRssMb: maxOf(series.map((row) => row.rssMb || 0)),
  };
}

async function main() {
  const counts = plan();
  fs.mkdirSync(resultsDir, { recursive: true });
  const dataDir = path.join(resultsDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  let child = null;
  let stopping = false;
  let base = process.env.LOAD_BASE || "";
  if (!base) {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        THIS_URL: `http://127.0.0.1:${port}`,
        METRICS: "1",
        METRICS_LOG: "1",
        LOAD_TEST: "1",
        LOAD_TEST_GOLD: process.env.LOAD_TEST_GOLD || "20000",
        DATA_DIR: dataDir,
        SKIP_FORMBAR: "1",
        BOT_COUNTDOWN_MS: "300",
        COUNTDOWN_MS: "300",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    await waitForLine(child, /listening on/, 20000);
    base = `http://127.0.0.1:${port}`;
  }

  const clients = [];
  let connectFailures = 0;
  const jobs = [];
  for (let i = 0; i < counts.bot; i += 1) jobs.push({ mode: "bot", index: i });
  for (let i = 0; i < counts.casual; i += 1) jobs.push({ mode: "casual", index: i });
  let nextJob = 0;
  const concurrency = Math.max(1, Number(process.env.LOAD_CONCURRENCY) || 20);
  async function connectWorker() {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob];
      nextJob += 1;
      try {
        clients.push(await bootClient(base, job.index, job.mode));
      } catch (err) {
        connectFailures += 1;
        console.error(`client ${job.mode} ${job.index} failed: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => connectWorker()));

  const series = [];
  const started = Date.now();
  let serverDied = false;
  if (child) {
    child.once("exit", () => {
      if (!stopping) serverDied = true;
    });
  }
  while (Date.now() - started < durationMs) {
    if (serverDied) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const res = await fetch(`${base}/api/v1/metrics`);
      if (res.ok) series.push(await res.json());
    } catch (err) {
      console.error(err.message);
    }
  }

  for (let i = 0; i < clients.length; i += 1) {
    clients[i].socket.emit("concede");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const res = await fetch(`${base}/api/v1/metrics`);
    if (res.ok) series.push({ ...(await res.json()), phase: "after-concede" });
  } catch {
    // Server may already be stopping.
  }

  for (let i = 0; i < clients.length; i += 1) {
    clearInterval(clients[i].timer);
    clients[i].socket.close();
  }
  if (child) {
    stopping = true;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  const summary = summarize(series);
  const out = {
    label,
    scenario,
    counts,
    durationMs,
    connectFailures,
    serverDied,
    clients: clients.length,
    expressOnly: true,
    summary,
    series,
  };
  const file = path.join(resultsDir, `${label}-${scenario}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`wrote ${file}`);
  const sustained = (summary && summary.maxAggregateP95 > 50 && series.length > 5);
  if (connectFailures > 0 || serverDied || sustained) {
    console.error("load run failed", { connectFailures, serverDied, maxAggregateP95: summary && summary.maxAggregateP95 });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
