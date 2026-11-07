// All money is integer. "Minor" means cents. "Base" means token units at
// 6 decimals. A float never touches an amount in this package.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const BASE_PER_CENT = 10_000n;

const DECIMAL = /^\d{1,15}(\.\d{1,2})?$/;

/** "1234.5" becomes 123450n. Returns null if it isn't a plain non-negative amount. */
export function parseAmount(text: string): bigint | null {
  const value = text.trim();
  if (!DECIMAL.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/** 123450n becomes "1234.50". */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const size = negative ? -cents : cents;
  const whole = size / 100n;
  const fraction = (size % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Rounds half up. A base-unit amount is never negative here. */
export function baseToCents(base: bigint): bigint {
  if (base < 0n) throw new RangeError('Amount must not be negative');
  return (base + BASE_PER_CENT / 2n) / BASE_PER_CENT;
}

export function centsToBase(cents: bigint): bigint {
  return cents * BASE_PER_CENT;
}

/**
 * Works in a browser as well as Node, so an approver's own device can re-read a
 * payment file and confirm its hash, rather than trusting what a server shows.
 */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}
