// The logic between a parsed bank file and the contract. No network and no
// disk here, which is what makes it testable without a chain.

import {
  centsToBase,
  formatCents,
  sha256Hex,
} from '@nostro/bankfiles';
import type {
  CanonicalLine,
  CanonicalRun,
  LineStatusInput,
  PayeeAccount,
  StatementEntry,
  StatementInput,
  StatusCode,
  StatusInput,
} from '@nostro/bankfiles';

// ---------- Shapes the contract returns ----------

export type RunStatus =
  | 'Submitted'
  | 'Approved'
  | 'Rejected'
  | 'Executing'
  | 'Completed'
  | 'CompletedWithFailures';

export type LineStatus = 'Pending' | 'Sending' | 'Sent' | 'Failed';

export interface ChainLine {
  e2e_hash: string;
  payee_key: string;
  receiver: string;
  amount: string;
  status: LineStatus;
  settled_at: string;
}

export interface ChainRun {
  id: number;
  message_hash: string;
  file_sha256: string;
  total: string;
  maker: string;
  approvals: string[];
  status: RunStatus;
  created_at: string;
  rejected_reason: string | null;
  lines: ChainLine[];
}

export interface ChainPayee {
  route_hash: string;
  registered_by: string;
  approved_by: string | null;
  active_after: string;
}

export interface LedgerEntry {
  seq: number;
  ts: string;
  block: string;
  kind: 'Debit' | 'Credit';
  amount: string;
  balance_after: string;
  run_id: number | null;
  line: number | null;
  reference: string;
}

// ---------- Payees ----------

export interface Route {
  /** A 1Click chain name, for example near, base, sol or tron. */
  chain: string;
  asset: string;
  address: string;
}

export interface Payee {
  key: string;
  name: string;
  /** The account as written in the company's bank file. */
  account: string;
  route: Route;
  /** Testnet has no Intents, so a testnet demo pays this account directly. */
  testnetReceiver?: string;
}

export const payeeKey = (account: PayeeAccount | string): string => {
  const value = typeof account === 'string' ? account : account.value;
  return sha256Hex(value.trim().toLowerCase().replace(/\s+/g, ''));
};

export const routeHash = (route: Route): string =>
  sha256Hex(`${route.chain}|${route.asset}|${route.address}`);

const party = (run: CanonicalRun): string => run.debtorName ?? run.initiatingParty;

export const messageHash = (run: CanonicalRun): string =>
  sha256Hex(`${party(run)}|${run.messageId}`);

export const e2eHash = (run: CanonicalRun, line: CanonicalLine): string =>
  sha256Hex(`${party(run)}|${line.endToEndId}`);

// ---------- Submitting a run ----------

export interface ResolvedLine {
  index: number;
  payeeKey: string;
  receiver: string;
  /** Token units leaving the account, fee included. */
  amountBase: bigint;
  /** Token units the payee receives. */
  principalBase: bigint;
  /** Set on mainnet, where each line has its own 1Click deposit address. */
  depositAddress?: string;
  route?: Route;
}

export interface SubmitArgs {
  message_hash: string;
  file_sha256: string;
  total: string;
  lines: { e2e_hash: string; payee_key: string; receiver: string; amount: string }[];
}

export function buildSubmitArgs(run: CanonicalRun, resolved: ResolvedLine[]): SubmitArgs {
  const lines = resolved.map((item) => {
    const line = run.lines[item.index];
    if (!line) throw new Error(`No line ${item.index} in this run.`);
    return {
      e2e_hash: e2eHash(run, line),
      payee_key: item.payeeKey,
      receiver: item.receiver,
      amount: item.amountBase.toString(),
    };
  });
  const total = resolved.reduce((sum, item) => sum + item.amountBase, 0n);
  return {
    message_hash: messageHash(run),
    file_sha256: run.sourceSha256,
    total: total.toString(),
    lines,
  };
}

/** On testnet a line pays its face value straight to the payee's account. */
export function resolveDirect(
  run: CanonicalRun,
  findPayee: (key: string) => Payee | undefined,
): { resolved: ResolvedLine[]; missing: CanonicalLine[] } {
  const resolved: ResolvedLine[] = [];
  const missing: CanonicalLine[] = [];
  for (const line of run.lines) {
    const key = payeeKey(line.creditorAccount);
    const payee = findPayee(key);
    const direct =
      payee?.testnetReceiver ??
      (line.creditorAccount.kind === 'NEAR' ? line.creditorAccount.value : undefined);
    if (!direct) {
      missing.push(line);
      continue;
    }
    const amount = centsToBase(line.amountMinor);
    resolved.push({
      index: line.index,
      payeeKey: key,
      receiver: direct,
      amountBase: amount,
      principalBase: amount,
      ...(payee ? { route: payee.route } : {}),
    });
  }
  return { resolved, missing };
}

// ---------- Status reports ----------

/** The contract's hold reasons, as ISO external status reason codes. */
export const HOLD_REASONS: Record<string, { code: string; text: string }> = {
  payee_unknown: { code: 'AC01', text: 'Payee is not in the directory' },
  payee_unapproved: { code: 'AC06', text: 'Payee is waiting for approval' },
  payee_cooloff: { code: 'AC06', text: 'New or changed payee is in its cool-off period' },
  over_payment_limit: { code: 'AM02', text: 'Payment is over the per-payment limit' },
  over_daily_limit: { code: 'AM02', text: 'Payment is over the daily limit' },
  insufficient_funds: { code: 'AM04', text: 'Not enough funds in the account' },
};

export type OneClickStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'INCOMPLETE_DEPOSIT'
  | 'REFUNDED'
  | 'FAILED';

export function lineStatus(
  runStatus: RunStatus,
  line: ChainLine,
  held?: string,
  routed?: OneClickStatus,
): Pick<LineStatusInput, 'status' | 'reasonCode' | 'reasonText'> {
  if (runStatus === 'Rejected') {
    return { status: 'RJCT', reasonCode: 'NARR', reasonText: 'Rejected by an approver' };
  }
  if (line.status === 'Failed') {
    return { status: 'RJCT', reasonCode: 'NARR', reasonText: 'The transfer failed on chain' };
  }
  if (line.status === 'Pending') {
    const reason = held ? HOLD_REASONS[held] : undefined;
    if (reason) return { status: 'PDNG', reasonCode: reason.code, reasonText: reason.text };
    return { status: runStatus === 'Submitted' ? 'PDNG' : 'ACCP' };
  }
  if (line.status === 'Sending') return { status: 'ACSP' };
  switch (routed) {
    case undefined: // Testnet pays directly, so Sent means settled.
    case 'SUCCESS':
      return { status: 'ACSC' };
    case 'INCOMPLETE_DEPOSIT':
      return { status: 'RJCT', reasonCode: 'AM09', reasonText: 'Deposit was below the quoted amount' };
    case 'REFUNDED':
      return { status: 'RJCT', reasonCode: 'NARR', reasonText: 'Refunded by the router' };
    case 'FAILED':
      return { status: 'RJCT', reasonCode: 'NARR', reasonText: 'Failed in the router' };
    default:
      return { status: 'ACSP' };
  }
}

export function groupStatus(statuses: StatusCode[]): StatusCode | 'PART' {
  const first = statuses[0];
  if (first === undefined) return 'PDNG';
  if (statuses.every((status) => status === first)) return first;
  return statuses.includes('RJCT') ? 'PART' : 'ACSP';
}

export function buildStatusReport(
  run: CanonicalRun,
  chainRun: ChainRun,
  options: {
    now: Date;
    held?: Record<number, string>;
    routed?: Record<number, OneClickStatus>;
  },
): StatusInput {
  const lines: LineStatusInput[] = run.lines.map((line) => {
    const chainLine = chainRun.lines[line.index];
    if (!chainLine) throw new Error(`Run ${chainRun.id} has no line ${line.index}.`);
    return {
      endToEndId: line.endToEndId,
      ...(line.instructionId ? { instructionId: line.instructionId } : {}),
      ...lineStatus(
        chainRun.status,
        chainLine,
        options.held?.[line.index],
        options.routed?.[line.index],
      ),
    };
  });
  return {
    messageId: `STS-${chainRun.id}-${options.now.getTime()}`.slice(0, 35),
    createdAt: options.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    originalMessageId: run.messageId,
    originalFormat: run.format,
    ...(run.createdAt ? { originalCreatedAt: run.createdAt } : {}),
    originalCount: run.lines.length,
    originalControlSumMinor: run.controlSumMinor,
    groupStatus: groupStatus(lines.map((line) => line.status)),
    lines,
  };
}

// ---------- Statements ----------

const toIso = (nanos: string): string =>
  new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/, 'Z');

const dateOf = (nanos: string): string => toIso(nanos).slice(0, 10);

export interface RunDetail {
  run: CanonicalRun;
  resolved: ResolvedLine[];
}

export interface StatementContext {
  accountId: string;
  ownerName: string;
  from: string;
  to: string;
  ledger: LedgerEntry[];
  details: (runId: number) => RunDetail | undefined;
  txHashOf: (seq: number) => string | undefined;
}

function describeDebit(
  entry: LedgerEntry,
  context: StatementContext,
): Partial<StatementEntry> {
  if (entry.run_id === null || entry.line === null) return {};
  const detail = context.details(entry.run_id);
  const line = detail?.run.lines[entry.line];
  const resolved = detail?.resolved.find((item) => item.index === entry.line);
  if (!line) return {};
  const amount = BigInt(entry.amount);
  const principal = resolved?.principalBase ?? amount;
  return {
    counterpartyName: line.creditorName,
    counterpartyAccount: line.creditorAccount.value,
    endToEndId: line.endToEndId,
    ...(line.remittance ? { remittance: line.remittance } : {}),
    ...(principal < amount ? { principalMinor6: principal, feeMinor6: amount - principal } : {}),
  };
}

/**
 * Builds a statement from nothing but the contract's ledger, plus names kept
 * off chain. The balances come straight from the ledger's running balance.
 */
export function buildStatement(context: StatementContext): StatementInput {
  const { ledger, from, to } = context;
  const before = ledger.filter((entry) => dateOf(entry.ts) < from);
  const within = ledger.filter((entry) => {
    const date = dateOf(entry.ts);
    return date >= from && date <= to;
  });

  const lastBefore = before.at(-1);
  const openingBalance = lastBefore ? BigInt(lastBefore.balance_after) : 0n;
  const lastWithin = within.at(-1);
  const closingBalance = lastWithin ? BigInt(lastWithin.balance_after) : openingBalance;

  const entries: StatementEntry[] = within.map((entry) => {
    const txHash = context.txHashOf(entry.seq);
    const described = entry.kind === 'Debit' ? describeDebit(entry, context) : {};
    return {
      seq: entry.seq,
      bookedAt: toIso(entry.ts),
      direction: entry.kind === 'Debit' ? 'debit' : 'credit',
      amountMinor6: BigInt(entry.amount),
      reference: entry.reference.slice(0, 64) || `LEDGER-${entry.seq}`,
      ...(txHash ? { txHash } : {}),
      ...(entry.kind === 'Credit' && entry.reference
        ? { remittance: entry.reference, counterpartyName: 'Incoming transfer' }
        : {}),
      ...described,
    };
  });

  // Everything here derives from the ledger, including the id and the date, so
  // rebuilding a statement gives identical bytes and its hash can be checked.
  const lastSeq = lastWithin?.seq ?? lastBefore?.seq;
  const compact = (date: string): string => date.replace(/-/g, '');
  return {
    statementId: `STMT-${compact(from)}-${compact(to)}-S${lastSeq ?? 'NONE'}`,
    createdAt: lastWithin ? toIso(lastWithin.ts) : `${to}T00:00:00Z`,
    accountId: context.accountId,
    accountName: 'USDC on NEAR',
    ownerName: context.ownerName,
    currency: 'USD',
    periodFrom: from,
    periodTo: to,
    openingBalance,
    closingBalance,
    entries,
  };
}

// ---------- Tie-out ----------

export interface TieOut {
  ledgerBalance: string;
  tokenBalance: string;
  difference: string;
  ties: boolean;
  /** The ledger's own arithmetic, entry by entry. */
  ledgerFoots: boolean;
  entries: number;
}

/** Rewalks every entry and compares the result with the token contract. */
export function tieOut(ledger: LedgerEntry[], ledgerBalance: bigint, tokenBalance: bigint): TieOut {
  let running = 0n;
  let foots = true;
  for (const entry of ledger) {
    running += entry.kind === 'Credit' ? BigInt(entry.amount) : -BigInt(entry.amount);
    if (running !== BigInt(entry.balance_after)) foots = false;
  }
  if (running !== ledgerBalance) foots = false;
  return {
    ledgerBalance: ledgerBalance.toString(),
    tokenBalance: tokenBalance.toString(),
    difference: (tokenBalance - ledgerBalance).toString(),
    ties: tokenBalance === ledgerBalance,
    ledgerFoots: foots,
    entries: ledger.length,
  };
}

// ---------- Display ----------

export const usd = (base: bigint | string): string => {
  const value = typeof base === 'string' ? BigInt(base) : base;
  return formatCents((value + 5_000n) / 10_000n);
};
