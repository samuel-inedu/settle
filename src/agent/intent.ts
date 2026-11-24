import { z } from "zod";
import { parseAmount } from "../core/money.js";

export const IntentSchema = z.object({
  intent: z
    .enum([
      "help",
      "create_invoice", // seller asks to get paid for something (escrow)
      "pay_invoice", // buyer wants to pay an existing ESC- invoice
      "release", // buyer releases escrowed funds to seller
      "dispute",
      "cancel",
      "status",
      "balance",
      "fund_wallet",
      "send", // wallet-to-wallet transfer
      "withdraw", // wallet to external crypto address
      "add_contact",
      "set_pin",
      "unknown",
    ])
    .describe("What the user wants to do"),
  amount: z.number().nullable().describe("Amount in major units, e.g. 15000 for ₦15,000"),
  currency: z.enum(["NGN", "USDT"]).nullable().describe("₦/naira/NGN -> NGN; $/USD/USDT/dollars -> USDT"),
  counterparty: z.string().nullable().describe("Phone number (digits only, with country code) or a contact name"),
  description: z.string().nullable().describe("What the invoice is for"),
  escrowId: z.string().nullable().describe("An invoice id like ESC-AB12C"),
  address: z.string().nullable().describe("A crypto wallet address for withdrawals"),
  network: z.string().nullable().describe("Blockchain network for withdrawals: TRX, ETH, BSC or MATIC"),
});

export type Intent = z.infer<typeof IntentSchema>;

const blank = (intent: Intent["intent"]): Intent => ({
  intent,
  amount: null,
  currency: null,
  counterparty: null,
  description: null,
  escrowId: null,
  address: null,
  network: null,
});

const ESC_RE = /\bESC-[A-Z0-9]{4,8}\b/i;
const PHONE_RE = /\+?\b(\d{10,15})\b/;

/** Nigerian local numbers (080…) -> 23480… */
export function normalisePhone(raw: string): string {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = "234" + d.slice(1);
  return d;
}

function extractCounterparty(text: string, keyword: RegExp): string | null {
  const phone = text.match(PHONE_RE);
  if (phone) return normalisePhone(phone[0]);
  const m = text.match(keyword);
  return m ? m[1].trim() : null;
}

/**
 * Deterministic parser for commands and common phrasings. It runs first (fast, free, predictable);
 * anything it can't place falls through to Claude when an API key is configured.
 */
export function parseIntentRules(raw: string): Intent | null {
  const text = raw.trim();
  const t = text.toLowerCase();
  const escrowId = text.match(ESC_RE)?.[0].toUpperCase() ?? null;

  if (/^(hi|hello|hey|help|menu|start|\?)\b/.test(t)) return blank("help");
  if (/^(balance|wallet|bal)\b/.test(t)) return blank("balance");
  if (/^(set|change|reset|create)\s+(my\s+)?pin\b/.test(t)) return blank("set_pin");
  if (/^(status|my invoices|invoices|history)\b/.test(t)) return { ...blank("status"), escrowId };

  if (escrowId) {
    if (/^(pay|checkout)\b/.test(t)) return { ...blank("pay_invoice"), escrowId };
    if (/^(release|approve|confirm)\b/.test(t)) return { ...blank("release"), escrowId };
    if (/^(dispute|report|problem)\b/.test(t))
      return { ...blank("dispute"), escrowId, description: text.replace(ESC_RE, "").replace(/^\w+\s*/, "").trim() || null };
    if (/^cancel\b/.test(t)) return { ...blank("cancel"), escrowId };
  }

  const amt = parseAmount(t);

  // "add contact Chinedu 08012345678" / "save Chinedu 2348012345678"
  const contact = text.match(/^(?:add contact|save contact|save)\s+([a-z][\w .'-]*?)\s+(\+?\d[\d\s-]{9,})$/i);
  if (contact) return { ...blank("add_contact"), counterparty: normalisePhone(contact[2]), description: contact[1].trim() };

  if (/^(fund|top ?up|deposit|add money)\b/.test(t) && amt)
    return { ...blank("fund_wallet"), amount: amt.amount, currency: amt.currency ?? null };

  // "withdraw 100 usdt to TXyz... on trx"
  if (/^(withdraw|cash ?out)\b/.test(t) && amt) {
    const addr = text.match(/\b(T[1-9A-HJ-NP-Za-km-z]{33}|0x[a-fA-F0-9]{40})\b/)?.[0] ?? null;
    const net = t.match(/\b(trx|tron|eth|erc20|bsc|bep20|matic|polygon)\b/)?.[0] ?? null;
    const network = net
      ? ({ tron: "TRX", erc20: "ETH", bep20: "BSC", polygon: "MATIC" } as Record<string, string>)[net] ?? net.toUpperCase()
      : addr?.startsWith("T")
        ? "TRX"
        : null;
    return { ...blank("withdraw"), amount: amt.amount, currency: amt.currency ?? "USDT", address: addr, network };
  }

  // "send ₦15,000 to Chinedu", "transfer 5k to 0803…", "pay chinedu 2000"
  if (/^(send|transfer|pay)\b/.test(t) && amt) {
    const counterparty = extractCounterparty(text, /\bto\s+([a-z][\w .'-]*)$/i) ?? text.match(/^pay\s+([a-z][\w'-]*)\s/i)?.[1] ?? null;
    return { ...blank("send"), amount: amt.amount, currency: amt.currency ?? null, counterparty };
  }

  // "invoice 250 usdt to 2348012345678 for logo design" / "bill tunde ₦50k for website"
  if (/^(invoice|bill|charge|request|escrow)\b/.test(t) && amt) {
    const description = text.match(/\bfor\s+(.+)$/i)?.[1].trim() ?? null;
    const head = description ? text.slice(0, text.toLowerCase().lastIndexOf(" for ")) : text;
    const counterparty = extractCounterparty(head, /\b(?:to|from)\s+([a-z][\w .'-]*)$/i);
    return { ...blank("create_invoice"), amount: amt.amount, currency: amt.currency ?? null, counterparty, description };
  }

  return null;
}

export interface IntentParser {
  parse(text: string): Promise<Intent>;
}

export class RulesIntentParser implements IntentParser {
  async parse(text: string): Promise<Intent> {
    return parseIntentRules(text) ?? blank("unknown");
  }
}
