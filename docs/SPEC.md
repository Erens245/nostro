# Nostro: technical spec

The single reference for everyone building a piece of this repo. If code and this file disagree, fix whichever is wrong and say so.

## Repo layout

```
nostro/
  contract/             Rust near-sdk contract (done first, see contract/src/lib.rs)
  mock-usdc/            Test-only NEP-141 with open mint. Testnet only
  packages/bankfiles/   Pure TypeScript: read payment files, write status and statement files. No chain code
  apps/server/          Node API: orchestrates runs, relayer, 1Click, statement building
  apps/web/             React portal (Vite)
  fixtures/             Sample input files made by independent tools
  schemas/              Fetches the ISO 20022 XSDs, pinned by hash. Their licence limits redistribution
  scripts/              deploy, demo, verify, browser check
```

npm workspaces. TypeScript strict mode. ESM. Node 26. No floats for money, ever: integers as `bigint` in code and decimal strings in JSON.

## Money units

| Unit | Meaning |
| --- | --- |
| minor | Cents. `$12.34` is `1234n`. What bank files mean |
| base | Token units. USDC has 6 decimals, so `$12.34` is `12340000n` |

`base = minor * 10000n`. Only USD files are accepted in the first version. Any other currency is an error, not a conversion.

## The canonical run

Every reader returns this shape. Nothing downstream knows which format came in.

```ts
export type SourceFormat = 'pain.001.001.03' | 'pain.001.001.09' | 'nacha' | 'csv';

export interface Issue {
  severity: 'error' | 'warning';
  code: string;          // stable, e.g. CONTROL_SUM_MISMATCH
  message: string;       // plain English for a finance clerk
  lineIndex?: number;    // zero-based index into lines
}

export interface PayeeAccount {
  kind: 'IBAN' | 'ACCOUNT' | 'NEAR';
  value: string;         // as written in the file
  routing?: string;      // NACHA routing number or BIC when present
}

export interface CanonicalLine {
  index: number;
  endToEndId: string;
  instructionId?: string;
  amountMinor: bigint;
  currency: 'USD';
  creditorName: string;
  creditorAccount: PayeeAccount;
  remittance?: string;   // free text, e.g. the invoice number
  purposeCode?: string;  // e.g. SALA, SUPP
}

export interface CanonicalRun {
  format: SourceFormat;
  messageId: string;
  createdAt: string;           // ISO 8601
  initiatingParty: string;
  debtorName?: string;
  debtorAccount?: string;
  requestedExecutionDate?: string; // YYYY-MM-DD
  controlSumMinor: bigint;     // computed from lines
  declaredControlSumMinor?: bigint; // what the file claimed
  declaredCount?: number;
  lines: CanonicalLine[];
  issues: Issue[];
  sourceSha256: string;        // hex SHA-256 of the exact input bytes
}
```

A file with any `error` issue can't be submitted. Readers report problems rather than throwing, so a clerk sees all of them at once. They throw only on input so broken it can't be recognized.

## Readers

| Function | Reads |
| --- | --- |
| `detectFormat(bytes)` | Returns a `SourceFormat` or null |
| `readPaymentFile(bytes, opts?)` | Detects, then parses |
| `readPain001(xml)` | `pain.001.001.03` and `.09`. Multiple `PmtInf` blocks allowed |
| `readNacha(text)` | NACHA fixed width, 94 columns, PPD and CCD entries. Checks hash and totals |
| `readCsv(text, mapping?)` | Delimited text. Maps common headers (`name`, `payee`, `account`, `amount`, `reference`) automatically |

Must check:

- Declared `NbOfTxs` and `CtrlSum` against the lines
- Every amount is positive with at most two decimals
- Currency is USD
- `EndToEndId` present. `NOTPROVIDED` is the ISO placeholder and is a warning; generate a stable id from `MsgId` + index
- Duplicate `EndToEndId` inside the file is an error
- NACHA entry hash and batch and file control totals

XML parsing must be safe: no external entities, no network access.

**NEAR accounts in files.** A creditor account is `kind: 'NEAR'` when `<Othr><SchmeNm><Prtry>` is `NEAR`, or when the value is a valid NEAR account id ending in `.near` or `.testnet`.

## Writers

All take a `StatementInput` or `StatusInput` built from chain data. Pure functions, deterministic for the same input.

```ts
export type StatusCode = 'ACCP' | 'ACSP' | 'ACSC' | 'RJCT' | 'PDNG';

export interface LineStatusInput {
  endToEndId: string;
  instructionId?: string;
  status: StatusCode;
  reasonCode?: string;      // ISO external code, e.g. AM04, DUPL, AC01
  reasonText?: string;
}

export interface StatusInput {
  messageId: string;            // id of this report
  createdAt: string;
  originalMessageId: string;
  originalFormat: SourceFormat;
  groupStatus: StatusCode | 'PART';
  lines: LineStatusInput[];
}

export interface StatementEntry {
  seq: number;              // on-chain ledger sequence
  bookedAt: string;         // ISO 8601
  direction: 'debit' | 'credit';
  amountMinor6: bigint;     // base units, 6 decimals
  principalMinor6?: bigint; // what the payee received, when different
  feeMinor6?: bigint;       // routing cost
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
  accountId: string;        // the NEAR contract account
  accountName: string;      // e.g. "USDC on NEAR"
  ownerName: string;
  currency: 'USD';
  periodFrom: string;       // YYYY-MM-DD
  periodTo: string;
  openingBalance: bigint;   // base units
  closingBalance: bigint;   // base units
  entries: StatementEntry[];
}
```

| Function | Writes | Read by |
| --- | --- | --- |
| `writePain002(StatusInput)` | `pain.002.001.10` XML | ERPs, for payment status |
| `writeCamt053(StatementInput)` | `camt.053.001.08` XML | SAP, Oracle, Odoo and other ERPs |
| `writeOfx(StatementInput)` | OFX 2.x | Xero, QuickBooks, GnuCash |
| `writeMt940(StatementInput)` | SWIFT MT940 text | Older ERPs and banks |
| `writeCsv(StatementInput)` | CSV | Anyone. One row per entry, opening and closing shown |
| `writeNearBusinessCsv(CanonicalRun, resolve)` | `alice.near, 10.50` per line | NEAR Business bulk payments, which needs one token |

Statement rules:

- `opening + credits - debits` must equal `closing`, or the writer throws.
- USDC has 6 decimals and bank formats have 2. Statement amounts round to cents **per entry, half up**. Carry any leftover cents in a final `ROUNDING` entry so a statement always balances to the cent. The sum of all rounding must be shown, never hidden.
- A debit with a fee shows the total as the entry amount, with `AmtDtls` carrying the principal and `Chrgs` the fee in camt.053. In OFX and MT940 and CSV it becomes two entries, principal and fee, so a bill can match its exact amount.
- `currency` is `USD`, with the account named `USDC on NEAR`, because statement formats require a three-letter currency code and USDC has none. This is a stated assumption of a 1:1 peg, and every writer's output must carry that note where the format allows it.

Reason codes to use: `AM04` insufficient funds, `DUPL` duplicate, `AC01` bad account, `AC06` blocked account (payee in cool-off or unapproved), `AM02` over limit, `NARR` anything else with text.

## Status mapping

| 1Click status | Contract state | ISO status |
| --- | --- | --- |
| none | Pending, run not approved | `PDNG` |
| `PENDING_DEPOSIT` | Sending | `ACSP` |
| `KNOWN_DEPOSIT_TX` | Sending | `ACSP` |
| `PROCESSING` | Sent | `ACSP` |
| `SUCCESS` | Sent | `ACSC` |
| `INCOMPLETE_DEPOSIT` | Sent | `RJCT` with `AM09` |
| `REFUNDED` | Sent | `RJCT` with `NARR` |
| `FAILED` | Sent or Failed | `RJCT` with `NARR` |
| n/a on testnet | Sent | `ACSC` |
| n/a | Failed | `RJCT` |

## Hashes sent to the contract

All lowercase hex SHA-256 of UTF-8 text.

| Field | Input |
| --- | --- |
| `message_hash` | `{debtor-or-initiating-party}|{messageId}` |
| `file_sha256` | Exact input bytes |
| `e2e_hash` | `{debtor-or-initiating-party}|{endToEndId}`. The message id is left out on purpose, so one payment can't be repeated in a new file |
| `payee_key` | Account value, trimmed, lowercased, spaces removed |
| `route_hash` | `{chain}|{asset}|{address}` |

## Contract

See `contract/src/lib.rs`. Roles: Maker, Checker, Settler. Errors are stable `E_*` strings the UI maps to plain English.

## Payout rails

Both produce a `receiver` and an `amount` per line, so the contract treats them alike.

| Rail | Network | Receiver | Fee |
| --- | --- | --- | --- |
| Direct | Testnet | The payee's own account | None |
| Intents | Mainnet | 1Click `depositAddress`, funded by `ft_transfer_call` to `intents.near` with `msg` set to that address | From the quote |

Mainnet quote parameters: `swapType: EXACT_OUTPUT`, `depositType: INTENTS`, `recipientType: DESTINATION_CHAIN`, `refundType: ORIGIN_CHAIN`, `refundTo` the contract account, `slippageTolerance: 10`. Quotes are taken before approval, so the approver sees the final numbers and the contract stores the exact deposit addresses. `dry: true` powers previews. Every real quote needs human approval while this is a hackathon entry.

`refundTo` must be an account that exists. If it doesn't, 1Click answers `Internal server error`, which looks like a problem with the quote types and isn't. Previews on testnet borrow `intents.near`. All four pairings of `INTENTS` and `ORIGIN_CHAIN` were accepted by dry quotes on 7 Nov 2026, with `INTENTS` deposits estimated at 12 seconds and `ORIGIN_CHAIN` at 22.

## Rules for the whole repo

- Never commit secrets. Keys live in `.env`, which is git-ignored.
- No marketing language in README or code comments.
- Mainnet actions are behind an explicit `NOSTRO_ALLOW_MAINNET=yes`, and a human sets it.
- Everything a judge runs must work without keys.
