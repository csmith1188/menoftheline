import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-own-bugs-"));
process.env.DATA_DIR = dataDir;

const {
  initDb,
  createLocalAccount,
  createSuggestion,
  countOpenBugs,
  countOpenSuggestions,
  deleteOwnBug,
  deleteOwnSuggestion,
  getAccount,
  getSuggestion,
  listOpenBugsForAccount,
  listOpenSuggestionsForAccount,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount(name) {
  seq += 1;
  const account = await createLocalAccount({
    email: `bugs${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name,
    verifiedAt: Date.now(),
  });
  return getAccount(account.id);
}

test("listOpenBugsForAccount returns only own open bugs", async () => {
  const a = await makeAccount("Bug Owner");
  const b = await makeAccount("Other Player");
  const ownBug = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "My bug",
    isBug: true,
    repro: "Click stuff",
  });
  await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "Not a bug",
    isBug: false,
    repro: null,
  });
  await createSuggestion({
    accountId: b.id,
    formbarId: 0,
    name: b.name,
    body: "Their bug",
    isBug: true,
    repro: "Other steps",
  });

  const listed = await listOpenBugsForAccount(a.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, ownBug);
  assert.equal(listed[0].body, "My bug");
  assert.equal(await countOpenBugs(a.id), 1);
});

test("deleteOwnBug archives own bug and frees open slot", async () => {
  const a = await makeAccount("Deleter");
  const bugId = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "Delete me",
    isBug: true,
    repro: "repro",
  });
  assert.equal(await countOpenBugs(a.id), 1);
  assert.equal(await deleteOwnBug(a.id, bugId), true);
  assert.equal(await countOpenBugs(a.id), 0);
  assert.equal((await listOpenBugsForAccount(a.id)).length, 0);
  const row = await getSuggestion(bugId);
  assert.ok(row.archived_at);
  assert.equal(await deleteOwnBug(a.id, bugId), false);
});

test("deleteOwnBug cannot archive another account's bug", async () => {
  const a = await makeAccount("Victim");
  const b = await makeAccount("Attacker");
  const bugId = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "Leave me alone",
    isBug: true,
    repro: "repro",
  });
  assert.equal(await deleteOwnBug(b.id, bugId), false);
  const row = await getSuggestion(bugId);
  assert.equal(row.archived_at, null);
  assert.equal(await countOpenBugs(a.id), 1);
});

test("listOpenSuggestionsForAccount returns only own open suggestions", async () => {
  const a = await makeAccount("Suggest Owner");
  const b = await makeAccount("Other Suggest");
  const ownId = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "My idea",
    isBug: false,
    repro: null,
  });
  await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "My bug not idea",
    isBug: true,
    repro: "steps",
  });
  await createSuggestion({
    accountId: b.id,
    formbarId: 0,
    name: b.name,
    body: "Their idea",
    isBug: false,
    repro: null,
  });

  const listed = await listOpenSuggestionsForAccount(a.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, ownId);
  assert.equal(listed[0].body, "My idea");
  assert.equal(await countOpenSuggestions(a.id), 1);
});

test("deleteOwnSuggestion archives own suggestion and frees open slot", async () => {
  const a = await makeAccount("Suggest Deleter");
  const id = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "Delete this idea",
    isBug: false,
    repro: null,
  });
  assert.equal(await countOpenSuggestions(a.id), 1);
  assert.equal(await deleteOwnSuggestion(a.id, id), true);
  assert.equal(await countOpenSuggestions(a.id), 0);
  assert.equal((await listOpenSuggestionsForAccount(a.id)).length, 0);
  const row = await getSuggestion(id);
  assert.ok(row.archived_at);
  assert.equal(await deleteOwnSuggestion(a.id, id), false);
  assert.equal(await deleteOwnBug(a.id, id), false);
});

test("deleteOwnSuggestion cannot archive another account's suggestion", async () => {
  const a = await makeAccount("Suggest Victim");
  const b = await makeAccount("Suggest Attacker");
  const id = await createSuggestion({
    accountId: a.id,
    formbarId: 0,
    name: a.name,
    body: "Keep this idea",
    isBug: false,
    repro: null,
  });
  assert.equal(await deleteOwnSuggestion(b.id, id), false);
  const row = await getSuggestion(id);
  assert.equal(row.archived_at, null);
  assert.equal(await countOpenSuggestions(a.id), 1);
});
