import { loadConfig } from "../src/config.js";
import { Store } from "../src/core/store.js";
import { ConsoleSender } from "../src/whatsapp/client.js";
import { MockBushaProvider } from "../src/busha/provider.js";
import { RulesIntentParser } from "../src/agent/intent.js";
import { Agent } from "../src/agent/agent.js";
import type { Inbound } from "../src/whatsapp/webhook.js";

let counter = 0;

export function makeHarness(overrides: { flows?: boolean } = {}) {
  const cfg = loadConfig();
  cfg.whatsapp.botNumber = "15550001111";
  cfg.whatsapp.pinFlowId = overrides.flows === false ? "" : "PIN_FLOW";
  cfg.whatsapp.setPinFlowId = overrides.flows === false ? "" : "SET_PIN_FLOW";
  cfg.escrowFeeBps = 100;
  cfg.publicBaseUrl = "https://settle.test";
  const store = new Store(null);
  const wa = new ConsoleSender(false);
  const payments = new MockBushaProvider({ publicBaseUrl: "https://settle.test", webhookSecret: "s3cret", cryptoNetwork: "TRX" });
  const agent = new Agent({ cfg, store, wa, payments, parser: new RulesIntentParser() });

  const text = (from: string, body: string, name?: string) =>
    agent.handleInbound({ id: `m${++counter}`, from, name, type: "text", text: body } as Inbound);
  const tap = (from: string, buttonId: string) =>
    agent.handleInbound({ id: `m${++counter}`, from, type: "button", buttonId, title: buttonId } as Inbound);
  const flow = (from: string, response: Record<string, unknown>) =>
    agent.handleInbound({ id: `m${++counter}`, from, type: "flow_reply", response } as Inbound);

  return { cfg, store, wa, payments, agent, text, tap, flow };
}
