import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseAmount } from "../src/core/money.js";
import { parseIntentRules, normalisePhone } from "../src/agent/intent.js";
import { verifyBushaSignature, parseBushaEvent } from "../src/busha/provider.js";
import { verifyMetaSignature, parseWhatsAppWebhook } from "../src/whatsapp/webhook.js";
import { eip681UsdtUri, toBaseUnits } from "../src/core/deeplinks.js";
import { hashPin, verifyPin, isValidPin } from "../src/core/pin.js";
import { payloads } from "../src/whatsapp/client.js";

test("parseAmount handles Nigerian formats", () => {
  assert.deepEqual(parseAmount("₦15,000"), { amount: 15000, currency: "NGN" });
  assert.deepEqual(parseAmount("N15k"), { amount: 15000, currency: "NGN" });
  assert.deepEqual(parseAmount("send 2.5m naira"), { amount: 2_500_000, currency: "NGN" });
  assert.deepEqual(parseAmount("$250"), { amount: 250, currency: "USDT" });
  assert.deepEqual(parseAmount("100 usdt"), { amount: 100, currency: "USDT" });
  assert.deepEqual(parseAmount("5000"), { amount: 5000, currency: undefined });
});

test("rules parser", () => {
  const inv = parseIntentRules("invoice 250 usdt to +234 803 123 4567 for logo design");
  assert.equal(inv?.intent, "create_invoice");
  assert.equal(inv?.amount, 250);
  assert.equal(inv?.currency, "USDT");
  assert.equal(inv?.description, "logo design");

  const bill = parseIntentRules("bill tunde ₦50k for website");
  assert.equal(bill?.intent, "create_invoice");
  assert.equal(bill?.amount, 50000);

  const send = parseIntentRules("Send ₦15,000 to Chinedu");
  assert.equal(send?.intent, "send");
  assert.equal(send?.counterparty, "Chinedu");

  assert.equal(parseIntentRules("pay ESC-AB12C")?.escrowId, "ESC-AB12C");
  assert.equal(parseIntentRules("release esc-ab12c")?.intent, "release");
  const wd = parseIntentRules("withdraw 100 usdt to 0x1111111111111111111111111111111111111111 on bsc");
  assert.equal(wd?.network, "BSC");
  assert.equal(parseIntentRules("abeg how far"), null, "free text falls through to Claude");
  assert.equal(normalisePhone("0803 123 4567"), "2348031234567");
});

test("Busha signature: base64 and hex accepted, tampering rejected", () => {
  const body = Buffer.from('{"event":"payment_request.completed","data":{"id":"PAYR_1"}}');
  const mac = createHmac("sha256", "whsec").update(body);
  const digest = mac.digest();
  assert.ok(verifyBushaSignature(body, digest.toString("base64"), "whsec"));
  assert.ok(verifyBushaSignature(body, digest.toString("hex"), "whsec"));
  assert.ok(!verifyBushaSignature(Buffer.from(body.toString() + " "), digest.toString("base64"), "whsec"));
  assert.ok(!verifyBushaSignature(body, undefined, "whsec"));
  assert.equal(parseBushaEvent({ event: "transfer.funds_delivered", data: { id: "TRF_1" } }).kind, "payout_completed");
  assert.equal(parseBushaEvent({ event: "customer.created", data: {} }).kind, "ignored");
});

test("Meta signature + webhook parsing", () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "2348011111111", profile: { name: "Ada" } }],
              messages: [
                { id: "a", from: "2348011111111", type: "text", text: { body: "hi" } },
                { id: "b", from: "2348011111111", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "release:ESC-1", title: "Release" } } },
                { id: "c", from: "2348011111111", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: '{"flow_token":"t","pin":"1357"}' } } },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = "sha256=" + createHmac("sha256", "app").update(raw).digest("hex");
  assert.ok(verifyMetaSignature(raw, sig, "app"));
  assert.ok(!verifyMetaSignature(raw, sig, "other"));
  const msgs = parseWhatsAppWebhook(body);
  assert.deepEqual(msgs.map((m) => m.type), ["text", "button", "flow_reply"]);
  assert.equal(msgs[0].name, "Ada");
  assert.deepEqual((msgs[2] as any).response, { flow_token: "t", pin: "1357" });
});

test("EIP-681 deep link", () => {
  assert.equal(toBaseUnits("250.5", 6), "250500000");
  assert.equal(toBaseUnits("1", 18), "1000000000000000000");
  assert.equal(
    eip681UsdtUri("ETH", "0xabc", "250.00"),
    "ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=0xabc&uint256=250000000",
  );
  assert.equal(eip681UsdtUri("TRX", "T…", "1"), null);
});

test("PIN hashing and validation", () => {
  const { hash, salt } = hashPin("4826");
  assert.ok(verifyPin("4826", hash, salt));
  assert.ok(!verifyPin("4827", hash, salt));
  assert.ok(!isValidPin("1111") && !isValidPin("1234") && !isValidPin("12a4") && isValidPin("4826"));
});

test("Cloud API payload shapes", () => {
  const p = payloads.flow("234", { flowId: "F", flowToken: "T", cta: "Enter PIN", body: "b", screen: "PIN_ENTRY", data: { summary: "s" } }, "draft");
  assert.equal(p.interactive.action.parameters.flow_action, "navigate");
  assert.equal(p.interactive.action.parameters.mode, "draft");
  const b = payloads.buttons("234", "x", [{ id: "1", title: "A very long button title here" }]);
  assert.ok(b.interactive.action.buttons[0].reply.title.length <= 20);
});
