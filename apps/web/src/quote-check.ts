// Checks NEAR Intents payouts on the approver's own device.
//
// Direct payments have their receiver bound by the contract. Through Intents
// each payment has a one-time deposit account, so the contract can't tell who
// a deposit will finally pay: that lives in 1Click's quote. This reads the
// quote, confirms 1Click really signed it, and confirms it pays the payee's
// approved route, with any refund coming back to the company.
//
// The signature scheme follows verifyQuoteSignature in 1Click's TypeScript SDK.
// A change to its signed fields makes this fail closed: the page says not to
// approve, which is the safe direction.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { routeHash } from '@nostro/bankfiles';
import type { LineMismatch } from '@nostro/bankfiles';

const MANAGER_KEY = 'reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const ED25519_PREFIX = 'ed25519:';

export interface QuoteRequestView {
  dry: boolean;
  swapType: string;
  slippageTolerance: number;
  originAsset: string;
  depositType: string;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: string;
  recipient: string;
  recipientType: string;
  deadline: string;
  quoteWaitingTimeMs?: number | null;
  referral?: string | null;
  virtualChainRecipient?: string | null;
  virtualChainRefundRecipient?: string | null;
  customRecipientMsg?: string | null;
}

export interface QuoteView {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate?: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface SignedQuote {
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequestView;
  quote: QuoteView;
}

/** Sorted keys and no undefined values, as json-stable-stringify gives here. */
function stableStringify(value: Record<string, unknown>): string {
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

const orNothing = <T>(value: T | null | undefined): T | undefined => value || undefined;

function signedRequest(request: QuoteRequestView): Record<string, unknown> {
  return {
    dry: request.dry,
    swapType: request.swapType,
    slippageTolerance: request.slippageTolerance,
    originAsset: request.originAsset,
    depositType: request.depositType,
    destinationAsset: request.destinationAsset,
    amount: request.amount,
    refundTo: request.refundTo,
    refundType: request.refundType,
    recipient: request.recipient,
    recipientType: request.recipientType,
    deadline: request.deadline,
    quoteWaitingTimeMs: orNothing(request.quoteWaitingTimeMs),
    referral: orNothing(request.referral),
    virtualChainRecipient: orNothing(request.virtualChainRecipient),
    virtualChainRefundRecipient: orNothing(request.virtualChainRefundRecipient),
    customRecipientMsg: orNothing(request.customRecipientMsg),
  };
}

function signedQuote(quote: QuoteView): Record<string, unknown> {
  return {
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
    depositAddress: orNothing(quote.depositAddress),
    depositMemo: orNothing(quote.depositMemo),
    deadline: orNothing(quote.deadline),
    timeWhenInactive: orNothing(quote.timeWhenInactive),
    timeEstimate: orNothing(quote.timeEstimate),
    refundFee: orNothing(quote.refundFee),
    withdrawFee: orNothing(quote.withdrawFee),
  };
}

const unprefixed = (value: string): string =>
  value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value;

export function verifyQuoteSignature(response: SignedQuote): boolean {
  try {
    const message = stableStringify({
      ...signedRequest(response.quoteRequest),
      ...signedQuote(response.quote),
      timestamp: response.timestamp,
    });
    const hash = base58.encode(sha256(new TextEncoder().encode(message)));
    return ed25519.verify(
      base58.decode(unprefixed(response.signature)),
      new TextEncoder().encode(hash),
      base58.decode(MANAGER_KEY),
    );
  } catch {
    return false;
  }
}

export interface ExpectedPayout {
  /** The receiver recorded on chain for this line. */
  depositAddress: string;
  /** The address in the payee's approved route. */
  recipient: string;
  destinationAsset: string;
  /** At the destination token's own decimals. */
  minimumOut: bigint;
  /** Where a refund must land: the company's own contract. */
  refundTo: string;
}

/** Everything wrong with a quote, in plain English. Empty means it's fine. */
export function checkPayout(response: SignedQuote, expected: ExpectedPayout): string[] {
  if (!verifyQuoteSignature(response)) return ['its quote is not genuinely signed by 1Click'];
  const { quote, quoteRequest } = response;
  const problems: string[] = [];
  if (quote.depositAddress !== expected.depositAddress) {
    problems.push('its quote is for a different deposit address');
  }
  if (quoteRequest.recipient !== expected.recipient) {
    problems.push(`it would pay ${quoteRequest.recipient}, not the approved address`);
  }
  if (quoteRequest.recipientType !== 'DESTINATION_CHAIN') {
    problems.push('it would not be delivered to the destination chain');
  }
  if (quoteRequest.destinationAsset !== expected.destinationAsset) {
    problems.push('it would pay a different token');
  }
  if (BigInt(quote.amountOut) < expected.minimumOut) {
    problems.push('it would deliver less than the invoice amount');
  }
  if (quoteRequest.refundTo !== expected.refundTo || quoteRequest.refundType !== 'ORIGIN_CHAIN') {
    problems.push('a refund would not come back to this account');
  }
  if (quoteRequest.dry) problems.push('its quote is only a preview');
  return problems;
}

export interface RoutedLine {
  index: number;
  name: string;
  payeeKey: string;
  depositAddress: string;
  route: { chain: string; asset: string; address: string } | null;
  /** Six-decimal token units the payee must receive. */
  principalBase: bigint;
}

export interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
}

export interface RoutedSources {
  contractId: string;
  /** The hash the checker approved, read from the chain. */
  approvedRouteHash: (payeeKey: string) => Promise<string | null>;
  status: (depositAddress: string) => Promise<SignedQuote>;
  tokens: () => Promise<Token[]>;
}

export async function verifyRoutedLines(
  lines: RoutedLine[],
  sources: RoutedSources,
): Promise<LineMismatch[]> {
  const mismatches: LineMismatch[] = [];
  const tokens = await sources.tokens();
  for (const line of lines) {
    const fail = (why: string) =>
      mismatches.push({ line: line.index, message: `Payment ${line.index + 1} (${line.name}): ${why}.` });

    if (!line.route) {
      fail('it has no approved route');
      continue;
    }
    // The route comes from the server, so it counts only if its hash is the one
    // approved on chain.
    if ((await sources.approvedRouteHash(line.payeeKey)) !== routeHash(line.route)) {
      fail('its route is not the one approved for this payee');
      continue;
    }
    const { chain, asset, address } = line.route;
    const token = tokens.find(
      (entry) => entry.blockchain === chain && entry.symbol.toUpperCase() === asset.toUpperCase(),
    );
    if (!token) {
      fail(`${asset} on ${chain} is not a known token`);
      continue;
    }
    let response: SignedQuote;
    try {
      response = await sources.status(line.depositAddress);
    } catch {
      fail('its quote could not be fetched');
      continue;
    }
    const scale = 10n ** BigInt(Math.max(token.decimals - 6, 0));
    for (const problem of checkPayout(response, {
      depositAddress: line.depositAddress,
      recipient: address,
      destinationAsset: token.assetId,
      minimumOut: line.principalBase * scale,
      refundTo: sources.contractId,
    })) {
      fail(problem);
    }
  }
  return mismatches;
}
