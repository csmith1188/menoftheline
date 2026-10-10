import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "motl-lots-"));
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
  addTickets,
  listTicketLotsForAccount,
  paypalRefundValueCents,
  formatUsdFromCents,
  amountValueToCents,
  lotRefundCents,
} = await import("../server/db.js");
const { hashPassword } = await import("../server/auth.js");

await initDb();

let seq = 0;
async function makeAccount() {
  seq += 1;
  return createLocalAccount({
    email: `lots${seq}@example.com`,
    passwordHash: await hashPassword("Password1!"),
    name: `Lot User ${seq}`,
    verifiedAt: Date.now(),
  });
}

async function creditPack(accountId, {
  packageId,
  amountValue,
  tickets,
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
  assert.equal(credited.credited, true);
  return purchase;
}

async function sumRemaining(accountId) {
  const lots = await listTicketLotsForAccount(accountId);
  return lots.reduce((n, lot) => n + Number(lot.tickets_remaining), 0);
}

test("amountValueToCents and lotRefundCents helpers", () => {
  assert.equal(amountValueToCents("5.00"), 500);
  assert.equal(amountValueToCents("20"), 2000);
  assert.equal(lotRefundCents(10, 500, 20), 250);
  assert.equal(formatUsdFromCents(2250), "22.50");
});

test("FIFO refund: 20@$5 then 100@$20, spend 10 → $22.50", async () => {
  const account = await makeAccount();
  await creditPack(account.id, {
    packageId: "pack_5",
    amountValue: "5.00",
    tickets: 20,
    orderId: `ORDER-FIFO-A-${account.id}`,
  });
  await creditPack(account.id, {
    packageId: "pack_20",
    amountValue: "20.00",
    tickets: 100,
    orderId: `ORDER-FIFO-B-${account.id}`,
  });
  assert.equal((await getAccount(account.id)).tickets, 120);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await spendFreeTicket(account.id), true);
  }
  const fresh = await getAccount(account.id);
  assert.equal(fresh.tickets, 110);
  assert.equal(await sumRemaining(account.id), 110);
  assert.equal(await paypalRefundValueCents(account.id), 2250);
  assert.equal(formatUsdFromCents(await paypalRefundValueCents(account.id)), "22.50");

  const lots = await listTicketLotsForAccount(account.id);
  const pack5 = lots.find((l) => l.source_type === "paypal_purchase" && l.tickets_total === 20);
  const pack20 = lots.find((l) => l.source_type === "paypal_purchase" && l.tickets_total === 100);
  assert.equal(pack5.tickets_remaining, 10);
  assert.equal(pack20.tickets_remaining, 100);
});

test("Digipog $0 lot sits in the same FIFO order", async () => {
  const account = await makeAccount();
  await creditPack(account.id, {
    packageId: "pack_5",
    amountValue: "5.00",
    tickets: 20,
    orderId: `ORDER-DIGI-A-${account.id}`,
  });
  await addTickets(account.id, 5, 100, 800000 + account.id);
  await creditPack(account.id, {
    packageId: "pack_20",
    amountValue: "20.00",
    tickets: 100,
    orderId: `ORDER-DIGI-B-${account.id}`,
  });
  // Spend all 20 PayPal + 5 Digipog from the oldest lots first.
  for (let i = 0; i < 25; i += 1) {
    assert.equal(await spendFreeTicket(account.id), true);
  }
  assert.equal((await getAccount(account.id)).tickets, 100);
  assert.equal(await paypalRefundValueCents(account.id), 2000);
  const lots = await listTicketLotsForAccount(account.id);
  const digi = lots.find((l) => l.source_type === "ticket_purchase");
  assert.ok(digi);
  assert.equal(digi.amount_cents, 0);
  assert.equal(digi.tickets_remaining, 0);
  const pack20 = lots.find((l) => l.tickets_total === 100 && l.source_type === "paypal_purchase");
  assert.equal(pack20.tickets_remaining, 100);
});

test("charge then refundTicket restores costed lot", async () => {
  const account = await makeAccount();
  await creditPack(account.id, {
    packageId: "pack_5",
    amountValue: "5.00",
    tickets: 20,
    orderId: `ORDER-REF-${account.id}`,
  });
  assert.equal(await holdTicket(account.id), true);
  assert.equal(await chargeHeld(account.id), true);
  assert.equal((await getAccount(account.id)).tickets, 19);
  assert.equal(await paypalRefundValueCents(account.id), 475);
  await refundTicket(account.id);
  assert.equal((await getAccount(account.id)).tickets, 20);
  assert.equal(await sumRemaining(account.id), 20);
  assert.equal(await paypalRefundValueCents(account.id), 500);
  const lots = await listTicketLotsForAccount(account.id);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].tickets_remaining, 20);
  assert.equal(lots[0].amount_cents, 500);
});

test("clawback prefers the purchase lot then FIFO others", async () => {
  const account = await makeAccount();
  const first = await creditPack(account.id, {
    packageId: "pack_5",
    amountValue: "5.00",
    tickets: 20,
    orderId: `ORDER-CLAW-A-${account.id}`,
  });
  await creditPack(account.id, {
    packageId: "pack_5",
    amountValue: "5.00",
    tickets: 20,
    orderId: `ORDER-CLAW-B-${account.id}`,
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await spendFreeTicket(account.id), true);
  }
  // First pack has 15 left; clawback wants 20 → takes 15 from pack + 5 from next.
  const result = await clawbackPaypalPurchase(first.id, { status: "refunded" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 20);
  assert.equal(result.shortfall, 0);
  assert.equal((await getAccount(account.id)).tickets, 15);
  assert.equal(await sumRemaining(account.id), 15);
  const lots = await listTicketLotsForAccount(account.id);
  const firstLot = lots.find((l) => String(l.source_id) === String(first.id));
  assert.equal(firstLot.tickets_remaining, 0);
});

test("grant lots are $0 and keep sum(remaining) == tickets", async () => {
  const account = await makeAccount();
  await grantTickets(account.id, 3);
  assert.equal(await sumRemaining(account.id), 3);
  assert.equal(await paypalRefundValueCents(account.id), 0);
  assert.equal(await spendFreeTicket(account.id), true);
  assert.equal(await sumRemaining(account.id), 2);
  assert.equal((await getAccount(account.id)).tickets, 2);
});
