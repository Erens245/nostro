#!/usr/bin/env node
// Runs the real server and portal against a SIMULATED chain, so the screens can
// be tried with no accounts and no network keys. Nothing here touches NEAR.
// Fee quotes are real, from the public 1Click API, with dry: true.
//
//   npm run build && npm run preview

import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { readPaymentFile } from '@nostro/bankfiles';
import { createApi } from '../apps/server/src/api.ts';
import { repoRoot } from '../apps/server/src/config.ts';
import type { Config } from '../apps/server/src/config.ts';
import { payeeKey, routeHash } from '../apps/server/src/domain.ts';
import type { Route } from '../apps/server/src/domain.ts';
import { OneClickApi } from '../apps/server/src/oneclick.ts';
import { Store } from '../apps/server/src/store.ts';
import { FakeChain } from '../apps/server/test/fake-chain.ts';

const port = Number(process.env['PORT'] ?? 8799);
const USDC = 1_000_000n;

const signers = {
  CLERK: 'clerk.testnet',
  CFO: 'cfo.testnet',
} as const;

for (const [role, accountId] of Object.entries(signers)) {
  process.env[`NOSTRO_DEMO_${role}_ID`] = accountId;
  process.env[`NOSTRO_DEMO_${role}_KEY`] = KeyPair.fromRandom('ed25519').toString();
}

const config: Config = {
  network: 'testnet',
  rpcUrl: '',
  contractId: 'acme.simulated.testnet',
  tokenId: 'usdc.simulated.testnet',
  company: 'Harbor and Pine Studio LLC',
  port,
  dataDir: '',
  webDir: join(repoRoot, 'apps', 'web', 'dist'),
  relayer: { accountId: 'relayer.testnet', privateKey: 'unused' },
  settler: { accountId: 'settler.testnet', privateKey: 'unused' },
  demoKeys: true,
};

const chain = new FakeChain();
chain.now = BigInt(Date.now()) * 1_000_000n;
chain.fund(20_000n * USDC);

const store = new Store(mkdtempSync(join(tmpdir(), 'nostro-preview-')));

// Addresses below are random, owned by nobody, and only ever quoted.
const routes: Route[] = [
  { chain: 'base', asset: 'USDC', address: '0xfdfc645013e76a26014c999b9f57dcfd6a431394' },
  { chain: 'sol', asset: 'USDC', address: 'FSeHn3V6YorPwpLsRirRnrmfeGQJTn4ei32WCUNFeBH3' },
  { chain: 'arb', asset: 'USDC', address: '0xfdfc645013e76a26014c999b9f57dcfd6a431394' },
  { chain: 'base', asset: 'USDC', address: '0x2a5e8f19c1cd3e7a4b6d90e1f3c7ab12de45f608' },
  { chain: 'tron', asset: 'USDT', address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' },
];

const run = readPaymentFile(readFileSync(join(repoRoot, 'fixtures', 'pain.001.001.03.xml')));
run.lines.forEach((line, index) => {
  const route = routes[index % routes.length] as Route;
  const key = payeeKey(line.creditorAccount);
  store.savePayee({
    key,
    name: line.creditorName,
    account: line.creditorAccount.value,
    route,
    testnetReceiver: `payee${index}.simulated.testnet`,
  });
  chain.payees.set(key, {
    route_hash: routeHash(route),
    registered_by: signers.CLERK,
    approved_by: signers.CFO,
    active_after: '0',
  });
});

const handle = createApi({ config, chain, store, oneClick: new OneClickApi() });
createServer((req, res) => void handle(req, res)).listen(port, '127.0.0.1', () => {
  console.log(`SIMULATED chain. Portal on http://127.0.0.1:${port}`);
});
