import { diffLines } from "diff";

/**
 * Line-oriented diff for admin review.
 * @returns {{ type: "add"|"del"|"ctx", text: string }[]}
 */
export function wikiLineDiff(before, after) {
  const parts = diffLines(String(before || ""), String(after || ""));
  const lines = [];
  for (const part of parts) {
    const type = part.added ? "add" : part.removed ? "del" : "ctx";
    const chunk = part.value.endsWith("\n")
      ? part.value.slice(0, -1).split("\n")
      : part.value.split("\n");
    for (const text of chunk) {
      lines.push({ type, text });
    }
  }
  return lines;
}
