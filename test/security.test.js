import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeSim } from "./helpers.js";
import {
  assertSessionSecret,
  canonicalRedirectLocation,
  debugRangesEnabled,
  isDevLocalHost,
  originAllowed,
} from "../server/hardening.js";
import { ensureCsrf } from "../server/csrf.js";
import { sanitizeCommand, allowSocketEvent } from "../server/commandLimit.js";
import {
  authenticateFormbarToken,
  loadFormbarPublicKey,
  resetFormbarAuthCache,
  verifyFormbarToken,
} from "../server/formbarAuth.js";
import { serializedSocketTransfer } from "../server/formbar.js";
import { otherPrivatePem, privatePem, publicPem, signFormbar, unsignedFormbar } from "./formbarToken.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-sec-"));
process.env.DATA_DIR = dataDir;
process.env.SKIP_FORMBAR = "1";
process.env.NODE_ENV = "test";

const db = await import("../server/db.js");
const { renderWikiBody, safeWikiUrl } = await import("../server/wiki-render.js");
const { Matchmaker } = await import("../server/matchmaking.js");

test("canonical host redirect maps apex to THIS_URL host", () => {
  const thisUrl = "https://www.menoftheline.com";
  assert.equal(
    canonicalRedirectLocation(thisUrl, { get: () => "menoftheline.com", originalUrl: "/games" }),
    "https://www.menoftheline.com/games",
  );
  assert.equal(
    canonicalRedirectLocation(thisUrl, { get: () => "www.menoftheline.com", originalUrl: "/games" }),
    null,
  );
  assert.equal(
    canonicalRedirectLocation("http://127.0.0.1:3000", { get: () => "localhost:3000", originalUrl: "/" }),
    null,
  );
});

test("ensureCsrf does not mint a token on an empty API session", () => {
  const emptyApi = { session: {}, path: "/api/v1/me" };
  const res = { locals: {} };
  ensureCsrf(emptyApi, res, () => {});
  assert.equal(emptyApi.session.csrfToken, undefined);

  const identified = { session: { accountId: 1 }, path: "/api/v1/me" };
  ensureCsrf(identified, res, () => {});
  assert.ok(identified.session.csrfToken);

  const html = { session: {}, path: "/games" };
  ensureCsrf(html, res, () => {});
  assert.ok(html.session.csrfToken);
});

test("production rejects a missing or placeholder session secret", () => {
  assert.throws(() => assertSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "" }));
  assert.throws(() => assertSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "lane-pusher-local" }));
  assert.throws(() => assertSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short-secret" }));
  const ok = "x".repeat(32);
  assert.equal(assertSessionSecret({ NODE_ENV: "production", SESSION_SECRET: ok }), ok);
  assert.equal(assertSessionSecret({ NODE_ENV: "development" }), "lane-pusher-local");
  assert.equal(assertSessionSecret({ NODE_TEST_CONTEXT: "1" }), "lane-pusher-local");
});

test("debug ranges stay off in production", () => {
  assert.equal(debugRangesEnabled({ NODE_ENV: "production", DEBUG_RANGES: "1" }), false);
  assert.equal(debugRangesEnabled({ NODE_ENV: "development", DEBUG_RANGES: "1" }), true);
});

test("origin checks follow THIS_URL and native tokens", () => {
  const thisUrl = "https://play.example.com";
  assert.equal(originAllowed("https://play.example.com", { thisUrl, nodeEnv: "production", hasAuthToken: false }), true);
  assert.equal(originAllowed("https://evil.example", { thisUrl, nodeEnv: "production", hasAuthToken: false }), false);
  assert.equal(originAllowed("http://localhost:3000", { thisUrl, nodeEnv: "production", hasAuthToken: false }), false);
  assert.equal(originAllowed("http://localhost:3000", { thisUrl, nodeEnv: "development", hasAuthToken: false }), true);
  assert.equal(originAllowed("http://192.168.1.20:3000", { thisUrl, nodeEnv: "development", hasAuthToken: false }), true);
  assert.equal(originAllowed("http://10.0.0.5:3000", { thisUrl, nodeEnv: "test", hasAuthToken: false }), true);
  assert.equal(originAllowed("http://192.168.1.20:3000", { thisUrl, nodeEnv: "production", hasAuthToken: false }), false);
  assert.equal(
    originAllowed("https://menoftheline.com", {
      thisUrl: "https://www.menoftheline.com",
      nodeEnv: "production",
      hasAuthToken: false,
    }),
    true,
  );
  assert.equal(
    originAllowed("https://www.menoftheline.com", {
      thisUrl: "https://menoftheline.com",
      nodeEnv: "production",
      hasAuthToken: false,
    }),
    true,
  );
  // Electron/Capacitor: odd Origins are fine when auth.token is present.
  assert.equal(originAllowed("null", { thisUrl, nodeEnv: "production", hasAuthToken: true }), true);
  assert.equal(originAllowed("capacitor://localhost", { thisUrl, nodeEnv: "production", hasAuthToken: true }), true);
  assert.equal(originAllowed("", { thisUrl, nodeEnv: "production", hasAuthToken: true }), true);
  assert.equal(originAllowed("null", { thisUrl, nodeEnv: "production", hasAuthToken: false }), false);
  assert.equal(originAllowed("http://8.8.8.8:3000", { thisUrl, nodeEnv: "development", hasAuthToken: false }), false);
  // Local THIS_URL + phone on LAN works even when NODE_ENV is unset/production.
  assert.equal(originAllowed("http://192.168.1.20:3000", {
    thisUrl: "http://localhost:3000",
    nodeEnv: undefined,
    hasAuthToken: false,
  }), true);
  assert.equal(originAllowed("http://192.168.1.20:3000", {
    thisUrl: "http://localhost:3000",
    nodeEnv: "production",
    hasAuthToken: false,
  }), true);
  assert.equal(originAllowed("http://evil.example", {
    thisUrl: "http://localhost:3000",
    nodeEnv: "production",
    hasAuthToken: false,
  }), false);
  assert.equal(originAllowed("", { thisUrl, nodeEnv: "production", hasAuthToken: false }), false);
  assert.equal(originAllowed("", { thisUrl, nodeEnv: "production", hasAuthToken: true }), true);
  assert.equal(isDevLocalHost("192.168.0.12"), true);
  assert.equal(isDevLocalHost("172.16.4.1"), true);
  assert.equal(isDevLocalHost("macbook.local"), true);
  assert.equal(isDevLocalHost("example.com"), false);
});

test("commands reject non-finite numbers, bad types, and prototype keys", () => {
  assert.equal(sanitizeCommand({ type: "order", troopId: Number.NaN, action: "forward" }), null);
  assert.equal(sanitizeCommand({ type: "order", troopId: Number.POSITIVE_INFINITY, action: "forward" }), null);
  assert.equal(sanitizeCommand({ type: "townProduce", checkpointId: Number.NaN }), null);
  assert.equal(sanitizeCommand({ type: "buy", lane: "top", unit: "nope" }), null);
  assert.equal(sanitizeCommand({ type: "buy", lane: "side", unit: "troop" }), null);
  assert.equal(sanitizeCommand(["buy"]), null);
  const proto = Object.create(null);
  proto.type = "bank";
  proto.__proto__ = { polluted: true };
  assert.equal(sanitizeCommand(proto), null);
  assert.equal(sanitizeCommand({ type: "bank", constructor: { bad: true } }), null);
  const clean = sanitizeCommand({ type: "order", troopId: "4", action: "shift", dir: 1, extra: { gold: 999 } });
  assert.deepEqual(clean, { type: "order", troopId: 4, action: "shift", solo: false, dir: 1 });

  const sim = makeSim();
  assert.equal(sim.applyCommand("player", { type: "order", troopId: Number.NaN, action: "forward" }), false);
  assert.equal(sim.applyCommand("player", { type: "townProduce", checkpointId: Number.POSITIVE_INFINITY }), false);
  const beforeGold = sim.player.gold;
  assert.equal(sim.applyCommand("player", { type: "buy", lane: "top", unit: "troop", gold: 999999 }), true);
  assert.ok(sim.player.gold < beforeGold);
  assert.ok(sim.player.gold < 999999);
});

test("socket event floods are dropped", () => {
  const socket = { data: {} };
  let accepted = 0;
  for (let i = 0; i < 10; i += 1) {
    if (allowSocketEvent(socket, "concede", 1_000)) accepted += 1;
  }
  assert.equal(accepted, 2);
});

test("wiki renderer blocks unsafe urls", () => {
  assert.equal(safeWikiUrl("javascript:alert(1)"), "");
  assert.equal(safeWikiUrl("JaVaScRiPt:alert(1)"), "");
  assert.equal(safeWikiUrl("data:text/html,hi"), "");
  assert.equal(safeWikiUrl("//evil.test"), "");
  assert.equal(safeWikiUrl("https://example.com/a"), "https://example.com/a");
  const html = renderWikiBody("[x](javascript:alert(1))\n\n[ok](https://example.com)\n\n<script>alert(1)</script>\n\n![a](https://example.com/a.png)");
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("<script"), false);
  assert.match(html, /href="https:\/\/example\.com\/"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /src="https:\/\/example\.com\/a\.png"/);
});

test("Formbar JWTs require the RS256 public key", async () => {
  const good = signFormbar({ id: 7, displayName: "Ace" }, privatePem, { expiresIn: "5m" });
  const identity = verifyFormbarToken(good, publicPem);
  assert.equal(identity.id, 7);

  const authed = await authenticateFormbarToken(good, "http://certs.invalid", {
    env: { NODE_ENV: "test", FORMBAR_PUBLIC_KEY_B64: Buffer.from(publicPem).toString("base64") },
  });
  assert.equal(authed.id, 7);
  assert.equal(authed.rawName, "Ace");

  const parts = good.split(".");
  const tampered = `${parts[0]}.${parts[1].replace(/./, (ch) => (ch === "A" ? "B" : "A"))}.${parts[2]}`;
  assert.throws(() => verifyFormbarToken(tampered, publicPem));
  assert.throws(() => verifyFormbarToken(unsignedFormbar({ id: 7, displayName: "Ace" }), publicPem));
  const other = signFormbar({ id: 7, displayName: "Ace" }, otherPrivatePem, { expiresIn: "5m" });
  assert.throws(() => verifyFormbarToken(other, publicPem));
  const expired = signFormbar({ id: 7, displayName: "Ace", exp: Math.floor(Date.now() / 1000) - 60 }, privatePem);
  assert.throws(() => verifyFormbarToken(expired, publicPem));

  resetFormbarAuthCache();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    throw new Error("down");
  };
  await assert.rejects(
    () => authenticateFormbarToken(good, "http://127.0.0.1:9", {
      env: { NODE_ENV: "production" },
      fetchImpl,
    }),
    (err) => err && err.code === "certs_unavailable",
  );
  assert.equal(fetches, 1);

  resetFormbarAuthCache();
  fetches = 0;
  const okFetch = async () => {
    fetches += 1;
    return { ok: true, text: async () => publicPem };
  };
  await loadFormbarPublicKey("http://certs.test", { fetchImpl: okFetch });
  await loadFormbarPublicKey("http://certs.test", { fetchImpl: okFetch });
  assert.equal(fetches, 1);
});

test("Formbar socket transfers run one at a time", async () => {
  const listeners = new Set();
  const sock = {
    connected: true,
    emits: [],
    once(event, fn) { listeners.add(fn); },
    off(event, fn) { listeners.delete(fn); },
    emit(event, data) {
      this.emits.push(data.amount);
      const fn = [...listeners][0];
      setTimeout(() => {
        if (fn) fn({ success: true, message: String(data.amount) });
      }, 15);
    },
  };
  const pending = Promise.all([1, 2, 3].map((amount) => serializedSocketTransfer(sock, { amount }, 1000)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sock.emits.length, 1);
  const results = await pending;
  assert.deepEqual(sock.emits, [1, 2, 3]);
  assert.deepEqual(results.map((row) => row.message), ["1", "2", "3"]);
  assert.equal(listeners.size, 0);

  const quiet = {
    connected: true,
    emits: [],
    once() {},
    off() {},
    emit(event, data) { this.emits.push(data.amount); },
  };
  const timed = Promise.all([
    serializedSocketTransfer(quiet, { amount: 9 }, 30),
    serializedSocketTransfer(quiet, { amount: 8 }, 30),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(quiet.emits.length, 1);
  const timedResults = await timed;
  assert.equal(timedResults[0].ambiguous, true);
  assert.equal(timedResults[1].ambiguous, true);
  assert.equal(timedResults[0].success, false);
  assert.deepEqual(quiet.emits, [9, 8]);
});

test("reward claims are single-use and ambiguous stays pending", async () => {
  await db.initDb();
  const account = await db.upsertAccount(88001, "Reward Tester");
  const suggestionId = await db.createSuggestion({
    accountId: account.id,
    formbarId: account.formbar_id,
    name: account.name,
    body: "Pay me once",
    isBug: false,
    repro: "",
  });
  const [first, second] = await Promise.all([
    db.claimSuggestionReward(suggestionId),
    db.claimSuggestionReward(suggestionId),
  ]);
  assert.equal(Number(first) + Number(second), 1);
  assert.equal(await db.claimSuggestionReward(suggestionId), false);
  let row = await db.getSuggestion(suggestionId);
  assert.equal(row.reward_status, "pending");
  assert.equal(row.rewarded_at, null);
  assert.equal(await db.releaseSuggestionReward(suggestionId), true);
  assert.equal(await db.claimSuggestionReward(suggestionId), true);
  assert.equal(await db.completeSuggestionReward(suggestionId), true);
  row = await db.getSuggestion(suggestionId);
  assert.equal(row.reward_status, "completed");
  assert.ok(row.rewarded_at);

  const saved = await db.saveWikiPage({
    slug: "reward-page",
    title: "Reward Page",
    body: "Once",
    formbarId: account.formbar_id,
    accountId: account.id,
    name: account.name,
  });
  assert.equal(saved.ok, true);
  const page = await db.getWikiPageBySlug("reward-page");
  const revisionId = page.revision.id;
  assert.equal(await db.claimWikiReward(revisionId), true);
  assert.equal(await db.claimWikiReward(revisionId), false);
  const pending = await db.getWikiRevision(revisionId);
  assert.equal(pending.reward_status, "pending");
  assert.equal(await db.releaseWikiReward(revisionId), true);
  assert.equal(await db.claimWikiReward(revisionId), true);
  assert.equal(await db.completeWikiReward(revisionId), true);

  const purchase = await db.beginTicketPurchase({
    accountId: account.id,
    formbarId: account.formbar_id,
    tickets: 5,
    digipogs: 100,
  });
  assert.ok(purchase);
  assert.equal(await db.beginTicketPurchase({
    accountId: account.id,
    formbarId: account.formbar_id,
    tickets: 5,
    digipogs: 100,
  }), null);
  assert.equal(await db.failTicketPurchase(purchase), true);
  const again = await db.beginTicketPurchase({
    accountId: account.id,
    formbarId: account.formbar_id,
    tickets: 5,
    digipogs: 100,
  });
  assert.ok(again);
  assert.equal(await db.completeTicketPurchase(again, account.id, 5), true);
  const fresh = await db.getAccount(account.id);
  assert.equal(fresh.tickets, 5);
});

test("expired queue entries are removed", async () => {
  const mm = new Matchmaker({});
  const events = [];
  const socket = {
    connected: true,
    data: { user: { id: "queue-user" } },
    request: { session: { save() {} } },
    emit(name) { events.push(name); },
  };
  mm.queueMaxAgeMs = 1000;
  mm.enqueue(mm.casual, {
    userId: "queue-user",
    name: "Queue",
    socket,
    joinedAt: Date.now() - 5000,
    mode: "casual",
  });
  await mm.expireQueues();
  assert.equal(mm.casual.length, 0);
  assert.equal(events.includes("go-home"), true);
  clearInterval(mm.timer);
  mm.ticker.stop();
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // SQLite may still hold the temp database on Windows.
  }
});
