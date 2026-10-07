import { marked } from "marked";
import { wikiSlug } from "./db.js";

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeMarkdownLabel(text) {
  return String(text || "").replace(/([\\\[\]*_`])/g, "\\$1");
}

/** http(s) and single-slash site paths. Blocks javascript:, data:, and protocol-relative URLs. */
export function safeWikiUrl(raw) {
  const value = String(raw || "").trim();
  if (!value || /[\u0000-\u001F\s]/.test(value)) return "";
  if (value.startsWith("//") || value.startsWith("/\\")) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    return "";
  }
  return "";
}

const renderer = {
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
};

marked.use({
  gfm: true,
  breaks: true,
  renderer,
});

/** Markdown + line breaks + tabs; [[Page Title]] wiki links. */
export function renderWikiBody(body, { existingSlugs = new Set() } = {}) {
  const raw = String(body || "");
  if (!raw) return "";

  const withTabs = raw.replace(/\t/g, "    ");

  const withWiki = withTabs.replace(/\[\[([^\[\]]+)\]\]/g, (_, title) => {
    const label = title.trim();
    const slug = wikiSlug(label);
    if (!slug) return escapeMarkdownLabel(label);
    return `[${escapeMarkdownLabel(label)}](/rules/${slug})`;
  });

  let html = marked.parse(withWiki, { async: false });

  html = html.replace(
    /<a href="\/rules\/([^"]+)">/g,
    (match, slug) => {
      const exists = existingSlugs.has(slug);
      const cls = exists ? "wiki-link" : "wiki-link wiki-wanted";
      return `<a class="${cls}" href="/rules/${encodeURIComponent(slug)}">`;
    },
  );

  return html;
}
