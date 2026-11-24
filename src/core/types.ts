export type Currency = "NGN" | "USDT";
export const CURRENCIES: Currency[] = ["NGN", "USDT"];

/** All money is stored as integer minor units (kobo / cents) to avoid float errors. */
export type Minor = number;

export interface User {
  phone: string; // E.164 without "+", e.g. 2348012345678
  name?: string;
  pinHash?: string;
  pinSalt?: string;
  pinFailures: number;
  lockedUntil?: number;
  balances: Record<Currency, Minor>;
  contacts: Record<string, string>; // lowercase name -> phone
  /** Token of a pending action waiting for a PIN typed in chat (only when Flows aren't configured). */
  awaitingPinToken?: string;
  createdAt: number;
}

export type EscrowStatus = "AWAITING_PAYMENT" | "FUNDED" | "RELEASED" | "DISPUTED" | "CANCELLED";

export interface CollectionDetails {
  method: "bank" | "crypto";
  providerRef: string; // Busha payment request id
  checkoutUrl?: string;
  bank?: { accountNumber: string; bankName: string; accountName: string; expiresAt?: string };
  crypto?: { address: string; network: string; currency: string; amount: string; expiresAt?: string };
}

export interface Escrow {
  id: string; // ESC-XXXXX
  sellerPhone: string;
  buyerPhone?: string;
  amount: Minor;
  currency: Currency;
  description: string;
  status: EscrowStatus;
  collections: CollectionDetails[];
  feeMinor?: Minor;
  history: { at: number; event: string }[];
  createdAt: number;
}

export interface Topup {
  id: string; // TOP-XXXXX
  phone: string;
  amount: Minor;
  currency: Currency;
  status: "PENDING" | "COMPLETED";
  collections: CollectionDetails[];
  createdAt: number;
}

export interface Withdrawal {
  id: string; // WDR-XXXXX
  phone: string;
  amount: Minor;
  currency: Currency;
  address: string;
  network: string;
  providerRef?: string;
  status: "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt: number;
}

export type PendingAction =
  | { kind: "set_pin"; then?: PendingActionInput }
  | { kind: "release"; escrowId: string }
  | { kind: "send"; to: string; amount: Minor; currency: Currency }
  | { kind: "withdraw"; amount: Minor; currency: Currency; address: string; network: string };

export type PendingActionInput = PendingAction;

export interface PendingRecord {
  token: string;
  phone: string;
  action: PendingAction;
  expiresAt: number;
}
