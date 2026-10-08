/**
 * PayPal Orders v2 REST client + settlement helpers.
 * Client secret stays on the server; browsers only see PAYPAL_CLIENT_ID.
 */

import { accountEmailVerified, discordLoginEnabled, localAccountsEnabled } from "./auth.js";
import {
  claimPaypalWebhookEvent,
  clawbackPaypalPurchase,
  createPaypalPurchase,
  creditPaypalPurchase,
  getPaypalPurchaseByCaptureId,
  getPaypalPurchaseByOrderId,
  listStalePaypalPurchases,
  markPaypalPurchaseApproved,
  markPaypalPurchaseCaptured,
  markPaypalPurchaseDenied,
  markPaypalPurchaseFailed,
  paypalWebhookEventSeen,
} from "./db.js";
import { asErr, logger } from "./logger.js";
import { getPaypalPackage, listPaypalPackages } from "./paypalPackages.js";

export { getPaypalPackage, listPaypalPackages };

/** Injectable fetch for tests. */
let paypalFetch = globalThis.fetch.bind(globalThis);

export function setPaypalFetch(fn) {
  paypalFetch = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

export function resetPaypalFetch() {
  paypalFetch = globalThis.fetch.bind(globalThis);
}

function envTrim(name) {
  return String(process.env[name] || "").trim();
}

export function paypalMode() {
  const mode = envTrim("PAYPAL_MODE").toLowerCase();
  return mode === "live" ? "live" : "sandbox";
}

export function paypalApiBase() {
  return paypalMode() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function paypalClientId() {
  return envTrim("PAYPAL_CLIENT_ID");
}

function paypalClientSecret() {
  return envTrim("PAYPAL_CLIENT_SECRET");
}

export function paypalWebhookId() {
  return envTrim("PAYPAL_WEBHOOK_ID");
}

export function paypalMerchantId() {
  return envTrim("PAYPAL_MERCHANT_ID");
}

/** Credentials present and local or Discord login enabled. */
export function paypalCheckoutEnabled() {
  if (!paypalClientId() || !paypalClientSecret()) return false;
  return localAccountsEnabled() || discordLoginEnabled();
}

export function paypalClientIdPublic() {
  return paypalCheckoutEnabled() ? paypalClientId() : "";
}

/**
 * Account may use PayPal ticket store: feature on, verified, no Formbar link.
 */
export function accountCanBuyPaypal(account) {
  if (!paypalCheckoutEnabled()) return false;
  if (!account || !account.id) return false;
  if (account.formbar_id != null && Number(account.formbar_id) > 0) return false;
  if (!accountEmailVerified(account)) return false;
  return true;
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export function clearPaypalTokenCache() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }
  const id = paypalClientId();
  const secret = paypalClientSecret();
  if (!id || !secret) {
    throw Object.assign(new Error("PayPal credentials not configured"), { code: "paypal_disabled" });
  }
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await paypalFetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    logger.warn({
      event: "paypal_oauth_failed",
      status: res.status,
    }, "PayPal OAuth failed");
    throw Object.assign(new Error("PayPal OAuth failed"), {
      code: "paypal_oauth",
      status: res.status,
    });
  }
  cachedToken = body.access_token;
  const expiresIn = Number(body.expires_in) || 3600;
  cachedTokenExpiresAt = now + expiresIn * 1000;
  return cachedToken;
}

async function paypalRequest(method, path, { body, idempotencyKey } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (idempotencyKey) {
    headers["PayPal-Request-Id"] = String(idempotencyKey);
  }
  const res = await paypalFetch(`${paypalApiBase()}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} failed`);
    err.code = "paypal_api";
    err.status = res.status;
    err.paypal = data;
    throw err;
  }
  return data;
}

export async function createPaypalOrder({ packageId, accountId, returnUrl, cancelUrl } = {}) {
  const pkg = getPaypalPackage(packageId);
  if (!pkg) {
    return { ok: false, error: "unknown_package" };
  }
  const account = Number(accountId);
  if (!Number.isInteger(account) || account <= 0) {
    return { ok: false, error: "invalid_account" };
  }

  // Prefer payment_source.paypal.experience_context only — do not also send
  // application_context (deprecated); PayPal returns 422 INCOMPATIBLE_PARAMETER_VALUE.
  const experience = {
    brand_name: "Men of the Line",
    shipping_preference: "NO_SHIPPING",
    user_action: "PAY_NOW",
  };
  const ret = String(returnUrl || "").trim();
  const can = String(cancelUrl || "").trim();
  if (ret) experience.return_url = ret;
  if (can) experience.cancel_url = can;

  const orderBody = {
    intent: "CAPTURE",
    purchase_units: [{
      amount: {
        currency_code: pkg.currency,
        value: pkg.amountValue,
      },
      description: `Men of the Line — ${pkg.label}`,
      custom_id: `motl:${account}:${pkg.id}`,
    }],
    payment_source: {
      paypal: {
        experience_context: experience,
      },
    },
  };

  let order;
  try {
    order = await paypalRequest("POST", "/v2/checkout/orders", {
      body: orderBody,
      idempotencyKey: `create-${account}-${pkg.id}-${Date.now()}`,
    });
  } catch (err) {
    logger.warn({
      event: "paypal_create_order_failed",
      accountId: account,
      packageId: pkg.id,
      err: asErr(err),
    }, "PayPal create order failed");
    return { ok: false, error: "paypal_create_failed" };
  }

  const orderId = String(order && order.id || "").trim();
  if (!orderId) {
    return { ok: false, error: "paypal_create_failed" };
  }

  const purchase = await createPaypalPurchase({
    accountId: account,
    packageId: pkg.id,
    amountValue: pkg.amountValue,
    currency: pkg.currency,
    tickets: pkg.tickets,
    paypalOrderId: orderId,
  });
  if (!purchase) {
    return { ok: false, error: "db_create_failed" };
  }

  logger.info({
    event: "paypal_order_created",
    accountId: account,
    purchaseId: purchase.id,
    orderId,
    packageId: pkg.id,
  }, "PayPal order created");

  return { ok: true, orderId, purchase, package: pkg };
}

export async function getPaypalOrder(orderId) {
  const oid = String(orderId || "").trim();
  if (!oid) throw Object.assign(new Error("missing order id"), { code: "invalid" });
  return paypalRequest("GET", `/v2/checkout/orders/${encodeURIComponent(oid)}`);
}

export async function capturePaypalOrder(orderId) {
  const oid = String(orderId || "").trim();
  if (!oid) throw Object.assign(new Error("missing order id"), { code: "invalid" });
  return paypalRequest("POST", `/v2/checkout/orders/${encodeURIComponent(oid)}/capture`, {
    body: {},
    idempotencyKey: `capture-${oid}`,
  });
}

function captureFromOrder(order) {
  const units = order && order.purchase_units;
  if (!Array.isArray(units) || !units.length) return null;
  const payments = units[0].payments;
  const captures = payments && payments.captures;
  if (!Array.isArray(captures) || !captures.length) return null;
  return captures[0];
}

function amountFromCaptureOrUnit(order, capture) {
  if (capture && capture.amount) {
    return {
      value: String(capture.amount.value || ""),
      currency: String(capture.amount.currency_code || "").toUpperCase(),
    };
  }
  const unit = order && order.purchase_units && order.purchase_units[0];
  if (unit && unit.amount) {
    return {
      value: String(unit.amount.value || ""),
      currency: String(unit.amount.currency_code || "").toUpperCase(),
    };
  }
  return { value: "", currency: "" };
}

/**
 * Verify PayPal order/capture matches our purchase package and optional merchant.
 */
export function verifyPaypalPayment(purchase, order) {
  if (!purchase || !order) {
    return { ok: false, error: "missing" };
  }
  const pkg = getPaypalPackage(purchase.package_id);
  if (!pkg) {
    return { ok: false, error: "unknown_package" };
  }
  const status = String(order.status || "").toUpperCase();
  const capture = captureFromOrder(order);
  const captureStatus = capture
    ? String(capture.status || "").toUpperCase()
    : "";
  const completed = status === "COMPLETED"
    || captureStatus === "COMPLETED";
  if (!completed) {
    return { ok: false, error: "not_completed", status, captureStatus };
  }
  const { value, currency } = amountFromCaptureOrUnit(order, capture);
  if (value !== pkg.amountValue || currency !== pkg.currency) {
    return {
      ok: false,
      error: "amount_mismatch",
      expected: { value: pkg.amountValue, currency: pkg.currency },
      actual: { value, currency },
    };
  }
  const expectedMerchant = paypalMerchantId();
  if (expectedMerchant) {
    const mid = String(
      (order.purchase_units && order.purchase_units[0] && order.purchase_units[0].payee
        && order.purchase_units[0].payee.merchant_id)
        || (capture && capture.payee && capture.payee.merchant_id)
        || "",
    ).trim();
    // When PayPal omits payee on capture responses, skip merchant check.
    if (mid && mid !== expectedMerchant) {
      return { ok: false, error: "merchant_mismatch", merchant: mid };
    }
  }
  const captureId = capture ? String(capture.id || "").trim() : "";
  if (!captureId) {
    return { ok: false, error: "missing_capture" };
  }
  return { ok: true, captureId, capture, package: pkg };
}

/**
 * Capture (if needed), verify, mark captured, credit tickets.
 * Safe for browser capture route, webhooks, and reconciliation.
 */
export async function settlePaypalPurchase(orderId, { accountId = null, captureIfNeeded = true } = {}) {
  const oid = String(orderId || "").trim();
  if (!oid) return { ok: false, error: "invalid_order" };

  const purchase = await getPaypalPurchaseByOrderId(oid);
  if (!purchase) return { ok: false, error: "not_found" };
  if (accountId != null && Number(purchase.account_id) !== Number(accountId)) {
    return { ok: false, error: "forbidden" };
  }
  if (purchase.status === "credited") {
    return { ok: true, duplicate: true, purchase, credited: false };
  }
  if (purchase.status === "refunded" || purchase.status === "reversed") {
    return { ok: false, error: "already_refunded", purchase };
  }
  if (purchase.status === "failed" || purchase.status === "denied") {
    return { ok: false, error: "failed", purchase };
  }

  let order;
  try {
    order = await getPaypalOrder(oid);
  } catch (err) {
    logger.warn({
      event: "paypal_get_order_failed",
      orderId: oid,
      purchaseId: purchase.id,
      err: asErr(err),
    }, "PayPal get order failed");
    return { ok: false, error: "paypal_get_failed" };
  }

  const orderStatus = String(order.status || "").toUpperCase();
  if (orderStatus === "APPROVED") {
    await markPaypalPurchaseApproved(purchase.id);
  }

  let working = order;
  if (captureIfNeeded && orderStatus === "APPROVED") {
    try {
      working = await capturePaypalOrder(oid);
    } catch (err) {
      // Capture may race with webhook; re-fetch
      logger.info({
        event: "paypal_capture_retry_get",
        orderId: oid,
        err: asErr(err),
      }, "PayPal capture failed; re-fetching order");
      try {
        working = await getPaypalOrder(oid);
      } catch (getErr) {
        return { ok: false, error: "paypal_capture_failed", detail: asErr(getErr) };
      }
    }
  }

  const verified = verifyPaypalPayment(purchase, working);
  if (!verified.ok) {
    if (verified.error === "not_completed") {
      return { ok: false, error: "not_completed", purchase, detail: verified };
    }
    await markPaypalPurchaseFailed(purchase.id, verified.error);
    logger.warn({
      event: "paypal_verify_failed",
      purchaseId: purchase.id,
      orderId: oid,
      reason: verified.error,
    }, "PayPal payment verification failed");
    return { ok: false, error: verified.error, detail: verified };
  }

  const marked = await markPaypalPurchaseCaptured(purchase.id, verified.captureId);
  if (!marked.ok && marked.error === "capture_taken") {
    const other = await getPaypalPurchaseByCaptureId(verified.captureId);
    if (other && other.id === purchase.id) {
      // fall through
    } else {
      return { ok: false, error: "capture_taken" };
    }
  }
  if (!marked.ok && !marked.alreadySettled) {
    return { ok: false, error: marked.error || "capture_mark_failed" };
  }

  const credit = await creditPaypalPurchase(purchase.id);
  if (!credit.ok && credit.error === "race") {
    const again = await creditPaypalPurchase(purchase.id);
    return again.ok
      ? {
        ok: true,
        purchase: again.purchase,
        credited: again.credited,
        duplicate: again.duplicate,
        balance: again.balance,
      }
      : { ok: false, error: again.error || "credit_failed" };
  }
  if (!credit.ok) {
    return { ok: false, error: credit.error || "credit_failed", purchase: credit.purchase };
  }

  logger.info({
    event: "paypal_purchase_credited",
    purchaseId: purchase.id,
    accountId: purchase.account_id,
    orderId: oid,
    captureId: verified.captureId,
    tickets: purchase.tickets,
    credited: credit.credited,
    duplicate: Boolean(credit.duplicate),
  }, "PayPal purchase settled");

  return {
    ok: true,
    purchase: credit.purchase,
    credited: credit.credited,
    duplicate: Boolean(credit.duplicate),
    balance: credit.balance,
  };
}

export async function verifyPaypalWebhookSignature({ headers, rawBody }) {
  const webhookId = paypalWebhookId();
  if (!webhookId) {
    return { ok: false, error: "webhook_not_configured" };
  }
  const transmissionId = headers["paypal-transmission-id"]
    || headers["PAYPAL-TRANSMISSION-ID"];
  const transmissionTime = headers["paypal-transmission-time"]
    || headers["PAYPAL-TRANSMISSION-TIME"];
  const certUrl = headers["paypal-cert-url"]
    || headers["PAYPAL-CERT-URL"];
  const authAlgo = headers["paypal-auth-algo"]
    || headers["PAYPAL-AUTH-ALGO"];
  const transmissionSig = headers["paypal-transmission-sig"]
    || headers["PAYPAL-TRANSMISSION-SIG"];
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return { ok: false, error: "missing_headers" };
  }
  let webhookEvent;
  try {
    webhookEvent = typeof rawBody === "string" ? JSON.parse(rawBody) : JSON.parse(String(rawBody));
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  try {
    const result = await paypalRequest("POST", "/v1/notifications/verify-webhook-signature", {
      body: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      },
    });
    const status = String(result && result.verification_status || "").toUpperCase();
    if (status !== "SUCCESS") {
      return { ok: false, error: "verification_failed", status };
    }
    return { ok: true, event: webhookEvent };
  } catch (err) {
    logger.warn({
      event: "paypal_webhook_verify_failed",
      err: asErr(err),
    }, "PayPal webhook verification failed");
    return { ok: false, error: "verify_request_failed" };
  }
}

function orderIdFromWebhookResource(resource, eventType) {
  if (!resource) return "";
  if (resource.id && String(eventType || "").startsWith("CHECKOUT.ORDER.")) {
    return String(resource.id);
  }
  if (resource.supplementary_data && resource.supplementary_data.related_ids) {
    const oid = resource.supplementary_data.related_ids.order_id;
    if (oid) return String(oid);
  }
  if (Array.isArray(resource.purchase_units)) {
    return String(resource.id || "");
  }
  return String(resource.id || "");
}

function captureIdFromWebhookResource(resource) {
  if (!resource) return "";
  if (resource.id && !resource.purchase_units) return String(resource.id);
  const cap = captureFromOrder(resource);
  return cap ? String(cap.id || "") : "";
}

export async function handlePaypalWebhookEvent(event) {
  const eventId = String(event && event.id || "").trim();
  const eventType = String(event && event.event_type || "").trim();
  if (!eventId) return { ok: false, error: "missing_event_id" };

  if (await paypalWebhookEventSeen(eventId)) {
    return { ok: true, duplicate: true };
  }

  const resource = event.resource || {};
  let purchase = null;
  const orderId = orderIdFromWebhookResource(resource, eventType);
  const captureId = captureIdFromWebhookResource(resource);

  if (orderId) purchase = await getPaypalPurchaseByOrderId(orderId);
  if (!purchase && captureId) purchase = await getPaypalPurchaseByCaptureId(captureId);

  const claimed = await claimPaypalWebhookEvent(
    eventId,
    eventType,
    purchase ? purchase.id : null,
  );
  if (!claimed) {
    return { ok: true, duplicate: true };
  }

  switch (eventType) {
    case "CHECKOUT.ORDER.APPROVED": {
      if (!purchase) return { ok: true, ignored: true, reason: "unknown_order" };
      await markPaypalPurchaseApproved(purchase.id);
      const settled = await settlePaypalPurchase(purchase.paypal_order_id, {
        captureIfNeeded: true,
      });
      return { ok: true, settled };
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      if (!purchase && orderId) {
        purchase = await getPaypalPurchaseByOrderId(orderId);
      }
      if (!purchase) return { ok: true, ignored: true, reason: "unknown_capture" };
      const settled = await settlePaypalPurchase(purchase.paypal_order_id, {
        captureIfNeeded: false,
      });
      // If get-order already has capture, settle will credit; if only capture
      // resource, mark captured from webhook payload then credit.
      if (!settled.ok && settled.error === "not_completed" && captureId) {
        const marked = await markPaypalPurchaseCaptured(purchase.id, captureId);
        if (marked.ok || marked.alreadySettled) {
          const credit = await creditPaypalPurchase(purchase.id);
          return { ok: true, credit };
        }
      }
      // When settle failed verify because getOrder shape differs, try mark+credit
      if (!settled.ok && captureId && purchase.status !== "credited") {
        const pkg = getPaypalPackage(purchase.package_id);
        const amount = resource.amount || {};
        const value = String(amount.value || "");
        const currency = String(amount.currency_code || "").toUpperCase();
        if (pkg && value === pkg.amountValue && currency === pkg.currency) {
          const expectedMerchant = paypalMerchantId();
          const mid = String(
            (resource.payee && resource.payee.merchant_id) || "",
          ).trim();
          if (!expectedMerchant || !mid || mid === expectedMerchant) {
            await markPaypalPurchaseCaptured(purchase.id, captureId);
            const credit = await creditPaypalPurchase(purchase.id);
            return { ok: true, credit };
          }
        }
      }
      return { ok: true, settled };
    }
    case "PAYMENT.CAPTURE.DENIED": {
      if (purchase) await markPaypalPurchaseDenied(purchase.id);
      return { ok: true };
    }
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED": {
      if (!purchase) return { ok: true, ignored: true, reason: "unknown_capture" };
      const status = eventType.endsWith("REVERSED") ? "reversed" : "refunded";
      const result = await clawbackPaypalPurchase(purchase.id, {
        status,
        reason: eventType,
      });
      if (result.ok && result.shortfall > 0) {
        logger.warn({
          event: "paypal_clawback_shortfall",
          purchaseId: purchase.id,
          accountId: purchase.account_id,
          shortfall: result.shortfall,
          applied: result.applied,
        }, "PayPal clawback shortfall; admin review needed");
      }
      return { ok: true, clawback: result };
    }
    default:
      return { ok: true, ignored: true, reason: "unhandled_type" };
  }
}

export async function reconcileStalePaypalPurchases({ olderThanMs = 120_000, limit = 25 } = {}) {
  if (!paypalCheckoutEnabled()) return { ok: true, processed: 0 };
  const rows = await listStalePaypalPurchases({ olderThanMs, limit });
  let processed = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await settlePaypalPurchase(row.paypal_order_id, { captureIfNeeded: true });
      processed += 1;
    } catch (err) {
      logger.warn({
        event: "paypal_reconcile_failed",
        purchaseId: row.id,
        orderId: row.paypal_order_id,
        err: asErr(err),
      }, "PayPal reconcile failed");
    }
  }
  return { ok: true, processed, considered: rows.length };
}

let reconcileTimer = null;

export function startPaypalReconcileLoop(intervalMs = 15 * 60 * 1000) {
  if (reconcileTimer || !paypalCheckoutEnabled()) return;
  const tick = () => {
    reconcileStalePaypalPurchases().catch((err) => {
      logger.warn({
        event: "paypal_reconcile_tick_failed",
        err: asErr(err),
      }, "PayPal reconcile tick failed");
    });
  };
  reconcileTimer = setInterval(tick, intervalMs);
  if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
  // Initial delayed pass so startup is not blocked
  setTimeout(tick, 30_000).unref?.();
}

export function stopPaypalReconcileLoop() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
