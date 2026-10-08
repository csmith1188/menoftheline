#!/usr/bin/env node
/**
 * Prepopulate the live wiki DB from wikidocs/*.md (confirmed System revisions).
 *
 * Usage:
 *   npm run seed-wiki
 *   npm run seed-wiki -- --dry-run
 *   npm run seed-wiki -- --only-missing
 *
 * Flags:
 *   --dry-run       Print planned upserts; do not write
 *   --only-missing  Skip pages that already exist (any revision)
 *   --dir <path>    Docs directory (default: wikidocs/)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../server/load-env.js";
import {
  closeDb,
  getWikiPageBySlug,
  initDb,
  upsertSystemWikiPage,
  wikiSlug,
} from "../server/db.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = path.join(ROOT, "wikidocs");

/** Filename → one or more wiki pages. Title/slug overrides keep [[Wiki Links]] working. */
const DOC_TARGETS = {
  "rules.md": [
    { slug: "home", title: "Home" },
    { slug: "men-of-the-line", title: "Men of the Line" },
  ],
  "quickstart.md": [{ title: "Quick Start" }],
};

function parseArgs(argv) {
  const out = { dryRun: false, onlyMissing: false, dir: DEFAULT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--only-missing") out.onlyMissing = true;
    else if (arg === "--dir") {
      const value = String(argv[++i] || "").trim();
      if (!value) {
        console.error("Missing value for --dir");
        process.exit(1);
      }
      out.dir = path.resolve(ROOT, value);
    } else if (arg.startsWith("--dir=")) {
      out.dir = path.resolve(ROOT, arg.slice("--dir=".length).trim());
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run seed-wiki -- [--dry-run] [--only-missing] [--dir path]`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

function titleFromMarkdown(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const link = text.match(/^\s*\[\[([^\]]+)\]\]\s*$/m);
  if (link) return link[1].trim();
  const heading = text.match(/^\s{0,3}#{1,2}\s+(.+?)\s*$/m);
  if (heading) return heading[1].replace(/\s+#+\s*$/, "").trim();
  return "";
}

function bodyForWiki(raw, title) {
  let text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Drop a leading [[Title]] line (some docs use it as a banner).
  text = text.replace(/^\s*\[\[[^\]]+\]\]\s*\n+/, "");
  if (title) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe = new RegExp(`^\\s{0,3}#{1,2}\\s+${escaped}\\s*(?:#+\\s*)?\\n+`, "i");
    text = text.replace(headingRe, "");
  }
  return text.trim();
}

function targetsForFile(fileName, raw) {
  const configured = DOC_TARGETS[fileName];
  if (configured) return configured;
  const title = titleFromMarkdown(raw);
  if (!title) return [];
  return [{ title, slug: wikiSlug(title) }];
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Docs directory not found: ${dir}`);
  }
  return fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = listMarkdownFiles(opts.dir);
  if (!files.length) {
    console.error(`No .md files in ${opts.dir}`);
    process.exitCode = 1;
    return;
  }

  if (!opts.dryRun) {
    await initDb();
  }

  const counts = { created: 0, updated: 0, renamed: 0, unchanged: 0, skipped: 0, failed: 0 };

  for (const fileName of files) {
    const fullPath = path.join(opts.dir, fileName);
    const raw = fs.readFileSync(fullPath, "utf8");
    const targets = targetsForFile(fileName, raw);
    if (!targets.length) {
      console.warn(`skip ${fileName}: no title found`);
      counts.skipped += 1;
      continue;
    }

    for (const target of targets) {
      const title = target.title || titleFromMarkdown(raw);
      const slug = wikiSlug(target.slug || title);
      const body = bodyForWiki(raw, titleFromMarkdown(raw) || title);

      if (opts.onlyMissing) {
        if (!opts.dryRun) {
          const existing = await getWikiPageBySlug(slug);
          if (existing) {
            console.log(`skip ${fileName} → ${slug} (exists)`);
            counts.skipped += 1;
            continue;
          }
        }
      }

      if (opts.dryRun) {
        console.log(`plan ${fileName} → /rules/${slug} (${title}), ${body.length} chars`);
        counts.created += 1;
        continue;
      }

      const result = await upsertSystemWikiPage({ slug, title, body });
      if (!result.ok) {
        console.error(`fail ${fileName} → ${slug}: ${result.error}`);
        counts.failed += 1;
        continue;
      }
      console.log(`${result.action} ${fileName} → /rules/${result.slug}`);
      counts[result.action] = (counts[result.action] || 0) + 1;
    }
  }

  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  console.log(opts.dryRun ? `dry-run done ${summary}` : `seed-wiki done ${summary}`);

  if (!opts.dryRun) {
    await closeDb();
  }
  if (counts.failed > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDb();
  } catch {
    // ignore close errors on failure path
  }
  process.exitCode = 1;
});
