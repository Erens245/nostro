#!/usr/bin/env node
// Runs the whole story on testnet, through the same API the portal uses, and
// writes the results to proof/ so anyone can check them against the chain.
//
//   node --env-file=.keys/testnet.env scripts/demo-testnet.ts
//
// It also tries the things that must fail, and records that they did.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyType,
  Signature,
  actions,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  teraToGas,
} from 'near-api-js';
import { readPaymentFile } from '@nostro/bankfiles';
import { createApi } from '../apps/server/src/api.ts';
import { NearChain } from '../apps/server/src/chain.ts';
import { loadConfig, repoRoot } from '../apps/server/src/config.ts';
import { payeeKey, routeHash } from '../apps/server/src/domain.ts';
import type { Payee } from '../apps/server/src/domain.ts';
import { OneClickApi } from '../apps/server/src/oneclick.ts';
import { decodeDelegate } from '../apps/server/src/relay.ts';
import { Store } from '../apps/server/src/store.ts';

const config = loadConfig();
if (config.network !== 'testnet') throw new Error('This script is for testnet only.');
if (!config.contractId) throw new Error('No deployment.json. Run scripts/deploy-testnet.ts first.');

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Run with --env-file=.keys/testnet.env`);
  return value;
};

interface Signer {
  accountId: string;
  key: KeyPair;
}
const signer = (prefix: string): Signer => ({
  accountId: env(`NOSTRO_DEMO_${prefix}_ID`),
  key: KeyPair.fromString(env(`NOSTRO_DEMO_${prefix}_KEY`) as `ed25519:${string}`),
});
const clerk = signer('CLERK');
const cfo = signer('CFO');

const chain = new NearChain(config);
const store = new Store(join(config.dataDir, config.contractId));
const handle = createApi({ config, chain, store, oneClick: new OneClickApi(config.oneClickKey) });
const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const provider = new JsonRpcProvider({ url: config.rpcUrl });
const proofDir = join(repoRoot, 'proof');
mkdirSync(proofDir, { recursive: true });

const proof: {
  network: string;
  contractId: string;
  tokenId: string;
  explorer: string;
  steps: { step: string; result: string; tx?: string }[];
  refusals: { attempt: string; refusedWith: string; by: string }[];
  statement?: Record<string, unknown>;
} = {
  network: 'testnet',
  contractId: config.contractId,
  tokenId: config.tokenId,
  explorer: 'https://testnet.nearblocks.io/txns/',
  steps: [],
  refusals: [],
};

function log(step: string, result: string, tx?: string): void {
  proof.steps.push({ step, result, ...(tx ? { tx } : {}) });
  console.log(`OK   ${step}: ${result}${tx ? `  ${tx}` : ''}`);
}

function refused(attempt: string, refusedWith: string, by: string): void {
  proof.refusals.push({ attempt, refusedWith, by });
  console.log(`REFUSED  ${attempt}: ${refusedWith} (${by})`);
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${api}${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

const post = <T>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  json<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });

/** Exactly what the browser does in apps/web/src/sign.ts. */
async function sign(staff: Signer, method: string, args: Record<string, unknown>): Promise<Uint8Array> {
  const publicKey = staff.key.getPublicKey();
  const context = await chain.signContext(staff.accountId, publicKey.toString());
  const delegate = buildDelegateAction({
    senderId: staff.accountId,
    receiverId: config.contractId,
    actions: [actions.functionCall(method, args, teraToGas(120), 0n)],
    nonce: BigInt(context.nonce) + 1n,
    maxBlockHeight: BigInt(context.blockHeight) + 120n,
    publicKey,
  });
  const { signature } = staff.key.sign(createHash('sha256').update(encodeDelegateAction(delegate)).digest());
  return encodeSignedDelegate({
    delegateAction: delegate,
    signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
  } as never);
}

interface RelayReply {
  hash?: string;
  error?: string;
  code?: string;
  events?: { event: string; data: Record<string, unknown> }[];
}

async function relay(staff: Signer, method: string, args: Record<string, unknown>, draftId?: string) {
  const encoded = await sign(staff, method, args);
  return post<RelayReply>('/api/relay', {
    signedDelegate: Buffer.from(encoded).toString('base64'),
    draftId,
  });
}

async function mustRelay(staff: Signer, method: string, args: Record<string, unknown>, draftId?: string) {
  const { status, body } = await relay(staff, method, args, draftId);
  if (status !== 200) throw new Error(`${method} failed: ${body.error ?? status}`);
  return body;
}

const fixture = (name: string): Uint8Array => readFileSync(join(repoRoot, 'fixtures', name));

async function addPayee(payee: Omit<Payee, 'key'>): Promise<void> {
  const { body } = await post<{ key: string; call: { method: string; args: Record<string, unknown> } }>(
    '/api/payees',
    payee,
  );
  await mustRelay(clerk, body.call.method, body.call.args);
  await mustRelay(cfo, 'approve_payee', { payee_key: body.key });
}

async function submit(bytes: Uint8Array, name: string) {
  const { status, body } = await post<{
    draftId: string;
    call: { method: string; args: Record<string, unknown> };
    error?: string;
  }>('/api/drafts', bytes, { 'x-file-name': name });
  if (status !== 201) throw new Error(`Draft failed: ${body.error}`);
  const sent = await mustRelay(clerk, body.call.method, body.call.args, body.draftId);
  const event = sent.events?.find((item) => item.event === 'run_submitted');
  return {
    runId: Number(event?.data['run_id']),
    hash: sent.hash ?? '',
    sha: body.call.args['file_sha256'] as string,
    args: body.call.args,
  };
}

// ---------- Payees ----------

const deployment = JSON.parse(readFileSync(join(repoRoot, 'deployment.json'), 'utf8')) as {
  owner: string;
};
for (const payee of store.payees()) {
  await addPayee(payee);
}
log('Payees registered by the clerk and approved by the director', `${store.payees().length} payees`);

// ---------- A gasless clerk ----------

const clerkBalanceBefore = (await provider.viewAccount({ accountId: clerk.accountId })).amount;

// ---------- The first file ----------

const pain = fixture('pain.001.001.03.xml');
const preview = await post<{ canSubmit: boolean; comparison: { feeUsd: string; wireFeeUsd: number } }>(
  '/api/preview',
  pain,
);
log('Preview priced with live 1Click quotes', `route $${preview.body.comparison.feeUsd}, wires $${preview.body.comparison.wireFeeUsd}`);

const first = await submit(pain, 'pain.001.001.03.xml');
log('Clerk submitted run, relayer paid the gas', `run ${first.runId}`, first.hash);

// ---------- Things that must fail ----------

const sameFile = await post<{ error?: string; canSubmit?: boolean }>('/api/preview', pain);
if (sameFile.body.canSubmit) throw new Error('A duplicate file was allowed through preview.');
refused('Submitting the same file again', 'Preview shows it as already submitted', 'server, from the contract');

const duplicate = await relay(clerk, 'submit_run', first.args);
if (duplicate.status === 200) throw new Error('The contract accepted a duplicate file.');
refused('Sending the same file straight to the contract', duplicate.body.code ?? String(duplicate.body.error), 'contract');

const notApproved = await post<{ error?: string; code?: string }>(`/api/runs/${first.runId}/execute`, {});
if (notApproved.status === 200) throw new Error('An unapproved run was executed.');
refused('Paying before approval', notApproved.body.code ?? String(notApproved.body.error), 'contract');

const wrongHash = await relay(cfo, 'approve_run', { run_id: first.runId, file_sha256: '0'.repeat(64) });
if (wrongHash.status === 200) throw new Error('An approval for the wrong file was accepted.');
refused('Approving a different file than the one submitted', wrongHash.body.code ?? String(wrongHash.body.error), 'contract');

const clerkApproves = await relay(clerk, 'approve_run', { run_id: first.runId, file_sha256: first.sha });
if (clerkApproves.status === 200) throw new Error('A clerk approved a run.');
refused('A clerk approving, through the relayer', String(clerkApproves.body.error), 'relayer');

// The relayer's check is a courtesy. Going around it must fail too.
const relayer = new Account(
  env('NOSTRO_RELAYER_ID'),
  provider,
  env('NOSTRO_RELAYER_KEY') as `ed25519:${string}`,
);
const direct = await sign(clerk, 'approve_run', { run_id: first.runId, file_sha256: first.sha });
try {
  await relayer.relayMetaTransaction(decodeDelegate(direct) as never);
  throw new Error('NOT REFUSED');
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  if (text === 'NOT REFUSED') throw new Error('The chain let a clerk key call approve_run.');
  refused('A clerk approving, going around the relayer', text.slice(0, 120), 'NEAR protocol, the key cannot call that method');
}

// ---------- Approve and pay ----------

const approved = await mustRelay(cfo, 'approve_run', { run_id: first.runId, file_sha256: first.sha });
log('Director approved the exact file', `run ${first.runId}`, approved.hash);

const executed = await post<{ sent: number[]; held: unknown[] }>(`/api/runs/${first.runId}/execute`, {});
log('Payments released', `${executed.body.sent.length} sent, ${executed.body.held.length} held`);

const receiver = store.payees()[1]?.testnetReceiver ?? '';
const received = await chain.tokenBalance(receiver);
log(`${store.payees()[1]?.name} was paid`, `${receiver} holds ${received} token units`);

// ---------- The fraud case ----------

const changed = store.payees()[4];
if (changed) {
  const newRoute = { chain: 'base', asset: 'USDC', address: '0x00000000000000000000000000000000000f4a0d' };
  const { body } = await post<{ call: { method: string; args: Record<string, unknown> } }>('/api/payees', {
    ...changed,
    route: newRoute,
  });
  await mustRelay(clerk, body.call.method, body.call.args);
  const chainPayee = await chain.view<{ approved_by: string | null }>('get_payee', { payee_key: changed.key });
  if (chainPayee.approved_by !== null) throw new Error('A changed payee kept its approval.');
  refused('Paying a payee whose details just changed', 'Approval wiped, line would be held', 'contract');
  await mustRelay(cfo, 'approve_payee', { payee_key: changed.key });
  void routeHash(newRoute);
}

// ---------- A second format ----------

const ach = fixture('payroll.ach');
const achRun = readPaymentFile(ach);
for (const [index, line] of achRun.lines.entries()) {
  const key = payeeKey(line.creditorAccount);
  if (store.findPayee(key)) continue;
  await addPayee({
    name: line.creditorName,
    account: line.creditorAccount.value,
    route: { chain: 'sol', asset: 'USDC', address: 'FSeHn3V6YorPwpLsRirRnrmfeGQJTn4ei32WCUNFeBH3' },
    testnetReceiver: `payee${index}.${deployment.owner}`,
  });
}
const second = await submit(ach, 'payroll.ach');
const secondApproved = await mustRelay(cfo, 'approve_run', { run_id: second.runId, file_sha256: second.sha });
const secondPaid = await post<{ sent: number[] }>(`/api/runs/${second.runId}/execute`, {});
log('A NACHA payroll file took the same path', `${secondPaid.body.sent.length} paid`, secondApproved.hash);

// ---------- Money in ----------

const owner = new Account(
  env('NOSTRO_OWNER_ID'),
  provider,
  env('NOSTRO_OWNER_KEY') as `ed25519:${string}`,
);
await owner.signAndSendTransaction({
  receiverId: config.tokenId,
  actions: [
    actions.functionCall(
      'ft_transfer_call',
      { receiver_id: config.contractId, amount: '1250000000', msg: 'INV-3007 Customer payment' },
      teraToGas(100),
      1n,
    ),
  ],
});
log('A customer payment arrived with its reference', 'INV-3007, 1,250.00');

// ---------- Reports ----------

const today = new Date().toISOString().slice(0, 10);
const download = async (path: string, name: string): Promise<Buffer> => {
  const response = await fetch(`${api}${path}`);
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(join(proofDir, name), bytes);
  return bytes;
};

await download(`/api/runs/${first.runId}/pain002`, 'status-report.pain002.xml');
const query = `from=${today}&to=${today}`;
await download(`/api/statements/download?${query}&format=camt053`, 'statement.camt053.xml');
await download(`/api/statements/download?${query}&format=ofx`, 'statement.ofx');
await download(`/api/statements/download?${query}&format=mt940`, 'statement.sta');
await download(`/api/statements/download?${query}&format=csv`, 'statement.csv');
log('Status report and statements written', 'see proof/');

const anchored = await post<{ hash: string; statementId: string }>('/api/statements/anchor', {
  from: today,
  to: today,
});
log('Statement hash fixed on chain', anchored.body.statementId, anchored.body.hash);

const verification = await json<Record<string, unknown>>(`/api/statements/verify?${query}`);
proof.statement = verification.body;
log('Statement ties to the token balance', JSON.stringify((verification.body as { tie: unknown }).tie));

const clerkBalanceAfter = (await provider.viewAccount({ accountId: clerk.accountId })).amount;
if (clerkBalanceAfter !== clerkBalanceBefore) {
  throw new Error(`The clerk's balance moved from ${clerkBalanceBefore} to ${clerkBalanceAfter}.`);
}
log('The clerk spent no NEAR', `balance stayed at ${clerkBalanceAfter} yoctoNEAR`);

writeFileSync(join(proofDir, 'testnet-run.json'), `${JSON.stringify(proof, null, 2)}\n`);
console.log('\nWrote proof/testnet-run.json');
server.close();
process.exit(0);
