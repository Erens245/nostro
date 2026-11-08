import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  KeyPair,
  KeyType,
  Signature,
  actions,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  teraToGas,
} from 'near-api-js';
import { readPaymentFile, sha256Hex, writeCamt053 } from '@nostro/bankfiles';
import { createApi } from '../src/api.ts';
import { parseEvents } from '../src/chain.ts';
import type { Config } from '../src/config.ts';
import { repoRoot } from '../src/config.ts';
import {
  buildStatement,
  buildSubmitArgs,
  e2eHash,
  groupStatus,
  lineStatus,
  messageHash,
  payeeKey,
  resolveDirect,
  routeHash,
  tieOut,
} from '../src/domain.ts';
import type { ChainLine, LedgerEntry, Payee, RunDetail } from '../src/domain.ts';
import type { OneClick } from '../src/oneclick.ts';
import { decodeDelegate, inspectDelegate } from '../src/relay.ts';
import { Store } from '../src/store.ts';
import { FakeChain } from './fake-chain.ts';

const CONTRACT = 'acme.nostro.testnet';
const pain = readFileSync(join(repoRoot, 'fixtures', 'pain.001.001.03.xml'));
const USDC = 1_000_000n;

/** A genuinely signed delegate, encoded the way the browser will send it. */
function signDelegate(options: {
  sender?: string;
  receiver?: string;
  method: string;
  args?: Record<string, unknown>;
  deposit?: bigint;
  actionCount?: number;
  transfer?: boolean;
}): Uint8Array {
  const pair = KeyPair.fromRandom('ed25519');
  const call = options.transfer
    ? actions.transfer(1n)
    : actions.functionCall(
        options.method,
        options.args ?? {},
        teraToGas('30'),
        options.deposit ?? 0n,
      );
  const delegate = buildDelegateAction({
    senderId: options.sender ?? 'cfo.testnet',
    receiverId: options.receiver ?? CONTRACT,
    actions: Array.from({ length: options.actionCount ?? 1 }, () => call),
    nonce: 7n,
    maxBlockHeight: 999_999n,
    publicKey: pair.getPublicKey(),
  });
  const { signature } = pair.sign(sha256(encodeDelegateAction(delegate)));
  return encodeSignedDelegate({
    delegateAction: delegate,
    signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
  } as never);
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

describe('the relayer gatekeeper', () => {
  const policy = { contractId: CONTRACT };
  const inspect = (options: Parameters<typeof signDelegate>[0]) =>
    inspectDelegate(decodeDelegate(signDelegate(options)), policy);

  test('decodes a real signed delegate', () => {
    const decoded = decodeDelegate(signDelegate({ method: 'approve_run', args: { run_id: 3 } }));
    assert.equal(decoded.delegateAction.senderId, 'cfo.testnet');
    assert.equal(decoded.delegateAction.receiverId, CONTRACT);
    const call = decoded.delegateAction.actions[0]?.functionCall;
    assert.equal(call?.methodName, 'approve_run');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(call?.args)), { run_id: 3 });
  });

  test('what is relayed is byte for byte what was signed', () => {
    // One changed byte would make the staff member's signature invalid on chain.
    const original = signDelegate({ method: 'approve_run', args: { run_id: 3, file_sha256: 'ab' } });
    const again = encodeSignedDelegate(decodeDelegate(original) as never);
    assert.deepEqual(Buffer.from(again), Buffer.from(original));
  });

  test('allows a staff method', () => {
    const result = inspect({ method: 'approve_run' });
    assert.ok(result.ok);
    assert.equal(result.role, 'Checker');
  });

  test('refuses any other contract, so it cannot be used as free gas', () => {
    const result = inspect({ method: 'approve_run', receiver: 'someone-else.testnet' });
    assert.equal(result.ok, false);
  });

  test('refuses methods staff must not reach', () => {
    for (const method of ['execute_run', 'set_role', 'set_limits', 'anchor_statement', 'mint']) {
      assert.equal(inspect({ method }).ok, false, method);
    }
  });

  test('refuses an attached deposit', () => {
    assert.equal(inspect({ method: 'approve_run', deposit: 1n }).ok, false);
  });

  test('refuses more than one action', () => {
    assert.equal(inspect({ method: 'approve_run', actionCount: 2 }).ok, false);
  });

  test('refuses a plain transfer', () => {
    assert.equal(inspect({ method: 'approve_run', transfer: true }).ok, false);
  });
});

describe('hashes sent to the contract', () => {
  const run = readPaymentFile(pain);
  const line = run.lines[0];
  assert.ok(line);

  test('a payee key ignores spacing and case', () => {
    assert.equal(payeeKey('GB29 NWBK 6016'), payeeKey('gb29nwbk6016'));
  });

  test('a changed route has a different hash', () => {
    const a = routeHash({ chain: 'base', asset: 'USDC', address: '0xaaa' });
    const b = routeHash({ chain: 'base', asset: 'USDC', address: '0xbbb' });
    assert.notEqual(a, b);
  });

  test('a line hash ignores the message id, so a repeat in a new file is caught', () => {
    const other = { ...run, messageId: 'A-DIFFERENT-FILE' };
    assert.equal(e2eHash(run, line), e2eHash(other, line));
    assert.notEqual(messageHash(run), messageHash(other));
  });

  test('two companies can use the same ids', () => {
    const other = { ...run, debtorName: 'Someone Else Ltd' };
    assert.notEqual(e2eHash(run, line), e2eHash(other, line));
  });

  test('all hashes are 64 lowercase hex characters, as the contract requires', () => {
    for (const value of [messageHash(run), e2eHash(run, line), payeeKey(line.creditorAccount)]) {
      assert.match(value, /^[0-9a-f]{64}$/);
    }
  });

  test('cents become six-decimal token units', () => {
    const key = (value: string) => value;
    const { resolved } = resolveDirect(run, (k) => ({
      key: key(k),
      name: 'x',
      account: 'x',
      route: { chain: 'near', asset: 'USDC', address: 'a.testnet' },
      testnetReceiver: 'a.testnet',
    }));
    const args = buildSubmitArgs(run, resolved);
    assert.equal(args.lines[1]?.amount, '2450750000');
    assert.equal(args.total, '9348550000');
    assert.equal(args.file_sha256, run.sourceSha256);
  });
});

describe('status mapping', () => {
  const line = (status: ChainLine['status']): ChainLine => ({
    e2e_hash: '',
    payee_key: '',
    receiver: 'a.testnet',
    amount: '1',
    status,
    settled_at: '0',
  });

  test('follows the table in the spec', () => {
    assert.equal(lineStatus('Submitted', line('Pending')).status, 'PDNG');
    assert.equal(lineStatus('Approved', line('Pending')).status, 'ACCP');
    assert.equal(lineStatus('Executing', line('Sending')).status, 'ACSP');
    assert.equal(lineStatus('Completed', line('Sent')).status, 'ACSC');
    assert.equal(lineStatus('Executing', line('Sent'), undefined, 'PROCESSING').status, 'ACSP');
    assert.equal(lineStatus('Completed', line('Sent'), undefined, 'SUCCESS').status, 'ACSC');
    assert.equal(lineStatus('Completed', line('Sent'), undefined, 'REFUNDED').status, 'RJCT');
    assert.equal(lineStatus('Completed', line('Sent'), undefined, 'INCOMPLETE_DEPOSIT').reasonCode, 'AM09');
    assert.equal(lineStatus('CompletedWithFailures', line('Failed')).status, 'RJCT');
    assert.equal(lineStatus('Rejected', line('Pending')).status, 'RJCT');
  });

  test('a hold explains itself with an ISO reason', () => {
    const result = lineStatus('Executing', line('Pending'), 'insufficient_funds');
    assert.equal(result.status, 'PDNG');
    assert.equal(result.reasonCode, 'AM04');
    assert.equal(lineStatus('Executing', line('Pending'), 'payee_cooloff').reasonCode, 'AC06');
  });

  test('a mixed run reports PART', () => {
    assert.equal(groupStatus(['ACSC', 'RJCT']), 'PART');
    assert.equal(groupStatus(['ACSC', 'ACSC']), 'ACSC');
    assert.equal(groupStatus(['ACSC', 'ACSP']), 'ACSP');
    assert.equal(groupStatus([]), 'PDNG');
  });
});

describe('statements from a ledger', () => {
  const day = (date: string): string =>
    (BigInt(Date.parse(`${date}T12:00:00Z`)) * 1_000_000n).toString();
  const ledger: LedgerEntry[] = [
    { seq: 0, ts: day('2026-11-06'), block: '1', kind: 'Credit', amount: '500000000', balance_after: '500000000', run_id: null, line: null, reference: 'FUNDING' },
    { seq: 1, ts: day('2026-11-07'), block: '2', kind: 'Debit', amount: '100130000', balance_after: '399870000', run_id: 1, line: 0, reference: 'ab' },
    { seq: 2, ts: day('2026-11-08'), block: '3', kind: 'Credit', amount: '50000000', balance_after: '449870000', run_id: null, line: null, reference: 'INV-9' },
  ];
  const run = readPaymentFile(pain);
  const detail: RunDetail = {
    run,
    resolved: [
      { index: 0, payeeKey: 'k', receiver: 'x.near', amountBase: 100_130_000n, principalBase: 100_000_000n },
    ],
  };
  const build = (from: string, to: string) =>
    buildStatement({
      accountId: CONTRACT,
      ownerName: 'Harbor and Pine',
      from,
      to,
      ledger,
      details: () => detail,
      txHashOf: (seq) => `TX${seq}`,
    });

  test('takes opening and closing from the running balance', () => {
    const input = build('2026-11-07', '2026-11-07');
    assert.equal(input.openingBalance, 500_000_000n);
    assert.equal(input.closingBalance, 399_870_000n);
    assert.equal(input.entries.length, 1);
  });

  test('joins names kept off chain to the ledger, and splits out the fee', () => {
    const [entry] = build('2026-11-07', '2026-11-07').entries;
    assert.equal(entry?.counterpartyName, run.lines[0]?.creditorName);
    assert.equal(entry?.feeMinor6, 130_000n);
    assert.equal(entry?.principalMinor6, 100_000_000n);
    assert.equal(entry?.txHash, 'TX1');
  });

  test('keeps a payer’s reference on a credit', () => {
    const [entry] = build('2026-11-08', '2026-11-08').entries;
    assert.equal(entry?.direction, 'credit');
    assert.equal(entry?.remittance, 'INV-9');
  });

  test('an empty period carries the balance through', () => {
    const input = build('2026-11-09', '2026-11-09');
    assert.equal(input.openingBalance, 449_870_000n);
    assert.equal(input.closingBalance, 449_870_000n);
    assert.equal(input.entries.length, 0);
  });

  test('rebuilding gives identical bytes, so a hash can be checked later', () => {
    const a = writeCamt053(build('2026-11-06', '2026-11-08'));
    const b = writeCamt053(build('2026-11-06', '2026-11-08'));
    assert.equal(a, b);
  });

  test('tie-out spots a token balance the ledger cannot explain', () => {
    assert.equal(tieOut(ledger, 449_870_000n, 449_870_000n).ties, true);
    const off = tieOut(ledger, 449_870_000n, 449_870_001n);
    assert.equal(off.ties, false);
    assert.equal(off.difference, '1');
  });

  test('tie-out spots a ledger entry that was altered', () => {
    const edited = ledger.map((entry) =>
      entry.seq === 1 ? { ...entry, amount: '100130001' } : entry,
    );
    assert.equal(tieOut(edited, 449_870_000n, 449_870_000n).ledgerFoots, false);
  });
});

describe('events', () => {
  test('reads our events and ignores everything else', () => {
    const events = parseEvents([
      'not an event',
      'EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{}]}',
      'EVENT_JSON:{"standard":"nostro","version":"1.0.0","event":"run_submitted","data":[{"run_id":4}]}',
      'EVENT_JSON:not json',
    ]);
    assert.deepEqual(events, [{ event: 'run_submitted', data: { run_id: 4 } }]);
  });
});

describe('the API, from file to statement', () => {
  let server: Server;
  let url: string;
  let chain: FakeChain;
  let dir: string;
  let quotes = 0;

  const oneClick: OneClick = {
    async quote(_route, amount) {
      quotes += 1;
      return { amountIn: amount + 200n, minAmountIn: amount + 130_000n, amountOut: amount, etaSeconds: 20 };
    },
    async status() {
      return 'SUCCESS';
    },
  };

  const config: Config = {
    network: 'testnet',
    rpcUrl: '',
    contractId: CONTRACT,
    tokenId: 'usdc.testnet',
    company: 'Harbor and Pine Studio LLC',
    port: 0,
    dataDir: '',
    webDir: join(repoRoot, 'no-such-dir'),
    relayer: { accountId: 'relayer.testnet', privateKey: 'x' },
    settler: { accountId: 'settler.testnet', privateKey: 'x' },
    demoKeys: false,
  };

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body instanceof Uint8Array ? body : JSON.stringify(body),
    });

  const relay = (options: Parameters<typeof signDelegate>[0], draftId?: string) =>
    post('/api/relay', { signedDelegate: base64(signDelegate(options)), draftId });

  async function addPayees(): Promise<void> {
    const run = readPaymentFile(pain);
    for (const line of run.lines) {
      const body: Partial<Payee> = {
        name: line.creditorName,
        account: line.creditorAccount.value,
        route: { chain: 'base', asset: 'USDC', address: '0xabc' },
        testnetReceiver: `payee${line.index}.testnet`,
      };
      const response = await post('/api/payees', body);
      assert.equal(response.status, 201);
      const { call } = (await response.json()) as { call: { method: string; args: { payee_key: string } } };
      assert.equal((await relay({ sender: 'clerk.testnet', method: call.method, args: call.args })).status, 200);
      assert.equal(
        (await relay({ method: 'approve_payee', args: { payee_key: call.args.payee_key } })).status,
        200,
      );
    }
  }

  async function submit(): Promise<{ runId: number; sha: string }> {
    const response = await post('/api/drafts', pain, { 'x-file-name': 'run.xml' });
    assert.equal(response.status, 201);
    const { draftId, call } = (await response.json()) as {
      draftId: string;
      call: { method: string; args: Record<string, unknown> };
    };
    const relayed = await relay({ sender: 'clerk.testnet', method: call.method, args: call.args }, draftId);
    assert.equal(relayed.status, 200);
    const runId = chain.runs.at(-1)?.id ?? 0;
    return { runId, sha: call.args['file_sha256'] as string };
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nostro-test-'));
  });

  beforeEach(async () => {
    server?.close();
    chain = new FakeChain();
    chain.fund(20_000n * USDC);
    quotes = 0;
    const store = new Store(mkdtempSync(join(dir, 'run-')));
    const handle = createApi({ config, chain, store, oneClick });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a preview shows payees with no route, and blocks submission', async () => {
    const response = await post('/api/preview', pain);
    const body = (await response.json()) as { canSubmit: boolean; missing: number[] };
    assert.equal(body.canSubmit, false);
    assert.equal(body.missing.length, 5);
  });

  test('a preview compares the route cost with a wire', async () => {
    await addPayees();
    const body = (await (await post('/api/preview', pain)).json()) as {
      canSubmit: boolean;
      comparison: { quotedLines: number; feeUsd: string; wireFeeUsd: number };
    };
    assert.equal(body.canSubmit, true);
    assert.equal(body.comparison.quotedLines, 5);
    assert.equal(body.comparison.feeUsd, '0.65');
    assert.equal(body.comparison.wireFeeUsd, 225);
    assert.equal(quotes, 5);
  });

  test('a failed quote leaves the preview usable', async () => {
    await addPayees();
    const original = oneClick.quote;
    oneClick.quote = async () => {
      throw new Error('1Click is down');
    };
    const body = (await (await post('/api/preview', pain)).json()) as {
      canSubmit: boolean;
      comparison: { quotedLines: number };
    };
    oneClick.quote = original;
    assert.equal(body.canSubmit, true);
    assert.equal(body.comparison.quotedLines, 0);
  });

  test('an unreadable file gets a useful 422', async () => {
    const response = await post('/api/preview', new TextEncoder().encode('hello'));
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { error: string }).error, /not recognized/);
  });

  test('a file with errors cannot become a draft', async () => {
    await addPayees();
    const bad = new TextEncoder().encode(
      pain.toString('utf8').replaceAll('<CtrlSum>9348.55</CtrlSum>', '<CtrlSum>1.00</CtrlSum>'),
    );
    const response = await post('/api/drafts', bad);
    assert.equal(response.status, 422);
  });

  test('the whole path: file, approval, payment, status, statement, anchor', async () => {
    await addPayees();
    const { runId, sha } = await submit();

    const pending = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
      status: string;
      lines: { creditorName: string; iso: { status: string } }[];
    };
    assert.equal(pending.status, 'Submitted');
    assert.equal(pending.lines[1]?.creditorName, 'Lucia Marin');
    assert.equal(pending.lines[1]?.iso.status, 'PDNG');

    assert.equal((await relay({ method: 'approve_run', args: { run_id: runId, file_sha256: sha } })).status, 200);

    const executed = (await (await post(`/api/runs/${runId}/execute`, {})).json()) as { sent: number[] };
    assert.equal(executed.sent.length, 5, 'the server keeps calling until every line has gone');
    assert.equal(chain.runs[0]?.status, 'Completed');

    const paid = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
      transactions: { step: string; hash: string; by?: string; lines?: number[] }[];
      lines: { txHash: string | null }[];
    };
    assert.deepEqual(
      paid.transactions.slice(0, 2).map((tx) => tx.step),
      ['Submitted', 'Approved'],
      'each step keeps its transaction, so it can be linked',
    );
    assert.equal(paid.transactions[0]?.by, 'clerk.testnet');
    const payments = paid.transactions.filter((tx) => tx.step === 'Paid');
    assert.deepEqual(payments.flatMap((tx) => tx.lines ?? []).sort(), [0, 1, 2, 3, 4]);
    assert.ok(paid.lines.every((line) => payments.some((tx) => tx.hash === line.txHash)), 'every line has its payment');

    const status = await (await fetch(`${url}/api/runs/${runId}/pain002`)).text();
    assert.match(status, /<GrpSts>ACSC<\/GrpSts>/);
    assert.equal((status.match(/<TxSts>ACSC<\/TxSts>/g) ?? []).length, 5);

    const today = new Date(Number(chain.now / 1_000_000n)).toISOString().slice(0, 10);
    const camt = await (await fetch(`${url}/api/statements/download?from=${today}&to=${today}&format=camt053`)).text();
    assert.match(camt, /Lucia Marin/);
    assert.match(camt, /<Amt Ccy="USD">20000\.00<\/Amt>/);

    for (const format of ['ofx', 'mt940', 'csv']) {
      const response = await fetch(`${url}/api/statements/download?from=${today}&to=${today}&format=${format}`);
      assert.equal(response.status, 200, format);
      assert.match(await response.text(), /2450[.,]75/, format);
    }

    const before = (await (await fetch(`${url}/api/statements/verify?from=${today}&to=${today}`)).json()) as {
      anchored: boolean;
      tie: { ties: boolean; ledgerFoots: boolean };
      sha256: string;
    };
    assert.equal(before.anchored, false);
    assert.equal(before.tie.ties, true);
    assert.equal(before.tie.ledgerFoots, true);
    assert.equal(before.sha256, sha256Hex(camt));

    assert.equal((await post('/api/statements/anchor', { from: today, to: today })).status, 200);
    const after = (await (await fetch(`${url}/api/statements/verify?from=${today}&to=${today}`)).json()) as {
      anchored: boolean;
      anchorMatches: boolean;
      anchorTx: string | null;
    };
    assert.equal(after.anchored, true);
    assert.equal(after.anchorMatches, true);
    assert.ok(after.anchorTx, 'the anchoring transaction is kept, so it can be linked');

    const again = await post('/api/statements/anchor', { from: today, to: today });
    assert.equal(again.status, 409);
  });

  test('transactions link to an explorer only when a real chain is behind the portal', async () => {
    const simulated = (await (await fetch(`${url}/api/config`)).json()) as { explorerTxUrl: string | null };
    assert.equal(simulated.explorerTxUrl, null, 'a simulated id would lead nowhere');

    const handle = createApi({
      config: { ...config, rpcUrl: 'https://rpc.testnet.example' },
      chain,
      store: new Store(mkdtempSync(join(dir, 'explorer-'))),
      oneClick,
    });
    const real = createServer((req, res) => void handle(req, res));
    await new Promise<void>((resolve) => real.listen(0, '127.0.0.1', resolve));
    const port = (real.address() as AddressInfo).port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as { explorerTxUrl: string | null };
    real.close();
    assert.equal(body.explorerTxUrl, 'https://testnet.nearblocks.io/txns/');
  });

  test('the approver can fetch the exact bytes that were submitted', async () => {
    await addPayees();
    const { runId, sha } = await submit();
    const bytes = new Uint8Array(await (await fetch(`${url}/api/runs/${runId}/file`)).arrayBuffer());
    assert.equal(sha256Hex(bytes), sha);
  });

  test('a contract refusal comes back in plain English', async () => {
    await addPayees();
    const { runId, sha } = await submit();
    chain.roles['clerk.testnet'] = 'Checker';
    const response = await relay({
      sender: 'clerk.testnet',
      method: 'approve_run',
      args: { run_id: runId, file_sha256: sha },
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, 'E_FOUR_EYES');
    assert.match(body.error, /cannot also approve/);
  });

  test('a stranger costs the relayer nothing', async () => {
    const response = await relay({ sender: 'stranger.testnet', method: 'approve_run', args: { run_id: 1 } });
    assert.equal(response.status, 403);
    assert.equal(chain.relayed.length, 0, 'nothing reached the chain');
  });

  test('a call to another contract is refused before it reaches the chain', async () => {
    const response = await relay({ method: 'approve_run', receiver: 'other.testnet' });
    assert.equal(response.status, 403);
    assert.equal(chain.relayed.length, 0);
  });

  test('garbage in place of a signature is refused', async () => {
    const response = await post('/api/relay', { signedDelegate: 'bm90IGEgZGVsZWdhdGU=' });
    assert.equal(response.status, 400);
  });

  test('a line paying the wrong account is held, even in an approved run', async () => {
    await addPayees();
    const { runId, sha } = await submit();
    const line = chain.runs[0]?.lines[1];
    assert.ok(line);
    line.receiver = 'attacker.testnet';
    await relay({ method: 'approve_run', args: { run_id: runId, file_sha256: sha } });
    const result = (await (await post(`/api/runs/${runId}/execute`, {})).json()) as {
      sent: number[];
      held: { line: number; reason: string }[];
    };
    assert.equal(result.sent.includes(1), false);
    assert.ok(result.held.some((hold) => hold.line === 1 && hold.reason === 'receiver_mismatch'));
    const status = await (await fetch(`${url}/api/runs/${runId}/pain002`)).text();
    assert.match(status, /<Cd>AC01<\/Cd>/);
  });

  test('a run reports what is recorded, so a device can compare it with the file', async () => {
    await addPayees();
    const { runId } = await submit();
    const body = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
      recordedLines: { amount: string }[];
    };
    assert.equal(body.recordedLines.length, 5);
    assert.equal(body.recordedLines[1]?.amount, '2450750000');
  });

  test('a held line reports why and stays pending', async () => {
    await addPayees();
    chain.balance = 1n * USDC;
    const { runId, sha } = await submit();
    await relay({ method: 'approve_run', args: { run_id: runId, file_sha256: sha } });
    const result = (await (await post(`/api/runs/${runId}/execute`, {})).json()) as {
      sent: number[];
      held: { line: number; reason: string }[];
    };
    assert.equal(result.sent.length, 0);
    assert.equal(result.held[0]?.reason, 'insufficient_funds');
    const status = await (await fetch(`${url}/api/runs/${runId}/pain002`)).text();
    assert.match(status, /<Cd>AM04<\/Cd>/);
  });

  test('a bad date is refused', async () => {
    const response = await fetch(`${url}/api/statements/verify?from=nope&to=2026-11-07`);
    assert.equal(response.status, 400);
  });

  test('a tie-out difference is reported, not hidden', async () => {
    chain.tokenExtra = 3n * USDC;
    const today = new Date(Number(chain.now / 1_000_000n)).toISOString().slice(0, 10);
    const body = (await (await fetch(`${url}/api/statements/verify?from=${today}&to=${today}`)).json()) as {
      tie: { ties: boolean; difference: string };
    };
    assert.equal(body.tie.ties, false);
    assert.equal(body.tie.difference, '3000000');
  });

  test('path traversal cannot read files outside the web folder', async () => {
    const response = await fetch(`${url}/..%2f..%2fpackage.json`);
    assert.notEqual(response.status, 200);
  });

  test('statics report a missing build plainly', async () => {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /npm run build/);
  });
});
