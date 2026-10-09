import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-account-delete-"));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;
delete process.env.ADMIN_USER_ID;

const {
  initDb,
  createLocalAccount,
  getAccount,
  getAccountByEmail,
  grantTickets,
  holdTicket,
  deleteAccountSelf,
  destroyAccountSessions,
  getDeletedAccountIdentity,
  FALLEN_SOLDIER,
  publicDisplayName,
  isAccountDeleted,
  isDisplayNameTaken,
  setAccountRole,
  insertGame,
  listAccountMmrHistory,
  listTicketLedger,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const { getUserDetail } = await import("../server/admin/users.js");

await initDb();

let seq = 0;
async function makeAccount(name, { tickets = 0, verified = true } = {}) {
  seq += 1;
  const account = await createLocalAccount({
    email: `del${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: verified ? Date.now() : null,
  });
  if (tickets) await grantTickets(account.id, tickets);
  return getAccount(account.id);
}

test("publicDisplayName uses Fallen Soldier for deleted or missing", () => {
  assert.equal(publicDisplayName(null), FALLEN_SOLDIER);
  assert.equal(publicDisplayName({ name: "Alive", deleted_at: null }), "Alive");
  assert.equal(
    publicDisplayName({ name: "X", deleted_at: 1 }, { snapshotName: "Old" }),
    FALLEN_SOLDIER,
  );
});

test("deleteAccountSelf scrubs PII and keeps history ids", async () => {
  const a = await makeAccount("Delete Me", { tickets: 4 });
  const oldEmail = a.email;
  const b = await makeAccount("Opponent");
  await insertGame({
    id: `g-del-${a.id}`,
    mode: "ranked",
    playerA: `a:${a.id}`,
    playerB: `a:${b.id}`,
    nameA: a.name,
    nameB: b.name,
    formbarA: 99,
    formbarB: null,
    accountA: a.id,
    accountB: b.id,
    winnerSide: "player",
    mmrABefore: 1000,
    mmrBBefore: 1000,
    mmrAAfter: 1016,
    mmrBAfter: 984,
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    winReason: "keep",
    outcome: "keep",
    chatJson: JSON.stringify([
      { kind: "user", from: "Delete Me", text: "gg", at: Date.now() },
    ]),
  });

  const result = await deleteAccountSelf(a.id);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDeleted, false);

  const tomb = await getAccount(a.id);
  assert.ok(tomb);
  assert.ok(isAccountDeleted(tomb));
  assert.equal(tomb.name, FALLEN_SOLDIER);
  assert.equal(tomb.email, null);
  assert.equal(tomb.password_hash, null);
  assert.equal(tomb.formbar_id, null);
  assert.equal(tomb.discord_id, null);
  assert.equal(tomb.tickets, 0);
  assert.equal(tomb.held, 0);
  assert.ok(Number(tomb.session_epoch) > Number(a.session_epoch));

  assert.equal(await getAccountByEmail(oldEmail), null);

  const identity = await getDeletedAccountIdentity(a.id);
  assert.equal(identity.former_name, "Delete Me");

  const history = await listAccountMmrHistory(b.id);
  const row = history.rows.find((r) => r.opponentAccountId === a.id);
  assert.ok(row);
  assert.equal(row.opponentName, FALLEN_SOLDIER);

  const ledger = await listTicketLedger(a.id);
  assert.ok(ledger.some((r) => r.kind === "account_delete" && r.delta === -4));

  await destroyAccountSessions(a.id);
});

test("same email can register a new account after deletion", async () => {
  const email = `reuse${Date.now()}@example.com`;
  const first = await createLocalAccount({
    email,
    passwordHash: await hashPassword("Password1!"),
    name: "Reuse One",
    verifiedAt: Date.now(),
  });
  assert.equal((await deleteAccountSelf(first.id)).ok, true);
  assert.equal(await getAccountByEmail(email), null);

  const second = await createLocalAccount({
    email,
    passwordHash: await hashPassword("Password1!"),
    name: "Reuse Two",
    verifiedAt: Date.now(),
  });
  assert.notEqual(second.id, first.id);
  assert.equal(second.name, "Reuse Two");
  assert.equal((await getAccount(first.id)).name, FALLEN_SOLDIER);
});

test("delete rejects held tickets and is idempotent", async () => {
  const a = await makeAccount("Held User", { tickets: 2 });
  assert.equal(await holdTicket(a.id), true);
  const blocked = await deleteAccountSelf(a.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "held_tickets");

  // release by zeroing held via grant path is awkward; create fresh
  const b = await makeAccount("Idempotent");
  const once = await deleteAccountSelf(b.id);
  assert.equal(once.ok, true);
  const twice = await deleteAccountSelf(b.id);
  assert.equal(twice.ok, true);
  assert.equal(twice.alreadyDeleted, true);
  const ledger = await listTicketLedger(b.id);
  assert.equal(ledger.filter((r) => r.kind === "account_delete").length, 0);
});

test("last admin cannot self-delete", async () => {
  const admin = await makeAccount("Solo Admin");
  await setAccountRole(admin.id, "admin");
  const result = await deleteAccountSelf(admin.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, "last_admin");
});

test("Fallen Soldier name is reserved for live accounts", async () => {
  assert.equal(await isDisplayNameTaken(FALLEN_SOLDIER), true);
  assert.equal(await isDisplayNameTaken("fallen soldier"), true);
});

test("staff detail exposes former name only", async () => {
  const a = await makeAccount("Staff See Me");
  await deleteAccountSelf(a.id);
  const detail = await getUserDetail(a.id);
  assert.equal(detail.deleted, true);
  assert.equal(detail.formerName, "Staff See Me");
  assert.equal(detail.account.name, FALLEN_SOLDIER);
  assert.equal(detail.account.email, null);
});
