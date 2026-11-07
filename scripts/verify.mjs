#!/usr/bin/env node
// One command, one PASS, FAIL or SKIP per claim. Needs no keys and spends nothing.
//
//   npm run verify
//
// SKIP means a check could not run here, which is different from passing. The
// exit code is the number of failures.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = { pass: 0, fail: 0, skip: 0 };

function report(state, claim, detail = '') {
  results[state.toLowerCase()] += 1;
  console.log(`${state.padEnd(5)} ${claim}${detail ? `\n      ${detail}` : ''}`);
}

function has(command, args = ['--version']) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

function testRun(claim, command, args, cwd) {
  // No shell, so a Node path with spaces in it still works on Windows.
  const run = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout}\n${run.stderr}`;
  const tests = /# tests (\d+)/.exec(output)?.[1] ?? /(\d+) passed/.exec(output)?.[1];
  const skipped = Number(/# skipped (\d+)/.exec(output)?.[1] ?? 0);
  if (run.status !== 0) {
    report('FAIL', claim, output.trim().split('\n').slice(-6).join('\n      '));
  } else if (skipped > 0) {
    report('SKIP', claim, `${skipped} checks skipped. Run: node schemas/fetch.mjs`);
  } else {
    report('PASS', claim, tests ? `${tests} tests` : '');
  }
}

// ---------- Code ----------

if (has('cargo')) {
  testRun('Contract controls hold: four eyes, duplicates, cool-off, limits, ledger', 'cargo', ['test', '--quiet'], join(root, 'contract'));
} else {
  report('SKIP', 'Contract unit tests', 'Rust is not installed. See contract/src/tests.rs.');
}

spawnSync(process.execPath, [join(root, 'schemas', 'fetch.mjs')], { stdio: 'ignore' });

testRun(
  'Bank files: third-party files read, XML valid against ISO schemas, statements foot in independent parsers',
  process.execPath,
  ['--test', '--test-reporter=tap', 'test/**/*.test.ts'],
  join(root, 'packages', 'bankfiles'),
);
testRun(
  'Server: relayer gate, status mapping, statement building, whole path on a stand-in chain',
  process.execPath,
  ['--test', '--test-reporter=tap', 'test/**/*.test.ts'],
  join(root, 'apps', 'server'),
);

// ---------- The deployed contract, read from the chain ----------

const deploymentPath = join(root, 'deployment.json');
if (!existsSync(deploymentPath)) {
  report('SKIP', 'Deployed contract checks', 'No deployment.json in this checkout.');
} else {
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  const rpc = process.env.NOSTRO_RPC_URL ?? 'https://test.rpc.fastnear.com';

  async function rpcCall(params) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'verify', method: 'query', params }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) {
        await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
        continue;
      }
      const body = await response.json();
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
      if (body.result?.error) throw new Error(String(body.result.error).slice(0, 200));
      return body.result;
    }
    throw new Error('The RPC is rate limiting this machine.');
  }

  const view = async (accountId, method, args = {}) => {
    const result = await rpcCall({
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  };

  async function check(claim, action) {
    try {
      const detail = await action();
      report('PASS', claim, detail ?? '');
    } catch (error) {
      report('FAIL', claim, error.message);
    }
  }

  const contract = deployment.contractId;

  await check(`Contract ${contract} is live on testnet`, async () => {
    const config = await view(contract, 'get_config');
    if (config.token !== deployment.tokenId) throw new Error('It uses a different token.');
    return `required approvals ${config.required_approvals}`;
  });

  await check('Every ledger entry adds up, and the total equals the token contract’s balance', async () => {
    const length = await view(contract, 'ledger_len');
    let running = 0n;
    for (let from = 0; from < length; from += 100) {
      for (const entry of await view(contract, 'get_ledger', { from_seq: from, limit: 100 })) {
        running += entry.kind === 'Credit' ? BigInt(entry.amount) : -BigInt(entry.amount);
        if (running !== BigInt(entry.balance_after)) throw new Error(`Entry ${entry.seq} does not foot.`);
      }
    }
    const balances = await view(contract, 'get_balances');
    const token = BigInt(await view(deployment.tokenId, 'ft_balance_of', { account_id: contract }));
    if (BigInt(balances.ledger) !== running) throw new Error('The ledger total is wrong.');
    if (token !== running) throw new Error(`Ledger ${running}, token ${token}.`);
    return `${length} entries, balance ${running}`;
  });

  await check('Staff accounts hold function-call keys only', async () => {
    const seen = [];
    for (const [name, account] of Object.entries(deployment.staff)) {
      if (!['clerk', 'cfo', 'controller'].includes(name)) continue;
      const { keys } = await rpcCall({
        request_type: 'view_access_key_list',
        finality: 'final',
        account_id: account,
      });
      for (const key of keys) {
        if (key.access_key.permission === 'FullAccess') throw new Error(`${account} has a full-access key.`);
        const allowed = key.access_key.permission.FunctionCall;
        if (allowed.receiver_id !== contract) throw new Error(`${account} can call another contract.`);
        seen.push(`${name}: ${allowed.method_names.join(', ')}`);
      }
    }
    return seen.join('\n      ');
  });

  const proofPath = join(root, 'proof', 'testnet-run.json');
  if (!existsSync(proofPath)) {
    report('SKIP', 'Recorded testnet run', 'No proof/testnet-run.json in this checkout.');
  } else {
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));

    await check('The statement in proof/ is the one whose hash is fixed on chain', async () => {
      const bytes = readFileSync(join(root, 'proof', 'statement.camt053.xml'));
      const sha = createHash('sha256').update(bytes).digest('hex');
      const anchor = await view(contract, 'get_statement', { statement_id: proof.statement.statementId });
      if (!anchor) throw new Error('No anchor on chain.');
      if (anchor.sha256 !== sha) throw new Error(`Chain ${anchor.sha256}, file ${sha}.`);
      return `${proof.statement.statementId} at block ${anchor.block}`;
    });

    await check('The run refused what it should have', async () => {
      if (proof.refusals.length < 5) throw new Error('Fewer refusals recorded than expected.');
      return proof.refusals.map((item) => `${item.attempt}: ${item.by}`).join('\n      ');
    });
  }
}

// ---------- Live routing, with no money ----------

try {
  const response = await fetch('https://1click.chaindefuser.com/v0/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 10,
      originAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      depositType: 'INTENTS',
      destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
      amount: '5000000000',
      refundTo: 'intents.near',
      refundType: 'ORIGIN_CHAIN',
      recipient: '0xfdfc645013e76a26014c999b9f57dcfd6a431394',
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const { quote } = await response.json();
  if (!quote) throw new Error(`No quote: ${response.status}`);
  const cost = (Number(BigInt(quote.minAmountIn) - 5_000_000_000n) / 1_000_000).toFixed(2);
  report('PASS', 'A live mainnet dry quote prices $5,000 USDC on NEAR to USDC on Base', `about $${cost}, ${quote.timeEstimate}s, no money moved`);
} catch (error) {
  report('SKIP', 'Live 1Click dry quote', `Could not reach 1Click: ${error.message}`);
}

console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`);
process.exit(results.fail);
