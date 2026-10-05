import { io } from "socket.io-client";

let socket = null;

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

function socketTransfer(socketClient, data) {
  return new Promise((resolve) => {
    if (!socketClient || !socketClient.connected) {
      resolve({
        success: false,
        message: "Not connected to Formbar.",
      });
      return;
    }

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      socketClient.off("transferResponse", onResponse);
      resolve(result);
    };

    const onResponse = (response) => {
      if (response && response.success === true) {
        finish({ success: true, message: response.message || "" });
      } else {
        finish({
          success: false,
          message: (response && response.message) || "Transfer failed.",
        });
      }
    };

    socketClient.once("transferResponse", onResponse);
    socketClient.emit("transferDigipogs", data, (ack) => {
      if (ack != null) onResponse(ack);
    });

    setTimeout(() => {
      finish({
        success: false,
        message: "Transfer timed out. Check Formbar and try again.",
      });
    }, 10000);
  });
}

async function transferDigipogs(socketClient, data) {
  const pin = pinNumber(data.pin);
  if (Number.isNaN(pin)) {
    return { success: false, message: "PIN must be a number." };
  }
  await waitConnected(socketClient);
  return socketTransfer(socketClient, { ...data, pin });
}

export async function payPool(socketClient, { userId, poolId, amount, pin, reason }) {
  const fromId = Number(userId);
  const toId = Number(poolId);
  if (!Number.isFinite(fromId) || fromId <= 0) {
    return {
      success: false,
      message: "Logged-in Formbar user id is missing. Log out and log in again.",
    };
  }
  if (!Number.isInteger(toId) || toId <= 0) {
    return { success: false, message: "Pool id is not configured." };
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
 */
export async function rewardFromPool(_socketClient, { userId, amount, reason }) {
  const toId = Number(userId);
  const fromId = Number(process.env.ADMIN_USER_ID);
  const pin = pinNumber(process.env.POOL_PIN);
  if (!Number.isInteger(toId) || toId <= 0) {
    return { success: false, message: "Contributor Formbar id is missing." };
  }
  if (!Number.isInteger(fromId) || fromId <= 0) {
    return { success: false, message: "Admin user id is not configured." };
  }
  if (Number.isNaN(pin)) {
    return { success: false, message: "Pool PIN is not configured." };
  }
  const digipogs = Number(amount);
  if (!Number.isFinite(digipogs) || digipogs <= 0) {
    return { success: false, message: "Reward amount is invalid." };
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
        message:
          (payload && (payload.message || payload.error)) ||
          `Transfer failed (${response.status}).`,
      };
    }
    if (payload && payload.success === false) {
      return {
        success: false,
        message: payload.message || payload.error || "Transfer failed.",
      };
    }
    return {
      success: true,
      message:
        (payload && payload.data && payload.data.message) ||
        (payload && payload.message) ||
        "",
    };
  } catch (err) {
    return {
      success: false,
      message: err.message || "Transfer request failed.",
    };
  }
}
