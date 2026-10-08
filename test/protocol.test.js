import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  isClientOutdated,
  parseProtocol,
} from "../shared/protocol.js";

test("protocol helpers", () => {
  assert.equal(typeof PROTOCOL_VERSION, "number");
  assert.ok(PROTOCOL_VERSION >= 1);
  assert.match(CLIENT_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(parseProtocol("2"), 2);
  assert.equal(parseProtocol(""), null);
  assert.equal(parseProtocol("nope"), null);
  assert.equal(isClientOutdated(null, 1), false);
  assert.equal(isClientOutdated(0, 1), true);
  assert.equal(isClientOutdated(1, 1), false);
  assert.equal(isClientOutdated(2, 1), false);
});
