import {
  countNewsEmailEligible,
  getActiveCampaignForNews,
  getNewsletterCampaign,
  listNewsletterCampaigns,
  listNewsletterOutboxErrors,
} from "../db.js";
import {
  NEWS_CATEGORIES,
  defaultEmailSubject,
  ensureNewsIds,
  getNewsById,
  loadNews,
  saveNewsArray,
  upsertNewsEntry,
  deleteNewsEntry,
  validateNewsArray,
  validateNewsEntry,
} from "../newsStore.js";
import {
  buildNewsEmailPayload,
  renderNewsPlainText,
  renderNewsWebsiteHtml,
  renderNewsEmailHtml,
} from "../newsRender.js";
import {
  cancelNewsletterCampaign,
  newsMailHourlyBudgetRemaining,
  newsMailSendsLastHour,
  newsMailConfig,
  pauseNewsletterCampaign,
  resumeNewsletterCampaign,
  sendNewsTestEmail,
  startNewsCampaign,
} from "../newsMailer.js";

function siteBase() {
  return String(process.env.THIS_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function listNewsForAdmin() {
  return ensureNewsIds({ updatedBy: "admin-list" });
}

export async function newsAdminIndexData() {
  const news = listNewsForAdmin();
  const campaigns = await listNewsletterCampaigns(40);
  const eligible = await countNewsEmailEligible();
  const activeByNews = {};
  for (const entry of news) {
    const active = await getActiveCampaignForNews(entry.id);
    if (active) activeByNews[entry.id] = active;
  }
  return {
    news,
    campaigns,
    eligible,
    activeByNews,
    categories: NEWS_CATEGORIES,
    mailBudget: {
      sentLastHour: newsMailSendsLastHour(),
      remaining: newsMailHourlyBudgetRemaining(),
      config: newsMailConfig(),
    },
  };
}

export async function newsAdminEditData(newsId) {
  const news = listNewsForAdmin();
  const entry = newsId ? getNewsById(newsId) : null;
  const active = entry ? await getActiveCampaignForNews(entry.id) : null;
  const eligible = await countNewsEmailEligible();
  let campaignDetail = null;
  let errors = [];
  if (active) {
    campaignDetail = await getNewsletterCampaign(active.id);
    errors = await listNewsletterOutboxErrors(active.id, 15);
  }
  return {
    entry,
    news,
    active,
    campaignDetail,
    errors,
    eligible,
    categories: NEWS_CATEGORIES,
    mailBudget: {
      sentLastHour: newsMailSendsLastHour(),
      remaining: newsMailHourlyBudgetRemaining(),
      config: newsMailConfig(),
    },
  };
}

export function parseNewsFormBody(body) {
  const itemsRaw = body.itemsText != null
    ? String(body.itemsText)
    : Array.isArray(body.items)
      ? body.items.join("\n")
      : "";
  const items = itemsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    id: body.id ? String(body.id).trim() : "",
    date: String(body.date || "").trim(),
    title: String(body.title || "").trim(),
    category: String(body.category || "").trim(),
    emailSubject: String(body.emailSubject || "").trim(),
    summary: String(body.summary || ""),
    body: String(body.body || ""),
    items,
  };
}

export function saveNewsFromForm(body, updatedBy) {
  const parsed = parseNewsFormBody(body);
  const result = validateNewsEntry(parsed);
  if (!result.ok) {
    const err = new Error(result.error);
    err.code = "NEWS_INVALID";
    throw err;
  }
  return upsertNewsEntry(result.entry, updatedBy);
}

export function saveNewsFromRawJson(newsJson, updatedBy) {
  let items;
  try {
    items = JSON.parse(String(newsJson || "[]"));
  } catch {
    const err = new Error("Invalid JSON");
    err.code = "NEWS_INVALID";
    throw err;
  }
  const validated = validateNewsArray(items);
  if (!validated.ok) {
    const err = new Error(validated.error);
    err.code = "NEWS_INVALID";
    throw err;
  }
  return saveNewsArray(validated.entries, updatedBy);
}

export function previewNewsEntry(entryLike) {
  const result = validateNewsEntry(entryLike || {});
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const entry = result.entry;
  const sampleUnsub = `${siteBase()}/unsubscribe/news?token=preview`;
  const email = buildNewsEmailPayload(entry, {
    siteUrl: siteBase(),
    unsubscribeUrl: sampleUnsub,
  });
  return {
    ok: true,
    entry,
    websiteHtml: renderNewsWebsiteHtml(entry),
    emailHtml: email.html,
    plainText: email.text,
    subject: email.subject,
  };
}

export {
  deleteNewsEntry,
  defaultEmailSubject,
  loadNews,
  renderNewsWebsiteHtml,
  renderNewsEmailHtml,
  renderNewsPlainText,
  startNewsCampaign,
  sendNewsTestEmail,
  pauseNewsletterCampaign,
  resumeNewsletterCampaign,
  cancelNewsletterCampaign,
  getNewsletterCampaign,
  listNewsletterCampaigns,
};
