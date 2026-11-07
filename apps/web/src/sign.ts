// Staff sign in the browser with their own key, and a relayer pays the gas. The
// key never leaves this device: the server only sees a signed request, which it
// can pass on or refuse, but can't change.

import { sha256 } from '@noble/hashes/sha2.js';
import {
  KeyPair,
  KeyType,
  Signature,
  actions,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  teraToGas,
} from 'near-api-js';
import { postJson, request } from './api.ts';
import type { Call } from './api.ts';

export interface Staff {
  accountId: string;
  privateKey: string;
  role: 'Maker' | 'Checker';
  label: string;
}

const STORAGE_KEY = 'nostro.staff';

export function loadStaff(): Staff | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Staff) : null;
  } catch {
    return null;
  }
}

export function saveStaff(staff: Staff | null): void {
  try {
    if (staff) localStorage.setItem(STORAGE_KEY, JSON.stringify(staff));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private windows can refuse storage. Sign-in then lasts for this page only.
  }
}

const TTL_BLOCKS = 120n;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signCall(staff: Staff, contractId: string, call: Call): Promise<string> {
  const pair = KeyPair.fromString(staff.privateKey as `ed25519:${string}`);
  const publicKey = pair.getPublicKey();
  const context = await request<{ nonce: string; blockHeight: string }>(
    `/api/sign-context?accountId=${encodeURIComponent(staff.accountId)}` +
      `&publicKey=${encodeURIComponent(publicKey.toString())}`,
  );
  const delegate = buildDelegateAction({
    senderId: staff.accountId,
    receiverId: contractId,
    actions: [actions.functionCall(call.method, call.args, teraToGas(120), 0n)],
    nonce: BigInt(context.nonce) + 1n,
    maxBlockHeight: BigInt(context.blockHeight) + TTL_BLOCKS,
    publicKey,
  });
  const { signature } = pair.sign(sha256(encodeDelegateAction(delegate)));
  return base64(
    encodeSignedDelegate({
      delegateAction: delegate,
      signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
    } as never),
  );
}

export interface Relayed {
  hash: string;
  events: { event: string; data: Record<string, unknown> }[];
}

/** Signs a contract call on this device, and has the relayer send it. */
export async function send(
  staff: Staff,
  contractId: string,
  call: Call,
  draftId?: string,
): Promise<Relayed> {
  const signedDelegate = await signCall(staff, contractId, call);
  return postJson<Relayed>('/api/relay', { signedDelegate, draftId });
}
