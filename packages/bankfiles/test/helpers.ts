import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateXML } from 'xmllint-wasm';
import type { StatementEntry, StatementInput } from '../src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const requireCjs = createRequire(join(root, 'package.json'));

export const fixture = (name: string): string =>
  readFileSync(join(root, 'fixtures', name), 'utf8');

const schemaFile = (name: string): string => join(root, 'schemas', 'cache', `${name}.xsd`);

/** Tests that need a schema are skipped, visibly, when it isn't available. */
export const noSchema = (name: string): false | string =>
  existsSync(schemaFile(name)) ? false : `schema ${name} is not available`;

export async function schemaErrors(name: string, xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'document.xml', contents: xml }],
    schema: [{ fileName: `${name}.xsd`, contents: readFileSync(schemaFile(name), 'utf8') }],
  });
  return result.valid ? [] : result.errors.map((error) => error.message);
}

export const USDC = 1_000_000n;

export function sampleStatement(): StatementInput {
  return {
    statementId: 'STMT-2026-11-07',
    createdAt: '2026-11-07T18:00:00Z',
    accountId: 'acme.nostro.testnet',
    accountName: 'USDC on NEAR',
    ownerName: 'Harbor and Pine Studio LLC',
    currency: 'USD',
    periodFrom: '2026-11-07',
    periodTo: '2026-11-07',
    openingBalance: 500n * USDC,
    closingBalance: 500n * USDC + 20_000n * USDC - 1_280_130_000n - 2_450_750_000n,
    entries: [
      {
        seq: 0,
        bookedAt: '2026-11-07T09:00:00Z',
        direction: 'credit',
        amountMinor6: 20_000n * USDC,
        counterpartyName: 'Treasury funding',
        counterpartyAccount: 'funding.testnet',
        reference: 'FUNDING',
      },
      {
        seq: 1,
        bookedAt: '2026-11-07T10:00:00Z',
        direction: 'debit',
        amountMinor6: 1_280_130_000n,
        principalMinor6: 1_280_000_000n,
        feeMinor6: 130_000n,
        counterpartyName: 'Brightwater Hosting Ltd',
        counterpartyAccount: 'brightwater.testnet',
        endToEndId: 'HP-1101-0001',
        reference: 'HP-1101-0001',
        remittance: 'INV-4471 Hosting October',
        txHash: '5h884GXBrX5za8cbTorKUGS2vK9dLJGG2zRawwL7eBkD',
      },
      {
        seq: 2,
        bookedAt: '2026-11-07T10:01:00Z',
        direction: 'debit',
        amountMinor6: 2_450_750_000n,
        counterpartyName: 'Lucia Marin',
        counterpartyAccount: 'lucia.testnet',
        endToEndId: 'HP-1101-0002',
        reference: 'HP-1101-0002',
        remittance: 'INV-208 Brand design',
      },
    ],
  };
}

/** A small seeded generator, so a failing random case can be repeated. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random entries with awkward sub-cent amounts, plus some fees. */
export function randomStatement(seed: number): StatementInput {
  const random = seeded(seed);
  const between = (low: number, high: number): number =>
    Math.floor(random() * (high - low + 1)) + low;
  const opening = BigInt(between(0, 2_000_000_000));
  let balance = opening;
  const entries: StatementEntry[] = [];
  const count = between(1, 25);

  for (let seq = 0; seq < count; seq += 1) {
    const size = [between(1, 9_999), between(10_000, 999_999), between(1_000_000, 900_000_000)];
    const amount = BigInt(size[between(0, 2)] ?? 1);
    const credit = balance < amount || random() < 0.4;
    const entry: StatementEntry = {
      seq,
      bookedAt: '2026-11-07T12:00:00Z',
      direction: credit ? 'credit' : 'debit',
      amountMinor6: amount,
      counterpartyName: `Party ${seq}`,
      reference: `REF-${seq}`,
      endToEndId: `E2E-${seq}`,
    };
    if (!credit && random() < 0.4) {
      const fee = BigInt(between(0, Number(amount) - 1));
      entry.feeMinor6 = fee;
      entry.principalMinor6 = amount - fee;
    }
    balance += credit ? amount : -amount;
    entries.push(entry);
  }

  return {
    ...sampleStatement(),
    statementId: `RANDOM-${seed}`,
    openingBalance: opening,
    closingBalance: balance,
    entries,
  };
}
