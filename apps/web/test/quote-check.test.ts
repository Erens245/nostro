import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routeHash } from '@nostro/bankfiles';
import { checkPayout, verifyQuoteSignature, verifyRoutedLines } from '../src/quote-check.ts';
import type { ExpectedPayout, RoutedLine, RoutedSources, SignedQuote } from '../src/quote-check.ts';

// A real reply from 1Click's status endpoint, signed by 1Click. It came from a
// free firm quote that was never funded, paying a random address.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const reply = JSON.parse(readFileSync(join(root, 'fixtures', '1click-status-sample.json'), 'utf8')) as {
  quoteResponse: SignedQuote;
};
const real = (): SignedQuote => structuredClone(reply.quoteResponse);

const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const RECIPIENT = '0xfdfc645013e76a26014c999b9f57dcfd6a431394';

const expected = (): ExpectedPayout => ({
  depositAddress: real().quote.depositAddress ?? '',
  recipient: RECIPIENT,
  destinationAsset: BASE_USDC,
  minimumOut: 1_000_000n,
  refundTo: 'intents.near',
});

describe('1Click quote signatures', () => {
  test('a genuine quote verifies, so this port matches 1Click', () => {
    assert.equal(verifyQuoteSignature(real()), true);
  });

  test('changing the recipient breaks the signature', () => {
    const quote = real();
    quote.quoteRequest.recipient = '0x00000000000000000000000000000000000f4a0d';
    assert.equal(verifyQuoteSignature(quote), false);
  });

  test('changing the deposit address breaks the signature', () => {
    const quote = real();
    quote.quote.depositAddress = 'a'.repeat(64);
    assert.equal(verifyQuoteSignature(quote), false);
  });

  test('changing the refund account breaks the signature', () => {
    const quote = real();
    quote.quoteRequest.refundTo = 'attacker.near';
    assert.equal(verifyQuoteSignature(quote), false);
  });

  test('a garbage signature is refused, not thrown', () => {
    const quote = real();
    quote.signature = 'ed25519:notasignature';
    assert.equal(verifyQuoteSignature(quote), false);
  });
});

describe('checking a payout against the approved route', () => {
  test('a genuine quote for the right payee passes', () => {
    assert.deepEqual(checkPayout(real(), expected()), []);
  });

  test('a genuine quote paying someone else is caught', () => {
    const problems = checkPayout(real(), { ...expected(), recipient: '0x1111111111111111111111111111111111111111' });
    assert.match(problems.join(), /not the approved address/);
  });

  test('a genuine quote for a different deposit is caught', () => {
    const problems = checkPayout(real(), { ...expected(), depositAddress: 'b'.repeat(64) });
    assert.match(problems.join(), /different deposit address/);
  });

  test('a genuine quote in the wrong token is caught', () => {
    const problems = checkPayout(real(), { ...expected(), destinationAsset: 'nep141:other.near' });
    assert.match(problems.join(), /different token/);
  });

  test('a genuine quote that delivers too little is caught', () => {
    const problems = checkPayout(real(), { ...expected(), minimumOut: 2_000_000n });
    assert.match(problems.join(), /less than the invoice/);
  });

  test('a refund going anywhere but this account is caught', () => {
    const problems = checkPayout(real(), { ...expected(), refundTo: 'acme.near' });
    assert.match(problems.join(), /refund would not come back/);
  });

  test('an unsigned quote fails first and alone', () => {
    const quote = real();
    quote.signature = 'ed25519:abc';
    assert.deepEqual(checkPayout(quote, expected()), ['its quote is not genuinely signed by 1Click']);
  });
});

describe('verifying every line of a run', () => {
  const route = { chain: 'base', asset: 'USDC', address: RECIPIENT };
  const line = (overrides: Partial<RoutedLine> = {}): RoutedLine => ({
    index: 0,
    name: 'Brightwater Hosting Ltd',
    payeeKey: 'k',
    depositAddress: expected().depositAddress,
    route,
    principalBase: 1_000_000n,
    ...overrides,
  });
  const sources = (overrides: Partial<RoutedSources> = {}): RoutedSources => ({
    contractId: 'intents.near',
    approvedRouteHash: async () => routeHash(route),
    status: async () => real(),
    tokens: async () => [{ assetId: BASE_USDC, blockchain: 'base', symbol: 'USDC', decimals: 6 }],
    ...overrides,
  });

  test('a clean run has no findings', async () => {
    assert.deepEqual(await verifyRoutedLines([line()], sources()), []);
  });

  test('a route the server made up is refused', async () => {
    const found = await verifyRoutedLines(
      [line({ route: { ...route, address: '0x2222222222222222222222222222222222222222' } })],
      sources(),
    );
    assert.match(found[0]?.message ?? '', /not the one approved/);
  });

  test('a payee nobody approved is refused', async () => {
    const found = await verifyRoutedLines([line()], sources({ approvedRouteHash: async () => null }));
    assert.match(found[0]?.message ?? '', /not the one approved/);
  });

  test('a line with no route is refused', async () => {
    const found = await verifyRoutedLines([line({ route: null })], sources());
    assert.match(found[0]?.message ?? '', /no approved route/);
  });

  test('a quote that cannot be fetched is refused, not skipped', async () => {
    const found = await verifyRoutedLines(
      [line()],
      sources({
        status: async () => {
          throw new Error('1Click is down');
        },
      }),
    );
    assert.match(found[0]?.message ?? '', /could not be fetched/);
  });

  test('a token 1Click does not list is refused', async () => {
    const found = await verifyRoutedLines([line()], sources({ tokens: async () => [] }));
    assert.match(found[0]?.message ?? '', /not a known token/);
  });

  test('every line is reported, by name', async () => {
    const found = await verifyRoutedLines(
      [line(), line({ index: 1, name: 'Lucia Marin', depositAddress: 'c'.repeat(64) })],
      sources(),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 1);
    assert.match(found[0]?.message ?? '', /Lucia Marin/);
  });
});
