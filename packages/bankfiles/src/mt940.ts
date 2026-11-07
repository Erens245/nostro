// Writes a SWIFT MT940 statement, the older format many ERPs and banks still
// use. It has strict field lengths, a limited character set and a comma as the
// decimal mark, so everything is cut down to fit.

import { formatCents } from './money.ts';
import { flatten, prepareStatement } from './statement.ts';
import type { FlatRow } from './statement.ts';
import type { StatementInput } from './types.ts';
import { cleanText } from './xml.ts';

const MAX_LINE = 65;
const MAX_NARRATIVE_LINES = 6;

/** The SWIFT "x" character set. Anything else becomes a hyphen or is dropped. */
function swiftText(value: string): string {
  return cleanText(value)
    .replace(/[_@#&=!*;<>[\]{}"\\|~^`$%]/g, '-')
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, '');
}

const shortDate = (date: string): string => date.replace(/-/g, '').slice(2);
const monthDay = (date: string): string => date.replace(/-/g, '').slice(4);
const swiftAmount = (cents: bigint): string => formatCents(cents).replace('.', ',');

function balance(tag: string, cents: bigint, date: string, currency: string): string {
  const mark = cents < 0n ? 'D' : 'C';
  const size = cents < 0n ? -cents : cents;
  return `:${tag}:${mark}${shortDate(date)}${currency}${swiftAmount(size)}`;
}

function statementLine(row: FlatRow): string {
  const code = row.type === 'fee' ? 'NCHG' : 'NTRF';
  const mark = row.direction === 'credit' ? 'C' : 'D';
  const customer = swiftText(row.endToEndId ?? 'NONREF').replace(/\s/g, '').slice(0, 16) || 'NONREF';
  const bank = swiftText(`N${row.id}`).replace(/\s/g, '').slice(0, 16);
  return `:61:${shortDate(row.date)}${monthDay(row.date)}${mark}${swiftAmount(row.cents)}${code}${customer}//${bank}`;
}

function narrative(row: FlatRow): string[] {
  const text = swiftText(`${row.name} ${row.memo}`).replace(/\s+/g, ' ').trim() || 'PAYMENT';
  const lines: string[] = [];
  for (let i = 0; i < text.length && lines.length < MAX_NARRATIVE_LINES; i += MAX_LINE) {
    lines.push(text.slice(i, i + MAX_LINE));
  }
  const first = lines[0] ?? '';
  // The ":86:" tag uses four of the first line's characters, so re-wrap to fit.
  if (first.length + 4 > MAX_LINE) {
    const rewrapped = [text.slice(0, MAX_LINE - 4)];
    for (
      let i = MAX_LINE - 4;
      i < text.length && rewrapped.length < MAX_NARRATIVE_LINES;
      i += MAX_LINE
    ) {
      rewrapped.push(text.slice(i, i + MAX_LINE));
    }
    return rewrapped;
  }
  return lines;
}

export function writeMt940(input: StatementInput): string {
  const statement = prepareStatement(input);
  const account = swiftText(input.accountId).slice(0, 35);
  const lines: string[] = [
    `:20:${swiftText(input.statementId).replace(/\s/g, '').slice(0, 16)}`,
    `:25:${account}`,
    ':28C:1/1',
    balance('60F', statement.openingCents, input.periodFrom, input.currency),
  ];
  for (const row of flatten(statement)) {
    lines.push(statementLine(row));
    const [first = 'PAYMENT', ...rest] = narrative(row);
    lines.push(`:86:${first}`, ...rest);
  }
  lines.push(balance('62F', statement.closingCents, input.periodTo, input.currency));
  return `${lines.join('\r\n')}\r\n`;
}
