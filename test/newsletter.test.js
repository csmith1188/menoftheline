import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-newsletter-"));
const newsPath = path.join(dataDir, "news.json");
process.env.DATA_DIR = dataDir;
process.env.NEWS_JSON_PATH = newsPath;
process.env.AUTH_EMAIL = "1";
process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_FROM = "news@example.com";
process.env.THIS_URL = "https://example.com";
process.env.NEWS_MAIL_DELAY_MS = "1";
process.env.NEWS_MAIL_MAX_PER_HOUR = "1000";
process.env.NEWS_MAIL_TICK_MS = "60000";
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;
delete process.env.ADMIN_USER_ID;

fs.writeFileSync(
  newsPath,
  `${JSON.stringify([
    {
      id: "2026-05-01-hello",
      date: "2026-05-01",
      title: "Hello",
      summary: "Summary",
      items: ["One"],
    },
  ], null, 2)}\n`,
);

const {
  initDb,
  createLocalAccount,
  getAccount,
  setEmailVerified,
  setNewsEmailOptIn,
  listNewsEmailEligibleAccounts,
  countNewsEmailEligible,
  issueNewsletterUnsubToken,
  findAccountByNewsletterUnsubToken,
  revokeNewsletterUnsubToken,
  createNewsletterCampaign,
  claimNewsletterOutboxRow,
  getActiveCampaignForNews,
  getNewsletterCampaign,
  completeNewsletterOutboxFailed,
  pauseCampaignForQuota,
  banAccount,
  cancelNewsletterCampaign,
} = await import("../server/db.js");
const { hashPassword, hashToken, newAuthToken } = await import("../server/auth.js");
const { setMailCapture, clearMailCapture } = await import("../server/mail.js");
const { setNewsFilePath, upsertNewsEntry } = await import("../server/newsStore.js");
const {
  startNewsCampaign,
  sendNewsTestEmail,
  __testProcessOneOutbox,
  __testResetMailerState,
  unsubscribeUrlForToken,
} = await import("../server/newsMailer.js");

setNewsFilePath(newsPath);
await initDb();
__testResetMailerState();

let seq = 0;
async function makeUser({ verified = true, optedIn = false } = {}) {
  seq += 1;
  const account = await createLocalAccount({
    email: `news${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name: `News User ${seq}`,
    verifiedAt: verified ? Date.now() : null,
  });
  if (verified) {
    await setEmailVerified(account.id, Date.now(), { reason: "test" });
  }
  if (optedIn) {
    await setNewsEmailOptIn(account.id, true, { source: "test" });
  }
  return getAccount(account.id);
}

test("existing accounts default to news email opt-out", async () => {
  const account = await makeUser({ verified: true, optedIn: false });
  assert.equal(Number(account.news_email_opt_in), 0);
  const eligible = await listNewsEmailEligibleAccounts();
  assert.ok(!eligible.some((a) => a.id === account.id));
});

test("opt-in and opt-out update eligibility", async () => {
  const account = await makeUser({ verified: true });
  await setNewsEmailOptIn(account.id, true, { source: "profile", ip: "1.2.3.4" });
  let eligible = await listNewsEmailEligibleAccounts();
  assert.ok(eligible.some((a) => a.id === account.id));
  await setNewsEmailOptIn(account.id, false, { source: "profile" });
  eligible = await listNewsEmailEligibleAccounts();
  assert.ok(!eligible.some((a) => a.id === account.id));
});

test("unverified and banned accounts are not eligible", async () => {
  const unverified = await makeUser({ verified: false });
  await setNewsEmailOptIn(unverified.id, true, { source: "test" });
  let eligible = await listNewsEmailEligibleAccounts();
  assert.ok(!eligible.some((a) => a.id === unverified.id));

  const banned = await makeUser({ verified: true, optedIn: true });
  await banAccount(banned.id, { reason: "ban test", bannedBy: null });
  eligible = await listNewsEmailEligibleAccounts();
  assert.ok(!eligible.some((a) => a.id === banned.id));
});

test("unsubscribe token opts out and revokes tokens", async () => {
  const account = await makeUser({ verified: true, optedIn: true });
  const token = newAuthToken();
  await issueNewsletterUnsubToken(account.id, hashToken(token));
  const found = await findAccountByNewsletterUnsubToken(hashToken(token));
  assert.equal(found.id, account.id);
  await setNewsEmailOptIn(account.id, false, { source: "unsubscribe_link" });
  await revokeNewsletterUnsubToken(hashToken(token));
  const again = await findAccountByNewsletterUnsubToken(hashToken(token));
  assert.equal(again, null);
  assert.match(unsubscribeUrlForToken(token), /\/unsubscribe\/news\?token=/);
});

test("duplicate active campaign is blocked", async () => {
  await makeUser({ verified: true, optedIn: true });
  // Clear any prior campaign on this news id
  const prior = await getActiveCampaignForNews("2026-05-01-hello");
  if (prior) await cancelNewsletterCampaign(prior.id);

  const first = await startNewsCampaign({ newsId: "2026-05-01-hello", createdBy: 1 });
  assert.equal(first.ok, true);
  const second = await startNewsCampaign({ newsId: "2026-05-01-hello", createdBy: 1 });
  assert.equal(second.ok, false);
  assert.equal(second.error, "campaign_active");
  await cancelNewsletterCampaign(first.campaignId);
});

test("outbox claim is exclusive", async () => {
  const user = await makeUser({ verified: true, optedIn: true });
  const created = await createNewsletterCampaign({
    newsId: "claim-test-news",
    subject: "Claim",
    createdBy: 1,
    recipients: [user],
  });
  assert.equal(created.ok, true);
  const one = await claimNewsletterOutboxRow("worker-a");
  const two = await claimNewsletterOutboxRow("worker-b");
  assert.ok(one);
  assert.equal(two, null);
  assert.equal(one.outbox.claimed_by, "worker-a");
  await cancelNewsletterCampaign(created.campaignId);
});

test("transient failure schedules retry; permanent fails", async () => {
  const user = await makeUser({ verified: true, optedIn: true });
  const created = await createNewsletterCampaign({
    newsId: "retry-test-news",
    subject: "Retry",
    createdBy: 1,
    recipients: [user],
  });
  const claimed = await claimNewsletterOutboxRow("worker-retry");
  assert.ok(claimed);
  await completeNewsletterOutboxFailed(claimed.outbox.id, created.campaignId, "timeout", {
    retryAt: Date.now() + 60_000,
  });
  const campaign = await getNewsletterCampaign(created.campaignId);
  assert.ok(campaign.pending >= 1);
  const claimed2 = await claimNewsletterOutboxRow("worker-retry-2");
  assert.equal(claimed2, null);
  await cancelNewsletterCampaign(created.campaignId);

  const created2 = await createNewsletterCampaign({
    newsId: "perm-fail-news",
    subject: "Fail",
    createdBy: 1,
    recipients: [await makeUser({ verified: true, optedIn: true })],
  });
  const c2 = await claimNewsletterOutboxRow("worker-perm");
  await completeNewsletterOutboxFailed(c2.outbox.id, created2.campaignId, "bounce", {
    permanent: true,
  });
  const done = await getNewsletterCampaign(created2.campaignId);
  assert.ok(done.failed >= 1 || done.status === "failed" || done.status === "completed");
});

test("quota pause marks campaign paused", async () => {
  const user = await makeUser({ verified: true, optedIn: true });
  const created = await createNewsletterCampaign({
    newsId: "quota-news",
    subject: "Quota",
    createdBy: 1,
    recipients: [user],
  });
  await pauseCampaignForQuota(created.campaignId, Date.now() + 3600_000, "quota");
  const campaign = await getNewsletterCampaign(created.campaignId);
  assert.equal(campaign.status, "paused");
});

test("test send captures mail with List-Unsubscribe", async () => {
  const admin = await makeUser({ verified: true, optedIn: false });
  const messages = [];
  setMailCapture((m) => messages.push(m));
  try {
    const result = await sendNewsTestEmail({
      newsId: "2026-05-01-hello",
      account: admin,
    });
    assert.equal(result.ok, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, admin.email);
    assert.match(messages[0].subject, /^\[Test\]/);
    assert.ok(messages[0].headers["List-Unsubscribe"]);
  } finally {
    clearMailCapture();
  }
});

test("worker sends one eligible outbox row", async () => {
  __testResetMailerState();
  const user = await makeUser({ verified: true, optedIn: true });
  upsertNewsEntry({
    id: "2026-05-01-hello-worker",
    date: "2026-05-01",
    title: "Worker",
    summary: "Hi",
    items: [],
  });
  const created = await createNewsletterCampaign({
    newsId: "2026-05-01-hello-worker",
    subject: "Worker send",
    createdBy: 1,
    recipients: [user],
  });
  const messages = [];
  setMailCapture((m) => messages.push(m));
  try {
    const result = await __testProcessOneOutbox();
    assert.equal(result.sent, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, user.email);
    const campaign = await getNewsletterCampaign(created.campaignId);
    assert.ok(campaign.sent >= 1);
  } finally {
    clearMailCapture();
  }
});

test("countNewsEmailEligible matches list length", async () => {
  const n = await countNewsEmailEligible();
  const list = await listNewsEmailEligibleAccounts();
  assert.equal(n, list.length);
});
