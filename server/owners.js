/**
 * Which process owns a match. One process is the default.
 * Extra processes do not share GameSim. They only share assignment rows
 * in SQLite so both players of a pair connect to the same owner.
 * A Socket.IO adapter would not copy the simulation.
 */

export function workerCount() {
  const n = Number(process.env.WORKER_COUNT);
  return Number.isInteger(n) && n > 1 ? n : 1;
}

export function workerIndex() {
  const n = Number(process.env.WORKER_INDEX);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

export function ownerBases() {
  return String(process.env.OWNER_BASES || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function ownerBase(index) {
  const bases = ownerBases();
  return bases[index] || "";
}

/** Index of the smallest load. Ties keep the earlier worker. */
export function pickLeastLoaded(loads) {
  let best = 0;
  for (let i = 1; i < loads.length; i += 1) {
    if (loads[i] < loads[best]) best = i;
  }
  return best;
}
