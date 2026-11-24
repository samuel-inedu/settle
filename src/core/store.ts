import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Escrow, PendingAction, PendingRecord, Topup, User, Withdrawal } from "./types.js";

interface DbShape {
  users: Record<string, User>;
  escrows: Record<string, Escrow>;
  topups: Record<string, Topup>;
  withdrawals: Record<string, Withdrawal>;
  pending: Record<string, PendingRecord>;
  processedEvents: string[];
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function shortId(prefix: string, len = 5): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}-${s}`;
}

/**
 * Tiny JSON-file store. Good enough for a hackathon (single process).
 * Swap for Postgres/SQLite later: every method here maps to one table.
 */
export class Store {
  private db: DbShape;
  private writeTimer?: NodeJS.Timeout;

  constructor(private file: string | null) {
    const empty: DbShape = { users: {}, escrows: {}, topups: {}, withdrawals: {}, pending: {}, processedEvents: [] };
    this.db = file && existsSync(file) ? { ...empty, ...JSON.parse(readFileSync(file, "utf8")) } : empty;
  }

  private save() {
    if (!this.file) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }

  // ---- users
  getUser(phone: string): User | undefined {
    return this.db.users[phone];
  }

  ensureUser(phone: string, name?: string): User {
    let u = this.db.users[phone];
    if (!u) {
      u = { phone, name, pinFailures: 0, balances: { NGN: 0, USDT: 0 }, contacts: {}, createdAt: Date.now() };
      this.db.users[phone] = u;
    } else if (name && !u.name) {
      u.name = name;
    }
    this.save();
    return u;
  }

  updateUser(phone: string, patch: Partial<User>): User {
    const u = this.ensureUser(phone);
    Object.assign(u, patch);
    this.save();
    return u;
  }

  // ---- escrows
  createEscrow(e: Omit<Escrow, "id" | "createdAt" | "history" | "collections" | "status">): Escrow {
    const escrow: Escrow = {
      ...e,
      id: shortId("ESC"),
      status: "AWAITING_PAYMENT",
      collections: [],
      history: [{ at: Date.now(), event: "created" }],
      createdAt: Date.now(),
    };
    this.db.escrows[escrow.id] = escrow;
    this.save();
    return escrow;
  }

  getEscrow(id: string): Escrow | undefined {
    return this.db.escrows[id.toUpperCase()];
  }

  updateEscrow(id: string, patch: Partial<Escrow>, event?: string): Escrow {
    const e = this.db.escrows[id];
    if (!e) throw new Error(`escrow ${id} not found`);
    Object.assign(e, patch);
    if (event) e.history.push({ at: Date.now(), event });
    this.save();
    return e;
  }

  escrowsFor(phone: string): Escrow[] {
    return Object.values(this.db.escrows)
      .filter((e) => e.sellerPhone === phone || e.buyerPhone === phone)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  allEscrows(): Escrow[] {
    return Object.values(this.db.escrows).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---- topups / withdrawals
  createTopup(t: Omit<Topup, "id" | "createdAt" | "status" | "collections">): Topup {
    const topup: Topup = { ...t, id: shortId("TOP"), status: "PENDING", collections: [], createdAt: Date.now() };
    this.db.topups[topup.id] = topup;
    this.save();
    return topup;
  }

  getTopup(id: string): Topup | undefined {
    return this.db.topups[id.toUpperCase()];
  }

  updateTopup(id: string, patch: Partial<Topup>): Topup {
    const t = this.db.topups[id];
    Object.assign(t, patch);
    this.save();
    return t;
  }

  createWithdrawal(w: Omit<Withdrawal, "id" | "createdAt">): Withdrawal {
    const wd: Withdrawal = { ...w, id: shortId("WDR"), createdAt: Date.now() };
    this.db.withdrawals[wd.id] = wd;
    this.save();
    return wd;
  }

  findWithdrawalByProviderRef(ref: string): Withdrawal | undefined {
    return Object.values(this.db.withdrawals).find((w) => w.providerRef === ref || w.id === ref);
  }

  updateWithdrawal(id: string, patch: Partial<Withdrawal>): Withdrawal {
    const w = this.db.withdrawals[id];
    Object.assign(w, patch);
    this.save();
    return w;
  }

  /** Match a Busha payment request id back to the escrow/topup it belongs to. */
  findByProviderRef(ref: string): { escrow?: Escrow; topup?: Topup } {
    const escrow = Object.values(this.db.escrows).find((e) => e.collections.some((c) => c.providerRef === ref));
    if (escrow) return { escrow };
    const topup = Object.values(this.db.topups).find((t) => t.collections.some((c) => c.providerRef === ref));
    return { topup };
  }

  // ---- ledger
  /** Atomic within this process: throws if insufficient funds. */
  transfer(from: string | null, to: string | null, amount: number, currency: "NGN" | "USDT") {
    if (amount <= 0) throw new Error("amount must be positive");
    if (from) {
      const f = this.ensureUser(from);
      if (f.balances[currency] < amount) throw new Error("INSUFFICIENT_FUNDS");
      f.balances[currency] -= amount;
    }
    if (to) this.ensureUser(to).balances[currency] += amount;
    this.save();
  }

  // ---- pending PIN-gated actions (single-use, expiring)
  createPending(phone: string, action: PendingAction): PendingRecord {
    const rec: PendingRecord = {
      token: `${action.kind}.${randomBytes(12).toString("hex")}`,
      phone,
      action,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    this.db.pending[rec.token] = rec;
    this.save();
    return rec;
  }

  /** Returns and deletes the pending record (single use). */
  consumePending(token: string, phone: string): PendingRecord | undefined {
    const rec = this.db.pending[token];
    if (!rec || rec.phone !== phone) return undefined;
    delete this.db.pending[token];
    this.save();
    return rec.expiresAt >= Date.now() ? rec : undefined;
  }

  // ---- idempotency
  /** Returns true the first time an event key is seen. */
  markProcessed(key: string): boolean {
    if (this.db.processedEvents.includes(key)) return false;
    this.db.processedEvents.push(key);
    if (this.db.processedEvents.length > 5000) this.db.processedEvents.splice(0, 1000);
    this.save();
    return true;
  }
}
