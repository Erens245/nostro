// The hashes a run is recorded under on chain, and the check that closes the gap
// between "the file is genuine" and "the payments are the file's payments".
//
// An approval names a file hash, but money follows the lines stored on chain.
// Those lines arrive separately, so a dishonest submitter could pair a genuine
// file with altered lines. compareRunToFile runs on the approver's own device
// and refuses any run whose lines differ from the file it just read.

import { centsToBase, sha256Hex } from './money.ts';
import type { CanonicalLine, CanonicalRun, PayeeAccount } from './types.ts';

export const payeeKey = (account: PayeeAccount | string): string => {
  const value = typeof account === 'string' ? account : account.value;
  return sha256Hex(value.trim().toLowerCase().replace(/\s+/g, ''));
};

const party = (run: CanonicalRun): string => run.debtorName ?? run.initiatingParty;

export const messageHash = (run: CanonicalRun): string =>
  sha256Hex(`${party(run)}|${run.messageId}`);

export const e2eHash = (run: CanonicalRun, line: CanonicalLine): string =>
  sha256Hex(`${party(run)}|${line.endToEndId}`);

/** What the contract holds for a line. */
export interface RecordedLine {
  e2e_hash: string;
  payee_key: string;
  amount: string;
}

export interface LineMismatch {
  /** Zero-based, or null for a problem with the whole run. */
  line: number | null;
  message: string;
}

export interface CompareOptions {
  /** Routing cost allowed above face value, in basis points. Zero pays face value. */
  maxFeeBps?: number;
}

export function compareRunToFile(
  run: CanonicalRun,
  recorded: RecordedLine[],
  options: CompareOptions = {},
): LineMismatch[] {
  const mismatches: LineMismatch[] = [];
  if (recorded.length !== run.lines.length) {
    mismatches.push({
      line: null,
      message: `The file has ${run.lines.length} payments, but ${recorded.length} are recorded.`,
    });
  }
  const maxFeeBps = BigInt(options.maxFeeBps ?? 0);
  for (const line of run.lines) {
    const entry = recorded[line.index];
    if (!entry) continue;
    const label = `Payment ${line.index + 1} (${line.creditorName})`;
    if (entry.e2e_hash !== e2eHash(run, line)) {
      mismatches.push({ line: line.index, message: `${label} has a different payment id on record.` });
    }
    if (entry.payee_key !== payeeKey(line.creditorAccount)) {
      mismatches.push({ line: line.index, message: `${label} is recorded against a different payee.` });
    }
    const face = centsToBase(line.amountMinor);
    const amount = BigInt(entry.amount);
    if (amount < face || amount > face + (face * maxFeeBps) / 10_000n) {
      mismatches.push({ line: line.index, message: `${label} has a different amount on record.` });
    }
  }
  return mismatches;
}
