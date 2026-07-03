// Market data: Binance public REST + WebSocket, with a seeded synthetic
// market as fallback so the app is fully demonstrable on a blocked network.
// No API key is needed — these are public endpoints.

import type { Candle, DataSource, FeedStatus, Symbol, Timeframe } from './types';
import { tfSeconds } from './types';

const REST = 'https://api.binance.com/api/v3';
const WS = 'wss://stream.binance.com:9443/ws';
const HISTORY = 300;

export interface MarketHandlers {
  onSnapshot: (candles: Candle[], source: DataSource) => void;
  onUpdate: (candle: Candle) => void;
  onStatus: (status: FeedStatus) => void;
}

export interface MarketHandle {
  stop: () => void;
}

// ── live feed ───────────────────────────────────────────────────────────

async function fetchKlines(symbol: Symbol, tf: Timeframe): Promise<Candle[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `${REST}/klines?symbol=${symbol}&interval=${tf}&limit=${HISTORY}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
    const rows: unknown[][] = await res.json();
    return rows.map((r) => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));
  } finally {
    clearTimeout(timer);
  }
}

function openStream(
  symbol: Symbol,
  tf: Timeframe,
  onUpdate: (c: Candle) => void,
  onStatus: (s: FeedStatus) => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retries = 0;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`${WS}/${symbol.toLowerCase()}@kline_${tf}`);
    ws.onopen = () => {
      retries = 0;
      onStatus('streaming');
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        const k = msg?.k;
        if (!k) return;
        onUpdate({
          time: Math.floor(k.t / 1000),
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
          volume: Number(k.v),
        });
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      if (retries < 5) {
        retries += 1;
        onStatus('connecting');
        setTimeout(connect, 1500 * retries);
      } else {
        onStatus('stalled');
      }
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}

// ── synthetic market (offline fallback) ─────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_PRICE: Record<Symbol, number> = {
  BTCUSDT: 67200,
  ETHUSDT: 3480,
  SOLUSDT: 162,
  BNBUSDT: 592,
  XRPUSDT: 0.53,
};

function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A random walk with regime shifts and volatility clustering — realistic
 *  enough that the analyst finds genuine structure in it. */
function generateDemoCandles(symbol: Symbol, tf: Timeframe, n = HISTORY): Candle[] {
  const rnd = mulberry32(hashCode(symbol + tf));
  const step = tfSeconds(tf);
  const now = Math.floor(Date.now() / 1000);
  const start = now - now % step - (n - 1) * step;

  let price = BASE_PRICE[symbol];
  let vol = price * 0.004; // per-bar sigma
  let drift = 0;
  const out: Candle[] = [];

  for (let i = 0; i < n; i++) {
    if (i % 40 === 0) drift = (rnd() - 0.5) * vol * 0.9; // new regime
    if (rnd() < 0.03) drift = (rnd() - 0.5) * vol * 2.5; // impulse event
    vol = Math.max(price * 0.0015, vol * 0.92 + price * 0.004 * rnd() * 0.16);

    const gauss = (rnd() + rnd() + rnd() + rnd() - 2) / 2; // ~N(0,1)-ish
    const open = price;
    const close = Math.max(price * 0.2, open + drift + gauss * vol);
    const wickUp = Math.abs(gauss) * vol * rnd();
    const wickDn = Math.abs(gauss) * vol * rnd();
    const high = Math.max(open, close) + wickUp;
    const low = Math.min(open, close) - wickDn;
    const volume = (price / 100) * (0.4 + rnd() + (Math.abs(close - open) / vol) * 1.2);

    out.push({ time: start + i * step, open, high, low, close, volume });
    price = close;
  }
  return out;
}

function startDemoTicker(
  initial: Candle[],
  tf: Timeframe,
  onUpdate: (c: Candle) => void,
): () => void {
  const step = tfSeconds(tf);
  const rnd = mulberry32(Date.now() & 0xffff);
  let last = { ...initial[initial.length - 1] };
  let ticks = 0;

  // Accelerated tape: the current candle breathes ~every 900ms and rolls
  // over every ~15 ticks, so the demo feels alive on any timeframe.
  const id = window.setInterval(() => {
    ticks += 1;
    if (ticks % 15 === 0) {
      last = {
        time: last.time + step,
        open: last.close,
        high: last.close,
        low: last.close,
        close: last.close,
        volume: 0,
      };
    }
    const sigma = last.close * 0.0009;
    const gauss = (rnd() + rnd() + rnd() + rnd() - 2) / 2;
    const next = Math.max(last.close * 0.5, last.close + gauss * sigma);
    last = {
      ...last,
      close: next,
      high: Math.max(last.high, next),
      low: Math.min(last.low, next),
      volume: last.volume + sigma * rnd() * 4,
    };
    onUpdate({ ...last });
  }, 900);

  return () => window.clearInterval(id);
}

// ── orchestrator ────────────────────────────────────────────────────────

/** Load a market: live Binance data when reachable, synthetic otherwise. */
export function subscribeMarket(
  symbol: Symbol,
  tf: Timeframe,
  handlers: MarketHandlers,
): MarketHandle {
  let cleanup: (() => void) | null = null;
  let cancelled = false;

  handlers.onStatus('connecting');

  fetchKlines(symbol, tf)
    .then((candles) => {
      if (cancelled) return;
      handlers.onSnapshot(candles, 'live');
      cleanup = openStream(symbol, tf, handlers.onUpdate, handlers.onStatus);
    })
    .catch(() => {
      if (cancelled) return;
      const demo = generateDemoCandles(symbol, tf);
      handlers.onSnapshot(demo, 'demo');
      handlers.onStatus('streaming');
      cleanup = startDemoTicker(demo, tf, handlers.onUpdate);
    });

  return {
    stop() {
      cancelled = true;
      cleanup?.();
    },
  };
}
