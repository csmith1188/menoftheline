import assert from "node:assert/strict";
import test from "node:test";
import {
  isProfaneName,
  isValidEmail,
  isValidPassword,
  passwordError,
  validateDisplayName,
  validateSignupFields,
} from "../server/auth.js";

test("email validation rejects bad patterns", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("user.name+tag@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail("a@@b.com"), false);
  assert.equal(isValidEmail(".user@example.com"), false);
  assert.equal(isValidEmail("user@example..com"), false);
  assert.equal(isValidEmail("user@example.c"), false);
});

test("password validation enforces length and non-blank", () => {
  assert.equal(isValidPassword("password"), true);
  assert.equal(isValidPassword("short"), false);
  assert.equal(isValidPassword("   "), false);
  assert.equal(passwordError("short"), "Password must be at least 8 characters.");
  assert.ok(passwordError("x".repeat(201)));
});

test("display names reject symbols and EN/ES profanity", () => {
  assert.equal(validateDisplayName("Ash Fox").ok, true);
  assert.equal(validateDisplayName("José-María").ok, true);
  assert.equal(validateDisplayName("a").ok, false);
  assert.equal(validateDisplayName("Bad<script>").ok, false);
  assert.equal(validateDisplayName("fuck you").ok, false);
  assert.equal(isProfaneName("mierda"), true);
  assert.equal(isProfaneName("f4ck"), true);
  assert.equal(isProfaneName("Noble Pike"), false);
});

test("signup fields validate name email and password together", () => {
  const ok = validateSignupFields({
    name: "Calm Otter",
    email: "otter@example.com",
    password: "password123",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.name, "Calm Otter");

  const badName = validateSignupFields({
    name: "fuckface",
    email: "ok@example.com",
    password: "password123",
  });
  assert.equal(badName.ok, false);
  assert.match(badName.error, /different display name/i);

  const badEs = validateSignupFields({
    name: "puta",
    email: "ok2@example.com",
    password: "password123",
  });
  assert.equal(badEs.ok, false);

  const badEmail = validateSignupFields({
    name: "Calm Otter",
    email: "nope",
    password: "password123",
  });
  assert.equal(badEmail.ok, false);
  assert.match(badEmail.error, /valid email/i);

  const badPass = validateSignupFields({
    name: "Calm Otter",
    email: "ok@example.com",
    password: "123",
  });
  assert.equal(badPass.ok, false);
  assert.match(badPass.error, /8 characters/i);
});
