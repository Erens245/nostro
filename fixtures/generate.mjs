#!/usr/bin/env node
// Makes the sample payment files with third-party libraries, so the tests read
// files this project did not write. Nothing here imports our own code.
//
// All names are invented. The IBANs are the standard examples from public IBAN
// documentation, not real accounts. Run: node fixtures/generate.mjs

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'package.json'));
const SEPA = require('sepa');
const nach = require('nach2');

const company = 'Harbor and Pine Studio LLC';

export const PAYEES = [
  { name: 'Brightwater Hosting Ltd', iban: 'GB29NWBK60161331926819', bic: 'NWBKGB2L', amount: 1280.0, memo: 'INV-4471 Hosting October', id: 'HP-1101-0001' },
  { name: 'Lucia Marin', iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX', amount: 2450.75, memo: 'INV-208 Brand design', id: 'HP-1101-0002' },
  { name: 'Tomas Novak', iban: 'CZ6508000000192000145399', bic: 'GIBACZPX', amount: 3100.0, memo: 'INV-77 Backend work', id: 'HP-1101-0003' },
  { name: 'Amina Bello', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', amount: 1875.5, memo: 'INV-1192 Copywriting', id: 'HP-1101-0004' },
  { name: 'Kestrel Freight BV', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A', amount: 642.3, memo: 'INV-5530 Shipping', id: 'HP-1101-0005' },
];

function pain001(version, messageId) {
  const doc = new SEPA.Document(version);
  doc.grpHdr.id = messageId;
  doc.grpHdr.created = new Date('2026-11-07T09:30:00Z');
  doc.grpHdr.initiatorName = company;

  const info = doc.createPaymentInfo();
  info.requestedExecutionDate = new Date('2026-11-09T00:00:00Z');
  info.debtorIBAN = 'FR1420041010050500013M02606';
  info.debtorBIC = 'PSSTFRPPXXX';
  info.debtorName = company;
  doc.addPaymentInfo(info);

  for (const payee of PAYEES) {
    const tx = info.createTransaction();
    tx.creditorName = payee.name;
    tx.creditorIBAN = payee.iban;
    tx.creditorBIC = payee.bic;
    tx.amount = payee.amount;
    tx.currency = 'USD';
    tx.remittanceInfo = payee.memo;
    tx.end2endId = payee.id;
    info.addTransaction(tx);
  }
  return doc.toString();
}

function nacha() {
  // Routing numbers below are public test values that pass the ABA checksum.
  const file = new nach.File({
    immediateDestination: '081000032',
    immediateOrigin: '123456789',
    immediateDestinationName: 'Example Bank',
    immediateOriginName: 'Harbor and Pine',
    referenceCode: '#A000001',
  });
  const batch = new nach.Batch({
    serviceClassCode: '220',
    companyName: 'Harbor and Pine',
    standardEntryClassCode: 'PPD',
    companyIdentification: '123456789',
    companyEntryDescription: 'PAYROLL',
    companyDescriptiveDate: 'NOV 09',
    effectiveEntryDate: nach.Utils.computeBusinessDay(2),
    originatingDFI: '081000032',
  });
  const staff = [
    ['Lucia Marin', '4410020031', 245075],
    ['Tomas Novak', '8820031144', 310000],
    ['Amina Bello', '1130046720', 187550],
    ['Owen Hart', '7740091152', 210025],
    ['Priya Raman', '3360072209', 195040],
  ];
  staff.forEach(([name, account, cents], index) => {
    batch.addEntry(
      new nach.Entry({
        receivingDFI: '081000210',
        DFIAccount: account,
        // nach2 takes dollars and writes cents.
        amount: (cents / 100).toFixed(2),
        idNumber: `EMP-${1000 + index}`,
        individualName: name,
        discretionaryData: 'A1',
        transactionCode: '22',
      }),
    );
  });
  file.addBatch(batch);
  return new Promise((resolve) => file.generateFile(resolve));
}

// A CSV has no standard, so this one is written by hand to look like a messy
// spreadsheet export: semicolons, a BOM, currency symbols and a totals row.
const messyCsv =
  '﻿"Vendor Name";IBAN;"Net Pay";Invoice No;Cur\r\n' +
  '"Brightwater Hosting; Ltd";GB29 NWBK 6016 1331 9268 19;"$1,280.00";INV-4471;USD\r\n' +
  'Lucia Marin;ES9121000418450200051332;$2450.75;INV-208;USD\r\n' +
  'Tomas Novak;tomas-novak.near;3100;INV-77;usd\r\n' +
  ';;;;\r\n' +
  'TOTAL;;"$6,830.75";;\r\n';

writeFileSync(join(here, 'pain.001.001.03.xml'), pain001('pain.001.001.03', 'HP-2026-11-07-001'));
writeFileSync(join(here, 'pain.001.001.09.xml'), pain001('pain.001.001.09', 'HP-2026-11-07-002'));
writeFileSync(join(here, 'payroll.ach'), await nacha());
writeFileSync(join(here, 'messy-export.csv'), messyCsv);
console.log('Wrote 4 fixtures.');
