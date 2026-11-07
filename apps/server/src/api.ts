// The HTTP API behind the portal. Plain node:http, to stay small and easy to read.

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import {
  hasErrors,
  readPaymentFile,
  sha256Hex,
  writeCamt053,
  writeCsv,
  writeMt940,
  writeOfx,
  writePain002,
} from '@nostro/bankfiles';
import type { CanonicalRun } from '@nostro/bankfiles';
import type { Chain, TxOutcome } from './chain.ts';
import type { Config } from './config.ts';
import {
  buildStatement,
  buildStatusReport,
  buildSubmitArgs,
  lineStatus,
  payeeKey,
  resolveDirect,
  routeHash,
  tieOut,
  usd,
} from './domain.ts';
import type {
  ChainPayee,
  ChainRun,
  LedgerEntry,
  OneClickStatus,
  Payee,
  ResolvedLine,
  Route,
} from './domain.ts';
import type { OneClick } from './oneclick.ts';
import { decodeDelegate, inspectDelegate } from './relay.ts';
import type { Store } from './store.ts';

export interface Deps {
  config: Config;
  chain: Chain;
  store: Store;
  oneClick: OneClick;
}

const MAX_BODY = 10 * 1024 * 1024;
const LEDGER_PAGE = 200;
const MAX_ROUNDS = 40;
/** Median outgoing international wire fee, NerdWallet 2026 figures via Corpay. */
const WIRE_FEE_USD = 45;

const MESSAGES: Record<string, string> = {
  E_FOUR_EYES: 'The person who submitted this cannot also approve it.',
  E_DUPLICATE_FILE: 'This file has already been submitted.',
  E_DUPLICATE_LINE: 'A payment in this file has already been submitted.',
  E_FILE_MISMATCH: 'This approval is for a different file than the one on record.',
  E_ALREADY_APPROVED: 'You have already approved this run.',
  E_NOT_AUTHORIZED: 'Your account is not allowed to do this.',
  E_NOT_SUBMITTED: 'This run is no longer waiting for a decision.',
  E_NOT_APPROVED: 'This run has not been approved.',
  E_OVER_PAYMENT_LIMIT: 'A payment is over the per-payment limit.',
  E_CONTROL_SUM: 'The payments do not add up to the total.',
  E_STATEMENT_DOES_NOT_TIE: 'The statement does not match the ledger.',
  E_STATEMENT_EXISTS: 'This statement has already been anchored.',
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, replacer));
}

function sendFile(res: ServerResponse, name: string, type: string, body: string | Uint8Array): void {
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, 'This file is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBody(req))) as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'This request is not valid JSON.');
  }
}

function checkFailure(outcome: TxOutcome): void {
  if (outcome.failure) {
    throw new HttpError(409, MESSAGES[outcome.failure] ?? outcome.failure, outcome.failure);
  }
}

const isDate = (value: string | null): value is string =>
  value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function createApi(deps: Deps) {
  const { config, chain, store, oneClick } = deps;

  const isReadOnly = (): boolean => !config.relayer || !config.settler;

  async function allLedger(): Promise<LedgerEntry[]> {
    const length = await chain.view<number>('ledger_len');
    const entries: LedgerEntry[] = [];
    for (let from = 0; from < length; from += LEDGER_PAGE) {
      entries.push(
        ...(await chain.view<LedgerEntry[]>('get_ledger', { from_seq: from, limit: LEDGER_PAGE })),
      );
    }
    return entries;
  }

  async function payeeState(key: string): Promise<'unknown' | 'unapproved' | 'cooloff' | 'active'> {
    const payee = await chain.view<ChainPayee | null>('get_payee', { payee_key: key });
    if (!payee) return 'unknown';
    if (!payee.approved_by) return 'unapproved';
    const activeAt = BigInt(payee.active_after) / 1_000_000n;
    return BigInt(Date.now()) < activeAt ? 'cooloff' : 'active';
  }

  async function feePreview(route: Route | undefined, amountBase: bigint) {
    if (!route) return null;
    try {
      // 1Click answers "Internal server error" if refundTo doesn't exist, so a
      // preview on testnet borrows a mainnet account that does. Nothing moves.
      const quote = await oneClick.quote(route, amountBase, {
        dry: true,
        refundTo: config.network === 'mainnet' ? config.contractId : 'intents.near',
      });
      const fee = quote.minAmountIn - amountBase;
      return {
        feeBase: fee > 0n ? fee : 0n,
        etaSeconds: quote.etaSeconds,
        route,
      };
    } catch {
      return null;
    }
  }

  function parse(bytes: Uint8Array, now?: Date): CanonicalRun {
    try {
      return readPaymentFile(bytes, { company: config.company, ...(now ? { now } : {}) });
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : 'This file cannot be read.');
    }
  }

  async function preview(bytes: Uint8Array) {
    const run = parse(bytes);
    const { resolved, missing } = resolveDirect(run, (key) => store.findPayee(key));
    const resolvedByLine = new Map(resolved.map((item) => [item.index, item]));

    const lines = await Promise.all(
      run.lines.map(async (line) => {
        const key = payeeKey(line.creditorAccount);
        const item = resolvedByLine.get(line.index);
        const payee = store.findPayee(key);
        return {
          ...line,
          payeeKey: key,
          state: await payeeState(key),
          receiver: item?.receiver ?? null,
          route: payee?.route ?? null,
          estimate: await feePreview(payee?.route, line.amountMinor * 10_000n),
        };
      }),
    );

    const quoted = lines.filter((line) => line.estimate);
    const feeBase = quoted.reduce((sum, line) => sum + (line.estimate?.feeBase ?? 0n), 0n);
    const fileSeen = run.messageId
      ? await chain.view<boolean>('is_message_seen', {
          message_hash: buildSubmitArgs(run, []).message_hash,
        })
      : false;

    return {
      run,
      lines,
      missing: missing.map((line) => line.index),
      duplicate: fileSeen,
      canSubmit: !hasErrors(run) && missing.length === 0 && !fileSeen && !isReadOnly(),
      comparison: {
        quotedLines: quoted.length,
        feeUsd: usd(feeBase),
        wireFeeUsd: quoted.length * WIRE_FEE_USD,
        note: 'Wire figure is the median outgoing international fee, and excludes FX margin.',
      },
    };
  }

  async function saveDraft(bytes: Uint8Array, fileName: string) {
    const run = parse(bytes);
    if (hasErrors(run)) {
      throw new HttpError(422, 'This file has errors. Fix them and upload it again.');
    }
    let resolved: ResolvedLine[];
    if (config.network === 'mainnet') {
      resolved = await resolveWithQuotes(run);
    } else {
      const direct = resolveDirect(run, (key) => store.findPayee(key));
      if (direct.missing.length > 0) {
        const names = direct.missing.map((line) => line.creditorName).join(', ');
        throw new HttpError(422, `No payout route for: ${names}.`);
      }
      resolved = direct.resolved;
    }
    const submitArgs = buildSubmitArgs(run, resolved);
    const draft = store.saveDraft({
      fileName,
      company: config.company,
      submitArgs,
      bytes,
      resolved,
    });
    return { draftId: draft.id, call: { method: 'submit_run', args: submitArgs } };
  }

  /**
   * Mainnet: a firm quote per line, taken before approval, so the approver sees
   * final numbers and the contract records the exact deposit addresses.
   */
  async function resolveWithQuotes(run: CanonicalRun): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    for (const line of run.lines) {
      const key = payeeKey(line.creditorAccount);
      const payee = store.findPayee(key);
      if (!payee) throw new HttpError(422, `No payout route for ${line.creditorName}.`);
      const principalBase = line.amountMinor * 10_000n;
      const quote = await oneClick.quote(payee.route, principalBase, {
        dry: false,
        refundTo: config.contractId,
      });
      if (!quote.depositAddress) throw new HttpError(502, '1Click returned no deposit address.');
      resolved.push({
        index: line.index,
        payeeKey: key,
        receiver: quote.depositAddress,
        depositAddress: quote.depositAddress,
        amountBase: quote.amountIn,
        principalBase,
        route: payee.route,
      });
    }
    return resolved;
  }

  async function relay(body: { signedDelegate?: string; draftId?: string }) {
    if (!body.signedDelegate) throw new HttpError(400, 'Missing signedDelegate.');
    let signed;
    try {
      signed = decodeDelegate(Buffer.from(body.signedDelegate, 'base64'));
    } catch {
      throw new HttpError(400, 'This signed request cannot be decoded.');
    }
    const inspection = inspectDelegate(signed, { contractId: config.contractId });
    if (!inspection.ok) throw new HttpError(403, inspection.reason);

    // The contract would refuse a stranger, but the relayer would have paid for
    // the attempt. Checking first keeps strangers from spending our gas.
    const allowed = await chain.view<boolean>('has_role', {
      account_id: inspection.senderId,
      role: inspection.role,
    });
    if (!allowed) throw new HttpError(403, `${inspection.senderId} is not a ${inspection.role}.`);

    const outcome = await chain.relay(signed);
    checkFailure(outcome);
    if (body.draftId) {
      const submitted = outcome.events.find((event) => event.event === 'run_submitted');
      if (submitted) store.bindRun(body.draftId, Number(submitted.data['run_id']));
    }
    return { hash: outcome.hash, events: outcome.events };
  }

  async function routedStatuses(runId: number, chainRun: ChainRun) {
    if (config.network !== 'mainnet') return {};
    const detail = store.detail(runId);
    const statuses: Record<number, OneClickStatus> = {};
    for (const item of detail?.resolved ?? []) {
      if (item.depositAddress && chainRun.lines[item.index]?.status === 'Sent') {
        try {
          statuses[item.index] = (await oneClick.status(item.depositAddress)) as OneClickStatus;
        } catch {
          statuses[item.index] = 'PROCESSING';
        }
      }
    }
    return statuses;
  }

  async function getRun(runId: number): Promise<ChainRun> {
    const run = await chain.view<ChainRun | null>('get_run', { run_id: runId });
    if (!run) throw new HttpError(404, `There is no run ${runId}.`);
    return run;
  }

  async function runSummary(chainRun: ChainRun) {
    const detail = store.detail(chainRun.id);
    return {
      id: chainRun.id,
      status: chainRun.status,
      maker: chainRun.maker,
      approvals: chainRun.approvals,
      totalUsd: usd(chainRun.total),
      lineCount: chainRun.lines.length,
      sent: chainRun.lines.filter((line) => line.status === 'Sent').length,
      createdAt: new Date(Number(BigInt(chainRun.created_at) / 1_000_000n)).toISOString(),
      messageId: detail?.run.messageId ?? null,
      format: detail?.run.format ?? null,
      fileSha256: chainRun.file_sha256,
    };
  }

  async function runDetail(runId: number) {
    const chainRun = await getRun(runId);
    const detail = store.detail(runId);
    const holds = store.holds(runId);
    const routed = await routedStatuses(runId, chainRun);
    const lines = chainRun.lines.map((line, index) => {
      const source = detail?.run.lines[index];
      const resolved = detail?.resolved.find((item) => item.index === index);
      return {
        index,
        status: line.status,
        iso: lineStatus(chainRun.status, line, holds[index], routed[index]),
        hold: holds[index] ?? null,
        receiver: line.receiver,
        amountUsd: usd(line.amount),
        principalUsd: resolved ? usd(resolved.principalBase) : null,
        creditorName: source?.creditorName ?? null,
        endToEndId: source?.endToEndId ?? null,
        remittance: source?.remittance ?? null,
        route: resolved?.route ?? null,
      };
    });
    return {
      ...(await runSummary(chainRun)),
      rejectedReason: chainRun.rejected_reason,
      issues: detail?.run.issues ?? [],
      lines,
      recordedLines: chainRun.lines.map(({ e2e_hash, payee_key, amount, receiver }) => ({
        e2e_hash,
        payee_key,
        amount,
        receiver,
      })),
    };
  }

  async function execute(runId: number) {
    const sent: number[] = [];
    const held: { line: number; reason: string }[] = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const run = await getRun(runId);
      if (!run.lines.some((line) => line.status === 'Pending')) break;

      const outcome = await chain.settle('execute_run', { run_id: runId, max_lines: 100 }, 300);
      checkFailure(outcome);

      let moved = 0;
      held.length = 0;
      for (const { event, data } of outcome.events) {
        if (event === 'line_sent') {
          moved += 1;
          sent.push(Number(data['line']));
          store.recordTx(Number(data['seq']), outcome.hash);
          store.clearHold(runId, Number(data['line']));
        } else if (event === 'line_failed') {
          moved += 1;
        } else if (event === 'line_held') {
          const hold = { line: Number(data['line']), reason: String(data['reason']) };
          held.push(hold);
          store.recordHold(runId, hold.line, hold.reason);
        }
      }
      if (moved === 0) break;
    }
    return { sent, held };
  }

  async function statementInput(from: string, to: string) {
    const ledger = await allLedger();
    return {
      ledger,
      input: buildStatement({
        accountId: config.contractId,
        ownerName: config.company,
        from,
        to,
        ledger,
        details: (runId) => store.detail(runId),
        txHashOf: (seq) => store.txHashOf(seq),
      }),
    };
  }

  async function verification(from: string, to: string) {
    const { ledger, input } = await statementInput(from, to);
    const balances = await chain.view<{ ledger: string }>('get_balances');
    const token = await chain.tokenBalance(config.contractId);
    const sha256 = sha256Hex(writeCamt053(input));
    const anchor = await chain.view<{ sha256: string; block: string } | null>('get_statement', {
      statement_id: input.statementId,
    });
    return {
      statementId: input.statementId,
      entries: input.entries.length,
      openingUsd: usd(input.openingBalance),
      closingUsd: usd(input.closingBalance),
      tie: tieOut(ledger, BigInt(balances.ledger), token),
      sha256,
      anchored: anchor !== null,
      anchorMatches: anchor?.sha256 === sha256,
      anchorBlock: anchor?.block ?? null,
    };
  }

  function requireDates(url: URL): { from: string; to: string } {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isDate(from) || !isDate(to) || from > to) {
      throw new HttpError(400, 'Give a valid from and to date, as YYYY-MM-DD.');
    }
    return { from, to };
  }

  async function downloadStatement(res: ServerResponse, url: URL): Promise<void> {
    const { from, to } = requireDates(url);
    const format = url.searchParams.get('format') ?? 'camt053';
    const { input } = await statementInput(from, to);
    const name = input.statementId;
    switch (format) {
      case 'camt053':
        return sendFile(res, `${name}.xml`, 'application/xml', writeCamt053(input));
      case 'ofx':
        return sendFile(res, `${name}.ofx`, 'application/x-ofx', writeOfx(input));
      case 'mt940':
        return sendFile(res, `${name}.sta`, 'text/plain', writeMt940(input));
      case 'csv':
        return sendFile(res, `${name}.csv`, 'text/csv', writeCsv(input));
      default:
        throw new HttpError(400, `Unknown format ${format}.`);
    }
  }

  async function anchor(body: { from?: string; to?: string }) {
    const { from, to } = body;
    if (!isDate(from ?? null) || !isDate(to ?? null)) {
      throw new HttpError(400, 'Give a valid from and to date.');
    }
    const { input, ledger } = await statementInput(from as string, to as string);
    const last = input.entries.at(-1);
    if (!last) throw new HttpError(422, 'This period has no entries to anchor.');
    const entry = ledger.find((item) => item.seq === last.seq);
    const outcome = await chain.settle(
      'anchor_statement',
      {
        statement_id: input.statementId,
        sha256: sha256Hex(writeCamt053(input)),
        closing_balance: entry?.balance_after,
        last_seq: last.seq,
      },
      60,
    );
    checkFailure(outcome);
    return { hash: outcome.hash, statementId: input.statementId };
  }

  async function listPayees() {
    return Promise.all(
      store.payees().map(async (payee) => ({
        ...payee,
        state: await payeeState(payee.key),
      })),
    );
  }

  function addPayee(body: Partial<Payee> & { route?: Route }) {
    const { name, account, route, testnetReceiver } = body;
    if (!name || !account || !route?.chain || !route.asset || !route.address) {
      throw new HttpError(400, 'A payee needs a name, an account and a full payout route.');
    }
    const key = payeeKey(account);
    store.savePayee({
      key,
      name,
      account,
      route,
      ...(testnetReceiver ? { testnetReceiver } : {}),
    });
    // On testnet money goes straight to this account, so the contract binds the
    // payee to it. On mainnet each payment gets its own deposit account instead.
    const receiver = config.network === 'testnet' ? (testnetReceiver ?? null) : null;
    return {
      key,
      call: {
        method: 'register_payee',
        args: { payee_key: key, route_hash: routeHash(route), receiver },
      },
    };
  }

  async function overview() {
    const [balances, contract] = await Promise.all([
      chain.view<{ ledger: string; available: string; spent_today: string }>('get_balances'),
      chain.view<Record<string, unknown>>('get_config'),
    ]);
    return {
      balanceUsd: usd(balances.ledger),
      availableUsd: usd(balances.available),
      spentTodayUsd: usd(balances.spent_today),
      contract,
    };
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const root = normalize(config.webDir);
    const requested = normalize(join(root, decodeURIComponent(url.pathname)));
    const inside = requested === root || requested.startsWith(root + sep);
    const isFile = inside && existsSync(requested) && statSync(requested).isFile();
    const path = isFile ? requested : join(root, 'index.html');
    if (!existsSync(path)) {
      res.writeHead(404).end('The portal has not been built. Run: npm run build');
      return;
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).pipe(res);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const runMatch = /^\/api\/runs\/(\d+)(?:\/(execute|file|pain002))?$/.exec(path);

    if (method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, {
        network: config.network,
        contractId: config.contractId,
        tokenId: config.tokenId,
        company: config.company,
        rpcUrl: config.rpcUrl,
        readOnly: isReadOnly(),
        demoKeys: config.demoKeys,
      });
    }
    if (method === 'GET' && path === '/api/overview') return sendJson(res, 200, await overview());
    if (method === 'GET' && path === '/api/sign-context') {
      const accountId = url.searchParams.get('accountId');
      const publicKey = url.searchParams.get('publicKey');
      if (!accountId || !publicKey) throw new HttpError(400, 'Give an accountId and a publicKey.');
      return sendJson(res, 200, await chain.signContext(accountId, publicKey));
    }
    if (method === 'POST' && path === '/api/preview') {
      return sendJson(res, 200, await preview(await readBody(req)));
    }
    if (method === 'POST' && path === '/api/drafts') {
      const name = String(req.headers['x-file-name'] ?? 'payment-file');
      return sendJson(res, 201, await saveDraft(await readBody(req), name));
    }
    if (method === 'POST' && path === '/api/relay') {
      return sendJson(res, 200, await relay(await readJson(req)));
    }
    if (method === 'GET' && path === '/api/runs') {
      const runs = await chain.view<ChainRun[]>('list_runs', { from_index: 0, limit: 100 });
      const summaries = await Promise.all(runs.map(runSummary));
      return sendJson(res, 200, summaries.reverse());
    }
    if (runMatch) {
      const id = Number(runMatch[1]);
      const action = runMatch[2];
      if (method === 'GET' && !action) return sendJson(res, 200, await runDetail(id));
      if (method === 'POST' && action === 'execute') {
        return sendJson(res, 200, await execute(id));
      }
      if (method === 'GET' && action === 'file') {
        const draft = store.draftForRun(id);
        if (!draft) throw new HttpError(404, 'This server does not hold that file.');
        return sendFile(res, draft.fileName, 'application/octet-stream', store.fileOf(draft));
      }
      if (method === 'GET' && action === 'pain002') {
        const detail = store.detail(id);
        if (!detail) throw new HttpError(404, 'This server does not hold that run’s file.');
        const chainRun = await getRun(id);
        const report = buildStatusReport(detail.run, chainRun, {
          now: new Date(),
          held: store.holds(id),
          routed: await routedStatuses(id, chainRun),
        });
        return sendFile(res, `status-run-${id}.xml`, 'application/xml', writePain002(report));
      }
    }
    if (method === 'GET' && path === '/api/payees') return sendJson(res, 200, await listPayees());
    if (method === 'POST' && path === '/api/payees') {
      return sendJson(res, 201, addPayee(await readJson(req)));
    }
    if (method === 'GET' && path === '/api/statements/verify') {
      const { from, to } = requireDates(url);
      return sendJson(res, 200, await verification(from, to));
    }
    if (method === 'GET' && path === '/api/statements/download') {
      return downloadStatement(res, url);
    }
    if (method === 'POST' && path === '/api/statements/anchor') {
      return sendJson(res, 200, await anchor(await readJson(req)));
    }
    if (method === 'GET' && path.startsWith('/api/demo-key/')) {
      if (!config.demoKeys) throw new HttpError(404, 'Demo sign-in is off.');
      const role = path.split('/').pop()?.toUpperCase() ?? '';
      const accountId = process.env[`NOSTRO_DEMO_${role}_ID`];
      const privateKey = process.env[`NOSTRO_DEMO_${role}_KEY`];
      if (!accountId || !privateKey) throw new HttpError(404, 'No demo key for that role.');
      return sendJson(res, 200, { accountId, privateKey });
    }
    if (path.startsWith('/api/')) throw new HttpError(404, 'No such endpoint.');
    serveStatic(req, res, url);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      await route(req, res, url);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      console.error(error);
      sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  };
}
