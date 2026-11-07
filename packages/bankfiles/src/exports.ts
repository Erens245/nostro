// Two plain-text exports: a CSV statement an accountant can open without
// asking anything, and the bulk-payment format NEAR Business accepts.

import { formatCents } from './money.ts';
import { PEG_NOTE, flatten, prepareStatement } from './statement.ts';
import type { CanonicalLine, CanonicalRun, StatementInput } from './types.ts';

function cell(value: string): string {
  // A leading = + - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function writeCsv(input: StatementInput): string {
  const statement = prepareStatement(input);
  const rows: string[][] = [
    ['Date', 'Type', 'Description', 'Reference', 'Debit', 'Credit', 'Balance', 'Ledger entry', 'NEAR transaction'],
    [input.periodFrom, 'Opening balance', input.accountName, '', '', '', formatCents(statement.openingCents), '', ''],
  ];
  let running = statement.openingCents;
  for (const row of flatten(statement)) {
    running += row.direction === 'credit' ? row.cents : -row.cents;
    const amount = formatCents(row.cents);
    rows.push([
      row.date,
      row.type,
      [row.name, row.memo].filter(Boolean).join(' - '),
      row.endToEndId ?? row.reference,
      row.direction === 'debit' ? amount : '',
      row.direction === 'credit' ? amount : '',
      formatCents(running),
      row.seq === undefined ? '' : String(row.seq),
      row.txHash ?? '',
    ]);
  }
  rows.push([
    input.periodTo, 'Closing balance', input.accountName, '', formatCents(statement.debitCents),
    formatCents(statement.creditCents), formatCents(statement.closingCents), '', '',
  ]);
  rows.push([input.periodTo, 'Note', PEG_NOTE, '', '', '', '', '', '']);
  return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

export interface NearBusinessExport {
  /** `alice.near, 10.50` per line, as NEAR Business bulk payments expects. */
  csv: string;
  /** Lines with no NEAR account, which must be sorted out by hand. */
  unresolved: CanonicalLine[];
}

/**
 * NEAR Business pays every line of a bulk payment in one token, from a treasury
 * on a private shard, so this suits a sensitive run such as payroll.
 * `resolve` maps a line to its payee's NEAR account.
 */
export function writeNearBusinessCsv(
  run: CanonicalRun,
  resolve: (line: CanonicalLine) => string | undefined,
): NearBusinessExport {
  const rows: string[] = [];
  const unresolved: CanonicalLine[] = [];
  for (const line of run.lines) {
    const account =
      resolve(line) ?? (line.creditorAccount.kind === 'NEAR' ? line.creditorAccount.value : undefined);
    if (account) rows.push(`${account}, ${formatCents(line.amountMinor)}`);
    else unresolved.push(line);
  }
  return { csv: rows.length > 0 ? `${rows.join('\n')}\n` : '', unresolved };
}
