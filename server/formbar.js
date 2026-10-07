import { io } from "socket.io-client";

let socket = null;

/**
 * Formbar's transferDigipogs socket emits a generic transferResponse with no
 * request id. Only one transfer may be outstanding per socket. A lost response
 * cannot be matched to a later transfer, so callers must treat timeouts as
 * ambiguous and must not automatically send the same payment again.
 * Exactly-once recovery needs a Formbar transaction or idempotency id.
 */
const transferChains = new WeakMap();

export function connectFormbar(authUrl, apiKey) {
  if (process.env.SKIP_FORMBAR === "1") return null;
  if (socket) return socket;
  socket = io(String(authUrl || "").replace(/\/$/, ""), {
    extraHeaders: { api: apiKey || "" },
  });
  socket.on("connect", () => console.log("Connected to Formbar"));
  socket.on("connect_error", (err) => {
    console.warn("Formbar socket error:", err.message);
  });
  return socket;
}

/** Drop the Formbar client so tests and short-lived processes can exit. */
export function disconnectFormbar() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.close();
  socket = null;
}

function pinNumber(pin) {
  const n = typeof pin === "string" ? parseInt(pin, 10) : Number(pin);
  return Number.isFinite(n) ? n : NaN;
}

function waitConnected(socketClient, ms = 5000) {
  if (socketClient && socketClient.connected) return Promise.resolve(true);
  if (!socketClient) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    socketClient.once("connect", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function enqueueTransfer(socketClient, job) {
  const previous = transferChains.get(socketClient) || Promise.resolve();
  const run = previous.then(job, job);
  transferChains.set(socketClient, run.then(() => {}, () => {}));
  return run;
}

function oneSocketTransfer(socketClient, data, timeoutMs) {
  return new Promise((resolve) => {
    if (!socketClient || !socketClient.connected) {
      resolve({
        success: false,
        ambiguous: false,
        message: "Not connected to Formbar.",
      });
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socketClient.off("transferResponse", onResponse);
      resolve(result);
    };

    const onResponse = (response) => {
      if (response && response.success === true) {
        finish({ success: true, ambiguous: false, message: response.message || "" });
      } else {
        finish({
          success: false,
          ambiguous: false,
          message: (response && response.message) || "Transfer failed.",
        });
      }
    };

    socketClient.once("transferResponse", onResponse);
    try {
      socketClient.emit("transferDigipogs", data, (ack) => {
        if (ack != null) onResponse(ack);
      });
    } catch (err) {
      finish({
        success: false,
        ambiguous: true,
        message: err.message || "Transfer request failed.",
      });
      return;
    }

    timer = setTimeout(() => {
      finish({
        success: false,
        ambiguous: true,
        message: "Transfer timed out. Check Formbar and try again.",
      });
    }, timeoutMs);
  });
}

/**
 * One outstanding transferDigipogs per socket. The next call starts only
 * after the previous one succeeds, fails, or times out. The listener is
 * removed when that call settles, so one response cannot resolve two callers.
 */
export function serializedSocketTransfer(socketClient, data, timeoutMs = 10000) {
  return enqueueTransfer(socketClient, () => oneSocketTransfer(socketClient, data, timeoutMs));
}

async function transferDigipogs(socketClient, data) {
  const pin = pinNumber(data.pin);
  if (Number.isNaN(pin)) {
    return { success: false, ambiguous: false, message: "PIN must be a number." };
  }
  await waitConnected(socketClient);
  return serializedSocketTransfer(socketClient, { ...data, pin });
}

export async function payPool(socketClient, { userId, poolId, amount, pin, reason }) {
  const fromId = Number(userId);
  const toId = Number(poolId);
  if (!Number.isFinite(fromId) || fromId <= 0) {
    return {
      success: false,
      ambiguous: false,
      message: "Logged-in Formbar user id is missing. Log out and log in again.",
    };
  }
  if (!Number.isInteger(toId) || toId <= 0) {
    return { success: false, ambiguous: false, message: "Pool id is not configured." };
  }

  return transferDigipogs(socketClient, {
    from: fromId,
    to: toId,
    amount: Number(amount),
    pin,
    reason: reason || "Game tickets",
    pool: toId,
  });
}

/**
 * Admin → player digipog transfer for wiki/suggestion rewards.
 * Uses ADMIN_USER_ID + POOL_PIN via POST /api/digipogs/transfer.
 * Network failures are ambiguous: Formbar may have applied the transfer.
 */
export async function rewardFromPool(_socketClient, { userId, amount, reason }) {
  const toId = Number(userId);
  const fromId = Number(process.env.ADMIN_USER_ID);
  const pin = pinNumber(process.env.POOL_PIN);
  if (!Number.isInteger(toId) || toId <= 0) {
    return { success: false, ambiguous: false, message: "Contributor Formbar id is missing." };
  }
  if (!Number.isInteger(fromId) || fromId <= 0) {
    return { success: false, ambiguous: false, message: "Admin user id is not configured." };
  }
  if (Number.isNaN(pin)) {
    return { success: false, ambiguous: false, message: "Pool PIN is not configured." };
  }
  const digipogs = Number(amount);
  if (!Number.isFinite(digipogs) || digipogs <= 0) {
    return { success: false, ambiguous: false, message: "Reward amount is invalid." };
  }

  const base = String(process.env.AUTH_URL || "https://formbar.yorktechapps.com")
    .replace(/\/$/, "");
  const apiKey = process.env.API_KEY || "";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.API = apiKey;

  try {
    const response = await fetch(`${base}/api/digipogs/transfer`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: fromId,
        to: toId,
        amount: digipogs,
        pin: String(pin),
        reason: reason || "Wiki contribution",
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        success: false,
        ambiguous: false,
        message:
          (payload && (payload.message || payload.error)) ||
          `Transfer failed (${response.status}).`,
      };
    }
    if (!payload) {
      return {
        success: false,
        ambiguous: true,
        message: "Transfer response was unreadable. It will not be retried automatically.",
      };
    }
    if (payload.success === false) {
      return {
        success: false,
        ambiguous: false,
        message: payload.message || payload.error || "Transfer failed.",
      };
    }
    return {
      success: true,
      ambiguous: false,
      message:
        (payload.data && payload.data.message) ||
        payload.message ||
        "",
    };
  } catch (err) {
    return {
      success: false,
      ambiguous: true,
      message: err.message || "Transfer request failed.",
    };
  }
}
