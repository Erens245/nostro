// The only file that talks to NEAR. Everything else depends on the Chain
// interface, so the logic above it can be tested without a network.

import { Account, JsonRpcProvider, actions, teraToGas } from 'near-api-js';
import type { Config } from './config.ts';
import type { DecodedDelegate } from './relay.ts';

export interface ChainEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface TxOutcome {
  hash: string;
  events: ChainEvent[];
  /** A contract error such as E_FOUR_EYES, if any receipt failed. */
  failure?: string;
}

/** What a browser needs to sign a delegate action without its own RPC access. */
export interface SignContext {
  nonce: string;
  blockHeight: string;
}

export interface Chain {
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  tokenBalance(accountId: string): Promise<bigint>;
  signContext(accountId: string, publicKey: string): Promise<SignContext>;
  relay(signed: DecodedDelegate): Promise<TxOutcome>;
  settle(method: string, args: Record<string, unknown>, tgas: number): Promise<TxOutcome>;
}

export function parseEvents(logs: string[]): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const log of logs) {
    if (!log.startsWith('EVENT_JSON:')) continue;
    try {
      const parsed = JSON.parse(log.slice('EVENT_JSON:'.length)) as {
        standard: string;
        event: string;
        data: Record<string, unknown>[];
      };
      if (parsed.standard !== 'nostro') continue;
      events.push({ event: parsed.event, data: parsed.data[0] ?? {} });
    } catch {
      // Not one of ours. A log line is not something to fail a payment over.
    }
  }
  return events;
}

interface Outcome {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; outcome?: { logs?: string[] } };
  receipts_outcome?: { outcome?: { logs?: string[]; status?: unknown } }[];
}

const ERROR_CODE = /E_[A-Z0-9_]+/;

function findFailure(outcome: Outcome): string | undefined {
  for (const receipt of outcome.receipts_outcome ?? []) {
    const status = receipt.outcome?.status as { Failure?: unknown } | undefined;
    if (status && typeof status === 'object' && 'Failure' in status) {
      const text = JSON.stringify(status.Failure);
      return ERROR_CODE.exec(text)?.[0] ?? text.slice(0, 300);
    }
  }
  return undefined;
}

function summarize(raw: unknown): TxOutcome {
  const outcome = raw as Outcome;
  const logs = [
    ...(outcome.transaction_outcome?.outcome?.logs ?? []),
    ...(outcome.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome?.logs ?? []),
  ];
  const failure = findFailure(outcome);
  return {
    hash: outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? '',
    events: parseEvents(logs),
    ...(failure ? { failure } : {}),
  };
}

export class NearChain implements Chain {
  private readonly provider: JsonRpcProvider;
  private readonly contractId: string;
  private readonly tokenId: string;
  private readonly relayer?: Account;
  private readonly settler?: Account;

  constructor(config: Config) {
    this.provider = new JsonRpcProvider({ url: config.rpcUrl });
    this.contractId = config.contractId;
    this.tokenId = config.tokenId;
    if (config.relayer) {
      this.relayer = new Account(
        config.relayer.accountId,
        this.provider,
        config.relayer.privateKey as `ed25519:${string}`,
      );
    }
    if (config.settler) {
      this.settler = new Account(
        config.settler.accountId,
        this.provider,
        config.settler.privateKey as `ed25519:${string}`,
      );
    }
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.provider.callFunction({
      contractId: this.contractId,
      method,
      args,
    });
    return result as T;
  }

  async tokenBalance(accountId: string): Promise<bigint> {
    const balance = await this.provider.callFunction({
      contractId: this.tokenId,
      method: 'ft_balance_of',
      args: { account_id: accountId },
    });
    return BigInt(String(balance));
  }

  async signContext(accountId: string, publicKey: string): Promise<SignContext> {
    const [key, block] = await Promise.all([
      this.provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'final' } }),
      this.provider.viewBlock({ finality: 'final' }),
    ]);
    return { nonce: String(key.nonce), blockHeight: String(block.header.height) };
  }

  async relay(signed: DecodedDelegate): Promise<TxOutcome> {
    if (!this.relayer) throw new Error('No relayer key is configured, so this portal is read-only.');
    try {
      return summarize(await this.relayer.relayMetaTransaction(signed as never));
    } catch (error) {
      return failureFrom(error);
    }
  }

  async settle(method: string, args: Record<string, unknown>, tgas: number): Promise<TxOutcome> {
    if (!this.settler) throw new Error('No settler key is configured, so this portal is read-only.');
    try {
      const outcome = await this.settler.signAndSendTransaction({
        receiverId: this.contractId,
        actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)],
      });
      return summarize(outcome);
    } catch (error) {
      return failureFrom(error);
    }
  }
}

function failureFrom(error: unknown): TxOutcome {
  const text = error instanceof Error ? error.message : String(error);
  return { hash: '', events: [], failure: ERROR_CODE.exec(text)?.[0] ?? text.slice(0, 300) };
}
