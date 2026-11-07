// Turns ledger entries into cents, once, for every statement format.
//
// Tokens have 6 decimals and banks have 2, so each entry rounds on its own. The
// rounded entries can then add up to a cent or so away from the rounded closing
// balance. A statement that doesn't foot is useless to an accountant, so the
// difference goes in a visible ROUNDING entry. It is never spread or hidden.

import { baseToCents } from './money.ts';
import type { StatementEntry, StatementInput } from './types.ts';

export const PEG_NOTE =
  'Amounts are USDC on NEAR, shown as USD at 1 USDC = 1 USD. ' +
  'Statement formats need a three-letter currency and USDC has none.';

export const ROUNDING_REFERENCE = 'ROUNDING';

export type EntryKind = 'payment' | 'receipt' | 'rounding';

export interface PreparedEntry {
  /** Stable across statements. Derived from the ledger sequence. */
  id: string;
  seq?: number;
  kind: EntryKind;
  date: string;
  bookedAt: string;
  direction: 'debit' | 'credit';
  cents: bigint;
  /** Set when a fee is part of the entry. Principal + fee = cents. */
  principalCents?: bigint;
  feeCents?: bigint;
  counterpartyName?: string;
  counterpartyAccount?: string;
  endToEndId?: string;
  reference: string;
  remittance?: string;
  txHash?: string;
}

export interface PreparedStatement {
  input: StatementInput;
  openingCents: bigint;
  closingCents: bigint;
  entries: PreparedEntry[];
  /** Signed value of the ROUNDING entry. Zero if there isn't one. */
  roundingCents: bigint;
  /** Entries too small to show as a cent. Their value is in the rounding entry. */
  belowOneCent: number;
  creditCents: bigint;
  debitCents: bigint;
}

/** One line in a flat format, where a fee has to be its own row. */
export interface FlatRow {
  id: string;
  seq?: number;
  type: 'payment' | 'fee' | 'receipt' | 'rounding';
  date: string;
  bookedAt: string;
  direction: 'debit' | 'credit';
  cents: bigint;
  name: string;
  memo: string;
  endToEndId?: string;
  reference: string;
  txHash?: string;
}

export class StatementDoesNotBalance extends Error {}

const dateOf = (timestamp: string): string => timestamp.slice(0, 10);

function checkEntry(entry: StatementEntry, input: StatementInput): void {
  const label = `Ledger entry ${entry.seq}`;
  if (entry.amountMinor6 <= 0n) {
    throw new StatementDoesNotBalance(`${label} must have a positive amount.`);
  }
  const { principalMinor6: principal, feeMinor6: fee, amountMinor6: amount } = entry;
  if (principal !== undefined && fee !== undefined && principal + fee !== amount) {
    throw new StatementDoesNotBalance(`${label}: principal plus fee must equal the amount.`);
  }
  const date = dateOf(entry.bookedAt);
  if (date < input.periodFrom || date > input.periodTo) {
    throw new StatementDoesNotBalance(`${label} is dated ${date}, outside the statement period.`);
  }
}

function prepareEntry(entry: StatementEntry): PreparedEntry {
  const cents = baseToCents(entry.amountMinor6);
  const principalBase =
    entry.principalMinor6 ??
    (entry.feeMinor6 === undefined ? undefined : entry.amountMinor6 - entry.feeMinor6);

  const prepared: PreparedEntry = {
    id: String(entry.seq),
    seq: entry.seq,
    kind: entry.direction === 'debit' ? 'payment' : 'receipt',
    date: dateOf(entry.bookedAt),
    bookedAt: entry.bookedAt,
    direction: entry.direction,
    cents,
    reference: entry.reference,
  };
  if (principalBase !== undefined) {
    // The fee is whatever is left, so principal and fee always add up to the entry.
    const principalCents = baseToCents(principalBase);
    const feeCents = cents - principalCents;
    if (feeCents > 0n) {
      prepared.principalCents = principalCents;
      prepared.feeCents = feeCents;
    }
  }
  if (entry.counterpartyName) prepared.counterpartyName = entry.counterpartyName;
  if (entry.counterpartyAccount) prepared.counterpartyAccount = entry.counterpartyAccount;
  if (entry.endToEndId) prepared.endToEndId = entry.endToEndId;
  if (entry.remittance) prepared.remittance = entry.remittance;
  if (entry.txHash) prepared.txHash = entry.txHash;
  return prepared;
}

export function prepareStatement(input: StatementInput): PreparedStatement {
  const entries = [...input.entries].sort((a, b) => a.seq - b.seq);
  for (const entry of entries) checkEntry(entry, input);

  // First the exact check, in token units, with no rounding involved.
  const net = entries.reduce(
    (sum, e) => (e.direction === 'credit' ? sum + e.amountMinor6 : sum - e.amountMinor6),
    0n,
  );
  if (input.openingBalance + net !== input.closingBalance) {
    throw new StatementDoesNotBalance(
      `Opening ${input.openingBalance} plus net ${net} does not equal closing ${input.closingBalance}.`,
    );
  }

  const openingCents = baseToCents(input.openingBalance);
  const closingCents = baseToCents(input.closingBalance);

  const prepared = entries.map(prepareEntry);
  const shown = prepared.filter((entry) => entry.cents > 0n);
  const belowOneCent = prepared.length - shown.length;

  const signed = (entry: PreparedEntry): bigint =>
    entry.direction === 'credit' ? entry.cents : -entry.cents;
  const shownNet = shown.reduce((sum, entry) => sum + signed(entry), 0n);
  const roundingCents = closingCents - openingCents - shownNet;

  if (roundingCents !== 0n) {
    const last = input.periodTo;
    shown.push({
      id: `${ROUNDING_REFERENCE}-${input.statementId}`,
      kind: 'rounding',
      date: last,
      bookedAt: `${last}T23:59:59Z`,
      direction: roundingCents > 0n ? 'credit' : 'debit',
      cents: roundingCents > 0n ? roundingCents : -roundingCents,
      reference: ROUNDING_REFERENCE,
      remittance: 'Rounding from 6-decimal token amounts to cents',
    });
  }

  const sumWhere = (direction: 'credit' | 'debit'): bigint =>
    shown.filter((e) => e.direction === direction).reduce((sum, e) => sum + e.cents, 0n);
  const creditCents = sumWhere('credit');
  const debitCents = sumWhere('debit');

  // Belt and braces. If this ever trips, a writer must not produce a file.
  if (openingCents + creditCents - debitCents !== closingCents) {
    throw new StatementDoesNotBalance('Rounded entries do not reach the closing balance.');
  }

  return {
    input,
    openingCents,
    closingCents,
    entries: shown,
    roundingCents,
    belowOneCent,
    creditCents,
    debitCents,
  };
}

/** Splits fees into their own rows, so a bill can match its exact amount. */
export function flatten(statement: PreparedStatement): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const entry of statement.entries) {
    const name = entry.counterpartyName ?? (entry.kind === 'rounding' ? 'Rounding' : 'Unknown');
    const memo = [entry.remittance, entry.endToEndId].filter(Boolean).join(' ');
    const base = {
      date: entry.date,
      bookedAt: entry.bookedAt,
      direction: entry.direction,
      ...(entry.seq === undefined ? {} : { seq: entry.seq }),
      ...(entry.endToEndId ? { endToEndId: entry.endToEndId } : {}),
      ...(entry.txHash ? { txHash: entry.txHash } : {}),
    };
    if (entry.feeCents) {
      rows.push({
        ...base,
        id: entry.id,
        type: 'payment',
        cents: entry.principalCents ?? entry.cents,
        name,
        memo,
        reference: entry.reference,
      });
      rows.push({
        ...base,
        id: `${entry.id}F`,
        type: 'fee',
        cents: entry.feeCents,
        name: 'Payment routing fee',
        memo: `Routing fee for ${entry.endToEndId ?? entry.reference}`,
        reference: entry.reference,
      });
    } else {
      rows.push({
        ...base,
        id: entry.id,
        type: entry.kind,
        cents: entry.cents,
        name,
        memo,
        reference: entry.reference,
      });
    }
  }
  return rows;
}
