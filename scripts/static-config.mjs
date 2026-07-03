// Post-build: writes the public app config into dist/ as static files so
// the app runs on pure static hosting (Cloudflare Pages) with no server.
// Also writes the SPA redirect rule. Nothing here is secret — the contract
// address and network are public by nature.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const NETWORKS = {
  studionet: {
    label: 'GenLayer StudioNet',
    chainIdHex: '0x105f2c9', // 17177033 (studio)
    rpc: 'https://studio.genlayer.com/api',
    explorer: '',
  },
  'testnet-bradbury': {
    label: 'GenLayer Testnet Bradbury',
    chainIdHex: '0x107d', // 4221
    rpc: 'https://rpc-bradbury.genlayer.com',
    explorer: 'https://explorer-bradbury.genlayer.com',
  },
};

const network = (process.env.GENLAYER_NETWORK || 'testnet-bradbury').trim();
const net = NETWORKS[network] ?? NETWORKS['testnet-bradbury'];

const config = {
  contract: (process.env.GENLAYER_CONTRACT_ADDRESS || '').trim(),
  network,
  networkLabel: net.label,
  chainIdHex: net.chainIdHex,
  rpc: net.rpc,
  explorer: net.explorer,
  faucet: 'https://testnet-faucet.genlayer.foundation/',
};

if (!config.contract) {
  console.warn('[static-config] WARNING: GENLAYER_CONTRACT_ADDRESS is empty');
}

mkdirSync(path.join(dist, 'api'), { recursive: true });
writeFileSync(path.join(dist, 'api', 'config'), JSON.stringify(config));
writeFileSync(path.join(dist, '_redirects'), '/* /index.html 200\n');
console.log(`[static-config] dist/api/config written · ${config.networkLabel} · ${config.contract}`);
