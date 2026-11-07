// Talks to the 1Click API. NEAR Intents has no testnet, so previews use real
// mainnet quotes with `dry: true`, which move nothing. Taking a firm quote for
// real money is a separate function, and only runs on a mainnet deployment.

import type { Route } from './domain.ts';

const API = 'https://1click.chaindefuser.com/v0';
/** Native USDC on NEAR, the asset every run pays from. */
export const USDC_ON_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

interface Token {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
}

export interface Quote {
  /** Token units to send, slippage buffer included. */
  amountIn: bigint;
  /** The least 1Click will accept for this payout. */
  minAmountIn: bigint;
  amountOut: bigint;
  etaSeconds: number;
  depositAddress?: string;
  deadline?: string;
}

export interface OneClick {
  quote(route: Route, amountOutBase: bigint, options: QuoteOptions): Promise<Quote>;
  status(depositAddress: string): Promise<string>;
}

export interface QuoteOptions {
  dry: boolean;
  refundTo: string;
}

export class OneClickApi implements OneClick {
  private tokens?: { at: number; list: Token[] };
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
    };
  }

  private async tokenList(): Promise<Token[]> {
    if (this.tokens && Date.now() - this.tokens.at < 600_000) return this.tokens.list;
    const response = await fetch(`${API}/tokens`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`1Click tokens failed: ${response.status}`);
    const list = (await response.json()) as Token[];
    this.tokens = { at: Date.now(), list };
    return list;
  }

  private async assetId(route: Route): Promise<Token> {
    const list = await this.tokenList();
    const token = list.find(
      (entry) =>
        entry.blockchain === route.chain &&
        entry.symbol.toUpperCase() === route.asset.toUpperCase(),
    );
    if (!token) throw new Error(`1Click has no ${route.asset} on ${route.chain}.`);
    return token;
  }

  async quote(route: Route, amountOutBase: bigint, options: QuoteOptions): Promise<Quote> {
    const token = await this.assetId(route);
    // Amounts are held at 6 decimals. A few routes, such as BSC, use 18.
    const scale = 10n ** BigInt(Math.max(token.decimals - 6, 0));
    const body = {
      dry: options.dry,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 10,
      originAsset: USDC_ON_NEAR,
      depositType: 'INTENTS',
      destinationAsset: token.assetId,
      amount: (amountOutBase * scale).toString(),
      refundTo: options.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: route.address,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const response = await fetch(`${API}/quote`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`1Click quote failed: ${response.status} ${await response.text()}`);
    }
    const { quote } = (await response.json()) as {
      quote: {
        amountIn: string;
        minAmountIn: string;
        amountOut: string;
        timeEstimate: number;
        depositAddress?: string;
        deadline?: string;
      };
    };
    return {
      amountIn: BigInt(quote.amountIn),
      minAmountIn: BigInt(quote.minAmountIn),
      amountOut: BigInt(quote.amountOut) / scale,
      etaSeconds: quote.timeEstimate,
      ...(quote.depositAddress ? { depositAddress: quote.depositAddress } : {}),
      ...(quote.deadline ? { deadline: quote.deadline } : {}),
    };
  }

  async status(depositAddress: string): Promise<string> {
    const url = `${API}/status?depositAddress=${encodeURIComponent(depositAddress)}`;
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`1Click status failed: ${response.status}`);
    return ((await response.json()) as { status: string }).status;
  }
}
