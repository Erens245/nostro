// Off-chain details: the original files, and what chain data alone can't say
// (names and account numbers, which must never go on a public chain).
//
// Plain JSON files. The stored file bytes are the source of truth for a run: it
// is parsed again on load, rather than trusting a saved copy of the parse.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPaymentFile } from '@nostro/bankfiles';
import type { Payee, ResolvedLine, RunDetail, SubmitArgs } from './domain.ts';

interface StoredLine {
  index: number;
  payeeKey: string;
  receiver: string;
  amountBase: string;
  principalBase: string;
  depositAddress?: string;
  route?: ResolvedLine['route'];
}

export interface Draft {
  id: string;
  createdAt: string;
  fileName: string;
  fileBase64: string;
  company: string;
  lines: StoredLine[];
  submitArgs: SubmitArgs;
  runId?: number;
}

interface State {
  payees: Payee[];
  drafts: Draft[];
  holds: Record<string, Record<string, string>>;
  transactions: Record<string, string>;
}

const empty = (): State => ({ payees: [], drafts: [], holds: {}, transactions: {} });

export class Store {
  private readonly path: string;
  private readonly state: State;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'store.json');
    this.state = existsSync(this.path)
      ? { ...empty(), ...(JSON.parse(readFileSync(this.path, 'utf8')) as Partial<State>) }
      : empty();
  }

  private save(): void {
    // Write then rename, so a crash can't leave half a file.
    const next = `${this.path}.tmp`;
    writeFileSync(next, JSON.stringify(this.state, null, 2));
    renameSync(next, this.path);
  }

  payees(): Payee[] {
    return this.state.payees;
  }

  findPayee(key: string): Payee | undefined {
    return this.state.payees.find((payee) => payee.key === key);
  }

  savePayee(payee: Payee): void {
    const others = this.state.payees.filter((entry) => entry.key !== payee.key);
    this.state.payees = [...others, payee];
    this.save();
  }

  saveDraft(
    input: Pick<Draft, 'fileName' | 'company' | 'submitArgs'> & {
      bytes: Uint8Array;
      resolved: ResolvedLine[];
    },
  ): Draft {
    const draft: Draft = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      fileName: input.fileName,
      fileBase64: Buffer.from(input.bytes).toString('base64'),
      company: input.company,
      submitArgs: input.submitArgs,
      lines: input.resolved.map((line) => ({
        ...line,
        amountBase: line.amountBase.toString(),
        principalBase: line.principalBase.toString(),
      })),
    };
    this.state.drafts.push(draft);
    this.save();
    return draft;
  }

  draft(id: string): Draft | undefined {
    return this.state.drafts.find((draft) => draft.id === id);
  }

  draftForRun(runId: number): Draft | undefined {
    return this.state.drafts.find((draft) => draft.runId === runId);
  }

  bindRun(draftId: string, runId: number): void {
    const draft = this.draft(draftId);
    if (!draft) return;
    draft.runId = runId;
    this.save();
  }

  /** The file bytes behind a run, exactly as uploaded. */
  fileOf(draft: Draft): Buffer {
    return Buffer.from(draft.fileBase64, 'base64');
  }

  detail(runId: number): RunDetail | undefined {
    const draft = this.draftForRun(runId);
    if (!draft) return undefined;
    return {
      run: readPaymentFile(this.fileOf(draft), {
        company: draft.company,
        now: new Date(draft.createdAt),
      }),
      resolved: draft.lines.map((line) => ({
        ...line,
        amountBase: BigInt(line.amountBase),
        principalBase: BigInt(line.principalBase),
      })),
    };
  }

  recordHold(runId: number, line: number, reason: string): void {
    const holds = (this.state.holds[runId] ??= {});
    holds[line] = reason;
    this.save();
  }

  clearHold(runId: number, line: number): void {
    const holds = this.state.holds[runId];
    if (!holds || !(line in holds)) return;
    delete holds[line];
    this.save();
  }

  holds(runId: number): Record<number, string> {
    return (this.state.holds[runId] ?? {}) as Record<number, string>;
  }

  recordTx(seq: number, hash: string): void {
    this.state.transactions[seq] = hash;
    this.save();
  }

  txHashOf(seq: number): string | undefined {
    return this.state.transactions[seq];
  }
}
