import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyAccount,
  detectFormat,
  hasErrors,
  isNearAccount,
  readCsv,
  readNacha,
  readPain001,
  readPaymentFile,
  routingChecksumOk,
  sha256Hex,
} from '../src/index.ts';
import type { CanonicalRun } from '../src/index.ts';
import { fixture, noSchema, schemaErrors } from './helpers.ts';

const codes = (run: CanonicalRun): string[] => run.issues.map((entry) => entry.code);
const TOTAL = 934_855n;

for (const version of ['pain.001.001.03', 'pain.001.001.09'] as const) {
  describe(`${version} made by the sepa library`, () => {
    const xml = fixture(`${version}.xml`);

    test('the fixture is valid against the real schema', { skip: noSchema(version) }, async () => {
      assert.deepEqual(await schemaErrors(version, xml), []);
    });

    test('reads every payment', () => {
      const run = readPain001(xml);
      assert.equal(run.format, version);
      assert.deepEqual(run.issues, []);
      assert.equal(run.lines.length, 5);
      assert.equal(run.controlSumMinor, TOTAL);
      assert.equal(run.declaredControlSumMinor, TOTAL);
      assert.equal(run.initiatingParty, 'Harbor and Pine Studio LLC');
      assert.equal(run.requestedExecutionDate, '2026-11-09');
      const line = run.lines[1];
      assert.equal(line?.creditorName, 'Lucia Marin');
      assert.equal(line?.amountMinor, 245_075n);
      assert.equal(line?.endToEndId, 'HP-1101-0002');
      assert.equal(line?.remittance, 'INV-208 Brand design');
      assert.deepEqual(line?.creditorAccount, {
        kind: 'IBAN',
        value: 'ES9121000418450200051332',
        routing: 'CAIXESBBXXX',
      });
    });

    test('catches a total that was changed', () => {
      const run = readPain001(xml.replaceAll('<CtrlSum>9348.55</CtrlSum>', '<CtrlSum>9348.56</CtrlSum>'));
      assert.ok(codes(run).includes('CONTROL_SUM_MISMATCH'));
      assert.ok(hasErrors(run));
    });

    test('catches a wrong payment count', () => {
      const run = readPain001(xml.replaceAll('<NbOfTxs>5</NbOfTxs>', '<NbOfTxs>6</NbOfTxs>'));
      assert.ok(codes(run).includes('COUNT_MISMATCH'));
    });

    test('catches a repeated payment id', () => {
      const run = readPain001(xml.replace('HP-1101-0002', 'HP-1101-0001'));
      assert.ok(codes(run).includes('DUPLICATE_END_TO_END_ID'));
    });

    test('refuses other currencies, not converting them', () => {
      const run = readPain001(xml.replaceAll('Ccy="USD"', 'Ccy="EUR"'));
      assert.equal(codes(run).filter((code) => code === 'CURRENCY_NOT_SUPPORTED').length, 5);
    });

    test('refuses a malformed amount', () => {
      const run = readPain001(xml.replace('2450.75', '2450.755'));
      assert.ok(codes(run).includes('INVALID_AMOUNT'));
    });

    test('refuses a zero amount', () => {
      const run = readPain001(xml.replace('>2450.75<', '>0.00<'));
      assert.ok(codes(run).includes('INVALID_AMOUNT'));
    });

    test('NOTPROVIDED gets a stable generated id and a warning', () => {
      const edited = xml.replace('HP-1101-0002', 'NOTPROVIDED');
      const first = readPain001(edited);
      const second = readPain001(edited);
      assert.ok(codes(first).includes('END_TO_END_ID_GENERATED'));
      assert.ok(!hasErrors(first));
      assert.equal(first.lines[1]?.endToEndId, second.lines[1]?.endToEndId);
      assert.notEqual(first.lines[1]?.endToEndId, 'NOTPROVIDED');
    });
  });
}

describe('pain.001 details', () => {
  const xml = fixture('pain.001.001.09.xml');
  const withAccount = (other: string): string =>
    xml.replace('<IBAN>GB29NWBK60161331926819</IBAN>', `<Othr>${other}</Othr>`);

  test('a NEAR account can sit in the account field', () => {
    const run = readPain001(withAccount('<Id>brightwater.near</Id>'));
    assert.equal(run.lines[0]?.creditorAccount.kind, 'NEAR');
    assert.equal(run.lines[0]?.creditorAccount.value, 'brightwater.near');
  });

  test('a scheme of NEAR marks any account as NEAR', () => {
    const run = readPain001(
      withAccount('<Id>a1b2c3</Id><SchmeNm><Prtry>NEAR</Prtry></SchmeNm>'),
    );
    assert.equal(run.lines[0]?.creditorAccount.kind, 'NEAR');
  });

  test('an ordinary other account stays an account', () => {
    const run = readPain001(withAccount('<Id>00123456</Id>'));
    assert.equal(run.lines[0]?.creditorAccount.kind, 'ACCOUNT');
  });

  test('a missing account is reported', () => {
    const run = readPain001(
      xml.replace('<CdtrAcct><Id><IBAN>GB29NWBK60161331926819</IBAN></Id></CdtrAcct>', ''),
    );
    assert.ok(codes(run).includes('MISSING_CREDITOR_ACCOUNT'));
  });

  test('other XML is refused with a reason', () => {
    assert.throws(
      () => readPain001('<Document xmlns="urn:example"><Hello/></Document>'),
      /not a supported payment file/,
    );
  });

  test('entity expansion attacks are refused', () => {
    const attack =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">&lol2;</Document>';
    assert.throws(() => readPain001(attack), /DOCTYPE/);
  });

  test('external entities are refused', () => {
    const attack =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">&xxe;</Document>';
    assert.throws(() => readPain001(attack), /DOCTYPE/);
  });
});

describe('NACHA file made by the nach2 library', () => {
  const ach = fixture('payroll.ach');

  test('reads every entry', () => {
    const run = readNacha(ach);
    assert.deepEqual(run.issues, []);
    assert.equal(run.format, 'nacha');
    assert.equal(run.lines.length, 5);
    assert.equal(run.controlSumMinor, 1_147_690n);
    assert.equal(run.initiatingParty, 'Harbor and Pine');
    const line = run.lines[0];
    assert.equal(line?.creditorName, 'Lucia Marin');
    assert.equal(line?.amountMinor, 245_075n);
    assert.equal(line?.purposeCode, 'SALA');
    assert.equal(line?.creditorAccount.value, '4410020031');
    assert.equal(line?.creditorAccount.routing, '081000210');
  });

  test('next month’s file is not mistaken for this one', () => {
    const header = ach.split(/\r?\n/)[0] ?? '';
    const nextMonth = ach.replace(header, header.replace('A094101', 'B094101'));
    const a = readNacha(ach).lines[0]?.endToEndId;
    const b = readNacha(nextMonth).lines[0]?.endToEndId;
    assert.notEqual(a, b, 'trace numbers restart, so the file stamp must separate them');
    assert.equal(readNacha(ach).lines[0]?.endToEndId, a, 'the same file keeps its ids');
  });

  test('catches an entry amount that was changed', () => {
    const run = readNacha(ach.replace('0000245075', '0000245076'));
    assert.ok(codes(run).includes('CONTROL_SUM_MISMATCH'));
  });

  test('catches a routing number that fails its checksum', () => {
    assert.equal(routingChecksumOk('081000210'), true);
    assert.equal(routingChecksumOk('081000211'), false);
    const run = readNacha(ach.replace('6220810002104410020031', '6220810002114410020031'));
    assert.ok(codes(run).includes('BAD_ROUTING_NUMBER'));
  });

  test('catches a changed routing hash', () => {
    const run = readNacha(ach.replace('6220810002104410020031', '6220910002104410020031'));
    assert.ok(codes(run).includes('ENTRY_HASH_MISMATCH'));
  });

  test('a cut-off file is reported', () => {
    const cut = ach.split(/\r?\n/).slice(0, 5).join('\n');
    assert.ok(codes(readNacha(cut)).includes('TRUNCATED_FILE'));
  });

  test('a line of the wrong length is reported', () => {
    const lines = ach.split(/\r?\n/);
    lines[2] = `${lines[2]}X`;
    assert.ok(codes(readNacha(lines.join('\n'))).includes('BAD_RECORD_LENGTH'));
  });

  test('a balancing debit is ignored with a warning', () => {
    const lines = ach.split(/\r?\n/);
    // Turn the last entry into a debit of the company, as balanced files do.
    lines[6] = `627${(lines[6] ?? '').slice(3)}`;
    const run = readNacha(lines.join('\n'));
    assert.equal(run.lines.length, 4);
    assert.ok(codes(run).includes('OFFSET_DEBIT_IGNORED'));
  });
});

describe('a messy CSV', () => {
  const csv = fixture('messy-export.csv');

  test('reads the payments and skips the totals row', () => {
    const run = readCsv(csv, { company: 'Harbor and Pine', now: new Date('2026-11-07T00:00:00Z') });
    assert.ok(!hasErrors(run), JSON.stringify(run.issues));
    assert.equal(run.lines.length, 3);
    assert.equal(run.controlSumMinor, 683_075n);
    assert.ok(codes(run).includes('ROW_SKIPPED'));
    assert.equal(run.lines[0]?.creditorName, 'Brightwater Hosting; Ltd');
    assert.equal(run.lines[0]?.amountMinor, 128_000n);
    assert.deepEqual(run.lines[0]?.creditorAccount, {
      kind: 'IBAN',
      value: 'GB29NWBK60161331926819',
    });
    assert.equal(run.lines[2]?.creditorAccount.kind, 'NEAR');
    assert.equal(run.lines[2]?.remittance, 'INV-77');
  });

  test('the same bytes give the same ids', () => {
    const a = readCsv(csv);
    const b = readCsv(csv);
    assert.equal(a.messageId, b.messageId);
    assert.deepEqual(
      a.lines.map((line) => line.endToEndId),
      b.lines.map((line) => line.endToEndId),
    );
  });

  test('reports a missing column by name', () => {
    const run = readCsv('Name,Account\nLucia,123\n');
    assert.ok(codes(run).includes('MISSING_COLUMN'));
  });

  test('a mapping can name a column it would not guess', () => {
    const run = readCsv('Who,Where,HowMuch\nLucia,lucia.near,10.50\n', {
      mapping: { name: 'Who', account: 'Where', amount: 'HowMuch' },
    });
    assert.ok(!hasErrors(run));
    assert.equal(run.lines[0]?.amountMinor, 1_050n);
  });

  test('refuses a European-style number instead of guessing', () => {
    const run = readCsv('name;account;amount\nLucia;lucia.near;"1.234,56"\n');
    assert.ok(codes(run).includes('INVALID_AMOUNT'));
  });

  test('refuses negative amounts', () => {
    const run = readCsv('name,account,amount\nLucia,lucia.near,-50\n');
    assert.ok(codes(run).includes('INVALID_AMOUNT'));
  });

  test('refuses other currencies', () => {
    const run = readCsv('name,account,amount,currency\nLucia,lucia.near,50,EUR\n');
    assert.ok(codes(run).includes('CURRENCY_NOT_SUPPORTED'));
  });

  test('catches a payee with no account', () => {
    const run = readCsv('name,account,amount\nLucia,,50\n');
    assert.ok(codes(run).includes('MISSING_CREDITOR_ACCOUNT'));
  });

  test('an empty list is an error', () => {
    assert.ok(codes(readCsv('name,account,amount\n')).includes('EMPTY_FILE'));
  });
});

describe('format detection', () => {
  test('tells the formats apart', () => {
    assert.equal(detectFormat(fixture('pain.001.001.03.xml')), 'pain.001.001.03');
    assert.equal(detectFormat(fixture('pain.001.001.09.xml')), 'pain.001.001.09');
    assert.equal(detectFormat(fixture('payroll.ach')), 'nacha');
    assert.equal(detectFormat(fixture('messy-export.csv')), 'csv');
  });

  test('an unknown file is refused with a useful message', () => {
    assert.equal(detectFormat('hello'), null);
    assert.throws(() => readPaymentFile('hello'), /pain\.001 XML, a NACHA file or a CSV/);
  });

  test('the hash is of the exact bytes', () => {
    const bytes = new TextEncoder().encode(fixture('messy-export.csv'));
    assert.equal(readPaymentFile(bytes).sourceSha256, sha256Hex(bytes));
  });

  test('NEAR account detection', () => {
    assert.ok(isNearAccount('alice.near'));
    assert.ok(isNearAccount('payroll.acme.near'));
    assert.ok(isNearAccount('a-b_c.testnet'));
    assert.ok(!isNearAccount('Alice.near'), 'uppercase is not valid');
    assert.ok(!isNearAccount('alice'));
    assert.ok(!isNearAccount('alice.near.'));
    assert.ok(!isNearAccount('alice..near'));
    assert.ok(!isNearAccount(`${'a'.repeat(62)}.near`), 'over 64 characters');
  });

  test('spaces inside an IBAN are removed', () => {
    assert.deepEqual(classifyAccount('DE89 3704 0044 0532 0130 00'), {
      kind: 'IBAN',
      value: 'DE89370400440532013000',
    });
  });
});
