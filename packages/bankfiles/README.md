# @nostro/bankfiles

Reads the payment files accounting software exports, and writes the status reports and statements it imports. Pure TypeScript with no chain code. Money is always an integer.

## Formats

| Direction | Format | Function |
| --- | --- | --- |
| In | ISO 20022 `pain.001.001.03` and `.09` | `readPain001` |
| In | NACHA ACH, PPD and CCD credits | `readNacha` |
| In | CSV, TSV and semicolon lists | `readCsv` |
| In | Any of the above, detected | `readPaymentFile` |
| Out | `pain.002.001.10` status report | `writePain002` |
| Out | `camt.053.001.08` statement | `writeCamt053` |
| Out | OFX 1.0.2 (default) or 2.2.0 | `writeOfx` |
| Out | SWIFT MT940 | `writeMt940` |
| Out | CSV statement | `writeCsv` |
| Out | NEAR Business bulk payment list | `writeNearBusinessCsv` |

## Try it

From the repo root:

1. Run `npm install`.
2. Run `npm test --workspace @nostro/bankfiles`. See every test pass, with `# skipped 0`.

The tests fetch the ISO schemas first, using `schemas/fetch.mjs`. Without a network they report SKIP for those checks rather than passing them.

## How it is checked

Tests that only read back our own output prove little, so:

| Claim | Checked by |
| --- | --- |
| We read real pain.001 files | Files made by the third-party [`sepa`](https://www.npmjs.com/package/sepa) library, themselves schema-valid |
| We read real NACHA files | A file made by [`nach2`](https://www.npmjs.com/package/nach2) |
| Our XML is valid | The ISO 20022 XSDs, through `xmllint-wasm`. Negative controls confirm the validator rejects bad documents |
| Our camt.053 is readable | [`@financica/camt053`](https://www.npmjs.com/package/@financica/camt053) |
| Our OFX is readable | [`ofx-js`](https://www.npmjs.com/package/ofx-js) and [`node-ofx-parser`](https://www.npmjs.com/package/node-ofx-parser) |
| Our MT940 is readable | [`mt940js`](https://www.npmjs.com/package/mt940js) |
| Statements balance to the cent | 2,000 random statements through the rounding code, then 200 per format read back by those parsers, comparing opening, entries and closing |

## What has not been proven

- **No real ERP or accounting product has read these files yet.** Xero, QuickBooks, SAP, Odoo and GnuCash are untested. Passing a schema and a parser library is good evidence, not proof that a given importer accepts a file.
- **No real ERP wrote the inputs either.** The fixtures come from libraries. A file from SAP may use parts of pain.001 those libraries don't.
- **OFX `BANKID` is `NEAR`.** A strict importer may expect a numeric routing number. This is untested.
- **`pain.002.001.10` schema has one source.** See `schemas/README.md`.

## Limits

- USD only. Anything else is an error, never a conversion.
- `pain.001` versions other than `.03` and `.09` are refused, including the German `pain.001.003.03`.
- NACHA reads credits. A debit is treated as a balancing entry and reported as a warning. IAT is not supported.
- CSV columns are matched by name. A European number such as `1.234,56` is refused, not guessed at.
- A CSV has no id of its own, so the id comes from a hash of its content. Two CSVs with identical bytes are the same file. Add an id or date column to a list that repeats unchanged each month.
- MT940 writes one statement for the whole period, without SWIFT header blocks, and cuts long text to fit.
- camt.053 clips account ids to 34 characters, because the format does. The full id is in the statement's note.

## Amounts shown as USD

Statement formats need a three-letter currency code and USDC has none. Statements say `USD`, name the account `USDC on NEAR`, and carry a note saying 1 USDC is taken as 1 USD. That is an assumption an accountant should know about.

## Rounding

Tokens have 6 decimals and banks have 2. Each entry rounds half up on its own. If the rounded entries don't reach the rounded closing balance, the difference appears as a visible `ROUNDING` entry. It is never spread across other entries. An entry too small to show as a cent is folded into that difference and counted in `belowOneCent`.
