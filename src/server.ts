import express, { type Request } from "express";
import type { Config } from "./config.js";
import type { Store } from "./core/store.js";
import type { PaymentProvider } from "./busha/provider.js";
import { MockBushaProvider } from "./busha/provider.js";
import { Agent } from "./agent/agent.js";
import {
  parseWhatsAppWebhook,
  verifyMetaSignature,
} from "./whatsapp/webhook.js";
import { renderCryptoPayPage } from "./core/deeplinks.js";
import { formatMoney } from "./core/money.js";
import { ConsoleSender, type WhatsAppSender } from "./whatsapp/client.js";

type RawRequest = Request & { rawBody?: Buffer };

export function createServer(opts: {
  cfg: Config;
  store: Store;
  agent: Agent;
  payments: PaymentProvider;
  wa?: WhatsAppSender;
}) {
  const { cfg, store, agent, payments, wa } = opts;
  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      whatsapp: cfg.whatsapp.mode,
      payments: payments.name,
    }),
  );

  // ---- WhatsApp Cloud API webhook -----------------------------------------
  app.get("/webhooks/whatsapp", (req, res) => {
    if (
      req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === cfg.whatsapp.verifyToken
    ) {
      return res.status(200).send(String(req.query["hub.challenge"]));
    }
    res.sendStatus(403);
  });

  app.post("/webhooks/whatsapp", (req, res) => {
    const raw = (req as RawRequest).rawBody ?? Buffer.from("");
    if (
      cfg.whatsapp.appSecret &&
      !verifyMetaSignature(
        raw,
        req.header("x-hub-signature-256"),
        cfg.whatsapp.appSecret,
      )
    ) {
      return res.sendStatus(401);
    }
    res.sendStatus(200); // ack fast, Meta retries slow webhooks
    for (const msg of parseWhatsAppWebhook(req.body)) {
      agent
        .handleInbound(msg)
        .catch((err) => console.error("[whatsapp] handler crashed", err));
    }
  });

  // ---- Busha webhook --------------------------------------------------------
  app.post("/webhooks/busha", async (req, res) => {
    const raw = (req as RawRequest).rawBody ?? Buffer.from("");
    if (cfg.busha.debug) {
      console.log(
        `[busha:debug] webhook x-bu-signature=${req.header("x-bu-signature")}\n  body: ${raw.toString("utf8")}`,
      );
    }
    if (!payments.verifyWebhook(raw, req.header("x-bu-signature"))) {
      console.warn("[busha] rejected webhook with bad signature");
      return res.sendStatus(401);
    }
    try {
      await agent.handleProviderEvent(payments.parseWebhook(req.body));
      res.sendStatus(200);
    } catch (err) {
      console.error("[busha] webhook handling failed", err);
      res.sendStatus(500); // let Busha retry
    }
  });

  // ---- Option 3: crypto wallet deep-link page (opened in WhatsApp's in-app browser)
  app.get("/pay/:ref/crypto", (req, res) => {
    const { escrow, topup } = store.findByProviderRef(req.params.ref);
    const owner = escrow ?? topup;
    const c = owner?.collections.find(
      (x) => x.providerRef === req.params.ref,
    )?.crypto;
    if (!owner || !c)
      return res.status(404).send("Payment not found or expired.");
    res.type("html").send(
      renderCryptoPayPage({
        ref: owner.id,
        address: c.address,
        network: c.network,
        amount: c.amount,
        description: escrow?.description ?? "Settle wallet top-up",
      }),
    );
  });

  // ---- Mock-mode helpers: hosted checkout that fires a signed Busha webhook
  if (payments instanceof MockBushaProvider) {
    const mock = payments;

    app.get("/dev/checkout/:ref", (req, res) => {
      const { escrow, topup } = store.findByProviderRef(req.params.ref);
      const owner = escrow ?? topup;
      if (!owner) return res.status(404).send("Unknown payment");
      const paid = escrow
        ? escrow.status !== "AWAITING_PAYMENT"
        : topup!.status === "COMPLETED";
      res.type("html")
        .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Checkout</title>
<style>:root{--bg:#f4f5f7;--card:#fff;--fg:#111;--muted:#666}@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--fg:#eee;--muted:#9aa}}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:420px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:16px;padding:20px}h1{margin:4px 0}.m{color:var(--muted);font-size:14px}
button{width:100%;padding:14px;border:0;border-radius:12px;background:#0a7c4a;color:#fff;font-size:16px;font-weight:600;margin-top:16px}</style></head>
<body><main><div class="card"><div class="m">Busha checkout (mock) · ${owner.id}</div><h1>${formatMoney(owner.amount, owner.currency)}</h1>
<div class="m">${escrow ? escrow.description : "Wallet top-up"}</div>
${paid ? `<p>✅ Already paid. Head back to WhatsApp.</p>` : `<form method="post" action="/dev/simulate-payment/${req.params.ref}"><button>Simulate successful payment</button></form>`}
</div></main></body></html>`);
    });

    app.post("/dev/simulate-payment/:ref", async (req, res) => {
      const { escrow, topup } = store.findByProviderRef(req.params.ref);
      const { raw, signature } = mock.buildPaidWebhook(
        req.params.ref,
        (escrow ?? topup)?.id,
      );
      // Go through the real webhook path (signature check included).
      const r = await fetch(`http://127.0.0.1:${cfg.port}/webhooks/busha`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bu-signature": signature,
        },
        body: raw,
      });
      if (req.headers.accept?.includes("application/json"))
        return res.json({ ok: r.ok });
      res
        .type("html")
        .send(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:24px;text-align:center"><h2>${r.ok ? "✅ Payment sent" : "❌ Failed"}</h2><p>Return to WhatsApp, your receipt is waiting.</p></body>`,
        );
    });

    app.get("/dev/escrows", (_req, res) => res.json(store.allEscrows()));
  }

  // ---- Console mode: expose the outbox so `npm run simulate` can show bot replies
  if (wa instanceof ConsoleSender) {
    app.get("/dev/outbox", (req, res) => {
      const since = Number(req.query.since ?? 0);
      res.json({ next: wa.outbox.length, messages: wa.outbox.slice(since) });
    });
  }

  return app;
}
