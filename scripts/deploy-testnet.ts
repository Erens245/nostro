#!/usr/bin/env node
// Sets up a complete Nostro deployment on testnet from one funded account.
// Test tokens have no value. Refuses to run against anything but testnet.
//
//   NOSTRO_FUNDER_ID=you.testnet NOSTRO_FUNDER_KEY=ed25519:... node scripts/deploy-testnet.ts
//
// Staff accounts end up holding only function-call keys, so a stolen clerk key
// can't do anything except what a clerk does. Keys go to .keys/testnet.env,
// which git ignores. Public facts go to deployment.json.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas } from 'near-api-js';
import { readPaymentFile } from '@nostro/bankfiles';
import { repoRoot } from '../apps/server/src/config.ts';
import { payeeKey, routeHash } from '../apps/server/src/domain.ts';
import type { Payee, Route } from '../apps/server/src/domain.ts';

const funderId = process.env['NOSTRO_FUNDER_ID'];
const funderKey = process.env['NOSTRO_FUNDER_KEY'];
if (!funderId || !funderKey) {
  console.error('Set NOSTRO_FUNDER_ID and NOSTRO_FUNDER_KEY to a funded testnet account.');
  process.exit(1);
}
if (!funderId.endsWith('.testnet') && !/^[0-9a-f]{64}$/.test(funderId)) {
  console.error(`${funderId} does not look like a testnet account. Refusing to continue.`);
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: process.env['NOSTRO_RPC_URL'] ?? 'https://test.rpc.fastnear.com' });
const funder = new Account(funderId, provider, funderKey as `ed25519:${string}`);
const USDC = 1_000_000n;
const suffix = randomBytes(3).toString('hex');
const root = `nostro-${suffix}.testnet`;

const wasm = (path: string): Uint8Array => {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    console.error(`${path} is missing. Run: cargo near build non-reproducible-wasm --no-abi`);
    process.exit(1);
  }
  return readFileSync(full);
};
const nostroWasm = wasm('contract/target/near/nostro.wasm');
const usdcWasm = wasm('mock-usdc/target/near/mock_usdc.wasm');

function say(message: string): void {
  console.log(`  ${message}`);
}

/** Creates an account by calling the `testnet` registrar, then returns it. */
async function createRoot(): Promise<{ account: Account; key: KeyPair }> {
  const key = KeyPair.fromRandom('ed25519');
  await funder.signAndSendTransaction({
    receiverId: 'testnet',
    actions: [
      actions.functionCall(
        'create_account',
        { new_account_id: root, new_public_key: key.getPublicKey().toString() },
        teraToGas(100),
        nearToYocto('8.5'),
      ),
    ],
  });
  return { account: new Account(root, provider, key.toString() as `ed25519:${string}`), key };
}

async function sub(parent: Account, name: string, near: `${number}`): Promise<{ id: string; key: KeyPair; account: Account }> {
  const id = `${name}.${parent.accountId}`;
  const key = KeyPair.fromRandom('ed25519');
  await parent.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto(near)),
      actions.addFullAccessKey(key.getPublicKey()),
    ],
  });
  return { id, key, account: new Account(id, provider, key.toString() as `ed25519:${string}`) };
}

/** Swaps a staff member's full key for one that can only call their own methods. */
async function restrict(staff: { account: Account; key: KeyPair }, contractId: string, methods: string[]): Promise<KeyPair> {
  const limited = KeyPair.fromRandom('ed25519');
  await staff.account.signAndSendTransaction({
    receiverId: staff.account.accountId,
    actions: [
      actions.addFunctionCallAccessKey(limited.getPublicKey(), contractId, methods, nearToYocto('0.25')),
      actions.deleteKey(staff.key.getPublicKey()),
    ],
  });
  return limited;
}

console.log(`Deploying Nostro to testnet under ${root}`);
const { account: owner, key: ownerKey } = await createRoot();
say(`root ${root}`);

const usdc = await sub(owner, 'usdc', '2');
const company = await sub(owner, 'acme', '3.5');
const clerk = await sub(owner, 'clerk', '0.1');
const cfo = await sub(owner, 'cfo', '0.1');
const controller = await sub(owner, 'controller', '0.1');
const settler = await sub(owner, 'settler', '0.5');
const relayer = await sub(owner, 'relayer', '0.5');
say('accounts created');

await usdc.account.signAndSendTransaction({
  receiverId: usdc.id,
  actions: [
    actions.deployContract(usdcWasm),
    actions.functionCall('new', {}, teraToGas(30), 0n),
  ],
});
say('test USDC deployed');

const PER_PAYMENT = 10_000n * USDC;
const DAILY = 50_000n * USDC;
await company.account.signAndSendTransaction({
  receiverId: company.id,
  actions: [
    actions.deployContract(nostroWasm),
    actions.functionCall(
      'new',
      {
        owner: root,
        token: usdc.id,
        settlement_target: null,
        required_approvals: 1,
        per_payment_limit: PER_PAYMENT.toString(),
        daily_limit: DAILY.toString(),
        payee_cooloff_minutes: 0,
      },
      teraToGas(30),
      0n,
    ),
  ],
});
say('Nostro contract deployed');

const call = (account: Account, contractId: string, method: string, args: object, deposit = 0n, tgas = 60) =>
  account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args as Record<string, unknown>, teraToGas(tgas), deposit)],
  });

for (const [id, role] of [
  [clerk.id, 'Maker'],
  [cfo.id, 'Checker'],
  [controller.id, 'Checker'],
  [settler.id, 'Settler'],
] as const) {
  await call(owner, company.id, 'set_role', { account_id: id, role, enabled: true }, 1n);
}
say('roles set');

const clerkKey = await restrict(clerk, company.id, ['submit_run', 'register_payee']);
const cfoKey = await restrict(cfo, company.id, ['approve_run', 'reject_run', 'approve_payee']);
const controllerKey = await restrict(controller, company.id, ['approve_run', 'reject_run', 'approve_payee']);
say('staff now hold function-call keys only');

await call(usdc.account, usdc.id, 'mint', { account_id: root, amount: (100_000n * USDC).toString() });
await call(owner, usdc.id, 'ft_transfer_call', {
  receiver_id: company.id,
  amount: (60_000n * USDC).toString(),
  msg: 'FUNDING',
}, 1n, 100);
say('account funded with 60,000 test USDC');

// Each payee in the sample files gets a receiving account and a real-looking
// route. The addresses are random and owned by nobody. They are only ever quoted.
const routes: Route[] = [
  { chain: 'base', asset: 'USDC', address: '0xfdfc645013e76a26014c999b9f57dcfd6a431394' },
  { chain: 'sol', asset: 'USDC', address: 'FSeHn3V6YorPwpLsRirRnrmfeGQJTn4ei32WCUNFeBH3' },
  { chain: 'arb', asset: 'USDC', address: '0x2a5e8f19c1cd3e7a4b6d90e1f3c7ab12de45f608' },
  { chain: 'base', asset: 'USDC', address: '0x7c3ab19d04ef5286a1d7b6e09c42f8e3150da6b7' },
  { chain: 'tron', asset: 'USDT', address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' },
];

const payees: Payee[] = [];
const run = readPaymentFile(readFileSync(join(repoRoot, 'fixtures', 'pain.001.001.03.xml')));
for (const [index, line] of run.lines.entries()) {
  const route = routes[index % routes.length] as Route;
  payees.push({
    key: payeeKey(line.creditorAccount),
    name: line.creditorName,
    account: line.creditorAccount.value,
    route,
    testnetReceiver: `payee${index}.${root}`,
  });
  await sub(owner, `payee${index}`, '0.02');
}
say('payee accounts created');

const dataDir = join(repoRoot, 'data', company.id);
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(dataDir, 'store.json'),
  JSON.stringify({ payees, drafts: [], holds: {}, transactions: {} }, null, 2),
);

const routeHashes = Object.fromEntries(payees.map((payee) => [payee.key, routeHash(payee.route)]));

writeFileSync(
  join(repoRoot, 'deployment.json'),
  `${JSON.stringify(
    {
      network: 'testnet',
      contractId: company.id,
      tokenId: usdc.id,
      owner: root,
      company: 'Harbor and Pine Studio LLC',
      staff: { clerk: clerk.id, cfo: cfo.id, controller: controller.id, settler: settler.id, relayer: relayer.id },
      routeHashes,
      deployedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

mkdirSync(join(repoRoot, '.keys'), { recursive: true });
writeFileSync(
  join(repoRoot, '.keys', 'testnet.env'),
  [
    '# Testnet only. These keys hold no value. Never commit this file.',
    `NOSTRO_OWNER_ID=${root}`,
    `NOSTRO_OWNER_KEY=${ownerKey.toString()}`,
    `NOSTRO_RELAYER_ID=${relayer.id}`,
    `NOSTRO_RELAYER_KEY=${relayer.key.toString()}`,
    `NOSTRO_SETTLER_ID=${settler.id}`,
    `NOSTRO_SETTLER_KEY=${settler.key.toString()}`,
    `NOSTRO_DEMO_CLERK_ID=${clerk.id}`,
    `NOSTRO_DEMO_CLERK_KEY=${clerkKey.toString()}`,
    `NOSTRO_DEMO_CFO_ID=${cfo.id}`,
    `NOSTRO_DEMO_CFO_KEY=${cfoKey.toString()}`,
    `NOSTRO_DEMO_CONTROLLER_ID=${controller.id}`,
    `NOSTRO_DEMO_CONTROLLER_KEY=${controllerKey.toString()}`,
    'NOSTRO_DEMO_KEYS=yes',
    '',
  ].join('\n'),
);

console.log(`\nDone. Contract: ${company.id}`);
console.log('Public details are in deployment.json. Keys are in .keys/testnet.env.');
console.log('Next: node --env-file=.keys/testnet.env scripts/demo-testnet.ts');
