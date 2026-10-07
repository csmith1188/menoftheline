import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** Rolling samples. Oldest values drop once the cap is hit. */
function makeSamples(cap = 240) {
  const values = [];
  return {
    push(value) {
      if (!Number.isFinite(value)) return;
      values.push(value);
      if (values.length > cap) values.shift();
    },
    stats() {
      if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0 };
      const sorted = values.slice().sort((a, b) => a - b);
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
      return {
        n: sorted.length,
        p50: round(at(0.5)),
        p95: round(at(0.95)),
        max: round(sorted[sorted.length - 1]),
      };
    },
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

const counters = {
  roomTicks: 0,
  simSteps: 0,
  broadcasts: 0,
  commandsAccepted: 0,
  commandsRejected: 0,
  sqliteWrites: 0,
  sqliteBusy: 0,
};

const samples = {
  tick: makeSamples(),
  sim: makeSamples(),
  broadcast: makeSamples(),
  bytes: makeSamples(),
  troops: makeSamples(),
  projectiles: makeSamples(),
  aggregate: makeSamples(),
  loop: makeSamples(),
};

let started = false;
let timer = null;
let loopDelay = null;
let lastCpu = null;
let lastCpuAt = 0;
let cpuPercent = 0;
let windowCommands = 0;
let windowSqlite = 0;
let commandsPerSec = 0;
let sqliteWritesPerSec = 0;
let gaugesFn = () => ({ rooms: 0, sockets: 0, socketBacklog: 0 });
let overrunMs = 0;

export function metricsEnabled() {
  return process.env.METRICS === "1";
}

function enabled() {
  return metricsEnabled();
}

export function noteRoomTick(ms) {
  if (!enabled()) return;
  counters.roomTicks += 1;
  if (counters.roomTicks % 20 === 0) samples.tick.push(ms);
}

export function noteSim(ms) {
  if (!enabled()) return;
  counters.simSteps += 1;
  if (counters.simSteps % 20 === 0) samples.sim.push(ms);
}

/** True on every 20th broadcast so callers can skip JSON.stringify. */
export function shouldSampleBroadcastBytes() {
  if (!enabled()) return false;
  return (counters.broadcasts + 1) % 20 === 0;
}

export function noteBroadcast(ms, byteSize, troops, projectiles) {
  if (!enabled()) return;
  counters.broadcasts += 1;
  if (counters.broadcasts % 20 !== 0) return;
  samples.broadcast.push(ms);
  if (byteSize > 0) samples.bytes.push(byteSize);
  if (troops != null) samples.troops.push(troops);
  if (projectiles != null) samples.projectiles.push(projectiles);
}

export function noteAggregateTick(ms, overrun) {
  if (!enabled()) return;
  samples.aggregate.push(ms);
  if (Number.isFinite(overrun)) overrunMs = overrun;
}

export function noteCommand(accepted) {
  if (!enabled()) return;
  if (accepted) {
    counters.commandsAccepted += 1;
    windowCommands += 1;
  } else {
    counters.commandsRejected += 1;
  }
}

export function noteSqliteWrite() {
  if (!enabled()) return;
  counters.sqliteWrites += 1;
  windowSqlite += 1;
}

export function noteSqliteBusy() {
  if (!enabled()) return;
  counters.sqliteBusy += 1;
}

export function report(gauges = null) {
  const live = gauges || gaugesFn() || {};
  const loop = loopDelay
    ? {
      p50: round(loopDelay.percentile(50) / 1e6),
      p99: round(loopDelay.percentile(99) / 1e6),
      max: round(loopDelay.max / 1e6),
    }
    : { p50: 0, p99: 0, max: 0 };
  return {
    enabled: enabled(),
    rooms: live.rooms || 0,
    sockets: live.sockets || 0,
    socketBacklog: live.socketBacklog || 0,
    cpuPercent: round(cpuPercent),
    rssMb: round(process.memoryUsage().rss / (1024 * 1024)),
    heapMb: round(process.memoryUsage().heapUsed / (1024 * 1024)),
    eventLoopDelayMs: loop,
    aggregateTickMs: samples.aggregate.stats(),
    roomTickMs: samples.tick.stats(),
    simMs: samples.sim.stats(),
    broadcastMs: samples.broadcast.stats(),
    snapshotBytes: samples.bytes.stats(),
    troops: samples.troops.stats(),
    projectiles: samples.projectiles.stats(),
    overrunMs: round(overrunMs),
    commandsAccepted: counters.commandsAccepted,
    commandsRejected: counters.commandsRejected,
    commandsPerSec,
    sqliteWrites: counters.sqliteWrites,
    sqliteWritesPerSec,
    sqliteBusy: counters.sqliteBusy,
    roomTicks: counters.roomTicks,
    broadcasts: counters.broadcasts,
  };
}

function sampleCpu() {
  const now = performance.now();
  const cpu = process.cpuUsage(lastCpu || undefined);
  if (lastCpu) {
    const elapsedUs = (now - lastCpuAt) * 1000;
    const used = cpu.user + cpu.system;
    cpuPercent = elapsedUs > 0 ? (used / elapsedUs) * 100 : 0;
  }
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
}

function logLine() {
  sampleCpu();
  commandsPerSec = windowCommands;
  sqliteWritesPerSec = windowSqlite;
  windowCommands = 0;
  windowSqlite = 0;
  if (loopDelay) samples.loop.push(loopDelay.percentile(99) / 1e6);
  const row = report();
  console.log(
    `metrics rooms=${row.rooms} sockets=${row.sockets} rssMb=${row.rssMb} cpu=${row.cpuPercent}`
    + ` loopP99=${row.eventLoopDelayMs.p99} aggP95=${row.aggregateTickMs.p95}`
    + ` simP95=${row.simMs.p95} snapP95=${row.broadcastMs.p95} snapBytesP95=${row.snapshotBytes.p95}`
    + ` cmdPerSec=${row.commandsPerSec} sqlitePerSec=${row.sqliteWritesPerSec}`
    + ` backlog=${row.socketBacklog} overrunMs=${row.overrunMs}`,
  );
}

export function startMetrics(opts = {}) {
  if (!enabled() || started) return;
  started = true;
  if (opts.gauges) gaugesFn = opts.gauges;
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  lastCpu = process.cpuUsage();
  lastCpuAt = performance.now();
  if (opts.log === false) return;
  timer = setInterval(logLine, 1000);
  if (timer.unref) timer.unref();
}

export function ensureMetrics() {
  if (!enabled()) return false;
  if (!started) startMetrics({ log: process.env.METRICS_LOG !== "0" });
  return true;
}

export function stopMetrics() {
  if (timer) clearInterval(timer);
  timer = null;
  if (loopDelay) loopDelay.disable();
  loopDelay = null;
  started = false;
}
