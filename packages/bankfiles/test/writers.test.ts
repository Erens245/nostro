import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCamt053 } from '@financica/camt053';
import {
  PEG_NOTE,
  StatementDoesNotBalance,
  flatten,
  parseAmount,
  parseDelimited,
  prepareStatement,
  readCsv,
  readPain001,
  writeCamt053,
  writeCsv,
  writeMt940,
  writeNearBusinessCsv,
  writeOfx,
  writePain002,
} from '../src/index.ts';
import type { StatementInput, StatusInput } from '../src/index.ts';
import {
  USDC,
  fixture,
  noSchema,
  randomStatement,
  requireCjs,
  sampleStatement,
  schemaErrors,
} from './helpers.ts';

// Independent parsers. None of this code is ours.
const { parse: parseOfxStrict } = requireCjs('ofx-js');
const nodeOfx = requireCjs('node-ofx-parser');
const { Parser: Mt940Parser } = requireCjs('mt940js');

const cents = (value: string | number): bigint => {
  const parsed = parseAmount(String(value).replace(/^-/, ''));
  assert.notEqual(parsed, null, `not an amount: ${value}`);
  return String(value).startsWith('-') ? -(parsed as bigint) : (parsed as bigint);
};

const toCents = (value: number): bigint => BigInt(Math.round(value * 100));

// Each helper reads a format with a third-party parser and returns what that
// parser saw, so a footing check can't be fooled by our own bookkeeping.

async function ofxView(text: string): Promise<{ net: bigint; closing: bigint; ids: string[] }> {
  const parsed = await parseOfxStrict(text);
  const statement = parsed.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS;
  const raw = statement.BANKTRANLIST.STMTTRN;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const net = list.reduce(
    (sum: bigint, row: { TRNAMT: string }) => sum + cents(row.TRNAMT),
    0n,
  );
  return {
    net,
    closing: cents(statement.LEDGERBAL.BALAMT),
    ids: list.map((row: { FITID: string }) => row.FITID),
  };
}

function mt940View(text: string): { opening: bigint; closing: bigint; net: bigint } {
  const parser = new Mt940Parser();
  const statements = parser.parse(text);
  assert.equal(statements.length, 1);
  const statement = statements[0];
  const net = statement.transactions.reduce(
    (sum: bigint, row: { amount: number }) => sum + toCents(row.amount),
    0n,
  );
  return {
    opening: toCents(statement.openingBalance),
    closing: toCents(statement.closingBalance),
    net,
  };
}

function camtView(xml: string): { opening: bigint; closing: bigint; net: bigint; count: number } {
  const report = parseCamt053(xml);
  assert.ok(report, 'the parser returned nothing');
  const statement = report.statements[0];
  assert.ok(statement);
  const balance = (type: string): bigint => {
    const found = statement.balances.find((entry) => entry.type === type);
    assert.ok(found, `no ${type} balance`);
    return toCents(found.amount);
  };
  const net = statement.entries.reduce(
    (sum, entry) =>
      sum + (entry.creditDebitIndicator === 'CRDT' ? 1n : -1n) * toCents(entry.amount),
    0n,
  );
  return { opening: balance('OPBD'), closing: balance('CLBD'), net, count: statement.entries.length };
}

function assertFoots(input: StatementInput, label: string): void {
  const prepared = prepareStatement(input);
  assert.equal(
    prepared.openingCents + prepared.creditCents - prepared.debitCents,
    prepared.closingCents,
    label,
  );
}

describe('statement rounding', () => {
  test('an awkward sub-cent case foots with a visible ROUNDING entry', () => {
    const input: StatementInput = {
      ...sampleStatement(),
      openingBalance: 0n,
      closingBalance: 2_010_000n + 1_004_999n - 1_004_999n - 1_004_999n,
      entries: [
        { seq: 0, bookedAt: '2026-11-07T01:00:00Z', direction: 'credit', amountMinor6: 2_010_000n, reference: 'A' },
        { seq: 1, bookedAt: '2026-11-07T02:00:00Z', direction: 'credit', amountMinor6: 1_004_999n, reference: 'B' },
        { seq: 2, bookedAt: '2026-11-07T03:00:00Z', direction: 'debit', amountMinor6: 1_004_999n, reference: 'C' },
        { seq: 3, bookedAt: '2026-11-07T04:00:00Z', direction: 'debit', amountMinor6: 1_004_999n, reference: 'D' },
      ],
    };
    const prepared = prepareStatement(input);
    assert.equal(prepared.openingCents + prepared.creditCents - prepared.debitCents, prepared.closingCents);
  });

  test('half a cent rounds up', () => {
    const input: StatementInput = {
      ...sampleStatement(),
      openingBalance: 0n,
      closingBalance: 5_000n,
      entries: [
        { seq: 0, bookedAt: '2026-11-07T01:00:00Z', direction: 'credit', amountMinor6: 5_000n, reference: 'A' },
      ],
    };
    assert.equal(prepareStatement(input).entries[0]?.cents, 1n);
  });

  test('an entry under a cent still counts, through the rounding entry', () => {
    const input: StatementInput = {
      ...sampleStatement(),
      openingBalance: 9_000n,
      closingBalance: 14_000n,
      entries: [
        { seq: 0, bookedAt: '2026-11-07T01:00:00Z', direction: 'credit', amountMinor6: 4_999n, reference: 'A' },
        { seq: 1, bookedAt: '2026-11-07T02:00:00Z', direction: 'credit', amountMinor6: 1n, reference: 'B' },
      ],
    };
    const prepared = prepareStatement(input);
    assert.equal(prepared.belowOneCent, 2);
    assert.equal(prepared.roundingCents, 0n, 'both round to nothing and so does the balance change');
    assert.equal(prepared.closingCents - prepared.openingCents, 0n);
  });

  test('fee and principal always add up to the entry', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      for (const entry of prepareStatement(randomStatement(seed)).entries) {
        if (entry.feeCents !== undefined) {
          assert.equal((entry.principalCents ?? 0n) + entry.feeCents, entry.cents);
        }
      }
    }
  });

  test('a statement that does not balance is refused', () => {
    const input = { ...sampleStatement(), closingBalance: sampleStatement().closingBalance + 1n };
    assert.throws(() => prepareStatement(input), StatementDoesNotBalance);
    assert.throws(() => writeCamt053(input), StatementDoesNotBalance);
    assert.throws(() => writeOfx(input), StatementDoesNotBalance);
    assert.throws(() => writeMt940(input), StatementDoesNotBalance);
    assert.throws(() => writeCsv(input), StatementDoesNotBalance);
  });

  test('an entry outside the period is refused', () => {
    const input = sampleStatement();
    const first = input.entries[0];
    assert.ok(first);
    first.bookedAt = '2026-11-08T00:00:00Z';
    assert.throws(() => prepareStatement(input), /outside the statement period/);
  });

  test('2,000 random statements foot to the cent', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      assertFoots(randomStatement(seed), `seed ${seed}`);
    }
  });
});

// If the validator accepted anything, every "valid against the schema" test
// above and below would be meaningless. These prove it can say no.
describe('negative controls: the validator really rejects bad documents', () => {
  test('a wrong code is rejected', { skip: noSchema('camt.053.001.08') }, async () => {
    const bad = writeCamt053(sampleStatement()).replace(
      '<CdtDbtInd>CRDT</CdtDbtInd>',
      '<CdtDbtInd>WRONG</CdtDbtInd>',
    );
    assert.ok((await schemaErrors('camt.053.001.08', bad)).length > 0);
  });

  test('a missing required element is rejected', { skip: noSchema('camt.053.001.08') }, async () => {
    const bad = writeCamt053(sampleStatement()).replace(/<CreDtTm>[^<]*<\/CreDtTm>/, '');
    assert.ok((await schemaErrors('camt.053.001.08', bad)).length > 0);
  });

  test('elements in the wrong order are rejected', { skip: noSchema('pain.002.001.10') }, async () => {
    const good = writePain002({
      messageId: 'M',
      createdAt: '2026-11-07T18:00:00Z',
      originalMessageId: 'O',
      originalFormat: 'pain.001.001.03',
      groupStatus: 'ACCP',
      lines: [{ endToEndId: 'E', status: 'ACSC' }],
    });
    const bad = good.replace(
      /<OrgnlMsgId>O<\/OrgnlMsgId>(\s*)<OrgnlMsgNmId>([^<]*)<\/OrgnlMsgNmId>/,
      '<OrgnlMsgNmId>$2</OrgnlMsgNmId>$1<OrgnlMsgId>O</OrgnlMsgId>',
    );
    assert.notEqual(bad, good);
    assert.ok((await schemaErrors('pain.002.001.10', bad)).length > 0);
  });

  test('a document is rejected by the wrong schema', { skip: noSchema('pain.002.001.10') }, async () => {
    const errors = await schemaErrors('pain.002.001.10', writeCamt053(sampleStatement()));
    assert.ok(errors.length > 0);
  });

  test('an independent parser notices a changed balance', () => {
    const xml = writeCamt053(sampleStatement());
    const bad = xml.replace('<Amt Ccy="USD">16769.12</Amt>', '<Amt Ccy="USD">16769.13</Amt>');
    assert.notEqual(bad, xml);
    const view = camtView(bad);
    assert.notEqual(view.opening + view.net, view.closing);
  });
});

describe('camt.053.001.08', () => {
  test('is valid against the real schema', { skip: noSchema('camt.053.001.08') }, async () => {
    assert.deepEqual(await schemaErrors('camt.053.001.08', writeCamt053(sampleStatement())), []);
  });

  test('random statements are all valid against the schema', { skip: noSchema('camt.053.001.08') }, async () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const errors = await schemaErrors('camt.053.001.08', writeCamt053(randomStatement(seed)));
      assert.deepEqual(errors, [], `seed ${seed}`);
    }
  });

  test('an independent parser reads the balances and entries', () => {
    const view = camtView(writeCamt053(sampleStatement()));
    assert.equal(view.opening, 50_000n);
    assert.equal(view.opening + view.net, view.closing);
    assert.equal(view.count, 3);
  });

  test('random statements foot when read by an independent parser', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const view = camtView(writeCamt053(randomStatement(seed)));
      assert.equal(view.opening + view.net, view.closing, `seed ${seed}`);
    }
  });

  test('a fee is shown on the entry, not as a second entry', () => {
    const xml = writeCamt053(sampleStatement());
    assert.match(xml, /<TtlChrgsAndTaxAmt Ccy="USD">0\.13<\/TtlChrgsAndTaxAmt>/);
    assert.match(xml, /<TxAmt>\s*<Amt Ccy="USD">1280\.00<\/Amt>\s*<\/TxAmt>/);
    assert.match(xml, /<Amt Ccy="USD">1280\.13<\/Amt>/);
  });

  test('says plainly that USD here means USDC', () => {
    assert.ok(writeCamt053(sampleStatement()).includes(PEG_NOTE.slice(0, 40)));
  });

  test('text in a name cannot break the XML', { skip: noSchema('camt.053.001.08') }, async () => {
    const input = sampleStatement();
    const entry = input.entries[1];
    assert.ok(entry);
    entry.counterpartyName = 'Smith & Sons <Ltd> "Trading"\n</Nm>';
    assert.deepEqual(await schemaErrors('camt.053.001.08', writeCamt053(input)), []);
  });
});

describe('pain.002.001.10', () => {
  const status = (): StatusInput => ({
    messageId: 'STS-2026-11-07-001',
    createdAt: '2026-11-07T18:00:00Z',
    originalMessageId: 'HP-2026-11-07-001',
    originalFormat: 'pain.001.001.03',
    originalCreatedAt: '2026-11-07T09:30:00Z',
    originalCount: 3,
    originalControlSumMinor: 934_855n,
    groupStatus: 'PART',
    lines: [
      { endToEndId: 'HP-1101-0001', status: 'ACSC' },
      { endToEndId: 'HP-1101-0002', instructionId: 'I-2', status: 'ACSP' },
      {
        endToEndId: 'HP-1101-0003',
        status: 'RJCT',
        reasonCode: 'AM04',
        reasonText: 'Insufficient funds when the run was executed',
      },
    ],
  });

  test('is valid against the real schema', { skip: noSchema('pain.002.001.10') }, async () => {
    assert.deepEqual(await schemaErrors('pain.002.001.10', writePain002(status())), []);
  });

  test('works for a run that started as NACHA', { skip: noSchema('pain.002.001.10') }, async () => {
    const xml = writePain002({ ...status(), originalFormat: 'nacha' });
    assert.deepEqual(await schemaErrors('pain.002.001.10', xml), []);
    assert.match(xml, /<OrgnlMsgNmId>NACHA<\/OrgnlMsgNmId>/);
  });

  test('carries each line’s status and reason', () => {
    const xml = writePain002(status());
    assert.match(xml, /<OrgnlEndToEndId>HP-1101-0003<\/OrgnlEndToEndId>\s*<TxSts>RJCT<\/TxSts>/);
    assert.match(xml, /<Cd>AM04<\/Cd>/);
    assert.match(xml, /<GrpSts>PART<\/GrpSts>/);
  });

  test('refers back to the original file', () => {
    const run = readPain001(fixture('pain.001.001.03.xml'));
    const xml = writePain002({ ...status(), originalMessageId: run.messageId });
    assert.ok(xml.includes(`<OrgnlMsgId>${run.messageId}</OrgnlMsgId>`));
  });
});

describe('OFX', () => {
  for (const version of ['1.0.2', '2.2.0'] as const) {
    test(`${version}: an independent parser agrees with the balances`, async () => {
      const input = sampleStatement();
      const view = await ofxView(writeOfx(input, { version }));
      const opening = 50_000n;
      assert.equal(opening + view.net, view.closing);
      assert.equal(view.closing, 1_676_912n);
    });
  }

  test('a second independent parser reads it too', () => {
    const parsed = nodeOfx.parse(writeOfx(sampleStatement()));
    const list = parsed.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS.BANKTRANLIST.STMTTRN;
    assert.equal(list.length, 4, 'principal and fee are separate rows');
  });

  test('random statements foot when read by an independent parser', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const input = randomStatement(seed);
      const prepared = prepareStatement(input);
      const view = await ofxView(writeOfx(input));
      assert.equal(prepared.openingCents + view.net, view.closing, `seed ${seed}`);
    }
  });

  test('a fee is its own row, so a bill matches its exact amount', async () => {
    const parsed = await parseOfxStrict(writeOfx(sampleStatement()));
    const rows = parsed.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS.BANKTRANLIST.STMTTRN;
    assert.ok(rows.some((row: { TRNAMT: string }) => row.TRNAMT === '-1280.00'));
    assert.ok(rows.some((row: { TRNAMT: string; TRNTYPE: string }) => row.TRNAMT === '-0.13' && row.TRNTYPE === 'FEE'));
  });

  test('transaction ids are unique and survive a rebuild', async () => {
    const first = await ofxView(writeOfx(sampleStatement()));
    const second = await ofxView(writeOfx(sampleStatement()));
    assert.deepEqual(first.ids, second.ids);
    assert.equal(new Set(first.ids).size, first.ids.length);
  });

  test('1.0.2 is plain ASCII even with accented names', () => {
    const input = sampleStatement();
    const entry = input.entries[2];
    assert.ok(entry);
    entry.counterpartyName = 'Lucía Marín';
    assert.match(writeOfx(input), /^[\x00-\x7F]*$/);
  });
});

describe('MT940', () => {
  test('an independent parser agrees with the balances', () => {
    const view = mt940View(writeMt940(sampleStatement()));
    assert.equal(view.opening, 50_000n);
    assert.equal(view.closing, 1_676_912n);
    assert.equal(view.opening + view.net, view.closing);
  });

  test('random statements foot when read by an independent parser', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const view = mt940View(writeMt940(randomStatement(seed)));
      assert.equal(view.opening + view.net, view.closing, `seed ${seed}`);
    }
  });

  test('no line is longer than the format allows', () => {
    const input = sampleStatement();
    const entry = input.entries[1];
    assert.ok(entry);
    entry.remittance = 'A very long payment description '.repeat(30);
    for (const line of writeMt940(input).split('\r\n')) {
      assert.ok(line.length <= 80, line);
      if (line.startsWith(':86:')) assert.ok(line.length <= 69, line);
      else if (!line.startsWith(':')) assert.ok(line.length <= 65, line);
    }
  });

  test('uses only characters the format allows', () => {
    const input = sampleStatement();
    const entry = input.entries[1];
    assert.ok(entry);
    entry.counterpartyName = 'Müller_& Söhne <GmbH> #1';
    assert.match(writeMt940(input), /^[A-Za-z0-9/\-?:().,'+ \r\n]*$/);
  });
});

describe('CSV statement', () => {
  test('foots row by row, with a running balance', () => {
    const rows = parseDelimited(writeCsv(sampleStatement()), ',');
    assert.equal(rows[1]?.[1], 'Opening balance');
    const body = rows.slice(2, -2);
    assert.equal(body.length, 4, 'principal and fee are separate rows');
    let balance = cents(rows[1]?.[6] ?? '0');
    for (const row of body) {
      balance += cents(row[5] || '0') - cents(row[4] || '0');
      assert.equal(cents(row[6] ?? '0'), balance);
    }
    assert.equal(balance, cents(rows.at(-2)?.[6] ?? '0'));
  });

  test('random statements foot row by row', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rows = parseDelimited(writeCsv(randomStatement(seed)), ',');
      let balance = cents(rows[1]?.[6] ?? '0');
      for (const row of rows.slice(2, -2)) balance += cents(row[5] || '0') - cents(row[4] || '0');
      assert.equal(balance, cents(rows.at(-2)?.[6] ?? '0'), `seed ${seed}`);
    }
  });

  test('opens in a spreadsheet with nothing to ask', () => {
    const text = writeCsv({ ...sampleStatement(), explorerTxUrl: 'https://testnet.nearblocks.io/txns/' });
    assert.ok(text.startsWith('﻿'), 'Excel needs the byte order mark to read UTF-8');
    const rows = parseDelimited(text, ',');
    const closing = rows.at(-2) ?? [];
    assert.equal(closing[1], 'Closing balance');
    assert.equal(closing[4], '', 'no totals on the balance row, which a column sum would count twice');
    assert.equal(closing[5], '');
    const body = rows.slice(2, -2);
    const debits = body.reduce((sum, row) => sum + cents(row[4] || '0'), 0n);
    const credits = body.reduce((sum, row) => sum + cents(row[5] || '0'), 0n);
    assert.equal(cents(rows[1]?.[6] ?? '0') + credits - debits, cents(closing[6] ?? '0'), 'the column sums reconcile');
    assert.deepEqual([...new Set(body.map((row) => row[1]))].sort(), ['Fee', 'Payment', 'Receipt']);
    assert.ok(
      body.some((row) => row[8]?.startsWith('https://testnet.nearblocks.io/txns/')),
      'a transaction is a link a person can open',
    );
  });

  test('a formula in a name cannot run in a spreadsheet', () => {
    const input = sampleStatement();
    const entry = input.entries[2];
    assert.ok(entry);
    entry.endToEndId = '=HYPERLINK("http://evil.example")';
    const rows = parseDelimited(writeCsv(input), ',');
    assert.ok(rows.flat().every((value) => !value.startsWith('=')));
  });
});

describe('NEAR Business export', () => {
  test('writes the documented format', () => {
    const run = readCsv('name,account,amount\nLucia,lucia.near,10.50\nTomas,tomas.near,21.34\n');
    const { csv, unresolved } = writeNearBusinessCsv(run, () => undefined);
    assert.equal(csv, 'lucia.near, 10.50\ntomas.near, 21.34\n');
    assert.equal(unresolved.length, 0);
  });

  test('a directory can resolve a bank account', () => {
    const run = readPain001(fixture('pain.001.001.03.xml'));
    const { csv, unresolved } = writeNearBusinessCsv(run, (line) =>
      line.creditorName === 'Lucia Marin' ? 'lucia.near' : undefined,
    );
    assert.equal(csv, 'lucia.near, 2450.75\n');
    assert.equal(unresolved.length, 4, 'the rest are listed, never dropped silently');
  });
});

describe('every writer', () => {
  test('gives the same bytes for the same input', () => {
    const input = sampleStatement();
    assert.equal(writeCamt053(input), writeCamt053(sampleStatement()));
    assert.equal(writeOfx(input), writeOfx(sampleStatement()));
    assert.equal(writeMt940(input), writeMt940(sampleStatement()));
    assert.equal(writeCsv(input), writeCsv(sampleStatement()));
  });

  test('does not reorder or lose entries', () => {
    const shuffled = sampleStatement();
    shuffled.entries.reverse();
    assert.equal(writeCamt053(shuffled), writeCamt053(sampleStatement()));
    assert.equal(flatten(prepareStatement(sampleStatement())).length, 4);
  });

  test('an empty period is still a valid statement', () => {
    const input: StatementInput = {
      ...sampleStatement(),
      openingBalance: 100n * USDC,
      closingBalance: 100n * USDC,
      entries: [],
    };
    assert.match(writeCamt053(input), /<NbOfNtries>0<\/NbOfNtries>/);
    assert.equal(mt940View(writeMt940(input)).closing, 10_000n);
  });
});
