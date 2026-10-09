import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-news-store-"));
const newsPath = path.join(dir, "news.json");
process.env.NEWS_JSON_PATH = newsPath;

const {
  setNewsFilePath,
  validateNewsEntry,
  validateNewsArray,
  loadNews,
  upsertNewsEntry,
  saveNewsArray,
  prependNewsEntry,
  ensureNewsIds,
  makeNewsId,
} = await import("../server/newsStore.js");

setNewsFilePath(newsPath);

test("validateNewsEntry assigns id and accepts legacy shape", () => {
  const result = validateNewsEntry({
    date: "2026-10-05",
    title: "Hello World",
    summary: "A summary",
    items: ["one", "two"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.id, "2026-10-05-hello-world");
  assert.equal(result.entry.items.length, 2);
});

test("validateNewsEntry rejects bad category and preserves unknown keys on upsert", () => {
  const bad = validateNewsEntry({ title: "X", category: "nope" });
  assert.equal(bad.ok, false);

  fs.writeFileSync(newsPath, "[]\n");
  upsertNewsEntry({
    date: "2026-01-01",
    title: "Custom",
    summary: "hi",
    items: [],
    customFlag: true,
  });
  const again = upsertNewsEntry({
    id: "2026-01-01-custom",
    date: "2026-01-01",
    title: "Custom",
    summary: "updated",
    items: ["a"],
    category: "feature",
  });
  assert.equal(again.summary, "updated");
  const raw = JSON.parse(fs.readFileSync(newsPath, "utf8"));
  assert.equal(raw[0].customFlag, true);
  assert.equal(raw[0].category, "feature");
});

test("saveNewsArray validates duplicates and ensureNewsIds migrates", () => {
  fs.writeFileSync(
    newsPath,
    `${JSON.stringify([
      { date: "2026-02-01", title: "Alpha", summary: "", items: [] },
      { date: "2026-02-01", title: "Alpha", summary: "", items: [] },
    ], null, 2)}\n`,
  );
  const ensured = ensureNewsIds();
  assert.equal(ensured.length, 2);
  assert.notEqual(ensured[0].id, ensured[1].id);

  const dup = validateNewsArray([
    { id: "same", date: "2026-01-01", title: "A", items: [] },
    { id: "same", date: "2026-01-02", title: "B", items: [] },
  ]);
  assert.equal(dup.ok, false);
});

test("prependNewsEntry leaves other entries intact", () => {
  fs.writeFileSync(
    newsPath,
    `${JSON.stringify([
      {
        id: "keep-me",
        date: "2026-03-01",
        title: "Keep",
        summary: "old",
        items: ["x"],
        extra: 1,
      },
    ], null, 2)}\n`,
  );
  const added = prependNewsEntry({
    date: "2026-03-02",
    title: "New Patch",
    summary: "notes",
    items: ["change"],
  });
  assert.match(added.id, /^2026-03-02-new-patch/);
  const all = loadNews();
  assert.equal(all.length, 2);
  const kept = JSON.parse(fs.readFileSync(newsPath, "utf8")).find((e) => e.id === "keep-me");
  assert.equal(kept.extra, 1);
});

test("makeNewsId uniquifies", () => {
  const used = new Set();
  const a = makeNewsId("2026-01-01", "Same Title", used);
  const b = makeNewsId("2026-01-01", "Same Title", used);
  assert.equal(a, "2026-01-01-same-title");
  assert.equal(b, "2026-01-01-same-title-2");
});

test("saveNewsArray round-trips markdown fields", () => {
  const saved = saveNewsArray([
    {
      date: "2026-04-01",
      title: "Markdown",
      summary: "**bold**",
      body: "Hello [site](/)",
      category: "announcement",
      emailSubject: "Custom subject",
      items: ["one"],
    },
  ]);
  assert.equal(saved[0].body, "Hello [site](/)");
  assert.equal(saved[0].emailSubject, "Custom subject");
});
