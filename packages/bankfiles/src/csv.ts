// Reads delimited payment lists, the fallback every accounting tool can export.
// No two look alike, so columns are recognized by name and problems are
// reported per row. A CSV has no file id, so the content hash stands in for one.

import { classifyAccount, finishRun, issue } from './checks.ts';
import { parseAmount, sha256Hex } from './money.ts';
import type { CanonicalLine, CanonicalRun, Issue } from './types.ts';

export type CsvField = 'name' | 'account' | 'amount' | 'reference' | 'id' | 'currency' | 'routing';

export interface CsvOptions {
  /** Force a column for a field, by its header text. */
  mapping?: Partial<Record<CsvField, string>>;
  /** Used as the initiating party, since a CSV doesn't say who sent it. */
  company?: string;
  now?: Date;
  sourceSha256?: string;
}

// Order matters: the first alias found in the header row wins.
const ALIASES: Record<CsvField, string[]> = {
  name: [
    'name', 'payee', 'payee name', 'beneficiary', 'beneficiary name', 'creditor', 'creditor name',
    'vendor', 'vendor name', 'supplier', 'supplier name', 'employee', 'employee name',
    'contractor', 'recipient', 'pay to',
  ],
  account: [
    'account', 'account number', 'account no', 'acct', 'acct no', 'iban', 'bank account',
    'near account', 'wallet', 'wallet address', 'address',
  ],
  amount: ['amount', 'amount usd', 'usd', 'net pay', 'net', 'net amount', 'payment', 'pay', 'total', 'value'],
  reference: [
    'reference', 'ref', 'invoice', 'invoice number', 'invoice no', 'memo', 'description',
    'remittance', 'remittance info', 'narrative', 'details', 'note',
  ],
  id: ['id', 'payment id', 'end to end id', 'endtoendid', 'e2e id', 'transaction id', 'bill id'],
  currency: ['currency', 'ccy', 'cur'],
  routing: ['routing', 'routing number', 'aba', 'sort code', 'swift', 'bic'],
};

/** Splits delimited text into rows, honoring quotes and doubled quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(firstLine: string): string {
  const counts = [',', ';', '\t', '|'].map(
    (delimiter) => [delimiter, firstLine.split(delimiter).length - 1] as const,
  );
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

const normalizeHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findColumns(
  headers: string[],
  mapping: CsvOptions['mapping'],
): Partial<Record<CsvField, number>> {
  const normalized = headers.map(normalizeHeader);
  const columns: Partial<Record<CsvField, number>> = {};
  for (const fieldName of Object.keys(ALIASES) as CsvField[]) {
    const forced = mapping?.[fieldName];
    if (forced !== undefined) {
      const index = normalized.indexOf(normalizeHeader(forced));
      if (index >= 0) columns[fieldName] = index;
      continue;
    }
    for (const alias of ALIASES[fieldName]) {
      const index = normalized.indexOf(alias);
      if (index >= 0) {
        columns[fieldName] = index;
        break;
      }
    }
  }
  return columns;
}

/** Accepts $1,234.56 and 1234.5. Refuses 1.234,56 rather than guessing at it. */
function cleanAmount(raw: string): string | null {
  const value = raw.replace(/\$|USD|\s/gi, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(value)) return value.replace(/,/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(value)) return value;
  return null;
}

export function readCsv(text: string, options: CsvOptions = {}): CanonicalRun {
  const source = text.replace(/^﻿/, '');
  const sourceSha256 = options.sourceSha256 ?? sha256Hex(text);
  const short = sourceSha256.slice(0, 12);
  const firstLine = source.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const rows = parseDelimited(source, detectDelimiter(firstLine)).filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  );

  const issues: Issue[] = [];
  const headers = rows[0] ?? [];
  const columns = findColumns(headers, options.mapping);
  for (const required of ['name', 'account', 'amount'] as const) {
    if (columns[required] === undefined) {
      issues.push(
        issue(
          'error',
          'MISSING_COLUMN',
          `No "${required}" column was found. The columns are: ${headers.join(', ') || 'none'}.`,
        ),
      );
    }
  }

  const lines: CanonicalLine[] = [];
  const canRead =
    columns.name !== undefined && columns.account !== undefined && columns.amount !== undefined;

  for (const [position, row] of rows.slice(1).entries()) {
    if (!canRead) break;
    const cell = (name: CsvField): string => {
      const column = columns[name];
      return column === undefined ? '' : (row[column] ?? '').trim();
    };
    const rowNumber = position + 2;
    const name = cell('name');
    const account = cell('account');
    const amountText = cell('amount');

    // Spreadsheet exports often end with a totals row.
    if (!account && (!name || /^(grand\s+)?totals?$/i.test(name))) {
      issues.push(issue('warning', 'ROW_SKIPPED', `Row ${rowNumber} looks like a totals row and was skipped.`));
      continue;
    }

    const index = lines.length;
    const label = `Row ${rowNumber}`;
    const cleaned = cleanAmount(amountText);
    const parsed = cleaned === null ? null : parseAmount(cleaned);
    if (parsed === null || parsed === 0n) {
      issues.push(
        issue('error', 'INVALID_AMOUNT', `${label} has an invalid amount: "${amountText}".`, index),
      );
    }
    const currency = cell('currency');
    if (currency && currency.toUpperCase() !== 'USD') {
      issues.push(
        issue('error', 'CURRENCY_NOT_SUPPORTED', `${label} is in ${currency}. Only USD can be paid.`, index),
      );
    }

    const id = cell('id');
    const routing = cell('routing');
    const reference = cell('reference');
    lines.push({
      index,
      endToEndId: id || `CSV-${short}-${rowNumber}`,
      amountMinor: parsed ?? 0n,
      currency: 'USD',
      creditorName: name,
      creditorAccount: classifyAccount(account, routing || undefined),
      ...(reference ? { remittance: reference } : {}),
    });
  }

  return finishRun({
    format: 'csv',
    messageId: `CSV-${short}`,
    createdAt: (options.now ?? new Date()).toISOString(),
    initiatingParty: options.company ?? 'CSV upload',
    lines,
    issues,
    sourceSha256,
  });
}
