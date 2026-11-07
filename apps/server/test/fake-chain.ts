// A small stand-in for the contract, so the API can be tested without a network.
// The real rules are tested in contract/src/tests.rs. This only imitates enough
// of them to drive the server, and its error codes match the contract's.

import type { Chain, ChainEvent, TxOutcome } from '../src/chain.ts';
import type { ChainPayee, ChainRun, LedgerEntry } from '../src/domain.ts';
import type { DecodedDelegate } from '../src/relay.ts';

type Args = Record<string, unknown>;

export class FakeChain implements Chain {
  roles: Record<string, string> = {
    'clerk.testnet': 'Maker',
    'cfo.testnet': 'Checker',
  };
  runs: ChainRun[] = [];
  payees = new Map<string, ChainPayee>();
  seenMessages = new Set<string>();
  ledger: LedgerEntry[] = [];
  statements = new Map<string, { sha256: string; block: string }>();
  balance = 0n;
  tokenExtra = 0n;
  now = 1_794_000_000_000_000_000n;
  txCounter = 0;
  relayed: string[] = [];

  fund(amount: bigint): void {
    this.balance += amount;
    this.append('Credit', amount, null, null, 'FUNDING');
  }

  private append(
    kind: 'Debit' | 'Credit',
    amount: bigint,
    run: number | null,
    line: number | null,
    reference: string,
  ): number {
    const seq = this.ledger.length;
    this.ledger.push({
      seq,
      ts: this.now.toString(),
      block: String(1000 + seq),
      kind,
      amount: amount.toString(),
      balance_after: this.balance.toString(),
      run_id: run,
      line,
      reference,
    });
    return seq;
  }

  async view<T>(method: string, args: Args = {}): Promise<T> {
    const result = ((): unknown => {
      switch (method) {
        case 'get_balances':
          return { ledger: this.balance.toString(), available: this.balance.toString(), spent_today: '0' };
        case 'get_config':
          return { owner: 'owner.testnet' };
        case 'has_role':
          return this.roles[args['account_id'] as string] === args['role'];
        case 'get_run':
          return this.runs.find((run) => run.id === args['run_id']) ?? null;
        case 'list_runs':
          return this.runs;
        case 'get_payee':
          return this.payees.get(args['payee_key'] as string) ?? null;
        case 'is_message_seen':
          return this.seenMessages.has(args['message_hash'] as string);
        case 'ledger_len':
          return this.ledger.length;
        case 'get_ledger':
          return this.ledger.slice(
            args['from_seq'] as number,
            (args['from_seq'] as number) + (args['limit'] as number),
          );
        case 'get_statement':
          return this.statements.get(args['statement_id'] as string) ?? null;
        default:
          throw new Error(`FakeChain has no view ${method}`);
      }
    })();
    return result as T;
  }

  async tokenBalance(): Promise<bigint> {
    return this.balance + this.tokenExtra;
  }

  private outcome(events: ChainEvent[], failure?: string): TxOutcome {
    this.txCounter += 1;
    return { hash: `TX${this.txCounter}`, events, ...(failure ? { failure } : {}) };
  }

  async relay(signed: DecodedDelegate): Promise<TxOutcome> {
    const delegate = signed.delegateAction;
    const call = delegate.actions[0]?.functionCall;
    if (!call) throw new Error('no call');
    this.relayed.push(call.methodName);
    const args = JSON.parse(new TextDecoder().decode(call.args)) as Args;
    const caller = delegate.senderId;

    switch (call.methodName) {
      case 'submit_run': {
        const message = args['message_hash'] as string;
        if (this.seenMessages.has(message)) return this.outcome([], 'E_DUPLICATE_FILE');
        this.seenMessages.add(message);
        const id = this.runs.length + 1;
        const lines = args['lines'] as ChainRun['lines'];
        this.runs.push({
          id,
          message_hash: message,
          file_sha256: args['file_sha256'] as string,
          total: args['total'] as string,
          maker: caller,
          approvals: [],
          status: 'Submitted',
          created_at: this.now.toString(),
          rejected_reason: null,
          lines: lines.map((line) => ({ ...line, status: 'Pending', settled_at: '0' })),
        });
        return this.outcome([{ event: 'run_submitted', data: { run_id: id } }]);
      }
      case 'approve_run': {
        const run = this.runs.find((item) => item.id === args['run_id']);
        if (!run) return this.outcome([], 'E_UNKNOWN_RUN');
        if (run.maker === caller) return this.outcome([], 'E_FOUR_EYES');
        if (run.file_sha256 !== args['file_sha256']) return this.outcome([], 'E_FILE_MISMATCH');
        run.approvals.push(caller);
        run.status = 'Approved';
        return this.outcome([{ event: 'run_approved', data: { run_id: run.id } }]);
      }
      case 'register_payee': {
        this.payees.set(args['payee_key'] as string, {
          route_hash: args['route_hash'] as string,
          registered_by: caller,
          approved_by: null,
          active_after: '0',
        });
        return this.outcome([{ event: 'payee_registered', data: {} }]);
      }
      case 'approve_payee': {
        const payee = this.payees.get(args['payee_key'] as string);
        if (!payee) return this.outcome([], 'E_UNKNOWN_PAYEE');
        payee.approved_by = caller;
        return this.outcome([{ event: 'payee_approved', data: {} }]);
      }
      default:
        return this.outcome([], 'E_UNEXPECTED');
    }
  }

  async settle(method: string, args: Args): Promise<TxOutcome> {
    if (method === 'anchor_statement') {
      const id = args['statement_id'] as string;
      const entry = this.ledger[args['last_seq'] as number];
      if (!entry || entry.balance_after !== args['closing_balance']) {
        return this.outcome([], 'E_STATEMENT_DOES_NOT_TIE');
      }
      if (this.statements.has(id)) return this.outcome([], 'E_STATEMENT_EXISTS');
      this.statements.set(id, { sha256: args['sha256'] as string, block: '2000' });
      return this.outcome([{ event: 'statement_anchored', data: {} }]);
    }
    if (method !== 'execute_run') throw new Error(`FakeChain has no method ${method}`);

    const run = this.runs.find((item) => item.id === args['run_id']);
    if (!run) return this.outcome([], 'E_UNKNOWN_RUN');
    if (run.status !== 'Approved' && run.status !== 'Executing') {
      return this.outcome([], 'E_NOT_APPROVED');
    }
    const events: ChainEvent[] = [];
    // Two lines per call, so the server has to loop as it must on a real chain.
    let budget = 2;
    for (const [index, line] of run.lines.entries()) {
      if (budget === 0) break;
      if (line.status !== 'Pending') continue;
      const payee = this.payees.get(line.payee_key);
      if (!payee?.approved_by) {
        events.push({ event: 'line_held', data: { line: index, reason: 'payee_unapproved' } });
        continue;
      }
      const amount = BigInt(line.amount);
      if (amount > this.balance) {
        events.push({ event: 'line_held', data: { line: index, reason: 'insufficient_funds' } });
        continue;
      }
      this.balance -= amount;
      line.status = 'Sent';
      const seq = this.append('Debit', amount, run.id, index, line.e2e_hash);
      events.push({ event: 'line_sent', data: { line: index, seq } });
      budget -= 1;
    }
    if (run.lines.every((line) => line.status === 'Sent')) run.status = 'Completed';
    else run.status = 'Executing';
    return this.outcome(events);
  }
}
