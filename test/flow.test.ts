import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./helpers.js";
import { parseBushaEvent } from "../src/busha/provider.js";

const SELLER = "2348011111111";
const BUYER = "2348022222222";

test("full escrow: invoice → pay by bank → Busha webhook → release with PIN → seller credited", async () => {
  const h = makeHarness();
  await h.text(SELLER, "invoice ₦50,000 to 08022222222 for website design", "Tunde");

  const escrow = h.store.allEscrows()[0];
  assert.equal(escrow.amount, 5_000_000);
  assert.equal(escrow.currency, "NGN");
  assert.equal(escrow.buyerPhone, BUYER);
  assert.match(h.wa.outbox.find((m) => m.to === SELLER)!.body, /wa\.me\/15550001111\?text=PAY%20ESC-/);

  // Buyer taps the Pay button on the invoice
  await h.tap(BUYER, `pay:${escrow.id}`);
  const collection = h.store.getEscrow(escrow.id)!.collections[0];
  assert.equal(collection.method, "bank");
  assert.ok(h.wa.outbox.some((m) => m.to === BUYER && m.body === collection.bank!.accountNumber), "account number sent alone");
  assert.ok(h.wa.outbox.some((m) => m.to === BUYER && m.kind === "cta_url"), "checkout button sent");

  // Busha confirms the transfer (signed webhook)
  const { raw, signature } = h.payments.buildPaidWebhook(collection.providerRef, escrow.id);
  assert.ok(h.payments.verifyWebhook(Buffer.from(raw), signature));
  await h.agent.handleProviderEvent(parseBushaEvent(JSON.parse(raw)));
  await h.agent.handleProviderEvent(parseBushaEvent(JSON.parse(raw))); // duplicate delivery is ignored
  assert.equal(h.store.getEscrow(escrow.id)!.status, "FUNDED");
  const funded = h.wa.lastTo(BUYER)!;
  assert.deepEqual(funded.buttons?.map((b) => b.id), [`release:${escrow.id}`, `dispute:${escrow.id}`]);

  // Seller cannot release; buyer taps Release → no PIN yet → Create-PIN Flow
  await h.tap(SELLER, `release:${escrow.id}`);
  assert.equal(h.store.getEscrow(escrow.id)!.status, "FUNDED");
  await h.tap(BUYER, `release:${escrow.id}`);
  const setPin = h.wa.lastTo(BUYER)!;
  assert.equal(setPin.kind, "flow");
  assert.equal(setPin.flow!.screen, "CREATE_PIN");

  // Mismatched confirmation → asked again
  await h.flow(BUYER, { flow_token: setPin.flow!.flowToken, pin: "4826", pin_confirm: "4827" });
  const retry = h.wa.lastTo(BUYER)!;
  assert.match(retry.body, /didn't match/);

  // Correct PIN creation completes the pending release immediately
  await h.flow(BUYER, { flow_token: retry.flow!.flowToken, pin: "4826", pin_confirm: "4826" });
  const released = h.store.getEscrow(escrow.id)!;
  assert.equal(released.status, "RELEASED");
  assert.equal(released.feeMinor, 50_000); // 1%
  assert.equal(h.store.getUser(SELLER)!.balances.NGN, 4_950_000);
  assert.match(h.wa.lastTo(SELLER)!.body, /You've been paid/);

  // Replaying the same Flow token does nothing
  await h.flow(BUYER, { flow_token: retry.flow!.flowToken, pin: "4826", pin_confirm: "4826" });
  assert.match(h.wa.lastTo(BUYER)!.body, /expired or was already used/);
  assert.equal(h.store.getUser(SELLER)!.balances.NGN, 4_950_000);
});

test("USDT invoice gets a deposit address and a wallet deep-link page", async () => {
  const h = makeHarness();
  await h.text(SELLER, "invoice $250 for logo design");
  const e = h.store.allEscrows()[0];
  assert.equal(e.currency, "USDT");
  assert.equal(e.buyerPhone, undefined);

  await h.text(BUYER, `PAY ${e.id}`);
  const c = h.store.getEscrow(e.id)!.collections[0];
  assert.equal(c.method, "crypto");
  assert.equal(c.crypto!.amount, "250.00");
  const cta = h.wa.outbox.find((m) => m.to === BUYER && m.kind === "cta_url")!;
  assert.equal(cta.url, `https://settle.test/pay/${c.providerRef}/crypto`);
  assert.equal(h.store.getEscrow(e.id)!.buyerPhone, BUYER, "first payer claims open invoice");

  // A third person can't hijack a claimed invoice
  await h.text("2348033333333", `pay ${e.id}`);
  assert.match(h.wa.lastTo("2348033333333")!.body, /different customer/);
});

test("wallet: fund → send with PIN; wrong PINs lock the account", async () => {
  const h = makeHarness();
  await h.text(SELLER, "fund ₦20k");
  const topup = Object.values((h.store as any).db.topups)[0] as any;
  const ref = topup.collections[0].providerRef;
  const { raw } = h.payments.buildPaidWebhook(ref, topup.id);
  await h.agent.handleProviderEvent(parseBushaEvent(JSON.parse(raw)));
  assert.equal(h.store.getUser(SELLER)!.balances.NGN, 2_000_000);

  await h.text(SELLER, "add contact Chinedu 08022222222");
  await h.text(SELLER, "send ₦15,000 to Chinedu");
  const setPin = h.wa.lastTo(SELLER)!;
  assert.equal(setPin.flow!.screen, "CREATE_PIN");
  await h.flow(SELLER, { flow_token: setPin.flow!.flowToken, pin: "7391", pin_confirm: "7391" });
  assert.equal(h.store.getUser(SELLER)!.balances.NGN, 500_000);
  assert.equal(h.store.getUser(BUYER)!.balances.NGN, 1_500_000);

  // Next send uses the PIN-entry Flow
  await h.text(SELLER, "send 1000 naira to 08022222222");
  let prompt = h.wa.lastTo(SELLER)!;
  assert.equal(prompt.flow!.screen, "PIN_ENTRY");
  assert.match(prompt.flow!.data.summary, /₦1,000\.00/);
  for (let i = 0; i < 3; i++) {
    await h.flow(SELLER, { flow_token: prompt.flow!.flowToken, pin: "0000" });
    prompt = h.wa.lastTo(SELLER)!;
  }
  assert.match(prompt.body, /locked/);
  assert.equal(h.store.getUser(SELLER)!.balances.NGN, 500_000, "nothing sent");
});

test("PIN-by-chat fallback works when Flows are not configured", async () => {
  const h = makeHarness({ flows: false });
  h.store.transfer(null, SELLER, 10_000, "USDT");
  await h.text(SELLER, "withdraw 50 usdt to TXYZabcdefghijkmnopqrstuvwxyz12345 on trx");
  assert.match(h.wa.lastTo(SELLER)!.body, /Reply with your new 4-digit PIN/);
  await h.text(SELLER, "5824");
  assert.equal(h.store.getUser(SELLER)!.balances.USDT, 5_000);
  assert.match(h.wa.lastTo(SELLER)!.body, /Withdrawal of 50\.00 USDT sent/);
});

test("dispute locks funds; seller can cancel unpaid invoices", async () => {
  const h = makeHarness();
  await h.text(SELLER, "invoice 10000 naira to 2348022222222 for shoes");
  const e = h.store.allEscrows()[0];
  await h.text(SELLER, `cancel ${e.id}`);
  assert.equal(h.store.getEscrow(e.id)!.status, "CANCELLED");

  await h.text(SELLER, "invoice 10000 naira to 2348022222222 for bag");
  const e2 = h.store.allEscrows()[0];
  await h.tap(BUYER, `pay:${e2.id}`);
  const ref = h.store.getEscrow(e2.id)!.collections[0].providerRef;
  await h.agent.handleProviderEvent({ kind: "collection_completed", providerRef: ref, eventKey: "x" });
  await h.tap(BUYER, `dispute:${e2.id}`);
  assert.equal(h.store.getEscrow(e2.id)!.status, "DISPUTED");
  await h.tap(BUYER, `release:${e2.id}`);
  assert.match(h.wa.lastTo(BUYER)!.body, /can't be released/);
});
