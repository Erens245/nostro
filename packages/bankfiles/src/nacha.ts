// Reads NACHA ACH files, the fixed-width format US payroll and accounting
// systems export. Lines are 94 characters. The first character is the record
// type: 1 file header, 5 batch header, 6 entry, 7 addenda, 8 batch control,
// 9 file control. Positions below are the zero-based start and end of each field.

import { classifyAccount, finishRun, issue } from './checks.ts';
import { sha256Hex } from './money.ts';
import type { CanonicalLine, CanonicalRun, Issue } from './types.ts';

const CREDIT_CODES = new Set(['22', '32']);
const DEBIT_CODES = new Set(['27', '37']);
const PRENOTE_CODES = new Set(['23', '33', '28', '38']);
const HASH_MODULUS = 10_000_000_000n;

const field = (record: string, start: number, end: number): string =>
  record.slice(start, end).trim();

const yymmdd = (value: string): string | undefined => {
  if (!/^\d{6}$/.test(value)) return undefined;
  return `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
};

/** The ABA routing checksum: weights 3, 7, 1 repeating, sum divisible by 10. */
export function routingChecksumOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...routing].reduce((total, digit, i) => total + Number(digit) * (weights[i] ?? 0), 0);
  return sum % 10 === 0;
}

export function readNacha(text: string, sourceSha256?: string): CanonicalRun {
  const records = text
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0)
    .filter((line) => !/^9{94}$/.test(line));

  const issues: Issue[] = [];
  const header = records[0];
  if (!header?.startsWith('1') || header.length !== 94) {
    throw new Error('This is not a NACHA file: the first line must be a 94-character file header.');
  }

  records.forEach((record, position) => {
    if (record.length !== 94) {
      issues.push(
        issue(
          'error',
          'BAD_RECORD_LENGTH',
          `Line ${position + 1} has ${record.length} characters. NACHA lines must have 94.`,
        ),
      );
    }
  });

  const date = field(header, 23, 29);
  const time = field(header, 29, 33);
  const modifier = field(header, 33, 34);
  const originName = field(header, 63, 86);

  const lines: CanonicalLine[] = [];
  let companyName = '';
  let companyId = '';
  let effectiveDate: string | undefined;
  let description = '';
  let batchHash = 0n;
  let batchCredit = 0n;
  let batchDebit = 0n;
  let batchEntries = 0;
  let fileHash = 0n;
  let fileCredit = 0n;
  let fileDebit = 0n;
  let fileEntries = 0;
  let batches = 0;
  let sawFileControl = false;

  for (let i = 1; i < records.length; i += 1) {
    const record = records[i] ?? '';
    switch (record[0]) {
      case '5': {
        batches += 1;
        companyName ||= field(record, 4, 20);
        companyId ||= field(record, 40, 50);
        description = field(record, 53, 63);
        effectiveDate ??= yymmdd(field(record, 69, 75));
        batchHash = 0n;
        batchCredit = 0n;
        batchDebit = 0n;
        batchEntries = 0;
        break;
      }
      case '6': {
        const code = field(record, 1, 3);
        const routing = `${field(record, 3, 11)}${field(record, 11, 12)}`;
        const account = field(record, 12, 29);
        const amount = BigInt(/^\d{10}$/.test(record.slice(29, 39)) ? record.slice(29, 39) : '0');
        const individualId = field(record, 39, 54);
        const name = field(record, 54, 76);
        const hasAddenda = field(record, 78, 79) === '1';
        const trace = field(record, 79, 94);

        batchHash += BigInt(field(record, 3, 11) || '0');
        batchEntries += 1;
        fileHash += BigInt(field(record, 3, 11) || '0');
        fileEntries += 1;

        let addenda: string | undefined;
        if (hasAddenda && records[i + 1]?.startsWith('7')) {
          addenda = field(records[i + 1] ?? '', 3, 83);
          batchEntries += 1;
          fileEntries += 1;
          i += 1;
        }

        if (DEBIT_CODES.has(code)) {
          batchDebit += amount;
          fileDebit += amount;
          issues.push(
            issue(
              'warning',
              'OFFSET_DEBIT_IGNORED',
              `The debit of ${name || 'the company account'} is treated as a balancing entry, not a payment.`,
            ),
          );
          break;
        }
        if (PRENOTE_CODES.has(code)) {
          issues.push(
            issue('warning', 'PRENOTE_SKIPPED', `A zero-dollar test entry for ${name} was skipped.`),
          );
          break;
        }

        const index = lines.length;
        // Trace numbers restart with each file, so a bare trace would make
        // next month's payroll look like a duplicate of this month's. The file
        // stamp keeps an id stable for one file and distinct across files.
        const endToEndId = `${date}${time}${modifier}-${trace}`;
        if (!CREDIT_CODES.has(code)) {
          issues.push(
            issue(
              'error',
              'UNSUPPORTED_ENTRY_CODE',
              `Payment ${index + 1} uses transaction code ${code}, which can't be paid.`,
              index,
            ),
          );
        }
        if (amount === 0n) {
          issues.push(
            issue('error', 'INVALID_AMOUNT', `Payment ${index + 1} has a zero amount.`, index),
          );
        }
        if (!routingChecksumOk(routing)) {
          issues.push(
            issue(
              'error',
              'BAD_ROUTING_NUMBER',
              `Payment ${index + 1} has an invalid routing number: ${routing}.`,
              index,
            ),
          );
        }

        batchCredit += amount;
        fileCredit += amount;
        const purposeCode = /PAYROLL|SALAR/i.test(description) ? 'SALA' : undefined;
        const remittance = addenda || individualId || description;
        lines.push({
          index,
          endToEndId,
          ...(individualId ? { instructionId: individualId } : {}),
          amountMinor: amount,
          currency: 'USD',
          creditorName: name,
          creditorAccount: classifyAccount(account, routing),
          ...(remittance ? { remittance } : {}),
          ...(purposeCode ? { purposeCode } : {}),
        });
        break;
      }
      case '8': {
        const declaredHash = BigInt(field(record, 10, 20) || '0');
        const declaredDebit = BigInt(field(record, 20, 32) || '0');
        const declaredCredit = BigInt(field(record, 32, 44) || '0');
        const declaredCount = Number(field(record, 4, 10));
        if (declaredHash !== batchHash % HASH_MODULUS) {
          issues.push(
            issue('error', 'ENTRY_HASH_MISMATCH', "A batch's routing hash doesn't match its entries."),
          );
        }
        if (declaredCredit !== batchCredit || declaredDebit !== batchDebit) {
          issues.push(
            issue(
              'error',
              'CONTROL_SUM_MISMATCH',
              "A batch's control totals don't match its entries.",
            ),
          );
        }
        if (declaredCount !== batchEntries) {
          issues.push(
            issue('error', 'COUNT_MISMATCH', "A batch's entry count doesn't match its entries."),
          );
        }
        break;
      }
      case '9': {
        sawFileControl = true;
        const declaredBatches = Number(field(record, 1, 7));
        const declaredEntries = Number(field(record, 13, 21));
        const declaredHash = BigInt(field(record, 21, 31) || '0');
        const declaredDebit = BigInt(field(record, 31, 43) || '0');
        const declaredCredit = BigInt(field(record, 43, 55) || '0');
        if (declaredHash !== fileHash % HASH_MODULUS) {
          issues.push(
            issue('error', 'ENTRY_HASH_MISMATCH', "The file's routing hash doesn't match its entries."),
          );
        }
        if (declaredCredit !== fileCredit || declaredDebit !== fileDebit) {
          issues.push(
            issue(
              'error',
              'CONTROL_SUM_MISMATCH',
              "The file's control totals don't match its entries.",
            ),
          );
        }
        if (declaredBatches !== batches || declaredEntries !== fileEntries) {
          issues.push(
            issue('error', 'COUNT_MISMATCH', "The file's counts don't match its contents."),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  if (!sawFileControl) {
    issues.push(
      issue('error', 'TRUNCATED_FILE', 'This file has no file control record, so it may be cut off.'),
    );
  }

  const company = companyName || originName;
  const createdDate = yymmdd(date);
  return finishRun({
    format: 'nacha',
    messageId: `${company}-${date}${time}${modifier}`,
    createdAt: createdDate
      ? `${createdDate}T${time.slice(0, 2) || '00'}:${time.slice(2, 4) || '00'}:00Z`
      : '',
    initiatingParty: company,
    ...(company ? { debtorName: company } : {}),
    ...(companyId ? { debtorAccount: companyId } : {}),
    ...(effectiveDate ? { requestedExecutionDate: effectiveDate } : {}),
    lines,
    issues,
    sourceSha256: sourceSha256 ?? sha256Hex(text),
  });
}
