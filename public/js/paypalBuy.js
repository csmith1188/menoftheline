/**
 * PayPal JS SDK buttons for ticket packages.
 * Server creates/captures orders; this file only handles UI callbacks.
 * Mobile uses App Switch / redirect return; desktop keeps the popup.
 */

function statusEl(root) {
  return root.querySelector("#paypal-status") || root.querySelector(".paypal-status");
}

function setStatus(root, message, kind) {
  const el = statusEl(root);
  if (!el) return;
  el.textContent = message || "";
  el.dataset.kind = kind || "";
  el.classList.toggle("paypal-status--error", kind === "error");
  el.classList.toggle("paypal-status--ok", kind === "ok");
  el.classList.toggle("paypal-status--busy", kind === "busy");
}

function loadSdk(clientId) {
  const existing = document.querySelector("script[data-paypal-sdk]");
  if (existing && window.paypal) {
    return Promise.resolve(window.paypal);
  }
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(window.paypal), { once: true });
      existing.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    script.async = true;
    script.dataset.paypalSdk = "1";
    script.addEventListener("load", () => {
      if (!window.paypal) {
        reject(new Error("PayPal SDK missing"));
        return;
      }
      resolve(window.paypal);
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")), { once: true });
    document.head.appendChild(script);
  });
}

/** Safe diagnostic fields only — no cookies, tokens, or payment payloads. */
function logPaypalDiag(label, err) {
  const detail = {
    label,
    message: err && err.message ? String(err.message) : String(err || ""),
  };
  if (err && err.status != null) detail.status = err.status;
  if (err && err.data && err.data.error) detail.error = String(err.data.error);
  console.error("[paypal]", detail);
}

function userMessageForApiError(err) {
  const code = err && err.data && err.data.error
    ? String(err.data.error)
    : (err && err.message ? String(err.message) : "");
  if (code === "login_required") return "Log in again to buy tickets.";
  if (code === "forbidden" || code === "paypal_unavailable") {
    return "PayPal checkout is unavailable for this account.";
  }
  if (code === "paypal_create_failed" || code === "request_failed_502") {
    return "Could not start PayPal checkout. Try again.";
  }
  if (code === "unknown_package") return "Unknown ticket package.";
  return "PayPal error. Try again.";
}

async function api(path, { method = "POST", csrf, body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf || "",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request_failed_${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function paypalReturnParams() {
  const params = new URLSearchParams(window.location.search);
  const token = String(params.get("token") || "").trim();
  const payerId = String(params.get("PayerID") || params.get("payerID") || "").trim();
  // Cancel return: same /buy URL with token and no PayerID.
  return { token, payerId, cancelled: Boolean(token) && !payerId };
}

function clearPaypalQuery() {
  const url = new URL(window.location.href);
  ["token", "PayerID", "payerID", "cancelled", "cancel", "ba_token"].forEach((key) => {
    url.searchParams.delete(key);
  });
  const next = url.pathname + (url.search || "") + (url.hash || "");
  window.history.replaceState({}, "", next);
}

async function showCaptureResult(root, result) {
  const tickets = result.tickets || 0;
  const balance = result.balance;
  const msg = result.duplicate
    ? `Already credited ${tickets} tickets.`
    : `Added ${tickets} tickets.`
      + (balance != null ? ` Balance: ${balance}.` : "");
  setStatus(root, msg, "ok");
  window.setTimeout(() => {
    window.location.reload();
  }, 900);
}

async function captureApprovedOrder(root, csrf, orderId) {
  setStatus(root, "Confirming payment…", "busy");
  try {
    const result = await api(`/api/paypal/orders/${encodeURIComponent(orderId)}/capture`, {
      csrf,
    });
    clearPaypalQuery();
    await showCaptureResult(root, result);
  } catch (err) {
    logPaypalDiag("capture", err);
    clearPaypalQuery();
    setStatus(root, `Payment failed: ${err.message || "unknown error"}`, "error");
  }
}

function buttonOptions(root, packageId, csrf) {
  return {
    style: {
      layout: "vertical",
      color: "gold",
      shape: "rect",
      label: "paypal",
      height: 40,
    },
    // Mobile: App Switch / redirect when the PayPal app is available.
    // Desktop keeps the normal popup checkout.
    appSwitchWhenAvailable: true,
    async createOrder() {
      setStatus(root, "Creating PayPal order…", "busy");
      try {
        const data = await api("/api/paypal/orders", {
          csrf,
          body: { packageId },
        });
        const orderId = data.orderId || data.id;
        if (!orderId) throw new Error("missing_order_id");
        setStatus(root, "Approve payment in PayPal…", "busy");
        return orderId;
      } catch (err) {
        logPaypalDiag("createOrder", err);
        setStatus(root, userMessageForApiError(err), "error");
        throw err;
      }
    },
    async onApprove(data) {
      const orderId = data && (data.orderID || data.orderId);
      if (!orderId) {
        setStatus(root, "PayPal error. Try again.", "error");
        return;
      }
      await captureApprovedOrder(root, csrf, orderId);
    },
    onCancel() {
      clearPaypalQuery();
      setStatus(root, "Payment cancelled.", "");
    },
    onError(err) {
      logPaypalDiag("onError", err);
      setStatus(root, userMessageForApiError(err), "error");
    },
  };
}

function mountButtons(paypal, root, packageId, csrf, { resume = false } = {}) {
  const container = root.querySelector(`#paypal-buttons-${packageId}`);
  if (!container || !paypal.Buttons) return { buttons: null, resumed: false };

  const buttons = paypal.Buttons(buttonOptions(root, packageId, csrf));
  let resumed = false;
  if (resume && typeof buttons.resume === "function") {
    try {
      // PayPal docs: resume() before render() after App Switch / redirect return.
      buttons.resume();
      resumed = true;
    } catch (err) {
      logPaypalDiag("resume", err);
    }
  }
  buttons.render(container);
  return { buttons, resumed };
}

async function handleReturnWithoutResume(root, csrf) {
  const { token, payerId } = paypalReturnParams();
  if (!token) return false;
  if (!payerId) {
    clearPaypalQuery();
    setStatus(root, "Payment cancelled.", "");
    return true;
  }
  await captureApprovedOrder(root, csrf, token);
  return true;
}

async function init() {
  const root = document.getElementById("paypal-store");
  if (!root) return;
  const clientId = root.dataset.clientId || "";
  const csrf = root.dataset.csrf || "";
  if (!clientId) {
    setStatus(root, "PayPal is not configured.", "error");
    return;
  }

  const ret = paypalReturnParams();
  const isReturn = Boolean(ret.token);

  setStatus(root, isReturn ? "Returning from PayPal…" : "Loading PayPal…", "busy");
  try {
    const paypal = await loadSdk(clientId);
    const packages = [...root.querySelectorAll(".paypal-package[data-package-id]")];
    let resumed = false;

    if (isReturn && packages.length) {
      // Resume on the first package button so SDK can fire onApprove/onCancel.
      const first = packages[0];
      const mounted = mountButtons(paypal, root, first.dataset.packageId, csrf, { resume: true });
      resumed = mounted.resumed;
      for (let i = 1; i < packages.length; i += 1) {
        mountButtons(paypal, root, packages[i].dataset.packageId, csrf);
      }
      if (!resumed) {
        await handleReturnWithoutResume(root, csrf);
      } else if (!ret.payerId) {
        // Cancel return: SDK may not always call onCancel; show status.
        clearPaypalQuery();
        setStatus(root, "Payment cancelled.", "");
      } else {
        // Resume should invoke onApprove; keep a capture fallback if it does not.
        setStatus(root, "Confirming payment…", "busy");
        window.setTimeout(() => {
          const el = statusEl(root);
          const kind = el && el.dataset.kind;
          if (kind === "ok" || kind === "error") return;
          handleReturnWithoutResume(root, csrf);
        }, 2500);
      }
    } else {
      for (const el of packages) {
        mountButtons(paypal, root, el.dataset.packageId, csrf);
      }
      setStatus(root, "", "");
    }
  } catch (err) {
    logPaypalDiag("init", err);
    if (isReturn && ret.payerId) {
      // SDK failed after approve — still try server capture.
      await handleReturnWithoutResume(root, csrf);
      return;
    }
    setStatus(root, "Could not load PayPal Checkout.", "error");
  }
}

init();
