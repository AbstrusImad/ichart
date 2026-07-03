// Browser-side GenLayer client. THE USER'S WALLET signs every analyze()
// transaction — the app never holds a private key. Reads go through a
// key-less client against the public RPC.

import { createClient } from 'genlayer-js';
import { studionet, testnetBradbury } from 'genlayer-js/chains';

export interface AppConfig {
  contract: `0x${string}`;
  network: 'studionet' | 'testnet-bradbury';
  networkLabel: string;
  chainIdHex: string;
  rpc: string;
  explorer: string;
  faucet: string;
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const CHAINS = {
  studionet: studionet,
  'testnet-bradbury': testnetBradbury,
} as const;

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/** Ask the wallet to be on the right chain, adding it if unknown. */
export async function ensureChain(cfg: AppConfig): Promise<void> {
  const eth = window.ethereum!;
  const current = (await eth.request({ method: 'eth_chainId' })) as string;
  if (current?.toLowerCase() === cfg.chainIdHex.toLowerCase()) return;
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: cfg.chainIdHex }],
    });
  } catch (e) {
    const code = (e as { code?: number })?.code;
    if (code !== 4902) throw e;
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: cfg.chainIdHex,
          chainName: cfg.networkLabel,
          rpcUrls: [cfg.rpc],
          nativeCurrency: { name: 'GEN Token', symbol: 'GEN', decimals: 18 },
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
        },
      ],
    });
  }
}

// genlayer-js's inferred client type isn't exportable across module
// boundaries; the handful of methods we use are typed here instead.
export interface GenLayerClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContract(args: Record<string, unknown>): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: Record<string, unknown>): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTransaction(args: { hash: string }): Promise<any>;
}

export interface WalletSession {
  address: `0x${string}`;
  // genlayer-js client bound to the user's wallet (it signs)
  client: GenLayerClientLike;
}

const REMEMBER_KEY = 'ichart_wallet_connected';

function buildSession(cfg: AppConfig, address: `0x${string}`): WalletSession {
  const client = createClient({
    chain: CHAINS[cfg.network],
    account: address,
    provider: window.ethereum,
  } as Parameters<typeof createClient>[0]) as unknown as GenLayerClientLike;
  return { address, client };
}

export async function connectWallet(cfg: AppConfig): Promise<WalletSession> {
  if (!hasWallet()) {
    throw new Error('No wallet found — install MetaMask to use iChart');
  }
  const eth = window.ethereum!;
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts?.[0] as `0x${string}` | undefined;
  if (!address) throw new Error('Wallet did not return an account');

  await ensureChain(cfg);
  try {
    localStorage.setItem(REMEMBER_KEY, '1');
  } catch {
    // storage unavailable — session just won't persist
  }
  return buildSession(cfg, address);
}

/** Silent reconnect on page load: no popups — only succeeds if the site is
 *  already authorized in the wallet. Chain is ensured lazily on first tx. */
export async function reconnectWallet(cfg: AppConfig): Promise<WalletSession | null> {
  try {
    if (!hasWallet() || localStorage.getItem(REMEMBER_KEY) !== '1') return null;
    const accounts = (await window.ethereum!.request({ method: 'eth_accounts' })) as string[];
    const address = accounts?.[0] as `0x${string}` | undefined;
    if (!address) return null;
    return buildSession(cfg, address);
  } catch {
    return null;
  }
}

export function forgetWallet(): void {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // ignore
  }
}

/** Key-less client for reads (no wallet involvement). */
let readClient: GenLayerClientLike | null = null;
let readClientNet: string | null = null;

export function getReadClient(cfg: AppConfig): GenLayerClientLike {
  if (!readClient || readClientNet !== cfg.network) {
    readClient = createClient({ chain: CHAINS[cfg.network] }) as unknown as GenLayerClientLike;
    readClientNet = cfg.network;
  }
  return readClient;
}

export async function getGenBalance(cfg: AppConfig, address: string): Promise<number> {
  const res = await fetch(cfg.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [address, 'latest'],
    }),
  });
  const data = await res.json();
  const hex: string = data?.result ?? '0x0';
  return Number(BigInt(hex)) / 1e18;
}
