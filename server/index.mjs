// iChart server — wallet-first edition.
// The app is fully client-side: users connect their own wallet and sign
// analyze() transactions themselves. This server only serves the static
// build and exposes the public app configuration (contract address,
// network). No private keys are used at runtime; the deployer key in .env
// exists solely for CLI contract deployments.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { studionet, testnetBradbury } from 'genlayer-js/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const NETWORKS = {
  studionet: { chain: studionet, label: 'GenLayer StudioNet' },
  'testnet-bradbury': { chain: testnetBradbury, label: 'GenLayer Testnet Bradbury' },
};
const networkId = (process.env.GENLAYER_NETWORK || 'testnet-bradbury').trim();
const net = NETWORKS[networkId] ?? NETWORKS['testnet-bradbury'];

const CONFIG = {
  contract: (process.env.GENLAYER_CONTRACT_ADDRESS || '').trim(),
  network: networkId,
  networkLabel: net.label,
  chainIdHex: '0x' + net.chain.id.toString(16),
  rpc: net.chain.rpcUrls.default.http[0],
  explorer: net.chain.blockExplorers?.default?.url ?? '',
  faucet: 'https://testnet-faucet.genlayer.foundation/',
};

const app = express();

app.get('/api/config', (_req, res) => {
  res.json(CONFIG);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, engine: 'genlayer', configured: Boolean(CONFIG.contract), network: CONFIG.networkLabel });
});

const dist = path.resolve(__dirname, '../dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(
    `iChart on http://localhost:${PORT} · ${CONFIG.networkLabel} · contract: ${CONFIG.contract || '(not deployed)'} · users sign with their own wallets`,
  );
});
