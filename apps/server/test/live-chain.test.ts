// Reads from real testnet, because a stand-in chain can't catch a wrong call into
// near-api-js, and gasless signing depends on these reads. Read-only, and skipped
// when testnet can't be reached.

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { JsonRpcProvider } from 'near-api-js';
import { NearChain } from '../src/chain.ts';
import type { Config } from '../src/config.ts';

const RPC = 'https://test.rpc.fastnear.com';
// A public test token with a full-access key, used only as something to read.
const ACCOUNT = 'usdc.fakes.testnet';

async function reachable(): Promise<boolean> {
  try {
    const provider = new JsonRpcProvider({ url: RPC });
    await provider.viewBlock({ finality: 'final' });
    return true;
  } catch {
    return false;
  }
}

describe('reading real testnet', async () => {
  const skip = (await reachable()) ? false : 'testnet is not reachable';
  const config: Config = {
    network: 'testnet',
    rpcUrl: RPC,
    contractId: ACCOUNT,
    tokenId: ACCOUNT,
    company: 'x',
    port: 0,
    dataDir: '',
    webDir: '',
    demoKeys: false,
  };
  let chain: NearChain;
  let publicKey = '';

  before(async () => {
    chain = new NearChain(config);
    if (skip) return;
    const provider = new JsonRpcProvider({ url: RPC });
    const { keys } = await provider.viewAccessKeyList({
      accountId: ACCOUNT,
      finalityQuery: { finality: 'final' },
    });
    publicKey = (keys[0] as unknown as { public_key: string }).public_key;
  });

  test('a sign context has a usable nonce and block', { skip }, async () => {
    const context = await chain.signContext(ACCOUNT, publicKey);
    assert.match(context.nonce, /^\d+$/);
    assert.ok(BigInt(context.nonce) > 0n);
    assert.ok(Number(context.blockHeight) > 100_000_000, context.blockHeight);
  });

  test('a contract view returns decoded JSON', { skip }, async () => {
    const metadata = await chain.view<{ decimals: number }>('ft_metadata');
    assert.equal(typeof metadata.decimals, 'number');
  });

  test('a token balance comes back as an integer', { skip }, async () => {
    assert.equal(typeof (await chain.tokenBalance(ACCOUNT)), 'bigint');
  });
});
