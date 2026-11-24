import { loadConfig } from "./config.js";
import { Store } from "./core/store.js";
import { CloudApiSender, ConsoleSender, type WhatsAppSender } from "./whatsapp/client.js";
import { BushaProvider, MockBushaProvider, type PaymentProvider } from "./busha/provider.js";
import { RulesIntentParser, type IntentParser } from "./agent/intent.js";
import { ClaudeIntentParser } from "./agent/claude.js";
import { Agent } from "./agent/agent.js";
import { createServer } from "./server.js";

const cfg = loadConfig();
const store = new Store(cfg.dataFile);

const wa: WhatsAppSender = cfg.whatsapp.mode === "cloud" ? new CloudApiSender(cfg.whatsapp) : new ConsoleSender();

const payments: PaymentProvider =
  cfg.busha.mode === "live"
    ? new BushaProvider(cfg.busha)
    : new MockBushaProvider({ publicBaseUrl: cfg.publicBaseUrl, webhookSecret: cfg.busha.webhookSecret, cryptoNetwork: cfg.busha.cryptoNetwork });

const parser: IntentParser = cfg.anthropic.enabled ? new ClaudeIntentParser(cfg.anthropic.model) : new RulesIntentParser();

const agent = new Agent({ cfg, store, wa, payments, parser });
const app = createServer({ cfg, store, agent, payments, wa });

const server = app.listen(cfg.port, () => {
  console.log(`\n🟢 Settle listening on :${cfg.port}`);
  console.log(`   WhatsApp: ${cfg.whatsapp.mode}  ·  Payments: ${payments.name}  ·  NLU: ${cfg.anthropic.enabled ? cfg.anthropic.model : "rules"}`);
  console.log(`   Webhooks: ${cfg.publicBaseUrl}/webhooks/whatsapp  ·  ${cfg.publicBaseUrl}/webhooks/busha\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.flush();
    server.close(() => process.exit(0));
  });
}
