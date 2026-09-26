import { io } from "socket.io-client";

let socket = null;

export function connectFormbar(authUrl, apiKey) {
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

/** Pool owner → contributor (wiki rewards). Uses POOL_OWNER_ID + POOL_PIN. */
export async function rewardFromPool(socketClient, { userId, amount, reason }) {
  const toId = Number(userId);
  const fromId = Number(process.env.POOL_OWNER_ID);
  const pin = process.env.POOL_PIN;
  if (!Number.isInteger(toId) || toId <= 0) {
    return { success: false, message: "Contributor Formbar id is missing." };
  }
  if (!Number.isInteger(fromId) || fromId <= 0) {
    return { success: false, message: "Pool owner id is not configured." };
  }
  if (!pin) {
    return { success: false, message: "Pool PIN is not configured." };
  }
  const digipogs = Number(amount);
  if (!Number.isFinite(digipogs) || digipogs <= 0) {
    return { success: false, message: "Reward amount is invalid." };
  }

  return transferDigipogs(socketClient, {
    from: fromId,
    to: toId,
    amount: digipogs,
    pin,
    reason: reason || "Wiki contribution",
  });
}
