# Submitting Nostro

For whoever leads this entry. Deadline: **14 Nov, 23:59 UTC, which is Sun 15 Nov, 05:29 IST.** Treat Saturday night as the real end. You get one submission.

The rules say only a person may do the steps in this file.

## Decide first

- **Who leads this entry?** One person can be on at most 2 projects, and each email can send 2 submissions. If a person is on two, each README must name the other project (Q-015).
- **Which email goes in the git history?** Commits on this machine use the name and email in git config. Making the repo public publishes them. If that's not the address you want public, say so before the repo goes public, because changing it later means rewriting history.

## Before going public

- [ ] `npm run verify` passes on a fresh clone
- [ ] `deployment.json` and `proof/` are committed, and the README's status table still matches reality
- [ ] No secret keys in history: `git log -p --all | grep -E "ed25519:[1-9A-HJ-NP-Za-km-z]{80}"` finds one line only, 1Click's quote signature in `fixtures/1click-status-sample.json`. A signature is as long as a secret key, and a public key is about half as long. Last checked 8 Nov
- [ ] `.keys/` is not in the repo
- [ ] The rules are re-read at https://nearhackathon.com/HACKATHON.md in case they changed

## The demo post

It must say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and have a video attached. Put all of that in the first post, because that post's link is what you submit. A standard X account allows 280 characters, so this draft is a first post and a reply. Edit them into your own words, and keep the first one under the limit.

First post, with the video attached:

> Your accounting software can already pay people. It exports a bank file.
>
> Nostro pays that file in stablecoins, with NEAR Intents reaching each payee's chain, and returns a statement your books can import. No wallet, no gas.
>
> Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon

Reply:

> Repo: (link)
>
> It runs on NEAR testnet, and a full run is recorded in the repo with its transaction ids. NEAR Intents has no testnet, so cross-chain payouts are quoted live but haven't carried real money yet.
>
> Accountants: which export should we support next?

Change the reply if a mainnet run happens. Only state numbers you've seen. If you quote a saving, use one from the demo.

## The demo video

About 90 seconds. Lead with the problem, and show one complete moment.

The rules say a person records the demo. There's a scripted recording of this flow on testnet in `demo/nostro-demo.mp4`, made by `scripts/record-demo.mjs` and committed, to use as a reference. A plain-language explainer for people who aren't technical, made by `scripts/record-explainer.mjs`, isn't committed. It has no product footage, so it isn't the demo.

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Accounting software, or the payment file | "Five suppliers to pay abroad. Wires would cost $225 and take days. This is the file our software already exports." |
| 0:12 | Drop the file into Nostro | "We don't change anything. Nostro reads it and prices each payment live." |
| 0:25 | The cost comparison | Read out the real numbers on screen |
| 0:35 | Submit, sign out, sign in as director | "The clerk can't approve their own run. The contract enforces that." |
| 0:45 | **Checked on this device** | "The director's own browser re-reads the file, so what's approved is what was uploaded." |
| 0:55 | Approve, Release, Settled | "No wallet popups and no gas. A relayer pays." |
| 1:05 | Upload the same file again | "Upload it twice and it's refused." |
| 1:12 | Statements, ties to the chain, download | "Here's the part that matters to an accountant: a statement that ties to the chain." |
| 1:22 | Import it into accounting software | The best shot in the video, if you can get it. See below |

**The best possible ending** is the statement appearing in real accounting software. GnuCash's importers already read these files. Xero has a free demo company with a statement import screen, which needs a person to log in and hasn't been tried, so test it early in case it needs changes.

If you approve a small mainnet run, replace "Settled" with the real transaction arriving on another chain. See `MAINNET.md`.

## The form

| Field | Value |
| --- | --- |
| Project name | Nostro |
| Team lead, email, team size | Yours to fill in |
| Tracks | `realworld` |
| NEAR account for the prize | A mainnet account a person creates. Never one made by an AI tool |
| Repository | The public repo URL |
| Demo post | The X post URL |
| Consent | Read it and agree yourself |

Text for "What did you build?", under 2,000 characters:

> Companies already have what they need to pay people: their accounting or payroll software exports a payment file, and imports a bank statement. Nostro makes a NEAR account work with both, so a finance team can pay in stablecoins without adopting a wallet, a gas token or a new workflow.
>
> A clerk uploads a pain.001, NACHA or CSV file. Nostro reads and checks it, and prices each payment with live NEAR Intents quotes. A second person approves, with their own browser re-reading the original file and confirming its hash, and the payments go out. Nostro returns a pain.002 status report and a statement as camt.053, OFX, MT940 or CSV.
>
> The contract enforces what finance teams need: the person who submits can't approve, a file or payment can't be paid twice, new or changed payees are held, and limits apply as money moves. Each debit and credit has a running balance, so a statement can be rebuilt from view calls alone and checked against the token balance by anyone.
>
> NEAR fits because Intents turns one USDC balance into payouts on many chains, meta transactions keep staff away from gas, function-call keys make segregation of duties a protocol rule, and named accounts fit in an ERP's account field.
>
> Parsers were tested against files made by third-party libraries, XML against the ISO 20022 schemas, and statements against independent readers including GnuCash's own OFX, MT940 and camt.053 importers. `npm run verify` reruns these checks with no keys. Nostro runs on NEAR testnet, and proof/ records a full run there with its transaction ids. NEAR Intents has no testnet, so its quotes are live but its payouts have not yet carried real money.

Keep the last paragraph accurate. Update it if the testnet or mainnet status changes. Don't describe Intents payouts as tested with real money unless a mainnet run has happened.

## Sending it

Use https://nearhackathon.com/#apply, or the API in HACKATHON.md. A second submission of the same repo is refused, and a mistake is fixed at https://nearhackathon.com/request-changes.

Make the repo public first, post on X second, submit third.
