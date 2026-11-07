import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApi } from './api.ts';
import { NearChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { OneClickApi } from './oneclick.ts';
import { Store } from './store.ts';

const config = loadConfig();
if (!config.contractId) {
  console.error('No contract is configured. Run scripts/deploy-testnet.mjs or set NOSTRO_CONTRACT_ID.');
  process.exit(1);
}

const handle = createApi({
  config,
  chain: new NearChain(config),
  store: new Store(join(config.dataDir, config.contractId)),
  oneClick: new OneClickApi(config.oneClickKey),
});

createServer((req, res) => void handle(req, res)).listen(config.port, () => {
  console.log(`Nostro portal on http://localhost:${config.port}`);
  console.log(`Network ${config.network}, contract ${config.contractId}`);
  if (!config.relayer || !config.settler) console.log('Read-only: no relayer or settler key.');
});
