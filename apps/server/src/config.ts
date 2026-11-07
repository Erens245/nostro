import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Signer {
  accountId: string;
  privateKey: string;
}

export interface Config {
  network: 'testnet' | 'mainnet';
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  company: string;
  port: number;
  dataDir: string;
  webDir: string;
  relayer?: Signer;
  settler?: Signer;
  oneClickKey?: string;
  /** Hands out demo staff keys. Testnet only. */
  demoKeys: boolean;
}

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Deployment {
  network?: 'testnet' | 'mainnet';
  contractId?: string;
  tokenId?: string;
  company?: string;
}

function readDeployment(): Deployment {
  const path = join(repoRoot, 'deployment.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Deployment) : {};
}

function signer(accountId?: string, privateKey?: string): Signer | undefined {
  return accountId && privateKey ? { accountId, privateKey } : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deployment = readDeployment();
  const network = (env['NOSTRO_NETWORK'] ?? deployment.network ?? 'testnet') as Config['network'];

  if (network === 'mainnet' && env['NOSTRO_ALLOW_MAINNET'] !== 'yes') {
    throw new Error('Mainnet needs NOSTRO_ALLOW_MAINNET=yes, set by a person.');
  }

  const relayer = signer(env['NOSTRO_RELAYER_ID'], env['NOSTRO_RELAYER_KEY']);
  const settler = signer(env['NOSTRO_SETTLER_ID'], env['NOSTRO_SETTLER_KEY']);
  const oneClickKey = env['ONECLICK_API_KEY'];

  return {
    network,
    rpcUrl:
      env['NOSTRO_RPC_URL'] ??
      (network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com'),
    contractId: env['NOSTRO_CONTRACT_ID'] ?? deployment.contractId ?? '',
    tokenId: env['NOSTRO_TOKEN_ID'] ?? deployment.tokenId ?? '',
    company: env['NOSTRO_COMPANY'] ?? deployment.company ?? 'Harbor and Pine Studio LLC',
    port: Number(env['PORT'] ?? 8787),
    dataDir: env['NOSTRO_DATA_DIR'] ?? join(repoRoot, 'data'),
    webDir: env['NOSTRO_WEB_DIR'] ?? join(repoRoot, 'apps', 'web', 'dist'),
    ...(relayer ? { relayer } : {}),
    ...(settler ? { settler } : {}),
    ...(oneClickKey ? { oneClickKey } : {}),
    demoKeys: network === 'testnet' && env['NOSTRO_DEMO_KEYS'] === 'yes',
  };
}
