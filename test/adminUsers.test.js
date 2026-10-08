import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-admin-users-"));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;
delete process.env.ADMIN_USER_ID;

const {
  initDb,
  createLocalAccount,
  getAccount,
  holdTicket,
  grantTickets,
  adjustTicketsAdmin,
  setEmailVerified,
  bumpSessionEpoch,
  searchAccounts,
  listTicketLedger,
  setAccountRole,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const {
  adminAdjustTickets,
  adminBan,
  adminSetRole,
  adminVerifyEmail,
} = await import("../server/admin/users.js");

await initDb();

let seq = 0;
async function makeAccount(name, { tickets = 0 } = {}) {
  seq += 1;
  const account = await createLocalAccount({
    email: `user${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: null,
  });
  if (tickets) await grantTickets(account.id, tickets);
  return getAccount(account.id);
}

test("ticket adjust respects held floor", async () => {
  const account = await makeAccount("Ticket User", { tickets: 3 });
  assert.equal(await holdTicket(account.id), true);
  const fresh = await getAccount(account.id);
  assert.equal(fresh.held, 1);
  const bad = await adjustTicketsAdmin(account.id, -3, { reason: "too much" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "below_held");
  const ok = await adjustTicketsAdmin(account.id, -2, {
    actorAccountId: 1,
    reason: "fine",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.after, 1);
  const ledger = await listTicketLedger(account.id);
  assert.ok(ledger.some((r) => r.kind === "admin_adjust"));
});

test("adminSetRole requires reason and blocks self", async () => {
  const actor = await makeAccount("Actor");
  await setAccountRole(actor.id, "admin");
  const target = await makeAccount("Target");
  const self = await adminSetRole(actor.id, actor.id, "player", "nope");
  assert.equal(self.error, "self_target");
  const noReason = await adminSetRole(actor.id, target.id, "moderator", "");
  assert.equal(noReason.error, "reason_required");
  const ok = await adminSetRole(actor.id, target.id, "moderator", "promote");
  assert.equal(ok.ok, true);
  assert.equal(ok.after, "moderator");
});

test("manual email verify sets verified_at and who/why", async () => {
  const actor = await makeAccount("Verifier");
  await setAccountRole(actor.id, "admin");
  const target = await makeAccount("Unverified");
  assert.equal(target.email_verified_at, null);
  const result = await adminVerifyEmail(actor.id, target.id, "manual check");
  assert.equal(result.ok, true);
  assert.ok(result.account.email_verified_at);
  assert.equal(result.account.email_verified_by, actor.id);
  assert.equal(result.account.email_verified_reason, "manual check");
});

test("ban blocks self and records reason", async () => {
  const actor = await makeAccount("Banner");
  await setAccountRole(actor.id, "admin");
  // ensure not sole admin
  const other = await makeAccount("Other Admin");
  await setAccountRole(other.id, "admin");
  const target = await makeAccount("To Ban");
  const self = await adminBan(actor.id, actor.id, { reason: "x" });
  assert.equal(self.error, "self_target");
  const ok = await adminBan(actor.id, target.id, { reason: "cheating", durationMs: 3600000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.account.ban_reason, "cheating");
  assert.ok(ok.account.ban_expires_at > Date.now());
});

test("session epoch bump works", async () => {
  const account = await makeAccount("Epoch");
  const before = account.session_epoch || 0;
  await bumpSessionEpoch(account.id);
  const after = await getAccount(account.id);
  assert.equal(after.session_epoch, before + 1);
});

test("search finds by name and email", async () => {
  const account = await makeAccount("Searchable Name");
  const byName = await searchAccounts({ q: "Searchable" });
  assert.ok(byName.rows.some((r) => r.id === account.id));
  const byEmail = await searchAccounts({ q: account.email });
  assert.ok(byEmail.rows.some((r) => r.id === account.id));
  assert.ok(!("password_hash" in byName.rows[0]));
});

test("setEmailVerified helper stores admin fields", async () => {
  const account = await makeAccount("Verify Helper");
  await setEmailVerified(account.id, Date.now(), { verifiedBy: 99, reason: "test" });
  const fresh = await getAccount(account.id);
  assert.equal(fresh.email_verified_by, 99);
  assert.equal(fresh.email_verified_reason, "test");
});

test("adminAdjustTickets wrapper requires reason", async () => {
  const actor = await makeAccount("AdjActor");
  const target = await makeAccount("AdjTarget", { tickets: 5 });
  const bad = await adminAdjustTickets(actor.id, target.id, 1, "");
  assert.equal(bad.error, "reason_required");
  const ok = await adminAdjustTickets(actor.id, target.id, 2, "comp");
  assert.equal(ok.ok, true);
  assert.equal(ok.after, 7);
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the sqlite handle */
  }
});
