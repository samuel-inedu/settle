import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { CollectionDetails, Currency, Minor } from "../core/types.js";
import { toMajorString } from "../core/money.js";

export interface CollectionRequest {
  reference: string; // our ESC-/TOP- id
  amount: Minor;
  currency: Currency;
  method: "bank" | "crypto";
  description: string;
  payer: { phone: string; name?: string; email?: string };
}

export interface PayoutRequest {
  reference: string; // our WDR- id
  amount: Minor;
  currency: Currency;
  address: string;
  network: string;
}

export type ProviderEvent =
  | {
      kind: "collection_completed";
      providerRef: string;
      reference?: string;
      eventKey: string;
    }
  | {
      kind: "collection_failed";
      providerRef: string;
      reference?: string;
      status: string;
      eventKey: string;
    }
  | { kind: "payout_completed"; providerRef: string; eventKey: string }
  | {
      kind: "payout_failed";
      providerRef: string;
      status: string;
      eventKey: string;
    }
  | { kind: "ignored"; event: string };

export interface PaymentProvider {
  readonly name: string;
  createCollection(req: CollectionRequest): Promise<CollectionDetails>;
  payout(req: PayoutRequest): Promise<{ providerRef: string; status: string }>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: unknown): ProviderEvent;
}

/**
 * Busha signs webhooks with HMAC-SHA256(raw body, webhook secret) in `x-bu-signature`.
 * Docs show both a base64 example and a hex description, so accept either encoding.
 */
export function verifyBushaSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest();
  for (const enc of ["base64", "hex"] as const) {
    const given = Buffer.from(signature.trim(), enc);
    if (given.length === digest.length && timingSafeEqual(given, digest))
      return true;
  }
  return false;
}

export function signBushaPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Maps Busha webhook envelopes `{ business_id, event, data }` to our events. */
export function parseBushaEvent(body: any): ProviderEvent {
  const event: string = body?.event ?? "";
  const data = body?.data ?? {};
  const providerRef: string =
    data.id ?? data.payment_request_id ?? data.reference ?? "";
  const eventKey = `${event}:${providerRef}`;

  switch (event) {
    case "payment_request.completed":
    case "deposit.success":
      return {
        kind: "collection_completed",
        providerRef,
        reference: data.reference,
        eventKey,
      };
    case "payment_request.expired":
    case "payment_request.failed":
    case "payment_request.cancelled":
      return {
        kind: "collection_failed",
        providerRef,
        reference: data.reference,
        status: event.split(".")[1],
        eventKey,
      };
    case "transfer.funds_delivered":
    case "transfer.completed":
      return { kind: "payout_completed", providerRef, eventKey };
    case "transfer.failed":
    case "transfer.funds_not_delivered":
    case "transfer.funds_refunded":
    case "transfer.cancelled":
      return {
        kind: "payout_failed",
        providerRef,
        status: event.split(".")[1],
        eventKey,
      };
    default:
      return { kind: "ignored", event };
  }
}

// ---------------------------------------------------------------------------
// Live Busha Business API
// Endpoint shapes from docs.busha.io. Items marked VERIFY are documented loosely
// and should be confirmed in the sandbox before the demo.
// ---------------------------------------------------------------------------

export interface BushaConfig {
  baseUrl: string;
  secretKey: string;
  publicKey: string;
  webhookSecret: string;
  cryptoNetwork: string;
  debug?: boolean;
}

export class BushaProvider implements PaymentProvider {
  readonly name = "busha";
  constructor(private cfg: BushaConfig) {
    if (!cfg.secretKey)
      throw new Error("BUSHA_SECRET_KEY is required when BUSHA_MODE=live");
  }

  private async call<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      // VERIFY: docs show `Authorization: Bearer <secret>`; the OpenAPI intro mentions a base64 key pair.
      Authorization: `Bearer ${this.cfg.secretKey}`,
      "Content-Type": "application/json",
    };
    if (this.cfg.publicKey) headers["X-BU-PUBLIC-KEY"] = this.cfg.publicKey;
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (this.cfg.debug) {
      console.log(
        `[busha:debug] ${method} ${path} -> ${res.status}\n  request: ${JSON.stringify(body ?? null)}\n  response: ${JSON.stringify(json, null, 2)}`,
      );
    }
    if (!res.ok) {
      const msg = json?.error?.message ?? res.statusText;
      throw new Error(
        `Busha ${method} ${path} -> ${res.status}: ${msg} (request id ${res.headers.get("x-request-id")})`,
      );
    }
    return json.data as T;
  }

  async createCollection(req: CollectionRequest): Promise<CollectionDetails> {
    const amount = toMajorString(req.amount);
    const payIn =
      req.method === "bank"
        ? { type: "temporary_bank_account" }
        : { type: "address", network: this.cfg.cryptoNetwork };

    // 1) Payment request: gives us bank details / a deposit address to show in chat.
    const pr = await this.call("POST", "/v1/payments/requests", {
      source_currency: req.currency,
      target_currency: req.currency,
      target_amount: amount,
      reference: req.reference,
      pay_in: payIn,
      additional_info: {
        // Busha requires an email; collect a real one in onboarding for production.
        email: req.payer.email ?? `${req.payer.phone}@users.settle.chat`,
        name: req.payer.name,
        phone_number: `+${req.payer.phone}`,
        source: "whatsapp",
      },
    });

    // 2) One-time payment link: opens in WhatsApp's in-app browser as a hosted checkout.
    let checkoutUrl: string | undefined;
    try {
      const link = await this.call("POST", "/v1/payments/links", {
        fixed: true,
        one_time: true,
        type: "payment_link",
        name: req.reference,
        title: `Settle ${req.reference}`,
        description: req.description.slice(0, 250),
        target_currency: req.currency,
        target_amount: amount,
      });
      checkoutUrl = link?.link;
    } catch (err) {
      console.warn(
        "[busha] payment link failed (continuing with in-chat details):",
        (err as Error).message,
      );
    }

    const p = pr?.pay_in ?? {};
    const details: CollectionDetails = {
      method: req.method,
      providerRef: pr.id,
      checkoutUrl,
    };
    if (req.method === "bank") {
      // VERIFY: field names of temporary bank account inside pay_in.
      details.bank = {
        accountNumber: p.account_number ?? p.bank_account?.account_number ?? "",
        bankName: p.bank_name ?? p.bank_account?.bank_name ?? "",
        accountName: p.account_name ?? p.bank_account?.account_name ?? "",
        expiresAt: p.expires_at ?? pr.expires_at,
      };
    } else {
      details.crypto = {
        address: p.address,
        network: p.network ?? this.cfg.cryptoNetwork,
        currency: req.currency,
        amount,
        expiresAt: p.expires_at ?? pr.expires_at,
      };
    }
    return details;
  }

  async payout(
    req: PayoutRequest,
  ): Promise<{ providerRef: string; status: string }> {
    // VERIFY: quote body. Quotes are valid for ~3 minutes, so transfer immediately.
    const quote = await this.call("POST", "/v1/quotes", {
      source_currency: req.currency,
      target_currency: req.currency,
      source_amount: toMajorString(req.amount),
      reference: req.reference,
      pay_out: { type: "address", address: req.address, network: req.network },
    });
    const transfer = await this.call("POST", "/v1/transfers", {
      quote_id: quote.id,
    });
    return { providerRef: transfer.id, status: transfer.status };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    return verifyBushaSignature(rawBody, signature, this.cfg.webhookSecret);
  }

  parseWebhook(body: unknown) {
    return parseBushaEvent(body);
  }
}

// ---------------------------------------------------------------------------
// Mock provider: realistic data + a fake hosted checkout page that fires a
// correctly-signed webhook, so the full flow works with zero credentials.
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MOCK_BANKS = ["Wema Bank", "Providus Bank", "Moniepoint MFB"];

export class MockBushaProvider implements PaymentProvider {
  readonly name = "mock";
  constructor(
    private opts: {
      publicBaseUrl: string;
      webhookSecret: string;
      cryptoNetwork: string;
    },
  ) {}

  async createCollection(req: CollectionRequest): Promise<CollectionDetails> {
    const providerRef = `PAYR_${randomBytes(8).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const checkoutUrl = `${this.opts.publicBaseUrl}/dev/checkout/${providerRef}`;
    if (req.method === "bank") {
      return {
        method: "bank",
        providerRef,
        checkoutUrl,
        bank: {
          accountNumber: String(
            9_000_000_000 + Math.floor(Math.random() * 999_999_999),
          ),
          bankName: MOCK_BANKS[Math.floor(Math.random() * MOCK_BANKS.length)],
          accountName: `Busha/Settle ${req.reference}`,
          expiresAt,
        },
      };
    }
    const net = this.opts.cryptoNetwork.toUpperCase();
    const address =
      net === "TRX"
        ? "T" + [...randomBytes(33)].map((b) => B58[b % 58]).join("")
        : "0x" + randomBytes(20).toString("hex");
    return {
      method: "crypto",
      providerRef,
      checkoutUrl,
      crypto: {
        address,
        network: net,
        currency: req.currency,
        amount: toMajorString(req.amount),
        expiresAt,
      },
    };
  }

  async payout(_req: PayoutRequest) {
    return {
      providerRef: `TRF_${randomBytes(8).toString("hex")}`,
      status: "funds_delivered",
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    return verifyBushaSignature(rawBody, signature, this.opts.webhookSecret);
  }

  parseWebhook(body: unknown) {
    return parseBushaEvent(body);
  }

  /** Builds a signed `payment_request.completed` webhook like Busha would send. */
  buildPaidWebhook(
    providerRef: string,
    reference?: string,
  ): { raw: string; signature: string } {
    const raw = JSON.stringify({
      business_id: "BUS_mock",
      event: "payment_request.completed",
      data: { id: providerRef, reference, status: "completed" },
    });
    return { raw, signature: signBushaPayload(raw, this.opts.webhookSecret) };
  }
}
