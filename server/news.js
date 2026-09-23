import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "news.json");

export function loadNews() {
  try {
    const items = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && item.title)
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error(err);
    return [];
  }
}
