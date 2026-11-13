# Nostro: idea brief

Track: Real-World Money (`realworld`). Written 7 Nov 2026. Deadline: 14 Nov 2026, 23:59 UTC (Sun 15 Nov, 05:29 IST).

**Status, 8 Nov 2026:** live on NEAR testnet as `acme.nostro-edc436.testnet` (`deployment.json`). `proof/testnet-run.json` records a full run with transaction ids:
- 10 payments from a pain.001 and a NACHA file
- 7 attempts that had to fail, refused by the contract, the relayer or the protocol
- a customer payment in
- a statement whose hash is fixed on chain and ties to the token balance

On that run, live quotes priced the five sample payments at $1.27 of routing costs, against $225 by wire. NEAR Intents payouts have not yet carried real money. That needs a mainnet run, and the human's yes.

## The idea in one paragraph

Give a NEAR account the interface of a bank. A company's accounting or payroll software already exports a payment file and already imports a bank statement. Nostro takes that same file, pays each line in stablecoins on the chain each payee chose, and returns the status report and statement the software already knows how to read. The finance team changes nothing: no wallet, no gas token, no new app to learn beyond a portal that looks like online banking.

The name is a banking term: a *nostro* account is "our account held at another institution". That is what this is.

## Why this one

The track asks for "something a normal company could use tomorrow". Most stablecoin payment tools ask the company to adopt a new tool. A normal company does not want a new tool. It wants its existing process to get cheaper.

| Check | Evidence | Confidence |
| --- | --- | --- |
| The demand is real | SAP sells a live Digital Currency Hub for S/4HANA ("trigger stablecoin payments from your core ERP") on Ethereum and Polygon. Nothing like it serves a small company on Xero, or anyone on NEAR | High that it exists. I could only read SAP's page through search results, because a direct fetch was blocked |
| It is much cheaper | Live dry quotes on 7 Nov for $5,000: USDC to Base 1.3 bps, Arbitrum 1.2 bps, Solana 2.4 bps. Median outgoing international wire fee: $45 (NerdWallet figures, via Corpay) | Quotes are real but no money moved. Small payments cost more (Solana was 26 bps at $100). Tron USDT read -8 bps at $5,000, so treat it as unreliable until tested. Receiving-side costs not included |
| It is fast | Same quotes estimate 17 to 22 s on USDC routes, 75 s to Tron. SWIFT wires typically take 3 to 5 business days | Estimates from the API, not measured settlement |
| It helps NEAR | Every payment run is NEAR Intents volume from a customer who never heard of Intents. No integration on their side, so distribution is any company with accounting software | Argument, not measurement |

**The rule for the pitch:** do not sell "ISO 20022". That phrase carries a crypto-meme association. Sell "the file your accounting software already exports". Name the formats only in the technical section.

## What makes NEAR the right chain

These are concrete, not decorative:

1. **Named accounts fit where bank details go.** `acme-supplier.near` can sit in the "account number" field of an ERP's vendor record. A 42-character hex address is a poor fit for a clerk.
2. **Meta transactions** mean finance staff never touch gas. The relayer pays only for calls to our contract.
3. **Function-call keys** make segregation of duties real: a clerk's key can submit a run and cannot approve one.
4. **NEAR Intents** turns one USDC balance into payouts on many chains, with `EXACT_OUTPUT` so the payee gets the exact invoice amount. Fees land on the statement as fees, which is what an accountant needs.
5. **Sub-accounts** can map to bank sub-accounts (`payroll.acme.near`, `ap.acme.near`).
6. **NEAR Business** gives confidential treasuries with Requestor and Finance roles. Nostro can export its bulk-payment format, so a sensitive run such as payroll goes through a private shard.

## What gets built

| # | Piece | Proof a judge can check |
| --- | --- | --- |
| 1 | Bank-file reader: pain.001 (.03 and .09), NACHA, CSV | Reads files made by independent libraries, not by us |
| 2 | Run contract in Rust: maker, checker, duplicate refusal, payee cool-off, limits | Unit tests. Deployed on testnet as `acme.nostro-edc436.testnet` |
| 3 | Gasless approval through a NEP-366 relayer limited to our contract | On testnet, staff calls go through the relayer, and the clerk's NEAR balance didn't move across a full run (`proof/testnet-run.json`) |
| 4 | Payout rails: testnet direct, mainnet through 1Click `EXACT_OUTPUT` | Live dry quotes. One small real mainnet run if the human approves |
| 5 | Statement writer: pain.002, camt.053, OFX, MT940, CSV | XSD validation, independent parsers, and balances tied to the chain |
| 6 | Portal UI: upload, approve, track, download | Runs locally, hosted if possible |
| 7 | `npm run verify`: one command, one PASS or FAIL per claim | Written for the AI screening stage |

## Requirements check

| Requirement | Plan |
| --- | --- |
| Public repo by the deadline | Human makes it public |
| Demo post on X with hashtag and tag | Human posts. Draft provided |
| Video, because a local demo needs one (Q-012) | Script provided. Human records |
| README with "do X, see Y" steps | Written for an AI reader |
| LICENSE file | MIT |
| Libraries and AI tools listed (Q-005) | In README |
| Mainnet NEAR payout account | Human creates. Never generated by an agent |
| Built inside the window (Q-001) | Whole repo created 7 Nov 2026 |
| Testnet allowed (Q-010) | Yes. Intents has no testnet (Q-007), so Intents parts use dry quotes and mainnet with tiny amounts only with human approval |

## Known risks

1. **Payees must accept stablecoins.** This is not a bank and does not reach local bank accounts. It suits contractors and suppliers abroad who already want USDC. Say so plainly.
2. **Salaries on a public chain.** The `confidentiality` quote parameter returned 401 without user authentication when tested, so private payouts are not free. Contract stores hashes only, and sensitive runs should go through NEAR Business. Do not claim privacy we have not proved.
3. **Regulation.** SAP routes through licensed providers. Nostro is non-custodial software, but a real company should take advice. Not legal advice.
4. **Currency labelling.** Statement formats need a three-letter currency, and USDC has none. Statements show `USD` with the account named as USDC on NEAR, and this is a documented assumption.
5. **Live proof needs a human.** Rules forbid an agent from spending mainnet funds unprompted. About $5 of USDC and a yes are needed for the best version of the demo.

## Ideas considered and rejected

| Idea | Why not |
| --- | --- |
| Direct debit for stablecoins | Real need, but cross-chain pull is not possible |
| Tax withheld at source into a vault | Original but narrow. Better as a later feature |
| Trade finance or letters of credit | Heavy on paperwork and off-chain trust. Too much for 7 days |
| Invoice factoring | It carries credit risk |
| Salary streaming | An old idea with weak company pull |

## Sources

- Rules: https://nearhackathon.com/HACKATHON.md
- 1Click fees: https://docs.near-intents.org/resources/fees
- NEAR Business: https://docs.business.near.com/llms.txt
- SAP Digital Currency Hub: https://www.sap.com/products/financial-management/digital-currency-hub.html
- Wire fees: https://www.corpay.com/es/resources/blog/wire-transfer-fees
- Xero and QuickBooks import formats: https://www.propersoft.net/import-into-xero/ and https://propersoft.net/howto/import-into-quickbooks-online
