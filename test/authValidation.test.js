import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEmailVerified,
  buildDiscriminatedDisplayName,
  isProfaneName,
  isValidEmail,
  isValidPassword,
  matchModeChargesTickets,
  modeRequiresTicket,
  noFreePlayEnabled,
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

test("discriminated display names append a numeric suffix", () => {
  assert.equal(buildDiscriminatedDisplayName("Ash Fox", 1), "Ash Fox");
  assert.equal(buildDiscriminatedDisplayName("Ash Fox", 2), "Ash Fox 2");
  assert.equal(buildDiscriminatedDisplayName("Ash Fox", 12), "Ash Fox 12");
  const long = "A".repeat(32);
  const d2 = buildDiscriminatedDisplayName(long, 2);
  assert.ok(d2.length <= 32);
  assert.match(d2, / 2$/);
});

test("accountEmailVerified gates local email when AUTH_EMAIL is on", () => {
  const prev = process.env.AUTH_EMAIL;
  process.env.AUTH_EMAIL = "1";
  try {
    assert.equal(accountEmailVerified(null), false);
    assert.equal(accountEmailVerified({ email: null, email_verified_at: null }), true);
    assert.equal(accountEmailVerified({ email: "a@b.co", email_verified_at: null }), false);
    assert.equal(accountEmailVerified({ email: "a@b.co", email_verified_at: 1 }), false);
    assert.equal(accountEmailVerified({ email: "a@b.co", email_verified_at: 1_700_000_000_000 }), true);
  } finally {
    if (prev == null) delete process.env.AUTH_EMAIL;
    else process.env.AUTH_EMAIL = prev;
  }
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

test("NO_FREE gates bot and casual ticket requirements", () => {
  const prev = process.env.NO_FREE;
  try {
    process.env.NO_FREE = "0";
    assert.equal(noFreePlayEnabled(), false);
    assert.equal(modeRequiresTicket("bot"), false);
    assert.equal(modeRequiresTicket("casual"), false);
    assert.equal(modeRequiresTicket("trainBot"), false);
    assert.equal(modeRequiresTicket("ranked"), true);
    assert.equal(matchModeChargesTickets("bot"), false);

    process.env.NO_FREE = "1";
    assert.equal(noFreePlayEnabled(), true);
    assert.equal(modeRequiresTicket("bot"), true);
    assert.equal(modeRequiresTicket("casual"), true);
    assert.equal(modeRequiresTicket("trainBot"), false);
    assert.equal(modeRequiresTicket("trainCasual"), false);
    assert.equal(matchModeChargesTickets("bot"), true);
    assert.equal(matchModeChargesTickets("casual"), true);
    assert.equal(matchModeChargesTickets("training"), false);
  } finally {
    if (prev == null) delete process.env.NO_FREE;
    else process.env.NO_FREE = prev;
  }
});
