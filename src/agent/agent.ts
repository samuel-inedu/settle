import type { Config } from "../config.js";
import type { Store } from "../core/store.js";
import type { WhatsAppSender } from "../whatsapp/client.js";
import type { Inbound } from "../whatsapp/webhook.js";
import type { PaymentProvider, ProviderEvent } from "../busha/provider.js";
import type { IntentParser, Intent } from "./intent.js";
import { normalisePhone } from "./intent.js";
import type { CollectionDetails, Currency, Escrow, PendingAction, Topup, User } from "../core/types.js";
import { formatMoney, toMinor } from "../core/money.js";
import { MAX_PIN_FAILURES, PIN_LOCK_MS, hashPin, isValidPin, verifyPin } from "../core/pin.js";
import { NETWORK_LABELS } from "../core/deeplinks.js";

export interface AgentDeps {
  cfg: Config;
  store: Store;
  wa: WhatsAppSender;
  payments: PaymentProvider;
  parser: IntentParser;
}

const HELP = `👋 *Welcome to Settle*: safe payments right here in WhatsApp.

*Get paid (escrow)*
• _invoice 250 usdt to 08031234567 for logo design_
• _bill Tunde ₦50k for website_

*Pay & manage*
• _pay ESC-AB12C_
• _release ESC-AB12C_ · _dispute ESC-AB12C_
• _status_

*Wallet*
• _balance_ · _fund ₦20,000_
• _send ₦15,000 to Chinedu_
• _add contact Chinedu 08031234567_
• _withdraw 100 usdt to T… on trx_
• _set pin_`;

export class Agent {
  constructor(private d: AgentDeps) {}

  // =========================================================================
  // Inbound WhatsApp
  // =========================================================================

  async handleInbound(msg: Inbound): Promise<void> {
    const { store } = this.d;
    if (!store.markProcessed(`wa:${msg.id}`)) return; // Meta retries webhooks; process once
    const user = store.ensureUser(msg.from, msg.name);
    try {
      if (msg.type === "flow_reply") return await this.onPinSubmitted(user, msg.response);
      if (msg.type === "button") return await this.onButton(user, msg.buttonId);
      if (msg.type === "text") {
        // PIN typed in chat (fallback when Flows aren't configured)
        if (user.awaitingPinToken && /^\s*\d{4}\s*$/.test(msg.text)) {
          const token = user.awaitingPinToken;
          store.updateUser(user.phone, { awaitingPinToken: undefined });
          return await this.onPinSubmitted(user, { flow_token: token, pin: msg.text.trim(), pin_confirm: msg.text.trim() });
        }
        const intent = await this.d.parser.parse(msg.text);
        return await this.onIntent(user, intent);
      }
      await this.d.wa.sendText(user.phone, "I can read text and button taps for now. Type *help* to see what I can do.");
    } catch (err) {
      console.error("[agent] error handling message", err);
      await this.d.wa.sendText(user.phone, "⚠️ Something went wrong on our side. Please try again in a moment.").catch(() => {});
    }
  }

  private async onButton(user: User, id: string) {
    const [action, ref] = id.split(":");
    const noRef = { escrowId: ref ?? null } as Partial<Intent>;
    const map: Record<string, Intent["intent"]> = {
      pay: "pay_invoice",
      release: "release",
      dispute: "dispute",
      status: "status",
      cancel: "cancel",
      help: "help",
      balance: "balance",
    };
    const intent = map[action] ?? "unknown";
    return this.onIntent(user, {
      intent,
      amount: null,
      currency: null,
      counterparty: null,
      description: null,
      escrowId: null,
      address: null,
      network: null,
      ...noRef,
    });
  }

  private async onIntent(user: User, i: Intent) {
    switch (i.intent) {
      case "help":
        return this.d.wa.sendText(user.phone, HELP);
      case "create_invoice":
        return this.createInvoice(user, i);
      case "pay_invoice":
        return this.payInvoice(user, i.escrowId);
      case "release":
        return this.requestRelease(user, i.escrowId);
      case "dispute":
        return this.dispute(user, i.escrowId, i.description);
      case "cancel":
        return this.cancel(user, i.escrowId);
      case "status":
        return this.status(user, i.escrowId);
      case "balance":
        return this.balance(user);
      case "fund_wallet":
        return this.fundWallet(user, i);
      case "send":
        return this.send(user, i);
      case "withdraw":
        return this.withdraw(user, i);
      case "add_contact":
        return this.addContact(user, i);
      case "set_pin":
        return this.startSetPin(user);
      default:
        return this.d.wa.sendButtons(
          user.phone,
          "Sorry, I didn't catch that 🤔\nTry _invoice ₦50k to 0803… for website_ or _send ₦5,000 to Chinedu_.",
          [
            { id: "help", title: "Show commands" },
            { id: "balance", title: "My balance" },
            { id: "status", title: "My invoices" },
          ],
        );
    }
  }

  // =========================================================================
  // Escrow
  // =========================================================================

  private async createInvoice(seller: User, i: Intent) {
    const { store, wa, cfg } = this.d;
    if (!i.amount || i.amount <= 0) {
      return wa.sendText(seller.phone, "How much should I invoice? e.g. _invoice ₦50,000 for website design_");
    }
    const currency: Currency = i.currency ?? "NGN";
    const buyerPhone = i.counterparty ? this.resolveContact(seller, i.counterparty) : undefined;
    if (buyerPhone === seller.phone) return wa.sendText(seller.phone, "You can't invoice yourself 🙂");

    const escrow = store.createEscrow({
      sellerPhone: seller.phone,
      buyerPhone: buyerPhone ?? undefined,
      amount: toMinor(i.amount),
      currency,
      description: i.description ?? "Payment",
    });

    const shareLink = `https://wa.me/${cfg.whatsapp.botNumber}?text=${encodeURIComponent(`PAY ${escrow.id}`)}`;
    const fee = Math.round((escrow.amount * cfg.escrowFeeBps) / 10_000);

    await wa.sendText(
      seller.phone,
      `🧾 *Invoice ${escrow.id} created*\n\n` +
        `${formatMoney(escrow.amount, currency)} for _${escrow.description}_\n` +
        `Settle fee at release: ${formatMoney(fee, currency)}\n\n` +
        `Send this link to your client. One tap opens WhatsApp and they can pay straight away:\n${shareLink}\n\n` +
        `Their money is held in escrow until they release it to you.`,
    );

    if (buyerPhone) {
      // Only delivered if the buyer messaged us in the last 24h; production should use an approved template.
      try {
        await this.sendInvoiceToBuyer(escrow, buyerPhone);
        await wa.sendText(seller.phone, `📨 I've also sent the invoice to +${buyerPhone}.`);
      } catch (err) {
        console.warn("[agent] could not message buyer directly:", (err as Error).message);
      }
    }
  }

  private async sendInvoiceToBuyer(e: Escrow, buyerPhone: string) {
    const seller = this.d.store.getUser(e.sellerPhone);
    await this.d.wa.sendButtons(
      buyerPhone,
      `🧾 *${seller?.name ?? "+" + e.sellerPhone}* sent you an invoice\n\n` +
        `*${formatMoney(e.amount, e.currency)}* for _${e.description}_\n` +
        `Ref: ${e.id}\n\n🔒 Your payment is held in escrow by Settle and is only released when you confirm delivery.`,
      [{ id: `pay:${e.id}`, title: `Pay ${e.currency === "NGN" ? "now" : "with USDT"}` }],
    );
  }

  private async payInvoice(payer: User, escrowId: string | null) {
    const { store, wa } = this.d;
    const e = escrowId ? store.getEscrow(escrowId) : undefined;
    if (!e) return wa.sendText(payer.phone, "I couldn't find that invoice. Check the reference (e.g. ESC-AB12C).");
    if (e.sellerPhone === payer.phone) return wa.sendText(payer.phone, "That's your own invoice. Share the link with your client 🙂");
    if (e.buyerPhone && e.buyerPhone !== payer.phone)
      return wa.sendText(payer.phone, "This invoice was issued to a different customer.");
    if (e.status !== "AWAITING_PAYMENT")
      return wa.sendText(payer.phone, `Invoice ${e.id} is already *${e.status.replace("_", " ").toLowerCase()}*.`);

    if (!e.buyerPhone) store.updateEscrow(e.id, { buyerPhone: payer.phone }, `claimed by ${payer.phone}`);

    const seller = store.getUser(e.sellerPhone);
    await wa.sendText(
      payer.phone,
      `🧾 *${e.id}*: ${formatMoney(e.amount, e.currency)}\nTo: ${seller?.name ?? "+" + e.sellerPhone}\nFor: _${e.description}_\n\n🔒 Held in escrow until you confirm delivery.`,
    );
    await this.sendCollection(payer, e.id, e.amount, e.currency, e.description, (c) => {
      store.updateEscrow(e.id, { collections: [...e.collections, c] }, `collection ${c.providerRef} (${c.method})`);
    });
  }

  /** Generates Busha payment details and posts them in chat (Option 1). */
  private async sendCollection(
    payer: User,
    reference: string,
    amount: number,
    currency: Currency,
    description: string,
    save: (c: CollectionDetails) => void,
  ) {
    const { wa, payments, cfg } = this.d;
    const method = currency === "NGN" ? "bank" : "crypto";
    const c = await payments.createCollection({
      reference,
      amount,
      currency,
      method,
      description,
      payer: { phone: payer.phone, name: payer.name },
    });
    save(c);

    if (c.bank) {
      await wa.sendText(
        payer.phone,
        `🏦 *Pay by bank transfer*\n\nTransfer exactly *${formatMoney(amount, currency)}* to:\n\n` +
          `Account: *${c.bank.accountNumber}*\nBank: ${c.bank.bankName}\nName: ${c.bank.accountName}\n\n` +
          `⏱ This account is just for this payment and expires in 30 mins.\nYour receipt will show up here automatically.`,
      );
      // Account number on its own so a long-press copies it cleanly.
      await wa.sendText(payer.phone, c.bank.accountNumber);
      if (c.checkoutUrl) {
        await wa.sendCtaUrl(payer.phone, "Prefer card or another method? Use the secure checkout.", "Open checkout", c.checkoutUrl, "Powered by Busha");
      }
    } else if (c.crypto) {
      const net = NETWORK_LABELS[c.crypto.network.toUpperCase()] ?? c.crypto.network;
      await wa.sendText(
        payer.phone,
        `🪙 *Pay with ${c.crypto.currency}*\n\nSend exactly *${c.crypto.amount} ${c.crypto.currency}* on *${net}* to:`,
      );
      await wa.sendText(payer.phone, c.crypto.address);
      await wa.sendCtaUrl(
        payer.phone,
        "Tap to open your wallet (MetaMask, Trust Wallet…) with the amount and address filled in.",
        "Pay in wallet",
        `${cfg.publicBaseUrl}/pay/${encodeURIComponent(c.providerRef)}/crypto`,
        "⚠️ Use the network shown above",
      );
    }
  }

  private async requestRelease(user: User, escrowId: string | null) {
    const { store, wa } = this.d;
    const e = escrowId ? store.getEscrow(escrowId) : undefined;
    if (!e) return wa.sendText(user.phone, "Which invoice? e.g. _release ESC-AB12C_");
    if (e.buyerPhone !== user.phone) return wa.sendText(user.phone, "Only the customer who paid can release this escrow.");
    if (e.status !== "FUNDED") return wa.sendText(user.phone, `${e.id} can't be released (status: ${e.status}).`);
    const seller = store.getUser(e.sellerPhone);
    return this.requirePin(user, { kind: "release", escrowId: e.id }, `Release ${formatMoney(e.amount, e.currency)} to ${seller?.name ?? "+" + e.sellerPhone} for ${e.description}`);
  }

  private async dispute(user: User, escrowId: string | null, reason: string | null) {
    const { store, wa } = this.d;
    const e = escrowId ? store.getEscrow(escrowId) : undefined;
    if (!e || (e.buyerPhone !== user.phone && e.sellerPhone !== user.phone))
      return wa.sendText(user.phone, "Which invoice? e.g. _dispute ESC-AB12C item not delivered_");
    if (e.status !== "FUNDED") return wa.sendText(user.phone, `Only funded escrows can be disputed (${e.id} is ${e.status}).`);
    store.updateEscrow(e.id, { status: "DISPUTED" }, `disputed by ${user.phone}: ${reason ?? "no reason"}`);
    const text = `⚖️ *${e.id} is under dispute*\nThe ${formatMoney(e.amount, e.currency)} stays locked in escrow while the Settle team reviews it (usually within 24h).${reason ? `\nReason: _${reason}_` : ""}`;
    await wa.sendText(e.buyerPhone!, text);
    await this.notify(e.sellerPhone, text);
  }

  private async cancel(user: User, escrowId: string | null) {
    const { store, wa } = this.d;
    const e = escrowId ? store.getEscrow(escrowId) : undefined;
    if (!e || e.sellerPhone !== user.phone) return wa.sendText(user.phone, "Only the person who created an invoice can cancel it.");
    if (e.status !== "AWAITING_PAYMENT") return wa.sendText(user.phone, `${e.id} can't be cancelled now (${e.status}).`);
    store.updateEscrow(e.id, { status: "CANCELLED" }, "cancelled by seller");
    await wa.sendText(user.phone, `🗑️ Invoice ${e.id} cancelled.`);
    if (e.buyerPhone) await this.notify(e.buyerPhone, `Invoice ${e.id} was cancelled by the seller. Don't send any payment for it.`);
  }

  private async status(user: User, escrowId: string | null) {
    const { store, wa } = this.d;
    const icon: Record<string, string> = { AWAITING_PAYMENT: "⏳", FUNDED: "🔒", RELEASED: "✅", DISPUTED: "⚖️", CANCELLED: "🗑️" };
    if (escrowId) {
      const e = store.getEscrow(escrowId);
      if (!e || (e.buyerPhone !== user.phone && e.sellerPhone !== user.phone)) return wa.sendText(user.phone, "Invoice not found.");
      return wa.sendText(
        user.phone,
        `${icon[e.status]} *${e.id}*: ${e.status.replace("_", " ")}\n${formatMoney(e.amount, e.currency)} · ${e.description}\n\n` +
          e.history.slice(-5).map((h) => `• ${new Date(h.at).toLocaleString("en-NG")}: ${h.event}`).join("\n"),
      );
    }
    const list = store.escrowsFor(user.phone).slice(0, 8);
    if (!list.length) return wa.sendText(user.phone, "No invoices yet. Try _invoice ₦20,000 for logo design_.");
    return wa.sendText(
      user.phone,
      "*Your invoices*\n\n" +
        list
          .map((e) => `${icon[e.status]} ${e.id} · ${formatMoney(e.amount, e.currency)} · ${e.sellerPhone === user.phone ? "you're paid" : "you pay"} · ${e.description}`)
          .join("\n"),
    );
  }

  // =========================================================================
  // Wallet (Option 2: pre-funded wallet + PIN)
  // =========================================================================

  private async balance(user: User) {
    const u = this.d.store.getUser(user.phone)!;
    return this.d.wa.sendText(
      user.phone,
      `👛 *Your Settle wallet*\n\n${formatMoney(u.balances.NGN, "NGN")}\n${formatMoney(u.balances.USDT, "USDT")}\n\n_fund ₦10,000_ to top up · _send ₦5,000 to Chinedu_ to pay someone`,
    );
  }

  private async fundWallet(user: User, i: Intent) {
    const { store, wa } = this.d;
    if (!i.amount || i.amount <= 0) return wa.sendText(user.phone, "How much? e.g. _fund ₦20,000_ or _fund 50 usdt_");
    const currency: Currency = i.currency ?? "NGN";
    const topup = store.createTopup({ phone: user.phone, amount: toMinor(i.amount), currency });
    await this.sendCollection(user, topup.id, topup.amount, currency, "Settle wallet top-up", (c) => {
      store.updateTopup(topup.id, { collections: [...topup.collections, c] });
    });
  }

  private async send(user: User, i: Intent) {
    const { store, wa } = this.d;
    if (!i.amount || i.amount <= 0) return wa.sendText(user.phone, "How much should I send? e.g. _send ₦15,000 to Chinedu_");
    if (!i.counterparty) return wa.sendText(user.phone, "Who should I send it to? Use a saved contact name or a phone number.");
    const to = this.resolveContact(user, i.counterparty);
    if (!to)
      return wa.sendText(user.phone, `I don't have *${i.counterparty}* saved yet.\nSave them first: _add contact ${i.counterparty} 0803…_`);
    if (to === user.phone) return wa.sendText(user.phone, "You can't send money to yourself 🙂");
    const currency: Currency = i.currency ?? "NGN";
    const amount = toMinor(i.amount);
    const bal = store.getUser(user.phone)!.balances[currency];
    if (bal < amount)
      return wa.sendText(user.phone, `Not enough balance: you have ${formatMoney(bal, currency)}.\nTop up with _fund ${formatMoney(amount - bal, currency)}_`);
    const name = store.getUser(to)?.name ?? this.contactName(user, to) ?? `+${to}`;
    return this.requirePin(user, { kind: "send", to, amount, currency }, `Send ${formatMoney(amount, currency)} to ${name}`);
  }

  private async withdraw(user: User, i: Intent) {
    const { store, wa } = this.d;
    const currency: Currency = i.currency ?? "USDT";
    if (currency !== "USDT") return wa.sendText(user.phone, "Naira bank withdrawals are coming soon. For now you can withdraw USDT to a wallet.");
    if (!i.amount || !i.address || !i.network)
      return wa.sendText(user.phone, "Tell me the amount, address and network, e.g.\n_withdraw 100 usdt to TXyz… on trx_");
    if (!NETWORK_LABELS[i.network.toUpperCase()]) return wa.sendText(user.phone, "Supported networks: TRX, ETH, BSC, MATIC.");
    const amount = toMinor(i.amount);
    const bal = store.getUser(user.phone)!.balances.USDT;
    if (bal < amount) return wa.sendText(user.phone, `Not enough balance: you have ${formatMoney(bal, "USDT")}.`);
    const short = `${i.address.slice(0, 6)}…${i.address.slice(-4)}`;
    return this.requirePin(
      user,
      { kind: "withdraw", amount, currency, address: i.address, network: i.network.toUpperCase() },
      `Withdraw ${formatMoney(amount, "USDT")} to ${short} (${NETWORK_LABELS[i.network.toUpperCase()]})`,
    );
  }

  private async addContact(user: User, i: Intent) {
    if (!i.description || !i.counterparty) return this.d.wa.sendText(user.phone, "Use: _add contact Chinedu 08031234567_");
    const contacts = { ...user.contacts, [i.description.toLowerCase()]: normalisePhone(i.counterparty) };
    this.d.store.updateUser(user.phone, { contacts });
    return this.d.wa.sendText(user.phone, `📇 Saved *${i.description}* (+${normalisePhone(i.counterparty)}).`);
  }

  private resolveContact(user: User, ref: string): string | undefined {
    const digits = ref.replace(/\D/g, "");
    if (digits.length >= 10) return normalisePhone(digits);
    return user.contacts[ref.toLowerCase().trim()];
  }

  private contactName(user: User, phone: string): string | undefined {
    const hit = Object.entries(user.contacts).find(([, p]) => p === phone);
    return hit ? hit[0].replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
  }

  // =========================================================================
  // PIN gate via WhatsApp Flows
  // =========================================================================

  private async startSetPin(user: User) {
    if (user.pinHash) {
      return this.requirePin(user, { kind: "set_pin" }, "Confirm your current PIN to set a new one");
    }
    return this.sendSetPinFlow(user);
  }

  private async sendSetPinFlow(user: User, then?: PendingAction, note?: string) {
    const { store, wa, cfg } = this.d;
    const rec = store.createPending(user.phone, { kind: "set_pin", then });
    const body = `${note ? note + "\n\n" : ""}🔐 Create a 4-digit Settle PIN. You'll use it to approve every payment.`;
    if (cfg.whatsapp.setPinFlowId) {
      return wa.sendFlow(user.phone, {
        flowId: cfg.whatsapp.setPinFlowId,
        flowToken: rec.token,
        cta: "Create PIN",
        body,
        screen: "CREATE_PIN",
        data: {},
      });
    }
    store.updateUser(user.phone, { awaitingPinToken: rec.token });
    return wa.sendText(user.phone, `${body}\n\nReply with your new 4-digit PIN.`);
  }

  /** Sends a PIN Flow (native pop-up form) that must be completed to run `action`. */
  private async requirePin(user: User, action: PendingAction, summary: string, note?: string) {
    const { store, wa, cfg } = this.d;
    const u = store.getUser(user.phone)!;
    if (!u.pinHash) return this.sendSetPinFlow(u, action, `To continue (${summary}), set up your PIN first.`);
    if (u.lockedUntil && u.lockedUntil > Date.now()) {
      const mins = Math.ceil((u.lockedUntil - Date.now()) / 60000);
      return wa.sendText(u.phone, `🔒 Too many wrong PIN attempts. Try again in ${mins} min.`);
    }
    const rec = store.createPending(u.phone, action);
    const body = `${note ? note + "\n\n" : ""}*${summary}*\n\nTap below and enter your PIN to approve.`;
    if (cfg.whatsapp.pinFlowId) {
      return wa.sendFlow(u.phone, {
        flowId: cfg.whatsapp.pinFlowId,
        flowToken: rec.token,
        cta: "Enter PIN",
        body,
        screen: "PIN_ENTRY",
        data: { summary },
      });
    }
    store.updateUser(u.phone, { awaitingPinToken: rec.token });
    return wa.sendText(u.phone, `${body.replace("Tap below and enter", "Reply with")}\n_(Delete the message after sending.)_`);
  }

  private async onPinSubmitted(user: User, response: Record<string, unknown>) {
    const { store, wa } = this.d;
    const token = String(response.flow_token ?? "");
    const pin = String(response.pin ?? "");
    const rec = store.consumePending(token, user.phone);
    if (!rec) return wa.sendText(user.phone, "⌛ That approval expired or was already used. Please start again.");
    const action = rec.action;

    // ---- creating a PIN
    if (action.kind === "set_pin" && !store.getUser(user.phone)!.pinHash) {
      const confirm = response.pin_confirm === undefined ? pin : String(response.pin_confirm);
      if (!isValidPin(pin)) return this.sendSetPinFlow(user, action.then, "That PIN is too easy to guess. Use 4 digits, not 1234 or 0000.");
      if (pin !== confirm) return this.sendSetPinFlow(user, action.then, "The two PINs didn't match. Let's try again.");
      const { hash, salt } = hashPin(pin);
      store.updateUser(user.phone, { pinHash: hash, pinSalt: salt, pinFailures: 0, lockedUntil: undefined });
      await wa.sendText(user.phone, "✅ PIN set. Keep it secret: Settle will never ask for it in a chat message.");
      // The user just authenticated by creating the PIN, so finish what they started.
      if (action.then) await this.execute(store.getUser(user.phone)!, action.then);
      return;
    }

    // ---- verifying a PIN
    const u = store.getUser(user.phone)!;
    if (u.lockedUntil && u.lockedUntil > Date.now()) return wa.sendText(u.phone, "🔒 PIN locked. Try again later.");
    if (!verifyPin(pin, u.pinHash!, u.pinSalt!)) {
      const failures = u.pinFailures + 1;
      if (failures >= MAX_PIN_FAILURES) {
        store.updateUser(u.phone, { pinFailures: 0, lockedUntil: Date.now() + PIN_LOCK_MS });
        return wa.sendText(u.phone, `🔒 Wrong PIN ${MAX_PIN_FAILURES} times. Payments are locked for 15 minutes.`);
      }
      store.updateUser(u.phone, { pinFailures: failures });
      return this.requirePin(u, action, this.summaryFor(u, action), `❌ Wrong PIN. ${MAX_PIN_FAILURES - failures} attempt(s) left.`);
    }
    store.updateUser(u.phone, { pinFailures: 0 });

    if (action.kind === "set_pin") return this.sendSetPinFlowForChange(u);
    return this.execute(u, action);
  }

  private async sendSetPinFlowForChange(u: User) {
    this.d.store.updateUser(u.phone, { pinHash: undefined, pinSalt: undefined });
    return this.sendSetPinFlow(u, undefined, "Current PIN confirmed.");
  }

  private summaryFor(u: User, a: PendingAction): string {
    if (a.kind === "release") {
      const e = this.d.store.getEscrow(a.escrowId);
      return e ? `Release ${formatMoney(e.amount, e.currency)} for ${e.description}` : "Release escrow";
    }
    if (a.kind === "send") return `Send ${formatMoney(a.amount, a.currency)} to ${this.contactName(u, a.to) ?? "+" + a.to}`;
    if (a.kind === "withdraw") return `Withdraw ${formatMoney(a.amount, a.currency)}`;
    return "Confirm your current PIN";
  }

  // =========================================================================
  // Execution (only reached after a valid PIN)
  // =========================================================================

  private async execute(u: User, a: PendingAction) {
    if (a.kind === "release") return this.executeRelease(u, a.escrowId);
    if (a.kind === "send") return this.executeSend(u, a.to, a.amount, a.currency);
    if (a.kind === "withdraw") return this.executeWithdraw(u, a);
  }

  private async executeRelease(buyer: User, escrowId: string) {
    const { store, wa, cfg } = this.d;
    const e = store.getEscrow(escrowId);
    if (!e || e.status !== "FUNDED" || e.buyerPhone !== buyer.phone)
      return wa.sendText(buyer.phone, `${escrowId} can no longer be released.`);
    const fee = Math.round((e.amount * cfg.escrowFeeBps) / 10_000);
    const net = e.amount - fee;
    store.transfer(null, e.sellerPhone, net, e.currency); // escrow pool -> seller wallet
    store.updateEscrow(e.id, { status: "RELEASED", feeMinor: fee }, `released by buyer; ${net} to seller, fee ${fee}`);

    await wa.sendText(
      buyer.phone,
      `✅ *Released*\n\n${formatMoney(e.amount, e.currency)} for _${e.description}_ has been paid out.\nRef: ${e.id}\n\nThanks for using Settle 💚`,
    );
    await this.notify(
      e.sellerPhone,
      `💸 *You've been paid!*\n\n${formatMoney(net, e.currency)} for _${e.description}_ is now in your Settle wallet` +
        `${fee ? ` (fee ${formatMoney(fee, e.currency)})` : ""}.\nRef: ${e.id}\n\nType _balance_ or _withdraw_.`,
    );
  }

  private async executeSend(from: User, to: string, amount: number, currency: Currency) {
    const { store, wa } = this.d;
    try {
      store.transfer(from.phone, to, amount, currency);
    } catch (err) {
      if ((err as Error).message === "INSUFFICIENT_FUNDS") return wa.sendText(from.phone, "Not enough balance anymore. Nothing was sent.");
      throw err;
    }
    const name = this.contactName(from, to) ?? store.getUser(to)?.name ?? `+${to}`;
    const bal = store.getUser(from.phone)!.balances[currency];
    await wa.sendText(from.phone, `✅ Sent *${formatMoney(amount, currency)}* to ${name}.\nNew balance: ${formatMoney(bal, currency)}`);
    await this.notify(to, `💰 You received *${formatMoney(amount, currency)}* from ${from.name ?? "+" + from.phone} on Settle.\nType _balance_ to see it.`);
  }

  private async executeWithdraw(u: User, a: Extract<PendingAction, { kind: "withdraw" }>) {
    const { store, wa, payments } = this.d;
    try {
      store.transfer(u.phone, null, a.amount, a.currency);
    } catch {
      return wa.sendText(u.phone, "Not enough balance anymore. Nothing was sent.");
    }
    const wd = store.createWithdrawal({ phone: u.phone, amount: a.amount, currency: a.currency, address: a.address, network: a.network, status: "PROCESSING" });
    try {
      const res = await payments.payout({ reference: wd.id, amount: a.amount, currency: a.currency, address: a.address, network: a.network });
      const done = ["funds_delivered", "completed"].includes(res.status);
      store.updateWithdrawal(wd.id, { providerRef: res.providerRef, status: done ? "COMPLETED" : "PROCESSING" });
      await wa.sendText(
        u.phone,
        done
          ? `✅ Withdrawal of ${formatMoney(a.amount, a.currency)} sent.\nRef: ${wd.id}`
          : `⏳ Withdrawal of ${formatMoney(a.amount, a.currency)} is processing. I'll message you when it lands.\nRef: ${wd.id}`,
      );
    } catch (err) {
      console.error("[agent] payout failed", err);
      store.transfer(null, u.phone, a.amount, a.currency); // refund
      store.updateWithdrawal(wd.id, { status: "FAILED" });
      await wa.sendText(u.phone, "❌ The withdrawal couldn't be processed. Your balance has been restored.");
    }
  }

  // =========================================================================
  // Busha webhooks
  // =========================================================================

  async handleProviderEvent(ev: ProviderEvent): Promise<void> {
    const { store } = this.d;
    if (ev.kind === "ignored") return;
    if (!store.markProcessed(`busha:${ev.eventKey}`)) return;

    if (ev.kind === "collection_completed" || ev.kind === "collection_failed") {
      let { escrow, topup } = store.findByProviderRef(ev.providerRef);
      if (!escrow && !topup && ev.reference) {
        escrow = store.getEscrow(ev.reference);
        topup = store.getTopup(ev.reference);
      }
      if (escrow) return ev.kind === "collection_completed" ? this.onEscrowFunded(escrow) : this.onCollectionFailed(escrow.buyerPhone, escrow.id, ev.status);
      if (topup) return ev.kind === "collection_completed" ? this.onTopupCompleted(topup) : this.onCollectionFailed(topup.phone, topup.id, ev.status);
      console.warn("[busha] no escrow/topup for", ev.providerRef);
      return;
    }

    const wd = store.findWithdrawalByProviderRef(ev.providerRef);
    if (!wd || wd.status !== "PROCESSING") return;
    if (ev.kind === "payout_completed") {
      store.updateWithdrawal(wd.id, { status: "COMPLETED" });
      await this.notify(wd.phone, `✅ Your withdrawal of ${formatMoney(wd.amount, wd.currency)} has been delivered.\nRef: ${wd.id}`);
    } else {
      store.updateWithdrawal(wd.id, { status: "FAILED" });
      store.transfer(null, wd.phone, wd.amount, wd.currency);
      await this.notify(wd.phone, `❌ Withdrawal ${wd.id} failed (${ev.status}). ${formatMoney(wd.amount, wd.currency)} is back in your wallet.`);
    }
  }

  private async onEscrowFunded(e: Escrow) {
    const { store, wa } = this.d;
    if (e.status !== "AWAITING_PAYMENT") return;
    store.updateEscrow(e.id, { status: "FUNDED" }, "payment confirmed by Busha");
    const seller = store.getUser(e.sellerPhone);
    if (e.buyerPhone) {
      await wa.sendButtons(
        e.buyerPhone,
        `✅ *Payment received*: ${formatMoney(e.amount, e.currency)}\nRef: ${e.id}\n\n🔒 Your money is held safely in escrow. ` +
          `Tap *Release funds* once ${seller?.name ?? "the seller"} has delivered _${e.description}_.`,
        [
          { id: `release:${e.id}`, title: "Release funds" },
          { id: `dispute:${e.id}`, title: "Raise dispute" },
        ],
        "Pending → Paid & held in escrow",
      );
    }
    await this.notify(
      e.sellerPhone,
      `🔒 *${e.id} is funded!*\n${formatMoney(e.amount, e.currency)} for _${e.description}_ is secured in escrow.\nDeliver the work. You'll be paid the moment your client releases it.`,
    );
  }

  private async onTopupCompleted(t: Topup) {
    const { store } = this.d;
    if (t.status !== "PENDING") return;
    store.updateTopup(t.id, { status: "COMPLETED" });
    store.transfer(null, t.phone, t.amount, t.currency);
    const bal = store.getUser(t.phone)!.balances[t.currency];
    await this.notify(t.phone, `✅ Wallet funded with ${formatMoney(t.amount, t.currency)}.\nBalance: ${formatMoney(bal, t.currency)}`);
  }

  private async onCollectionFailed(phone: string | undefined, ref: string, status: string) {
    if (phone) await this.notify(phone, `⚠️ Payment for ${ref} ${status}. Reply _pay ${ref}_ to get fresh payment details.`);
  }

  /** Messages a user who may be outside the 24h window; never let that break the flow. */
  private async notify(phone: string, text: string) {
    try {
      await this.d.wa.sendText(phone, text);
    } catch (err) {
      console.warn(`[agent] notify ${phone} failed (outside 24h window? use a template):`, (err as Error).message);
    }
  }
}
