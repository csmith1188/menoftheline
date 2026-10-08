/**
 * PayPal JS SDK buttons for ticket packages.
 * Server creates/captures orders; this file only handles UI callbacks.
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

function mountButtons(paypal, root, packageId, csrf) {
  const container = root.querySelector(`#paypal-buttons-${packageId}`);
  if (!container || !paypal.Buttons) return;

  paypal.Buttons({
    style: {
      layout: "vertical",
      color: "gold",
      shape: "rect",
      label: "paypal",
      height: 40,
    },
    async createOrder() {
      setStatus(root, "Creating PayPal order…", "busy");
      const data = await api("/api/paypal/orders", {
        csrf,
        body: { packageId },
      });
      const orderId = data.orderId || data.id;
      if (!orderId) throw new Error("missing_order_id");
      setStatus(root, "Approve payment in PayPal…", "busy");
      return orderId;
    },
    async onApprove(data) {
      setStatus(root, "Confirming payment…", "busy");
      try {
        const result = await api(`/api/paypal/orders/${encodeURIComponent(data.orderID)}/capture`, {
          csrf,
        });
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
      } catch (err) {
        setStatus(root, `Payment failed: ${err.message || "unknown error"}`, "error");
      }
    },
    onCancel() {
      setStatus(root, "Payment cancelled.", "");
    },
    onError(err) {
      console.error(err);
      setStatus(root, "PayPal error. Try again.", "error");
    },
  }).render(container);
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
  setStatus(root, "Loading PayPal…", "busy");
  try {
    const paypal = await loadSdk(clientId);
    const packages = root.querySelectorAll(".paypal-package[data-package-id]");
    for (const el of packages) {
      mountButtons(paypal, root, el.dataset.packageId, csrf);
    }
    setStatus(root, "", "");
  } catch (err) {
    console.error(err);
    setStatus(root, "Could not load PayPal Checkout.", "error");
  }
}

init();
