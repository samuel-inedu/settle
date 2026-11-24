import type { Currency, Minor } from "./types.js";

export function toMinor(amount: number): Minor {
  return Math.round(amount * 100);
}

export function toMajorString(minor: Minor): string {
  return (minor / 100).toFixed(2);
}

/** ₦15,000.00 / 250.00 USDT */
export function formatMoney(minor: Minor, currency: Currency): string {
  const n = (minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "NGN" ? `₦${n}` : `${n} USDT`;
}

/**
 * Parse loose human amounts: "₦15,000", "N15k", "15000 naira", "$250", "250 usdt", "1.5m".
 * Returns null if no amount found.
 */
export function parseAmount(text: string): { amount: number; currency?: Currency } | null {
  const t = text.toLowerCase().replace(/,/g, "");
  const m = t.match(/(₦|\bngn\s*|\bn(?=\d)|\$|\busdt\s*|\busd\s*)?(\d+(?:\.\d+)?)\s*(k|m)?\b\s*(naira|ngn|usdt|usd|dollars?)?/);
  if (!m) return null;
  let amount = parseFloat(m[2]);
  if (m[3] === "k") amount *= 1_000;
  if (m[3] === "m") amount *= 1_000_000;
  const sym = (m[1] || m[4] || "").trim();
  let currency: Currency | undefined;
  if (["₦", "n", "ngn", "naira"].includes(sym)) currency = "NGN";
  if (["$", "usdt", "usd", "dollar", "dollars"].includes(sym)) currency = "USDT";
  return { amount, currency };
}
