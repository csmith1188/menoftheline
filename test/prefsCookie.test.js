import assert from "node:assert/strict";
import test from "node:test";
import {
  PREFS_BGM_COOKIE,
  PREFS_TOOLTIPS_COOKIE,
  parsePrefsBgm,
  parsePrefsTooltips,
} from "../shared/prefs.js";
import { readPrefsCookies, writePrefsCookies } from "../server/prefsCookie.js";

test("parsePrefsTooltips accepts 0/1", () => {
  assert.equal(parsePrefsTooltips("0"), false);
  assert.equal(parsePrefsTooltips("1"), true);
  assert.equal(parsePrefsTooltips(""), null);
  assert.equal(parsePrefsTooltips(undefined), null);
});

test("parsePrefsBgm clamps percent", () => {
  assert.equal(parsePrefsBgm("40"), 40);
  assert.equal(parsePrefsBgm("-5"), 0);
  assert.equal(parsePrefsBgm("200"), 100);
  assert.equal(parsePrefsBgm("nope"), null);
});

test("readPrefsCookies uses defaults when missing", () => {
  const prefs = readPrefsCookies({ headers: {} });
  assert.equal(prefs.tooltips, true);
  assert.equal(prefs.bgmVolume, 50);
  assert.equal(prefs.hasTooltips, false);
  assert.equal(prefs.hasBgm, false);
});

test("readPrefsCookies reads Cookie header", () => {
  const prefs = readPrefsCookies({
    headers: {
      cookie: `${PREFS_TOOLTIPS_COOKIE}=0; ${PREFS_BGM_COOKIE}=25`,
    },
  });
  assert.equal(prefs.tooltips, false);
  assert.equal(prefs.bgmVolume, 25);
  assert.equal(prefs.hasTooltips, true);
  assert.equal(prefs.hasBgm, true);
});

test("writePrefsCookies appends Set-Cookie for both prefs", () => {
  const cookies = [];
  const res = {
    append(name, value) {
      if (name === "Set-Cookie") cookies.push(value);
    },
  };
  writePrefsCookies(res, { tooltips: false, bgmVolume: 33 }, "http://localhost:3000");
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], new RegExp(`^${PREFS_TOOLTIPS_COOKIE}=0;`));
  assert.match(cookies[1], new RegExp(`^${PREFS_BGM_COOKIE}=33;`));
  assert.match(cookies[0], /SameSite=Lax/i);
  assert.doesNotMatch(cookies[0], /HttpOnly/i);
});
