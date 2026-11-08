// Talks to the server. Types mirror apps/server/src/api.ts.

export interface PortalConfig {
  network: 'testnet' | 'mainnet';
  contractId: string;
  tokenId: string;
  company: string;
  rpcUrl: string;
  readOnly: boolean;
  demoKeys: boolean;
  /** Prefix that links a transaction hash to an explorer. Null on the simulated chain. */
  explorerTxUrl: string | null;
}

export interface Call {
  method: string;
  args: Record<string, unknown>;
}

export interface RunSummary {
  id: number;
  status: string;
  maker: string;
  approvals: string[];
  totalUsd: string;
  lineCount: number;
  sent: number;
  createdAt: string;
  messageId: string | null;
  format: string | null;
  fileSha256: string;
}

export interface Route {
  chain: string;
  asset: string;
  address: string;
}

export interface RunLine {
  index: number;
  status: string;
  iso: { status: string; reasonCode?: string; reasonText?: string };
  /** NEAR Intents' own status for a routed payment, on mainnet. */
  routerStatus: string | null;
  /** The transaction that paid this line. */
  txHash: string | null;
  hold: string | null;
  receiver: string;
  amountUsd: string;
  principalUsd: string | null;
  creditorName: string | null;
  endToEndId: string | null;
  remittance: string | null;
  route: Route | null;
}

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  lineIndex?: number;
}

export interface RunTx {
  step: 'Submitted' | 'Approved' | 'Rejected' | 'Paid';
  hash: string;
  by?: string;
  lines?: number[];
}

export interface RunDetail extends RunSummary {
  rejectedReason: string | null;
  issues: Issue[];
  /** Each step of the run on chain, in order. */
  transactions: RunTx[];
  lines: RunLine[];
  /** As the server reports them. The browser reads the chain directly when it can. */
  recordedLines: { e2e_hash: string; payee_key: string; amount: string; receiver: string }[];
}

export type PayeeState = 'unknown' | 'unapproved' | 'cooloff' | 'active';

export interface PreviewLine {
  index: number;
  endToEndId: string;
  amountMinor: string;
  creditorName: string;
  creditorAccount: { kind: string; value: string };
  remittance?: string;
  payeeKey: string;
  state: PayeeState;
  receiver: string | null;
  route: Route | null;
  estimate: { feeBase: string; etaSeconds: number; route: Route } | null;
}

export interface Preview {
  run: {
    format: string;
    messageId: string;
    initiatingParty: string;
    requestedExecutionDate?: string;
    controlSumMinor: string;
    issues: Issue[];
    lines: unknown[];
  };
  lines: PreviewLine[];
  missing: number[];
  duplicate: boolean;
  canSubmit: boolean;
  comparison: { quotedLines: number; feeUsd: string; wireFeeUsd: number; note: string };
}

export interface Payee {
  key: string;
  name: string;
  account: string;
  route: Route;
  testnetReceiver?: string;
  state: PayeeState;
}

export interface Overview {
  balanceUsd: string;
  availableUsd: string;
  spentTodayUsd: string;
  contract: {
    required_approvals: number;
    per_payment_limit: string;
    daily_limit: string;
    payee_cooloff_ns: string;
  };
}

export interface Verification {
  statementId: string;
  entries: number;
  openingUsd: string;
  closingUsd: string;
  tie: {
    ledgerBalance: string;
    tokenBalance: string;
    difference: string;
    ties: boolean;
    ledgerFoots: boolean;
    entries: number;
  };
  sha256: string;
  anchored: boolean;
  anchorMatches: boolean;
  anchorBlock: string | null;
  anchorTx: string | null;
}

export class ApiError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('The server could not be reached.');
  }
  const text = await response.text();
  let body: { error?: string; code?: string } & Record<string, unknown>;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new ApiError(`The server sent an unexpected reply (${response.status}).`);
  }
  if (!response.ok) throw new ApiError(body.error ?? 'That did not work.', body.code);
  return body as T;
}

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
