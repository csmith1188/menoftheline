import { marked } from "marked";
import { wikiSlug } from "./db.js";

const renderer = {
  html({ text }) {
    // Disallow raw HTML from page authors.
    return escapeHtml(text);
  },
};

marked.use({
  gfm: true,
  breaks: true,
  renderer,
});

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

/** Markdown + line breaks + tabs; [[Page Title]] wiki links. */
export function renderWikiBody(body, { existingSlugs = new Set() } = {}) {
  const raw = String(body || "");
  if (!raw) return "";

  // Tabs → 4 spaces so nested lists and alignment work in markdown.
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
