// The gasless relayer's gatekeeper. The relayer spends real gas for whoever
// calls it, so each signed delegate is decoded and inspected first. Anything
// other than one zero-deposit call to one of our staff methods is refused
// before a transaction exists.

import { deserialize } from 'borsh';
import { SCHEMA } from 'near-api-js';

export type StaffRole = 'Maker' | 'Checker';

export const STAFF_METHODS: Record<string, StaffRole> = {
  submit_run: 'Maker',
  register_payee: 'Maker',
  approve_run: 'Checker',
  reject_run: 'Checker',
  approve_payee: 'Checker',
};

const MAX_GAS = 300_000_000_000_000n;
const MAX_ARGS_BYTES = 64 * 1024;

export interface RelayPolicy {
  contractId: string;
}

interface DecodedAction {
  functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
}

export interface DecodedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: DecodedAction[];
    nonce: bigint;
    maxBlockHeight: bigint;
  };
  signature: unknown;
}

export type Inspection =
  | { ok: true; senderId: string; method: string; role: StaffRole; args: Uint8Array }
  | { ok: false; reason: string };

export function decodeDelegate(encoded: Uint8Array): DecodedDelegate {
  const decoded = deserialize(SCHEMA.SignedDelegate, encoded) as unknown as DecodedDelegate;
  // borsh hands back call args as a plain array. Everything else expects bytes.
  for (const action of decoded.delegateAction.actions) {
    const call = action.functionCall;
    if (call) call.args = Uint8Array.from(call.args);
  }
  return decoded;
}

export function inspectDelegate(signed: DecodedDelegate, policy: RelayPolicy): Inspection {
  const { delegateAction: delegate } = signed;
  if (delegate.receiverId !== policy.contractId) {
    return { ok: false, reason: `This relayer only pays for calls to ${policy.contractId}.` };
  }
  if (delegate.actions.length !== 1) {
    return { ok: false, reason: 'A request must contain exactly one action.' };
  }
  const call = delegate.actions[0]?.functionCall;
  if (!call) return { ok: false, reason: 'Only function calls are relayed.' };

  const role = STAFF_METHODS[call.methodName];
  if (!role) return { ok: false, reason: `Method ${call.methodName} is not relayed.` };
  if (BigInt(call.deposit) !== 0n) {
    return { ok: false, reason: 'A relayed call cannot attach a deposit.' };
  }
  if (BigInt(call.gas) > MAX_GAS) return { ok: false, reason: 'This call asks for too much gas.' };
  if (call.args.length > MAX_ARGS_BYTES) return { ok: false, reason: 'This call is too large.' };

  return {
    ok: true,
    senderId: delegate.senderId,
    method: call.methodName,
    role,
    args: call.args,
  };
}
