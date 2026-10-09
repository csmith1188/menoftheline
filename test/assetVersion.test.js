import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssetVersion } from "../server/assetVersion.js";
import { CLIENT_VERSION } from "../shared/protocol.js";
import {
  matchSeatBusy,
  shouldApplyAssetUpdate,
} from "../shared/assetUpdate.js";

test("resolveAssetVersion prefers ASSET_VERSION env", () => {
  assert.equal(
    resolveAssetVersion({
      env: { ASSET_VERSION: "deploy-abc" },
      execGit: () => "deadbeef",
    }),
    "deploy-abc",
  );
});

test("resolveAssetVersion uses git short SHA when env unset", () => {
  assert.equal(
    resolveAssetVersion({
      env: {},
      execGit: () => "abc1234\n",
    }),
    "abc1234",
  );
});

test("resolveAssetVersion falls back to CLIENT_VERSION when git fails", () => {
  assert.equal(
    resolveAssetVersion({
      env: {},
      execGit: () => {
        throw new Error("no git");
      },
    }),
    CLIENT_VERSION,
  );
});

test("matchSeatBusy treats live seats as busy until winner", () => {
  assert.equal(matchSeatBusy("waiting", null), true);
  assert.equal(matchSeatBusy("countdown", null), true);
  assert.equal(matchSeatBusy("playing", null), true);
  assert.equal(matchSeatBusy("playing", "north"), false);
  assert.equal(matchSeatBusy("idle", null), false);
  assert.equal(matchSeatBusy(null, null), false);
});

test("shouldApplyAssetUpdate prompts in match and reloads when safe", () => {
  assert.equal(shouldApplyAssetUpdate("a", "a", { busy: false }), "ignore");
  assert.equal(shouldApplyAssetUpdate("a", "b", { busy: false }), "reload");
  assert.equal(shouldApplyAssetUpdate("a", "b", { busy: true }), "prompt");
  assert.equal(shouldApplyAssetUpdate("a", "b", { shell: true }), "ignore");
  assert.equal(shouldApplyAssetUpdate("", "b", { busy: false }), "ignore");
  assert.equal(shouldApplyAssetUpdate("a", "", { busy: false }), "ignore");
});
