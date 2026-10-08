import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-admin-auth-"));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;
delete process.env.ADMIN_USER_ID;

const {
  initDb,
  createLocalAccount,
  setAccountRole,
  countAdmins,
  getAccount,
  isAccountBanned,
  banAccount,
  writeAdminAudit,
  listAdminAudit,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");
const {
  accountIsAdmin,
  accountIsStaff,
  assertNotSelfTarget,
  getStaffContext,
} = await import("../server/admin/auth.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  const hash = await hashPassword("Password1!");
  const account = await createLocalAccount({
    email: `u${seq}@example.com`,
    passwordHash: hash,
    name,
    verifiedAt: Date.now(),
  });
  assert.ok(account);
  return account;
}

test("default accounts are players, not staff", async () => {
  const account = await makeAccount("Player One");
  assert.equal(accountIsAdmin(account), false);
  assert.equal(accountIsStaff(account), false);
  const staff = await getStaffContext({ accountId: account.id });
  assert.equal(staff.role, "player");
});

test("role admin grants admin, moderator grants staff only", async () => {
  const account = await makeAccount("Staff Two");
  await setAccountRole(account.id, "moderator");
  const mod = await getAccount(account.id);
  assert.equal(accountIsStaff(mod), true);
  assert.equal(accountIsAdmin(mod), false);

  await setAccountRole(account.id, "admin");
  const admin = await getAccount(account.id);
  assert.equal(accountIsAdmin(admin), true);
});

test("cannot demote the last admin", async () => {
  const a = await makeAccount("Admin A");
  const b = await makeAccount("Admin B");
  await setAccountRole(a.id, "admin");
  await setAccountRole(b.id, "admin");
  assert.ok((await countAdmins()) >= 2);

  // Demote all admins except b
  for (let id = 1; id <= a.id; id += 1) {
    const acct = await getAccount(id);
    if (acct && acct.id !== b.id && acct.role === "admin") {
      const r = await setAccountRole(id, "player");
      assert.equal(r.ok, true);
    }
  }
  assert.equal(await countAdmins(), 1);
  const last = await setAccountRole(b.id, "player");
  assert.equal(last.ok, false);
  assert.equal(last.error, "last_admin");
});

test("self-target guard", () => {
  assert.equal(assertNotSelfTarget(3, 3).ok, false);
  assert.equal(assertNotSelfTarget(3, 4).ok, true);
});

test("ban marks account banned", async () => {
  const account = await makeAccount("Banned Guy");
  const result = await banAccount(account.id, { reason: "abuse", bannedBy: 1 });
  assert.equal(result.ok, true);
  assert.equal(isAccountBanned(result.account), true);
});

test("audit rows persist", async () => {
  const id = await writeAdminAudit({
    adminAccountId: 1,
    action: "test_action",
    targetType: "account",
    targetId: "2",
    reason: "unit test",
    before: { a: 1 },
    after: { a: 2 },
  });
  assert.ok(id > 0);
  const list = await listAdminAudit({ pageSize: 5 });
  assert.ok(list.rows.some((r) => r.action === "test_action"));
});

test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold the sqlite handle */
  }
});
