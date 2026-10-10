import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-community-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.LOCAL_ACCOUNTS = "1";
process.env.DISCORD_LOGIN = "0";
process.env.FORMBAR_LOGIN = "0";
process.env.AUTH_EMAIL = "1";
delete process.env.ADMIN_BOOTSTRAP_ACCOUNT_ID;

const {
  initDb,
  createLocalAccount,
  getAccount,
  createPaypalPurchase,
  markPaypalPurchaseCaptured,
  creditPaypalPurchase,
  clawbackPaypalPurchase,
  spendFreeTicket,
  chargeHeld,
  holdTicket,
  refundTicket,
  grantTickets,
  communityPercentages,
  createFundingGoal,
  replaceFundingGoal,
  fulfillFundingGoal,
  startDevRound,
  closeDevRound,
  setCommunityDefaults,
  ensurePlayerCommunitySelections,
  setPlayerCommunitySelection,
  getCommunityPublicState,
  getCommunityHistory,
  listCommunityContributions,
  listLiveFundingGoals,
  listActiveDevPriorities,
} = await import("../server/db.js");
const { hashPassword, communityFundingEnabled } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount() {
  seq += 1;
  return createLocalAccount({
    email: `comm${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name: `Comm User ${seq}`,
    verifiedAt: Date.now(),
  });
}

async function creditPack(accountId, {
  packageId = "pack_5",
  amountValue = "5.00",
  tickets = 20,
  orderId,
}) {
  const purchase = await createPaypalPurchase({
    accountId,
    packageId,
    amountValue,
    currency: "USD",
    tickets,
    paypalOrderId: orderId,
  });
  await markPaypalPurchaseCaptured(purchase.id, `CAP-${orderId}`);
  const credited = await creditPaypalPurchase(purchase.id);
  assert.equal(credited.ok, true);
  return purchase;
}

async function setupCommunity() {
  const goals = [];
  const live = await listLiveFundingGoals();
  if (live.length === 0) {
    for (let slot = 0; slot < 3; slot += 1) {
      const r = await createFundingGoal({
        title: `Goal ${slot}`,
        description: `Desc ${slot}`,
        targetTickets: 10,
        slot,
        setAsDefault: slot === 0,
      });
      assert.equal(r.ok, true, r.error);
      goals.push(r.goal);
    }
  } else {
    const bySlot = [0, 1, 2].map((slot) => live.find((g) => Number(g.slot) === slot));
    for (let slot = 0; slot < 3; slot += 1) {
      const cur = bySlot[slot];
      if (!cur) {
        const r = await createFundingGoal({
          title: `Goal ${slot}`,
          description: `Desc ${slot}`,
          targetTickets: 10,
          slot,
          setAsDefault: slot === 0,
        });
        assert.equal(r.ok, true, r.error);
        goals.push(r.goal);
      } else {
        const r = await replaceFundingGoal(cur.id, {
          title: `Goal ${slot}`,
          description: `Desc ${slot}`,
          targetTickets: 10,
          transferOverflow: false,
          setAsDefault: slot === 0,
        });
        assert.equal(r.ok, true, r.error);
        goals.push(r.goal);
      }
    }
  }

  const openPri = await listActiveDevPriorities();
  if (openPri.length) {
    const closed = await closeDevRound({ winnerPriorityId: openPri[0].id });
    assert.equal(closed.ok, true, closed.error);
  }
  const round = await startDevRound({
    priorities: [
      { title: "Units", description: "New units", setAsDefault: true },
      { title: "Modes", description: "New modes" },
      { title: "Campaign", description: "Campaign" },
    ],
  });
  assert.equal(round.ok, true, round.error);
  return { goals, round };
}

test("communityPercentages sum to 100 or all zero", () => {
  assert.deepEqual(communityPercentages([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(communityPercentages([1, 1, 1]), [34, 33, 33]);
  const p = communityPercentages([50, 30, 20]);
  assert.equal(p.reduce((a, b) => a + b, 0), 100);
});

test("communityFundingEnabled is off when Formbar is the only login", () => {
  const prev = {
    LOCAL_ACCOUNTS: process.env.LOCAL_ACCOUNTS,
    DISCORD_LOGIN: process.env.DISCORD_LOGIN,
    FORMBAR_LOGIN: process.env.FORMBAR_LOGIN,
  };
  try {
    process.env.LOCAL_ACCOUNTS = "0";
    process.env.DISCORD_LOGIN = "0";
    process.env.FORMBAR_LOGIN = "1";
    assert.equal(communityFundingEnabled(), false);
    process.env.LOCAL_ACCOUNTS = "1";
    assert.equal(communityFundingEnabled(), true);
    process.env.LOCAL_ACCOUNTS = "0";
    process.env.DISCORD_LOGIN = "1";
    assert.equal(communityFundingEnabled(), true);
  } finally {
    process.env.LOCAL_ACCOUNTS = prev.LOCAL_ACCOUNTS;
    process.env.DISCORD_LOGIN = prev.DISCORD_LOGIN;
    process.env.FORMBAR_LOGIN = prev.FORMBAR_LOGIN;
  }
});

test("first-time player receives defaults", async () => {
  const { goals, round } = await setupCommunity();
  const account = await makeAccount();
  const sel = await ensurePlayerCommunitySelections(account.id);
  assert.equal(sel.fundingGoalId, goals[0].id);
  assert.equal(sel.devPriorityId, round.priorityIds[0]);
});

test("player can change either selection without redistributing totals", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await creditPack(account.id, { orderId: `ORD-SEL-${account.id}`, tickets: 5, amountValue: "5.00" });
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  assert.equal(await spendFreeTicket(account.id), true);
  const before = await getCommunityPublicState(account.id);
  const fund0 = before.funding[0].contributedTickets;
  const fund1 = before.funding[1].contributedTickets;
  await setPlayerCommunitySelection(account.id, { fundingGoalId: goals[1].id });
  const after = await getCommunityPublicState(account.id);
  assert.equal(after.funding[0].contributedTickets, fund0);
  assert.equal(after.funding[1].contributedTickets, fund1);
  assert.equal(after.selections.fundingGoalId, goals[1].id);
});

test("paid spend affects funding and development; grant spend only development", async () => {
  await setupCommunity();
  const paidUser = await makeAccount();
  const freeUser = await makeAccount();
  await creditPack(paidUser.id, { orderId: `ORD-PAID-${paidUser.id}`, tickets: 5 });
  await grantTickets(freeUser.id, 5);
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setCommunityDefaults({
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  await setPlayerCommunitySelection(paidUser.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  await setPlayerCommunitySelection(freeUser.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  const before = await getCommunityPublicState();
  assert.equal(await spendFreeTicket(paidUser.id), true);
  assert.equal(await spendFreeTicket(freeUser.id), true);
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, before.funding[0].contributedTickets + 1);
  assert.equal(
    after.development[0].contributedTickets,
    before.development[0].contributedTickets + 2,
  );
});

test("ticket purchase alone does not contribute", async () => {
  await setupCommunity();
  const account = await makeAccount();
  const before = await getCommunityPublicState();
  await creditPack(account.id, { orderId: `ORD-BUY-${account.id}`, tickets: 20 });
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, before.funding[0].contributedTickets);
  assert.equal(
    after.development[0].contributedTickets,
    before.development[0].contributedTickets,
  );
});

test("failed spend generates no contributions", async () => {
  await setupCommunity();
  const account = await makeAccount();
  const before = await getCommunityPublicState();
  assert.equal(await spendFreeTicket(account.id), false);
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, before.funding[0].contributedTickets);
  assert.equal(
    after.development[0].contributedTickets,
    before.development[0].contributedTickets,
  );
});

test("funding can exceed 100 percent", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await creditPack(account.id, {
    orderId: `ORD-OVER-${account.id}`,
    packageId: "pack_20",
    amountValue: "20.00",
    tickets: 100,
  });
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  for (let i = 0; i < 15; i += 1) {
    assert.equal(await spendFreeTicket(account.id), true);
  }
  const state = await getCommunityPublicState();
  assert.ok(state.funding[0].contributedTickets >= 15);
  assert.ok(state.funding[0].contributedTickets > state.funding[0].targetTickets);
  assert.equal(state.funding[0].barPercent, 100);
  assert.equal(state.funding[0].status, "goal_reached");
});

test("replace funding preserves history and migrates selections", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await creditPack(account.id, { orderId: `ORD-REP-${account.id}`, tickets: 5 });
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  assert.equal(await spendFreeTicket(account.id), true);
  const oldId = goals[0].id;
  const replaced = await replaceFundingGoal(oldId, {
    title: "New Hosting",
    description: "Better servers",
    targetTickets: 50,
    transferOverflow: false,
    setAsDefault: true,
  });
  assert.equal(replaced.ok, true, replaced.error);
  const sel = await ensurePlayerCommunitySelections(account.id);
  assert.equal(sel.fundingGoalId, replaced.goal.id);
  const history = await getCommunityHistory();
  assert.ok(history.funding.some((g) => g.id === oldId && g.status === "archived"));
  const live = await listLiveFundingGoals();
  assert.ok(live.some((g) => g.id === replaced.goal.id));
  assert.ok(!live.some((g) => g.id === oldId));
});

test("match refund reverses funding and development", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await creditPack(account.id, { orderId: `ORD-REF-${account.id}`, tickets: 5 });
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  assert.equal(await holdTicket(account.id), true);
  assert.equal(await chargeHeld(account.id), true);
  const mid = await getCommunityPublicState();
  assert.equal(mid.funding[0].contributedTickets >= 1, true);
  await refundTicket(account.id);
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, mid.funding[0].contributedTickets - 1);
  assert.equal(
    after.development[0].contributedTickets,
    mid.development[0].contributedTickets - 1,
  );
  assert.equal((await getAccount(account.id)).tickets, 5);
});

test("paypal clawback reverses funding from that purchase but not necessarily all dev", async () => {
  await setupCommunity();
  const account = await makeAccount();
  const purchase = await creditPack(account.id, {
    orderId: `ORD-CLAW-${account.id}`,
    tickets: 5,
  });
  await grantTickets(account.id, 2);
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  // FIFO: spend grant first if grant lot is older? grant is after purchase, so paid first.
  assert.equal(await spendFreeTicket(account.id), true);
  const mid = await getCommunityPublicState();
  const fundMid = mid.funding[0].contributedTickets;
  const devMid = mid.development[0].contributedTickets;
  const result = await clawbackPaypalPurchase(purchase.id, { status: "refunded" });
  assert.equal(result.ok, true);
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, fundMid - 1);
  assert.equal(after.development[0].contributedTickets, devMid);
});

test("closing a round preserves final results", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await grantTickets(account.id, 3);
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, { devPriorityId: pris[1].id });
  assert.equal(await spendFreeTicket(account.id), true);
  assert.equal(await spendFreeTicket(account.id), true);
  const closed = await closeDevRound({
    winnerPriorityId: pris[1].id,
    tieBreakNotes: "clear lead",
  });
  assert.equal(closed.ok, true, closed.error);
  const history = await getCommunityHistory();
  const round = history.rounds.find((r) => r.id === closed.roundId);
  assert.ok(round);
  assert.equal(round.winnerPriorityId, pris[1].id);
  assert.ok(round.priorities.some((p) => p.id === pris[1].id && p.voteStatus === "won"));
  const open = await listActiveDevPriorities();
  assert.equal(open.length, 0);
});

test("legacy/grant never counts as paid funding", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await grantTickets(account.id, 3);
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  const before = await getCommunityPublicState();
  assert.equal(await spendFreeTicket(account.id), true);
  const after = await getCommunityPublicState();
  assert.equal(after.funding[0].contributedTickets, before.funding[0].contributedTickets);
  assert.equal(
    after.development[0].contributedTickets,
    before.development[0].contributedTickets + 1,
  );
  const rows = await listCommunityContributions({ accountId: account.id, limit: 5 });
  assert.ok(rows.some((r) => r.paid_tickets === 0 && r.dev_delta === 1));
});

test("fulfill does not erase contribution total", async () => {
  await setupCommunity();
  const account = await makeAccount();
  await creditPack(account.id, {
    orderId: `ORD-FUL-${account.id}`,
    packageId: "pack_20",
    amountValue: "20.00",
    tickets: 100,
  });
  const goals = await listLiveFundingGoals();
  const pris = await listActiveDevPriorities();
  await setPlayerCommunitySelection(account.id, {
    fundingGoalId: goals[0].id,
    devPriorityId: pris[0].id,
  });
  for (let i = 0; i < 12; i += 1) {
    assert.equal(await spendFreeTicket(account.id), true);
  }
  const fulfilled = await fulfillFundingGoal(goals[0].id, {
    notes: "Bought hosting",
    links: "https://example.com",
  });
  assert.equal(fulfilled.ok, true);
  assert.equal(fulfilled.goal.status, "fulfilled");
  assert.ok(fulfilled.goal.contributedTickets >= 12);
});
