import assert from "node:assert/strict";
import { test } from "node:test";
import { asErr, createSampler, logger } from "../server/logger.js";

test("logger exports a pino instance with default level", () => {
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.child, "function");
  assert.ok(logger.level);
});

test("asErr wraps non-Error values", () => {
  const fromString = asErr("boom");
  assert.ok(fromString instanceof Error);
  assert.equal(fromString.message, "boom");
  const original = new Error("keep");
  assert.equal(asErr(original), original);
});

test("createSampler logs first then every Nth", () => {
  const sample = createSampler(3);
  assert.equal(sample(), true);
  assert.equal(sample(), false);
  assert.equal(sample(), false);
  assert.equal(sample(), true);
});
