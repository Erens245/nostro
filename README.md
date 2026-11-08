# Nostro

Pay from a NEAR account using the files your accounting software already exports.

Track: Real-World Money (`realworld`). Built at NEAR HACKATHON, November 2026.

## What it is

A company's accounting or payroll software can already produce a payment file, and can already import a bank statement. Nostro accepts that same file, pays each line in stablecoins on the chain each payee chose, and returns a status report and a statement the software can read. The company changes nothing about how it works.

A *nostro* account is banking's term for "our account held elsewhere".

## The problem

Paying a supplier or contractor abroad by wire has a median fee of $45 before FX margin, and usually takes days. Stablecoins are far cheaper, but today a finance team has to adopt a new app, a wallet and a gas token, and then re-key what comes out of it into their books. Most companies won't do that.

## For the bookkeeper

- **What you give it:** the payment file your accounting or payroll software already exports for the bank. That's an ISO 20022 pain.001, a NACHA file, or a CSV with name, account and amount.
- **What you get back:** a status report for each run (pain.002), and a statement for any period as camt.053, OFX, MT940 or CSV. You import it as you would a bank statement.
- **What a statement shows:** every payment, with its routing fee shown separately, every incoming transfer, and a running balance. If rounding to the cent leaves a difference, it appears as its own line, so the statement always adds up. Amounts are USDC shown as US dollars at 1:1, and the statement says so.
- **What a status means:** *Pending* is waiting for approval or release. *Settled* is paid. *Rejected* is not paid, with the reason beside it. *Refunded* means the money came back to the company's account.
- **How to check it:** every step and every payment names the NEAR transaction behind it, linked to the NearBlocks explorer. The CSV has the same link on each row, and opens in Excel as it is.

## How it works

```
Accounting software                              Accounting software
  exports a file                                   imports a statement
       |                                                  ^
       v                                                  |
  Read and check  -->  Clerk submits  -->  Second    -->  Ledger on chain
  pain.001, NACHA,     (no gas: a          person         balances to the
  CSV                  relayer pays)       approves       token contract
                                              |
                                              v
                                     Contract enforces the controls,
                                     NEAR Intents pays each line
```

## Try it

You need Node 22.18 or newer. Rust is optional.

**1. Run every check.**

```sh
npm install
npm run verify
```

You see one `PASS`, `FAIL` or `SKIP` per claim, and a summary. It needs no keys and spends nothing. `SKIP` means a check couldn't run on your machine, not that it passed.

**2. Use the portal.** This runs the real server and portal against a simulated chain, so it needs no accounts. Fee quotes are real, from the public 1Click API, with `dry: true`.

```sh
npm run build
npm run preview
```

1. Open http://127.0.0.1:8799. You see a sign-in page with two roles.
2. Click **Finance clerk**. You see a $20,000.00 balance.
3. Click **New payment run** and choose `fixtures/pain.001.001.03.xml`. You see 5 payments totalling $9,348.55, live routing costs for each, and a comparison with the same payments by wire.
4. Click **Submit for approval**. You see the run waiting for approval. The clerk is offered no approve button.
5. Click **Sign out**, then **Finance director**.
6. Click **Approvals**, then **Run 1**. You see **Checked on this device**: the browser fetched the original file, hashed it and read it itself.
7. Click **Approve**, then **Release payments**. Each payment shows **Settled** and the transaction that paid it, and **On chain** lists every step. On the simulated chain these ids aren't on an explorer. On testnet they link to NearBlocks.
8. Click **Statements**. You see **This statement ties to the chain**. Download camt.053, OFX, MT940 or CSV.

**3. Try to break it.** Click **Sign out**, **Finance clerk**, then **New payment run**, and choose `fixtures/pain.001.001.03.xml` again. You see **This file has already been submitted**, and the button is disabled.

**4. Automate the browser steps.** The preview keeps its runs in memory, so stop it and start `npm run preview` again first. With a fresh preview and Chrome installed, `node scripts/browser-check.mjs` walks the same path in a real browser and prints one `PASS` per step.

**5. Check a deployment.** See [Deployment](#deployment).

## What is real

| Part | Status |
| --- | --- |
| Contract | Rust, near-sdk 5.30. `cargo test` in `contract/` covers each control |
| Payment file readers | Tested on files made by third-party libraries, not by this project |
| Statement and status writers | XML validated against ISO 20022 schemas. Every format read back by independent parsers |
| Gasless approvals | NEP-366 delegates signed in the browser. The relayer decodes each one and refuses anything but a permitted call |
| Fee quotes | Real, live, from 1Click with `dry: true` |
| Transaction links | Each run step, payment and statement anchor links to its NEAR transaction on NearBlocks. The simulated preview shows ids with no link |
| Payouts through NEAR Intents | **Code path unit-tested, not yet run with real money.** NEAR Intents has no testnet |
| Real accounting software | GnuCash's importers (LibOFX, AqBanking) read our OFX, MT940 and camt.053 from the command line, with balances correct to the cent. See `proof/` and `scripts/interop-gnucash.mjs` |
| Xero, QuickBooks, SAP, Odoo | **Not tested.** Nor has a file been clicked through GnuCash's own import screens |
| `npm run preview` | Simulated chain. Labelled as such |

## What NEAR does here

| Feature | Why it's needed |
| --- | --- |
| NEAR Intents | One USDC balance pays out on many chains. `EXACT_OUTPUT` means a payee gets the exact invoice amount, and the cost shows up as a separate fee |
| Meta transactions (NEP-366) | Finance staff never hold or see NEAR. The relayer only pays for staff methods on our own contract |
| Function-call keys | Segregation of duties is enforced by the protocol. A clerk's key can't call `approve_run`, and owner actions need one yoctoNEAR, which a function-call key can't attach |
| Named accounts | `supplier.near` fits in the "account number" field of an ERP vendor record, so a file can name a payee directly |
| NEAR Business | Bulk-payment export, for a sensitive run such as payroll, through a confidential treasury |

## Controls the contract enforces

Each has unit tests in `contract/src/tests.rs`.

- **Four eyes.** The person who submitted a run can never approve it, and one person can't supply two approvals.
- **Exact approval.** An approval names the SHA-256 of the file.
- **Bound receivers.** On direct payments a payee can only be paid at the account approved for them, so a run can't name an approved payee and send the money elsewhere.
- **Duplicates.** A file, or a single payment moved into a new file, can't be paid twice. Rejecting a run releases it for correction.
- **Payee cool-off.** New or changed payee details lose their approval, which blunts "our bank details have changed" fraud.
- **Limits.** Per-payment and daily caps, checked as money moves.
- **Ledger.** Each debit and credit has a running balance, so a statement can be rebuilt from view calls alone. A statement can only be anchored if its closing balance matches the ledger.

Only hashes go on chain. Names and account numbers stay off chain.

The approver's browser adds one more check that the contract can't do, because it never sees the file. It re-reads the original file, then compares every recorded line with it: amount, payee and payment id. A matching file hash alone wouldn't be enough, since money follows the recorded lines. If they differ, the page says not to approve and the button stays disabled.

## Layout

| Path | What it is |
| --- | --- |
| `contract/` | The Nostro contract |
| `mock-usdc/` | Valueless test token with open minting. Refuses to initialize outside testnet |
| `packages/bankfiles/` | File readers and writers. No chain code |
| `apps/server/` | Run orchestration, relayer, statements |
| `apps/web/` | The portal |
| `fixtures/` | Sample payment files |
| `schemas/` | Script that fetches the ISO schemas, pinned by hash. The schemas aren't redistributed here |
| `scripts/` | Deploy, demo, verify, browser check, and the plain-language explainer video (`record-explainer.mjs`) |
| `docs/` | Design notes, spec and mainnet runbook |

## Deployment

`deployment.json` holds the live testnet contract, if one has been deployed from this checkout, and `proof/` holds the record of a full run. `npm run verify` then reads the chain and checks, with no keys:

- every ledger entry adds up and the total equals the token contract's balance
- staff accounts hold only function-call keys, limited to their own methods
- `proof/statement.camt053.xml` hashes to the value stored on chain

To deploy your own, from one funded testnet account, with Rust and [cargo-near](https://github.com/near/cargo-near) installed:

```sh
cd contract && cargo near build non-reproducible-wasm --no-abi && cd ..
cd mock-usdc && cargo near build non-reproducible-wasm --no-abi && cd ..
NOSTRO_FUNDER_ID=you.testnet NOSTRO_FUNDER_KEY=ed25519:... node scripts/deploy-testnet.ts
node --env-file=.keys/testnet.env scripts/demo-testnet.ts
```

## Limits

- This is software, not a bank, and it is not a licensed payment service. It doesn't reach local bank accounts: payees must be willing to receive stablecoins.
- USD only. Statements show USDC as USD at 1:1, and say so.
- Public-chain payouts can be observed. The `confidentiality` quote option returned 401 without user authentication when tested, so private payouts aren't claimed. Use the NEAR Business export for sensitive runs.
- The approver's check runs in code the portal serves, so a fully compromised server could serve a tampered page. A real deployment needs the portal hosted separately from the service holding the relayer and settler keys.
- Through NEAR Intents each payment has a one-time deposit account, so the contract can't bind a receiver the way it does for direct payments. The destination is inside the 1Click quote, so on mainnet the approver's browser checks that instead: the quote must be signed by 1Click and pay the approved route, with refunds back to this account. It's tested against a real signed quote, and hasn't yet guarded a real payment.
- Payee details are stored by the server as plain JSON. That's fine for a demo and not for production.
- Demo sign-in hands out throwaway testnet keys, and only when `NOSTRO_DEMO_KEYS=yes` on testnet.

## Libraries and tools

**Runtime:** near-sdk, near-contract-standards, near-api-js, borsh, saxes, @noble/hashes, @noble/curves, @scure/base, React, React DOM.

**Build:** cargo-near, TypeScript, Vite, @vitejs/plugin-react.

**Tests only:** sepa and nach2 (making fixtures), ofx-js, node-ofx-parser, mt940js, @financica/camt053 (reading our output), xmllint-wasm (schema validation), GnuCash's LibOFX and AqBanking (reading our statements), headless Chrome (browser check).

**Demo and explainer videos:** headless Chrome, ffmpeg and Windows speech synthesis.

**AI tools:** written with Claude Code, with NEAR's agent skills (`near/agent-skills`) installed for reference.

All of this repository was created during the hackathon window, starting on 7 November 2026.

## License

MIT. See `LICENSE`.
