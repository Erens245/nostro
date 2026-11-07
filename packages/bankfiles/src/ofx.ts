// Writes an OFX bank statement, the file type small-business accounting tools
// import. 1.0.2 (SGML) is the default because it is what banks still commonly
// issue, and the widest-accepted choice. 2.2.0 (XML) is available on request.
//
// Importers remember FITIDs to refuse duplicates, so each one comes from the
// ledger sequence and stays the same however many times a statement is rebuilt.
//
// Not yet checked against Xero or QuickBooks themselves. See the README.

import { formatCents } from './money.ts';
import { flatten, prepareStatement } from './statement.ts';
import type { FlatRow, PreparedStatement } from './statement.ts';
import type { StatementInput } from './types.ts';
import { cleanText, clip } from './xml.ts';

export type OfxVersion = '1.0.2' | '2.2.0';

export interface OfxOptions {
  version?: OfxVersion;
}

const timestamp = (iso: string): string => iso.replace(/[-:TZ]/g, '').slice(0, 14);

const dateOnly = (date: string): string => date.replace(/-/g, '');

/** 1.0.2 files declare US-ASCII, so anything outside it becomes a question mark. */
function field(value: string, max: number, ascii: boolean): string {
  const clipped = clip(cleanText(value), max);
  const safe = ascii ? clipped.replace(/[^\x20-\x7E]/g, '?') : clipped;
  return safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function transactionType(row: FlatRow): string {
  if (row.type === 'fee') return 'FEE';
  return row.direction === 'credit' ? 'CREDIT' : 'DEBIT';
}

function buildTags(statement: PreparedStatement, ascii: boolean, close: boolean): string[] {
  const { input } = statement;
  const tag = (name: string, value: string): string =>
    close ? `<${name}>${value}</${name}>` : `<${name}>${value}`;

  const status = ['<STATUS>', tag('CODE', '0'), tag('SEVERITY', 'INFO'), '</STATUS>'];
  const lines: string[] = [
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    ...status,
    tag('DTSERVER', timestamp(input.createdAt)),
    tag('LANGUAGE', 'ENG'),
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    tag('TRNUID', field(input.statementId, 36, true)),
    ...status,
    '<STMTRS>',
    tag('CURDEF', input.currency),
    '<BANKACCTFROM>',
    tag('BANKID', 'NEAR'),
    tag('ACCTID', field(input.accountId, 22, true)),
    tag('ACCTTYPE', 'CHECKING'),
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    tag('DTSTART', `${dateOnly(input.periodFrom)}000000`),
    tag('DTEND', `${dateOnly(input.periodTo)}235959`),
  ];

  for (const row of flatten(statement)) {
    const signed = row.direction === 'credit' ? row.cents : -row.cents;
    const memo = row.memo || row.reference;
    lines.push(
      '<STMTTRN>',
      tag('TRNTYPE', transactionType(row)),
      tag('DTPOSTED', timestamp(row.bookedAt)),
      tag('TRNAMT', formatCents(signed)),
      tag('FITID', field(`NOSTRO-${row.id}`, 32, true)),
      tag('NAME', field(row.name, 32, ascii)),
      tag('MEMO', field(memo, 255, ascii)),
      '</STMTTRN>',
    );
  }

  lines.push(
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    tag('BALAMT', formatCents(statement.closingCents)),
    tag('DTASOF', `${dateOnly(input.periodTo)}235959`),
    '</LEDGERBAL>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  );
  return lines;
}

export function writeOfx(input: StatementInput, options: OfxOptions = {}): string {
  const statement = prepareStatement(input);
  if ((options.version ?? '1.0.2') === '2.2.0') {
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>';
    return `${header}\n${buildTags(statement, false, true).join('\n')}\n`;
  }
  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join('\r\n');
  return header + buildTags(statement, true, false).join('\r\n') + '\r\n';
}
