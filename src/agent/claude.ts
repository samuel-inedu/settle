import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { IntentSchema, parseIntentRules, type Intent, type IntentParser } from "./intent.js";

const SYSTEM = `You are the language-understanding layer of Settle, a WhatsApp payments and escrow assistant for Nigerian freelancers, traders and their clients (powered by Busha).
Classify the user's WhatsApp message into exactly one intent and extract its fields. Users write in English, Nigerian Pidgin, or mixed; amounts may use ₦, N, k (thousand), m (million), $ or "dollars".

Intents:
- create_invoice: the user is getting paid by someone and wants Settle to hold the money in escrow ("bill Tunde 50k for the website", "make invoice of $300 for logo").
- pay_invoice: they want to pay an existing invoice id (ESC-…).
- release: they confirm the work was delivered and want to release escrow funds.
- dispute / cancel / status: about an invoice.
- balance, fund_wallet (top up their Settle wallet), send (wallet transfer to a person), withdraw (to a crypto address), add_contact, set_pin, help.
- unknown: anything else.
$ / USD / dollars means USDT. Use null for fields that are not stated; never invent amounts, phone numbers or ids.`;

/**
 * Claude-backed intent parser. Rules run first for exact commands; Claude handles free text.
 * Any API failure falls back to the rules parser so the bot never goes silent.
 */
export class ClaudeIntentParser implements IntentParser {
  private client = new Anthropic();
  constructor(private model: string) {}

  async parse(text: string): Promise<Intent> {
    const rule = parseIntentRules(text);
    if (rule) return rule;
    try {
      const res = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM,
        messages: [{ role: "user", content: text.slice(0, 2000) }],
        output_config: { effort: "low", format: betaZodOutputFormat(IntentSchema) },
        // Server-side fallback if a safety classifier declines (routes by refusal category).
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (res.stop_reason === "refusal" || !res.parsed_output) return { ...emptyUnknown };
      return res.parsed_output;
    } catch (err) {
      console.warn("[claude] intent parse failed, using rules:", (err as Error).message);
      return { ...emptyUnknown };
    }
  }
}

const emptyUnknown: Intent = {
  intent: "unknown",
  amount: null,
  currency: null,
  counterparty: null,
  description: null,
  escrowId: null,
  address: null,
  network: null,
};
