# Settle

AI-powered payments and escrow inside WhatsApp, powered by **Busha**.

A freelancer types *"invoice $250 to 0803… for logo design"*. Their client taps one link, pays by Naira bank transfer or USDT without leaving WhatsApp, and the money sits in escrow. When the work is delivered, the client taps **Release funds** and approves it with a PIN in a native WhatsApp Flow. The freelancer gets a receipt and their wallet balance updates.

It combines the three payment patterns that work in Nigeria today without Meta's native WhatsApp Pay:

| # | Pattern | Where in the code |
|---|---------|-------------------|
| 1 | **Dynamic payment details in chat**: Busha generates a one-time NGN bank account or USDT deposit address, sent as copyable messages plus a one-tap checkout button that opens in WhatsApp's in-app browser | `Agent.sendCollection`, `BushaProvider.createCollection` |
| 2 | **Pre-funded wallet + PIN in a WhatsApp Flow**: release escrow, send money and withdraw, each approved in a native pop-up form | `Agent.requirePin`, `flows/*.json` |
| 3 | **Crypto wallet deep links**: a "Pay in wallet" button opens MetaMask / Trust Wallet with the amount and address pre-filled (EIP-681) | `src/core/deeplinks.ts`, `GET /pay/:ref/crypto` |

## Architecture

```
 WhatsApp user                   Settle (Node/TS, Express)                     Busha Business API
 ─────────────                   ─────────────────────────                     ──────────────────
 "invoice ₦50k to …"  ──Meta──▶  POST /webhooks/whatsapp
                                   └─ verify X-Hub-Signature-256
                                   └─ intent: rules parser → Claude (optional)
                                   └─ Agent: create escrow, reply with share link
 client: "PAY ESC-…"  ─────────▶  Agent.payInvoice ───────────────────────────▶ POST /v1/payments/requests
                       ◀──────── account no. / USDT address + checkout button ◀─ (temp bank acct / address)
 client pays from bank app / wallet ─────────────────────────────────────────▶ Busha
                                  POST /webhooks/busha  ◀─────────────────────── payment_request.completed
                                   └─ verify x-bu-signature (HMAC-SHA256)
                       ◀──────── "✅ Paid, held in escrow" [Release] [Dispute]
 taps Release ────────▶  PIN Flow (native form) ─▶ nfm_reply ─▶ scrypt verify
                       ◀──────── "✅ Released"     seller: "💸 You've been paid"
 seller: "withdraw 100 usdt to T…" ─▶ PIN Flow ─▶ POST /v1/quotes → POST /v1/transfers
```

```
src/
  index.ts            wiring (picks cloud/console WhatsApp, live/mock Busha, Claude/rules NLU)
  server.ts           HTTP routes: webhooks, crypto pay page, mock checkout, dev outbox
  agent/agent.ts      the conversation + escrow state machine (the core of the app)
  agent/intent.ts     zod intent schema + deterministic parser (₦15k, $250, Pidgin-friendly)
  agent/claude.ts     Claude structured-output parser for free text
  busha/provider.ts   Busha client, webhook verification/parsing, and a mock provider
  whatsapp/client.ts  Cloud API payload builders (text, reply buttons, CTA URL, Flow)
  whatsapp/webhook.ts Meta signature check + inbound message normalisation
  core/               store (JSON file), money (minor units), PIN hashing, deep links
flows/                WhatsApp Flow JSON for PIN entry and PIN creation
scripts/simulate.ts   chat with the bot from your terminal
test/                 end-to-end and unit tests (node:test)
```

Escrow lifecycle: `AWAITING_PAYMENT → FUNDED → RELEASED`, with `DISPUTED` (from FUNDED) and `CANCELLED` (seller, before payment).

## Quick start (no accounts needed)

```bash
npm install
cp .env.example .env          # defaults: WHATSAPP_MODE=console, BUSHA_MODE=mock
npm run dev                   # terminal 1
npm run simulate              # terminal 2: you're chatting as the seller
```

A full demo in the simulator:

```
[Tunde] > invoice ₦50k to 08022222222 for website
[Tunde] > /as 2348022222222 Ada       ← become the client
[Ada]   > /tap 1                      ← "Pay now" on the invoice
[Ada]   > /paid                       ← fires a signed Busha webhook (or open the checkout link)
[Ada]   > /tap 1                      ← "Release funds"
[Ada]   > /pin 4826                   ← creates the PIN and releases the funds
[Ada]   > /as 2348011111111 Tunde
[Tunde] > balance                     ← ₦49,500.00 (1% fee)
```

Run the tests with `npm test`. `npm run typecheck` checks types.

## Going live on WhatsApp (about 20 minutes, free)

1. **Meta app.** Go to [developers.facebook.com](https://developers.facebook.com) → Create App → Business → add **WhatsApp**. On *API Setup*, copy the temporary access token and the **Phone number ID**, and add your own phone as a test recipient.
2. **Tunnel.** Run `ngrok http 3000` (or `cloudflared tunnel --url localhost:3000`) and put the HTTPS URL in `PUBLIC_BASE_URL`.
3. **Webhook.** In WhatsApp → Configuration, set the callback to `https://<tunnel>/webhooks/whatsapp`, set the verify token to the value of `WHATSAPP_VERIFY_TOKEN`, and subscribe to **messages**. Put the App Secret (App settings → Basic) in `WHATSAPP_APP_SECRET`.
4. **Flows.** In WhatsApp Manager → Flows → Create Flow, paste `flows/pin_flow.json`, save it, and copy its ID into `WHATSAPP_PIN_FLOW_ID`. Repeat with `flows/set_pin_flow.json` for `WHATSAPP_SET_PIN_FLOW_ID`. With `WHATSAPP_FLOW_MODE=draft` you can test without publishing. If these IDs are empty, the bot asks for the PIN as a chat reply instead.
5. Set `WHATSAPP_MODE=cloud` and `WHATSAPP_BOT_NUMBER`, restart, and send "hi" to your test number.

> **24-hour rule:** WhatsApp only delivers free-form messages to people who messaged you in the last 24 hours. That's why invoices go out as a `wa.me/<bot>?text=PAY ESC-…` link: the client's first tap opens the conversation. For production, create an approved **utility template** for "invoice sent" and "you've been paid" notifications.

## Connecting Busha

1. Create a sandbox business, generate an API key (Settings → Developer tools → API Tokens), and register a webhook at `https://<tunnel>/webhooks/busha`.
2. Set `BUSHA_MODE=live`, `BUSHA_SECRET_KEY`, `BUSHA_PUBLIC_KEY` and `BUSHA_WEBHOOK_SECRET`.

The integration follows docs.busha.io. These points are documented loosely there and are marked `VERIFY` in `src/busha/provider.ts`. Check them in the sandbox before your demo:

- **Auth header.** The code sends `Authorization: Bearer <secret>`. The OpenAPI intro mentions a base64 key pair instead.
- **Field names of the temporary bank account inside `pay_in`.** The code reads them defensively.
- **Body of `POST /v1/quotes` for crypto payouts.** The code puts the destination in `pay_out`.
- **Encoding of `x-bu-signature`.** The code accepts both base64 and hex.
- **Whether `deposit.success` also fires for these payments.** Both it and `payment_request.completed` are handled, and events are deduplicated.

Keep `BUSHA_MODE=mock` for a stage demo if the sandbox is flaky. The mock checkout page fires correctly signed webhooks through the same code path.

## Claude for natural language (optional)

Exact commands are handled by a fast deterministic parser. If you set `ANTHROPIC_API_KEY`, anything else, such as *"abeg bill Tunde 50k for the website wey I finish yesterday"*, goes to Claude (`claude-opus-5-5`, low effort). Claude returns a zod-validated intent through structured outputs. Server-side model fallback is turned on for refusals. If Claude fails, the bot falls back to the rules parser and replies with the help menu.

## Security notes

- PINs are hashed with scrypt and per-user salts. The bot locks payments for 15 minutes after 3 wrong attempts and rejects weak PINs (`1234`, `0000`…).
- Every PIN-gated action uses a **single-use, 10-minute** Flow token bound to the user's phone, so replayed Flow submissions are rejected.
- Both webhooks are HMAC-verified (Meta: `X-Hub-Signature-256`; Busha: `x-bu-signature`) and idempotent (message and event IDs are deduplicated).
- Money is stored in integer minor units. The JSON store is single-process: swap `src/core/store.ts` for Postgres before handling real funds. Each method maps to one table.
- `/dev/*` routes exist only in mock or console mode.

## Roadmap ideas

Approved message templates · NGN bank withdrawals via Busha recipients · cross-currency payments (pay a USDT invoice in Naira using Busha quotes) · dispute dashboard · milestones (partial releases) · auto-release after N days.
