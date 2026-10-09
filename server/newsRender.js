import { Marked } from "marked";
import { safeWikiUrl } from "./wiki-render.js";
import { defaultEmailSubject } from "./newsStore.js";

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

const newsMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, text }) {
      const safe = safeWikiUrl(href);
      const label = escapeHtml(text);
      if (!safe) return label;
      const external = /^https?:/i.test(safe);
      const rel = external ? ' rel="noopener noreferrer"' : "";
      return `<a href="${escapeHtml(safe)}"${rel}>${label}</a>`;
    },
    image({ href, text }) {
      const safe = safeWikiUrl(href);
      const alt = escapeHtml(text);
      if (!safe) return alt;
      return `<img src="${escapeHtml(safe)}" alt="${alt}">`;
    },
  },
});

function siteBase() {
  return String(process.env.THIS_URL || "http://localhost:3000").replace(/\/$/, "");
}

/** Make relative /path URLs absolute for email. */
export function absolutizeHtml(html, baseUrl = siteBase()) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  if (!base) return String(html || "");
  return String(html || "")
    .replace(/\b(href|src)="(\/[^"]*)"/gi, (_, attr, pathPart) => {
      return `${attr}="${escapeAttr(`${base}${pathPart}`)}"`;
    });
}

export function renderNewsMarkdown(md) {
  const raw = String(md || "").replace(/\t/g, "    ");
  if (!raw.trim()) return "";
  return newsMarked.parse(raw, { async: false });
}

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Website fragment for one news entry (no outer card wrapper).
 */
export function renderNewsWebsiteHtml(entry) {
  if (!entry || !entry.title) return "";
  const parts = [];
  parts.push(`<p class="hint">${escapeHtml(entry.date || "")}</p>`);
  if (entry.category) {
    parts.push(`<p class="hint news-category">${escapeHtml(entry.category)}</p>`);
  }
  parts.push(`<h3>${escapeHtml(entry.title)}</h3>`);
  if (entry.summary) {
    parts.push(`<div class="news-summary">${renderNewsMarkdown(entry.summary)}</div>`);
  }
  if (entry.body) {
    parts.push(`<div class="news-body">${renderNewsMarkdown(entry.body)}</div>`);
  }
  if (Array.isArray(entry.items) && entry.items.length) {
    parts.push("<ul class=\"notes\">");
    for (const line of entry.items) {
      parts.push(`<li>${escapeHtml(line)}</li>`);
    }
    parts.push("</ul>");
  }
  return parts.join("\n");
}

/**
 * Plain-text body for one news entry.
 */
export function renderNewsPlainText(entry, {
  siteUrl = siteBase(),
  unsubscribeUrl = "",
} = {}) {
  const lines = [];
  lines.push("Men Of The Line");
  if (siteUrl) lines.push(siteUrl);
  lines.push("");
  if (entry.date) lines.push(String(entry.date));
  if (entry.category) lines.push(`Category: ${entry.category}`);
  lines.push(String(entry.title || "News"));
  lines.push("");
  if (entry.summary) {
    const summaryText = stripTags(renderNewsMarkdown(entry.summary)) || String(entry.summary);
    lines.push(summaryText);
    lines.push("");
  }
  if (entry.body) {
    const bodyText = stripTags(renderNewsMarkdown(entry.body)) || String(entry.body);
    lines.push(bodyText);
    lines.push("");
  }
  if (Array.isArray(entry.items) && entry.items.length) {
    for (const line of entry.items) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }
  if (siteUrl) {
    lines.push(`Read more: ${siteUrl}`);
    lines.push("");
  }
  const sender = String(process.env.NEWS_MAIL_SENDER_NAME || "Men Of The Line").trim();
  const address = String(process.env.NEWS_MAIL_PHYSICAL_ADDRESS || "").trim();
  if (sender || address) {
    lines.push("---");
    if (sender) lines.push(sender);
    if (address) lines.push(address);
    lines.push("");
  }
  if (unsubscribeUrl) {
    lines.push("Unsubscribe from news emails:");
    lines.push(unsubscribeUrl);
  }
  return lines.join("\n").trim() + "\n";
}

/**
 * Email-friendly HTML document for one news entry.
 */
export function renderNewsEmailHtml(entry, {
  siteUrl = siteBase(),
  unsubscribeUrl = "",
} = {}) {
  const base = String(siteUrl || siteBase()).replace(/\/$/, "");
  const brand = "Men Of The Line";
  const sender = escapeHtml(process.env.NEWS_MAIL_SENDER_NAME || brand);
  const address = escapeHtml(process.env.NEWS_MAIL_PHYSICAL_ADDRESS || "");
  const summaryHtml = entry.summary ? absolutizeHtml(renderNewsMarkdown(entry.summary), base) : "";
  const bodyHtml = entry.body ? absolutizeHtml(renderNewsMarkdown(entry.body), base) : "";
  const itemsHtml = Array.isArray(entry.items) && entry.items.length
    ? `<ul style="margin:12px 0;padding-left:20px;color:#e7eef6;">${
      entry.items.map((line) => `<li style="margin:0 0 6px;">${escapeHtml(line)}</li>`).join("")
    }</ul>`
    : "";

  const categoryBadge = entry.category
    ? `<p style="margin:0 0 8px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#e8c36a;">${escapeHtml(entry.category)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(defaultEmailSubject(entry))}</title>
</head>
<body style="margin:0;padding:0;background:#121821;color:#e7eef6;font-family:Georgia,'Times New Roman',serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#121821;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1d2836;border:1px solid #314257;border-radius:4px;">
        <tr>
          <td style="padding:20px 24px 8px;font-family:Cinzel,'Palatino Linotype',Palatino,serif;font-size:22px;font-weight:bold;letter-spacing:0.04em;">
            <a href="${escapeAttr(base || "#")}" style="color:#e7eef6;text-decoration:none;">${escapeHtml(brand)}</a>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 20px;">
            <p style="margin:0 0 8px;font-size:13px;color:#9aafc4;">${escapeHtml(entry.date || "")}</p>
            ${categoryBadge}
            <h1 style="margin:0 0 12px;font-family:Cinzel,'Palatino Linotype',Palatino,serif;font-size:20px;color:#e8c36a;font-weight:normal;">${escapeHtml(entry.title || "")}</h1>
            ${summaryHtml ? `<div style="margin:0 0 12px;line-height:1.5;color:#e7eef6;">${summaryHtml}</div>` : ""}
            ${bodyHtml ? `<div style="margin:0 0 12px;line-height:1.5;color:#e7eef6;">${bodyHtml}</div>` : ""}
            ${itemsHtml}
            <p style="margin:20px 0 0;">
              <a href="${escapeAttr(base || "#")}" style="color:#e8c36a;">Visit Men Of The Line</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px 20px;border-top:1px solid #314257;font-size:12px;line-height:1.5;color:#9aafc4;">
            <p style="margin:0 0 8px;">${sender}${address ? `<br>${address}` : ""}</p>
            ${unsubscribeUrl
    ? `<p style="margin:0;">You are receiving this because you opted in to news emails.
<a href="${escapeAttr(unsubscribeUrl)}" style="color:#e8c36a;">Unsubscribe</a></p>`
    : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function buildNewsEmailPayload(entry, {
  siteUrl = siteBase(),
  unsubscribeUrl = "",
} = {}) {
  return {
    subject: defaultEmailSubject(entry),
    text: renderNewsPlainText(entry, { siteUrl, unsubscribeUrl }),
    html: renderNewsEmailHtml(entry, { siteUrl, unsubscribeUrl }),
  };
}
