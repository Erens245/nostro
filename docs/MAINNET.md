# Running on mainnet

This has not been done yet. The hackathon rules say only a person may sign mainnet transactions, deploy to mainnet or spend tokens, so every step below is for a person to approve. NEAR Intents has no testnet, so this is the only way to prove a real cross-chain payout.

## Why it's worth doing

Everything else is proven on testnet or with dry quotes. One real run, with tiny amounts, shows that a file in becomes USDC on another chain, and a statement out. It's the strongest moment for the demo video.

## What it needs

| Item | Amount | Notes |
| --- | --- | --- |
| A mainnet account for the contract | About 3 to 4 NEAR | Mostly storage for the 253 KB contract |
| Mainnet accounts for staff and the relayer | About 0.5 NEAR | |
| USDC on NEAR | About $5 | Use the native token `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| A 1Click API key | Free | https://partners.near-intents.org. Without one, each swap costs 0.25% more |
| Your own receiving addresses | 2 or 3 | Wallets you control on Base, Solana or Arbitrum |

## Contract settings

Deploy `contract/target/near/nostro.wasm` and call `new` with:

```json
{
  "owner": "<a person's account>",
  "token": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "settlement_target": "intents.near",
  "required_approvals": 1,
  "per_payment_limit": "5000000",
  "daily_limit": "10000000",
  "payee_cooloff_minutes": 0
}
```

Those limits are $5 a payment and $10 a day, so a mistake stays small. The contract must also be registered with the USDC token through `storage_deposit`.

## Server settings

```sh
NOSTRO_NETWORK=mainnet
NOSTRO_ALLOW_MAINNET=yes
NOSTRO_CONTRACT_ID=<contract>
NOSTRO_TOKEN_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
ONECLICK_API_KEY=<key>
```

The server won't start on mainnet without `NOSTRO_ALLOW_MAINNET=yes`.

## What is untested

These have unit tests or dry quotes only:

- `ft_transfer_call` from the contract to `intents.near`, with `msg` set to the 1Click deposit address.
- A firm quote with `depositType: INTENTS` and `refundType: ORIGIN_CHAIN`. A dry quote accepts this pairing.
- Refunds. On `EXACT_OUTPUT`, 1Click returns the slippage buffer by plain transfer, which the contract can't see. `reconcile()` records it as `UNALLOCATED_CREDIT`. The statement then shows a slightly high fee and a small later credit, and that's worth tidying.
- Gas. The contract sends about 3 lines per call through Intents, and the server repeats calls until a run is done.

Facts found while building:

- `refundTo` must be an account that exists, or 1Click answers `Internal server error`.
- Direct `ft_transfer` to a mainnet deposit address would need a `storage_deposit` first, which is why the contract uses `ft_transfer_call` instead.

Start with one payment of $1 before trying a full run.
