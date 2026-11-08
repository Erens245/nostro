// The shared shapes. Every reader returns a CanonicalRun, so nothing downstream
// knows or cares which file format came in. See docs/SPEC.md.

export type SourceFormat =
  | 'pain.001.001.03'
  | 'pain.001.001.09'
  | 'nacha'
  | 'csv';

export interface Issue {
  severity: 'error' | 'warning';
  /** Stable, for example CONTROL_SUM_MISMATCH. */
  code: string;
  /** Plain English for a finance clerk. */
  message: string;
  /** Zero-based index into lines. */
  lineIndex?: number;
}

export interface PayeeAccount {
  kind: 'IBAN' | 'ACCOUNT' | 'NEAR';
  /** As written in the file. */
  value: string;
  /** NACHA routing number, or a BIC, when the file has one. */
  routing?: string;
}

export interface CanonicalLine {
  index: number;
  endToEndId: string;
  instructionId?: string;
  amountMinor: bigint;
  currency: 'USD';
  creditorName: string;
  creditorAccount: PayeeAccount;
  /** Free text, for example the invoice number. */
  remittance?: string;
  /** For example SALA or SUPP. */
  purposeCode?: string;
}

export interface CanonicalRun {
  format: SourceFormat;
  messageId: string;
  /** ISO 8601. */
  createdAt: string;
  initiatingParty: string;
  debtorName?: string;
  debtorAccount?: string;
  /** YYYY-MM-DD. */
  requestedExecutionDate?: string;
  /** Computed from the lines. */
  controlSumMinor: bigint;
  /** What the file claimed. */
  declaredControlSumMinor?: bigint;
  declaredCount?: number;
  lines: CanonicalLine[];
  issues: Issue[];
  /** Hex SHA-256 of the exact input bytes. */
  sourceSha256: string;
}

export type StatusCode = 'ACCP' | 'ACSP' | 'ACSC' | 'RJCT' | 'PDNG';

export interface LineStatusInput {
  endToEndId: string;
  instructionId?: string;
  status: StatusCode;
  /** ISO external code, for example AM04, DUPL or AC01. */
  reasonCode?: string;
  reasonText?: string;
}

export interface StatusInput {
  /** Id of this report. */
  messageId: string;
  createdAt: string;
  originalMessageId: string;
  originalFormat: SourceFormat;
  originalCreatedAt?: string;
  originalCount?: number;
  originalControlSumMinor?: bigint;
  groupStatus: StatusCode | 'PART';
  lines: LineStatusInput[];
}

export interface StatementEntry {
  /** On-chain ledger sequence. */
  seq: number;
  /** ISO 8601. */
  bookedAt: string;
  direction: 'debit' | 'credit';
  /** Base units, 6 decimals. */
  amountMinor6: bigint;
  /** What the payee received, when it differs from the amount. */
  principalMinor6?: bigint;
  /** Routing cost. */
  feeMinor6?: bigint;
  counterpartyName?: string;
  counterpartyAccount?: string;
  endToEndId?: string;
  reference: string;
  remittance?: string;
  txHash?: string;
}

export interface StatementInput {
  statementId: string;
  createdAt: string;
  /** The NEAR contract account. */
  accountId: string;
  /** For example "USDC on NEAR". */
  accountName: string;
  ownerName: string;
  currency: 'USD';
  /** YYYY-MM-DD. */
  periodFrom: string;
  periodTo: string;
  /** Base units. */
  openingBalance: bigint;
  /** Base units. */
  closingBalance: bigint;
  entries: StatementEntry[];
  /**
   * Turns a transaction hash into an explorer link when prefixed to it, for
   * example "https://testnet.nearblocks.io/txns/". Only the CSV uses it.
   */
  explorerTxUrl?: string;
}
