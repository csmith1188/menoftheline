import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-reports-"));
process.env.DATA_DIR = dataDir;
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;
delete process.env.ADMIN_USER_ID;

const {
  initDb,
  createLocalAccount,
  createPlayerReport,
  hasPlayerReport,
  listPlayerReports,
  resolvePlayerReport,
  resolvePlayerReportsForUser,
  countOpenPlayerReports,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  return createLocalAccount({
    email: `report${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
}

test("one report per reporter→reported pair", async () => {
  const a = await makeAccount("Reporter A");
  const b = await makeAccount("Target B");
  const first = await createPlayerReport({
    reporterAccountId: a.id,
    reporterName: a.name,
    reportedAccountId: b.id,
    reportedName: b.name,
    matchId: "match-1",
    matchMode: "ranked",
    body: "Griefing in ranked",
  });
  assert.equal(first.ok, true);
  assert.ok(first.id > 0);
  assert.equal(await hasPlayerReport(a.id, b.id), true);
  const again = await createPlayerReport({
    reporterAccountId: a.id,
    reporterName: a.name,
    reportedAccountId: b.id,
    reportedName: b.name,
    body: "Second attempt",
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, "already_reported");
});

test("reverse direction and other targets still allowed", async () => {
  const a = await makeAccount("Reporter C");
  const b = await makeAccount("Target D");
  const c = await makeAccount("Target E");
  assert.equal((await createPlayerReport({
    reporterAccountId: a.id,
    reporterName: a.name,
    reportedAccountId: b.id,
    reportedName: b.name,
    body: "First target",
  })).ok, true);
  assert.equal((await createPlayerReport({
    reporterAccountId: b.id,
    reporterName: b.name,
    reportedAccountId: a.id,
    reportedName: a.name,
    body: "Counter report",
  })).ok, true);
  assert.equal((await createPlayerReport({
    reporterAccountId: a.id,
    reporterName: a.name,
    reportedAccountId: c.id,
    reportedName: c.name,
    body: "Different target",
  })).ok, true);
});

test("resolve one and resolve-all for user", async () => {
  const r1 = await makeAccount("R1");
  const r2 = await makeAccount("R2");
  const target = await makeAccount("Ban Me");
  await createPlayerReport({
    reporterAccountId: r1.id,
    reporterName: r1.name,
    reportedAccountId: target.id,
    reportedName: target.name,
    body: "Report one",
  });
  await createPlayerReport({
    reporterAccountId: r2.id,
    reporterName: r2.name,
    reportedAccountId: target.id,
    reportedName: target.name,
    body: "Report two",
  });
  assert.equal(await countOpenPlayerReports(target.id), 2);
  const open = await listPlayerReports({ reportedAccountId: target.id, status: "open" });
  assert.equal(open.length, 2);
  assert.equal(await resolvePlayerReport(open[0].id, {
    status: "dismissed",
    resolvedBy: r1.id,
    note: "no action",
  }), true);
  assert.equal(await countOpenPlayerReports(target.id), 1);
  const n = await resolvePlayerReportsForUser(target.id, {
    status: "resolved",
    resolvedBy: r1.id,
    note: "cleared",
  });
  assert.equal(n, 1);
  assert.equal(await countOpenPlayerReports(target.id), 0);
  // Unique pair still blocks a new report after resolve.
  const blocked = await createPlayerReport({
    reporterAccountId: r1.id,
    reporterName: r1.name,
    reportedAccountId: target.id,
    reportedName: target.name,
    body: "After resolve",
  });
  assert.equal(blocked.error, "already_reported");
});
