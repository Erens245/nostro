#!/usr/bin/env node
// Writes a sample statement in every format to a folder, for checking with
// software outside this repo: node scripts/write-sample-statements.ts <folder>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCamt053, writeCsv, writeMt940, writeOfx } from '@nostro/bankfiles';
import type { StatementInput } from '@nostro/bankfiles';

const folder = process.argv[2];
if (!folder) {
  console.error('Give a folder to write to.');
  process.exit(1);
}
mkdirSync(folder, { recursive: true });

const USDC = 1_000_000n;

export const sample: StatementInput = {
  statementId: 'STMT-20261107-20261107-S2',
  createdAt: '2026-11-07T18:00:00Z',
  accountId: 'acme.nostro.testnet',
  accountName: 'USDC on NEAR',
  ownerName: 'Harbor and Pine Studio LLC',
  currency: 'USD',
  periodFrom: '2026-11-07',
  periodTo: '2026-11-07',
  openingBalance: 500n * USDC,
  closingBalance: 16_769_120_000n,
  entries: [
    {
      seq: 0,
      bookedAt: '2026-11-07T09:00:00Z',
      direction: 'credit',
      amountMinor6: 20_000n * USDC,
      counterpartyName: 'Treasury funding',
      counterpartyAccount: 'funding.testnet',
      reference: 'FUNDING',
      remittance: 'FUNDING',
    },
    {
      seq: 1,
      bookedAt: '2026-11-07T10:00:00Z',
      direction: 'debit',
      amountMinor6: 1_280_130_000n,
      principalMinor6: 1_280_000_000n,
      feeMinor6: 130_000n,
      counterpartyName: 'Brightwater Hosting Ltd',
      counterpartyAccount: 'GB29NWBK60161331926819',
      endToEndId: 'HP-1101-0001',
      reference: 'HP-1101-0001',
      remittance: 'INV-4471 Hosting October',
    },
    {
      seq: 2,
      bookedAt: '2026-11-07T10:01:00Z',
      direction: 'debit',
      amountMinor6: 2_450_750_000n,
      counterpartyName: 'Lucia Marin',
      counterpartyAccount: 'ES9121000418450200051332',
      endToEndId: 'HP-1101-0002',
      reference: 'HP-1101-0002',
      remittance: 'INV-208 Brand design',
    },
  ],
};

writeFileSync(join(folder, 'statement.ofx'), writeOfx(sample));
writeFileSync(join(folder, 'statement-220.ofx'), writeOfx(sample, { version: '2.2.0' }));
writeFileSync(join(folder, 'statement.sta'), writeMt940(sample));
writeFileSync(join(folder, 'statement.camt053.xml'), writeCamt053(sample));
writeFileSync(join(folder, 'statement.csv'), writeCsv(sample));
console.log(`Wrote 5 statements to ${folder}`);
