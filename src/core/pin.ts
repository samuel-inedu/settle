import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const MAX_PIN_FAILURES = 3;
export const PIN_LOCK_MS = 15 * 60 * 1000;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4}$/.test(pin) && !/^(\d)\1{3}$/.test(pin) && pin !== "1234";
}

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
