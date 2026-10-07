import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeUserText,
  SUGGESTION_BODY_MAX,
  WIKI_TITLE_MAX,
} from "../server/db.js";

test("sanitizeUserText strips control characters and null bytes", () => {
  assert.equal(sanitizeUserText("hello\u0000world"), "helloworld");
  assert.equal(sanitizeUserText("a\u0007b\u001Fc"), "abc");
  assert.equal(sanitizeUserText("keep\nline\tand"), "keep\nline\tand");
});

test("sanitizeUserText normalizes newlines and trims", () => {
  assert.equal(sanitizeUserText("  a\r\nb\rc  "), "a\nb\nc");
});

test("sanitizeUserText can collapse whitespace for titles", () => {
  assert.equal(
    sanitizeUserText("  Two\nWords\tHere  ", { max: WIKI_TITLE_MAX, allowNewlines: false }),
    "Two Words Here",
  );
});

test("sanitizeUserText enforces max length", () => {
  const long = "x".repeat(SUGGESTION_BODY_MAX + 50);
  assert.equal(sanitizeUserText(long).length, SUGGESTION_BODY_MAX);
  assert.equal(sanitizeUserText("abcd", { max: 2 }), "ab");
});
