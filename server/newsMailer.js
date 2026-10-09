import { randomBytes } from "crypto";
import {
  accountEmailVerified,
  hashToken,
  newAuthToken,
} from "./auth.js";
import {
  claimNewsletterOutboxRow,
  completeNewsletterOutboxFailed,
  completeNewsletterOutboxSent,
  completeNewsletterOutboxSkipped,
  createNewsletterCampaign,
  getActiveCampaignForNews,
  issueNewsletterUnsubToken,
  isAccountBanned,
  listNewsEmailEligibleAccounts,
  newsEmailOptedIn,
  pauseCampaignForQuota,
  pauseNewsletterCampaign,
  resumeNewsletterCampaign,
  cancelNewsletterCampaign,
  getNewsletterCampaign,
} from "./db.js";
import { asErr, logger } from "./logger.js";
import { mailReady, sendNewsEmail } from "./mail.js";
import { getNewsById, defaultEmailSubject } from "./newsStore.js";
import { buildNewsEmailPayload } from "./newsRender.js";

const WORKER_ID = `news-${process.pid}-${randomBytes(4).toString("hex")}`;

let tickTimer = null;
let ticking = false;
let lastSendAt = 0;
/** @type {number[]} */
const sendTimestamps = [];

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function newsMailConfig() {
  return {
    batchSize: envInt("NEWS_MAIL_BATCH_SIZE", 1),
    concurrency: envInt("NEWS_MAIL_CONCURRENCY", 1),
    delayMs: envInt("NEWS_MAIL_DELAY_MS", 60_000),
    maxPerHour: envInt("NEWS_MAIL_MAX_PER_HOUR", 70),
    maxAttempts: envInt("NEWS_MAIL_MAX_ATTEMPTS", 5),
    tickMs: envInt("NEWS_MAIL_TICK_MS", 5_000),
  };
}

function siteBase() {
  return String(process.env.THIS_URL || "http://localhost:3000").replace(/\/$/, "");
}

function pruneSendWindow(now = Date.now()) {
  const hourAgo = now - 60 * 60 * 1000;
  while (sendTimestamps.length && sendTimestamps[0] < hourAgo) {
    sendTimestamps.shift();
  }
}

export function newsMailSendsLastHour() {
  pruneSendWindow();
  return sendTimestamps.length;
}

export function newsMailHourlyBudgetRemaining() {
  const { maxPerHour } = newsMailConfig();
  return Math.max(0, maxPerHour - newsMailSendsLastHour());
}

function isQuotaError(err) {
  const msg = String(err && (err.message || err.response || err) || "").toLowerCase();
  const code = err && (err.responseCode || err.code);
  return /quota|policy rejection|rate.?limit|too many/i.test(msg)
    || code === 421
    || code === 450
    || code === 452;
}

function isTransientError(err) {
  if (isQuotaError(err)) return true;
  const code = err && (err.code || err.responseCode);
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNECTION" || code === "ESOCKET") {
    return true;
  }
  const n = Number(code);
  if (Number.isFinite(n) && n >= 400 && n < 500) return true;
  return false;
}

export async function ensureUnsubTokenForAccount(accountId) {
  const token = newAuthToken();
  await issueNewsletterUnsubToken(accountId, hashToken(token));
  return token;
}

export function unsubscribeUrlForToken(token) {
  return `${siteBase()}/unsubscribe/news?token=${encodeURIComponent(token)}`;
}

export async function startNewsCampaign({ newsId, createdBy }) {
  const entry = getNewsById(newsId);
  if (!entry) return { ok: false, error: "news_not_found" };
  if (!mailReady()) return { ok: false, error: "mail_not_ready" };

  const active = await getActiveCampaignForNews(entry.id);
  if (active) return { ok: false, error: "campaign_active", campaignId: active.id };

  const recipients = await listNewsEmailEligibleAccounts();
  if (!recipients.length) return { ok: false, error: "no_recipients" };

  const subject = defaultEmailSubject(entry);
  const result = await createNewsletterCampaign({
    newsId: entry.id,
    subject,
    createdBy,
    recipients,
  });
  if (!result.ok) return result;
  logger.info({
    event: "newsletter_campaign_queued",
    campaignId: result.campaignId,
    newsId: entry.id,
    total: result.total,
    createdBy,
  }, "newsletter campaign queued");
  return { ok: true, campaignId: result.campaignId, total: result.total, subject };
}

export async function sendNewsTestEmail({ newsId, account }) {
  const entry = getNewsById(newsId);
  if (!entry) return { ok: false, error: "news_not_found" };
  if (!account || !account.email) return { ok: false, error: "no_email" };
  if (!accountEmailVerified(account)) return { ok: false, error: "unverified" };
  if (!mailReady()) return { ok: false, error: "mail_not_ready" };

  const token = await ensureUnsubTokenForAccount(account.id);
  const payload = buildNewsEmailPayload(entry, {
    siteUrl: siteBase(),
    unsubscribeUrl: unsubscribeUrlForToken(token),
  });
  const info = await sendNewsEmail({
    to: account.email,
    subject: `[Test] ${payload.subject}`,
    text: payload.text,
    html: payload.html,
    unsubscribeUrl: unsubscribeUrlForToken(token),
  });
  return { ok: true, messageId: info && info.messageId };
}

function recipientStillEligible(account) {
  if (!account || !account.email) return { ok: false, reason: "no_email" };
  if (!accountEmailVerified(account)) return { ok: false, reason: "unverified" };
  if (!newsEmailOptedIn(account)) return { ok: false, reason: "opted_out" };
  if (isAccountBanned(account)) return { ok: false, reason: "banned" };
  return { ok: true };
}

async function processOneOutbox() {
  const cfg = newsMailConfig();
  pruneSendWindow();
  if (sendTimestamps.length >= cfg.maxPerHour) return { skipped: "hourly_cap" };
  if (lastSendAt && Date.now() - lastSendAt < cfg.delayMs) {
    return { skipped: "delay" };
  }

  const claimed = await claimNewsletterOutboxRow(WORKER_ID);
  if (!claimed) return { skipped: "empty" };

  const { outbox, account } = claimed;
  const campaign = await getNewsletterCampaign(outbox.campaign_id);
  if (!campaign || campaign.status === "paused" || campaign.status === "cancelled") {
    await completeNewsletterOutboxSkipped(outbox.id, outbox.campaign_id, "campaign_not_active");
    return { skipped: "campaign" };
  }

  const eligibility = recipientStillEligible(account);
  if (!eligibility.ok) {
    await completeNewsletterOutboxSkipped(outbox.id, outbox.campaign_id, eligibility.reason);
    return { skipped: eligibility.reason };
  }

  const entry = getNewsById(campaign.news_id);
  if (!entry) {
    await completeNewsletterOutboxFailed(outbox.id, outbox.campaign_id, "news_missing", {
      permanent: true,
    });
    return { failed: "news_missing" };
  }

  try {
    const token = await ensureUnsubTokenForAccount(account.id);
    const unsub = unsubscribeUrlForToken(token);
    const payload = buildNewsEmailPayload(entry, {
      siteUrl: siteBase(),
      unsubscribeUrl: unsub,
    });
    const info = await sendNewsEmail({
      to: account.email,
      subject: campaign.subject || payload.subject,
      text: payload.text,
      html: payload.html,
      unsubscribeUrl: unsub,
    });
    lastSendAt = Date.now();
    sendTimestamps.push(lastSendAt);
    await completeNewsletterOutboxSent(
      outbox.id,
      outbox.campaign_id,
      info && info.messageId,
    );
    logger.info({
      event: "newsletter_send_ok",
      campaignId: outbox.campaign_id,
      accountId: account.id,
      toDomain: outbox.email_domain,
    }, "newsletter message sent");
    return { sent: true };
  } catch (err) {
    const attempts = Number(outbox.attempts || 0) + 1;
    if (isQuotaError(err)) {
      const resumeAt = Date.now() + 60 * 60 * 1000;
      await completeNewsletterOutboxFailed(outbox.id, outbox.campaign_id, err.message || "quota", {
        retryAt: resumeAt,
      });
      await pauseCampaignForQuota(
        outbox.campaign_id,
        resumeAt,
        "SMTP quota exceeded; campaign paused for 1 hour",
      );
      logger.warn({
        event: "newsletter_quota_pause",
        campaignId: outbox.campaign_id,
        err: asErr(err),
      }, "newsletter paused for SMTP quota");
      return { paused: true };
    }
    if (isTransientError(err) && attempts < cfg.maxAttempts) {
      const backoff = Math.min(
        60 * 60 * 1000,
        cfg.delayMs * (2 ** Math.max(0, attempts - 1)),
      );
      await completeNewsletterOutboxFailed(outbox.id, outbox.campaign_id, err.message || "transient", {
        retryAt: Date.now() + backoff,
      });
      return { retry: true };
    }
    await completeNewsletterOutboxFailed(outbox.id, outbox.campaign_id, err.message || "failed", {
      permanent: true,
    });
    logger.error({
      event: "newsletter_send_failed",
      campaignId: outbox.campaign_id,
      accountId: account && account.id,
      toDomain: outbox.email_domain,
      err: asErr(err),
    }, "newsletter message failed");
    return { failed: true };
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!mailReady()) return;
    const cfg = newsMailConfig();
    const n = Math.max(1, Math.min(cfg.batchSize, cfg.concurrency));
    for (let i = 0; i < n; i += 1) {
      const result = await processOneOutbox();
      if (result.skipped === "empty" || result.skipped === "delay" || result.skipped === "hourly_cap") {
        break;
      }
      if (result.paused) break;
    }
  } catch (err) {
    logger.error({ event: "newsletter_tick_failed", err: asErr(err) }, "newsletter tick failed");
  } finally {
    ticking = false;
  }
}

export function startNewsMailer() {
  if (tickTimer) return;
  const { tickMs } = newsMailConfig();
  const run = () => {
    tick().catch((err) => {
      logger.error({ event: "newsletter_tick_failed", err: asErr(err) }, "newsletter tick failed");
    });
  };
  run();
  tickTimer = setInterval(run, tickMs);
  if (typeof tickTimer.unref === "function") tickTimer.unref();
  logger.info({ event: "newsletter_mailer_started", workerId: WORKER_ID }, "newsletter mailer started");
}

export function stopNewsMailer() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export {
  pauseNewsletterCampaign,
  resumeNewsletterCampaign,
  cancelNewsletterCampaign,
};

/** Test helpers */
export async function __testProcessOneOutbox() {
  return processOneOutbox();
}

export function __testResetMailerState() {
  lastSendAt = 0;
  sendTimestamps.length = 0;
}
