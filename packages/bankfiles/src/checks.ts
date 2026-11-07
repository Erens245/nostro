// Checks shared by every reader. A clerk should see all the problems with a
// file at once, so readers collect issues instead of stopping at the first.

import { formatCents } from './money.ts';
import type { CanonicalLine, CanonicalRun, Issue, PayeeAccount } from './types.ts';

const NEAR_ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*\.(?:near|testnet)$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z\d]{11,30}$/;

export function isNearAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT.test(value);
}

/** Decides what kind of account a bare string is, for formats with no field for it. */
export function classifyAccount(raw: string, routing?: string): PayeeAccount {
  const value = raw.trim();
  const compact = value.replace(/\s+/g, '').toUpperCase();
  let account: PayeeAccount;
  if (isNearAccount(value)) account = { kind: 'NEAR', value };
  else if (IBAN.test(compact)) account = { kind: 'IBAN', value: compact };
  else account = { kind: 'ACCOUNT', value };
  if (routing) account.routing = routing;
  return account;
}

export function issue(
  severity: Issue['severity'],
  code: string,
  message: string,
  lineIndex?: number,
): Issue {
  return lineIndex === undefined
    ? { severity, code, message }
    : { severity, code, message, lineIndex };
}

/** Checks every run has to pass, whatever format it came from. */
export function finishRun(
  run: Omit<CanonicalRun, 'controlSumMinor'> & { issues: Issue[] },
): CanonicalRun {
  const issues = [...run.issues];
  const lines: CanonicalLine[] = run.lines;
  const controlSumMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0n);

  if (lines.length === 0) {
    issues.push(issue('error', 'EMPTY_FILE', 'This file has no payments in it.'));
  }
  if (run.declaredCount !== undefined && run.declaredCount !== lines.length) {
    issues.push(
      issue(
        'error',
        'COUNT_MISMATCH',
        `The file says it has ${run.declaredCount} payments, but ${lines.length} were found.`,
      ),
    );
  }
  if (
    run.declaredControlSumMinor !== undefined &&
    run.declaredControlSumMinor !== controlSumMinor
  ) {
    issues.push(
      issue(
        'error',
        'CONTROL_SUM_MISMATCH',
        `The file says the total is ${formatCents(run.declaredControlSumMinor)}, ` +
          `but the payments add up to ${formatCents(controlSumMinor)}.`,
      ),
    );
  }

  const seen = new Map<string, number>();
  for (const line of lines) {
    const first = seen.get(line.endToEndId);
    if (first === undefined) {
      seen.set(line.endToEndId, line.index);
    } else {
      issues.push(
        issue(
          'error',
          'DUPLICATE_END_TO_END_ID',
          `Payments ${first + 1} and ${line.index + 1} share the id ` +
            `"${line.endToEndId}", which could pay someone twice.`,
          line.index,
        ),
      );
    }
    if (!line.creditorName) {
      issues.push(
        issue(
          'error',
          'MISSING_CREDITOR_NAME',
          `Payment ${line.index + 1} has no payee name.`,
          line.index,
        ),
      );
    }
    if (!line.creditorAccount.value) {
      issues.push(
        issue(
          'error',
          'MISSING_CREDITOR_ACCOUNT',
          `Payment ${line.index + 1} has no account to pay.`,
          line.index,
        ),
      );
    }
  }

  return { ...run, controlSumMinor, issues };
}

export function hasErrors(run: CanonicalRun): boolean {
  return run.issues.some((entry) => entry.severity === 'error');
}
