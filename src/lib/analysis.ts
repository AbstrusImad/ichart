// Consensus analysis flow, fully client-side: the user's wallet signs the
// analyze() transaction, then we poll the network until validators settle
// (or fail definitively — surfaced as an honest error, never a fallback).

import type { AIResponse, Candle, OverlayAction, Symbol, Timeframe } from './types';
import type { AppConfig, WalletSession } from './genlayerClient';
import { ensureChain, getReadClient } from './genlayerClient';

const POLL_MS = 6_000;
const MAX_WAIT_MS = 15 * 60_000;

// Bradbury rotates leaders through multiple rounds — LEADER_TIMEOUT /
// VALIDATORS_TIMEOUT statuses are transient retry states, NOT final.
// Only a terminal status decides the outcome.
const TERMINAL_STATUSES = new Set(['ACCEPTED', 'FINALIZED', 'CANCELED', 'UNDETERMINED']);
const OK_RESULTS = new Set(['MAJORITY_AGREE', 'AGREE', 'IDLE', '']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

export interface TxProgressEvent {
  phase: 'signing' | 'submitted' | 'consensus' | 'success' | 'failed';
  txHash?: `0x${string}`;
  explorer?: string | null;
  chainStatus?: string;
  message?: string;
}

interface ChainRecord {
  symbol: string;
  timeframe: string;
  question: string;
  seq: number;
  analysis: {
    direction?: string;
    support?: number;
    resistance?: number;
    last_close?: number;
    change_pct?: number;
    first_time_s?: number;
    last_time_s?: number;
    summary?: string;
    intent?: string;
    strip?: string;
  };
}

/** Compact stats computed from the same public candles the chart shows —
 *  auditable by anyone against Binance's immutable closed-candle history. */
function buildStats(candles: Candle[]): string {
  const win = candles.slice(-96);
  const closes = win.map((c) => c.close);
  const last = closes[closes.length - 1];
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));

  // rich derived features instead of the raw series: Bradbury's per-round
  // budget can't absorb raw candles in the LLM prompt (leader times out),
  // but ~18 descriptive numbers give the model enough substance to write a
  // question-specific answer. All deterministic from public closed candles,
  // so any record remains auditable off-chain.
  const n = win.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  closes.forEach((c, i) => {
    sx += i; sy += c; sxy += i * c; sxx += i * i;
  });
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const trendPct = (slope * (n - 1)) / (closes[0] || 1) * 100;

  const tr = win.map((c) => (c.high - c.low) / (c.close || 1)) ;
  const volPct = (tr.reduce((a, b) => a + b, 0) / n) * 100;

  const last12 = win.slice(-12);
  const chg12 = ((last - last12[0].close) / last12[0].close) * 100;
  const green12 = last12.filter((c) => c.close >= c.open).length;
  let streak = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    const up = win[i].close >= win[i].open;
    if (i === win.length - 1) streak = up ? 1 : -1;
    else if (up === streak > 0) streak += up ? 1 : -1;
    else break;
  }
  let uw = 0, lw = 0;
  last12.forEach((c) => {
    const range = c.high - c.low || 1e-9;
    uw += (c.high - Math.max(c.open, c.close)) / range;
    lw += (Math.min(c.open, c.close) - c.low) / range;
  });

  return JSON.stringify({
    last_close: r4(last),
    change_pct: r2(((last - closes[0]) / closes[0]) * 100),
    high: r4(hi),
    low: r4(lo),
    first_time_s: win[0].time,
    last_time_s: win[win.length - 1].time,
    range_pos_pct: r2(((last - lo) / (hi - lo || 1)) * 100),
    trend_slope_pct: r2(trendPct),
    avg_candle_range_pct: r2(volPct),
    last12_change_pct: r2(chg12),
    green_of_last12: green12,
    candle_streak: streak,
    upper_wick_share_pct: r2((uw / 12) * 100),
    lower_wick_share_pct: r2((lw / 12) * 100),
    dist_to_high_pct: r2(((hi - last) / last) * 100),
    dist_to_low_pct: r2(((last - lo) / last) * 100),
  });
}

export async function runConsensusAnalysis(
  cfg: AppConfig,
  session: WalletSession,
  symbol: Symbol,
  timeframe: Timeframe,
  prompt: string,
  candles: Candle[],
  onEvent?: (e: TxProgressEvent) => void,
): Promise<AIResponse> {
  const question = prompt.slice(0, 300);
  const stats = buildStats(candles);

  // 1. the USER signs — this is their transaction, on their wallet
  onEvent?.({ phase: 'signing' });
  let txHash: `0x${string}`;
  try {
    // reconnects are silent, so the chain may still need switching here
    await ensureChain(cfg);
    txHash = (await session.client.writeContract({
      address: cfg.contract,
      functionName: 'analyze',
      args: [symbol, timeframe, stats, question],
      value: 0n,
    })) as `0x${string}`;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'transaction was not sent';
    onEvent?.({ phase: 'failed', message });
    throw e;
  }
  const explorerLink = cfg.explorer
    ? `${cfg.explorer.replace(/\/$/, '')}/tx/${txHash}`
    : null;
  onEvent?.({ phase: 'submitted', txHash, explorer: explorerLink });

  // 2. poll the network until settled or definitively failed
  const read = getReadClient(cfg);
  const deadline = Date.now() + MAX_WAIT_MS;

  // *_TIMEOUT statuses sometimes recover via leader rotation — but if one
  // sits unchanged this long, the tx is stuck for good (seen on Bradbury).
  const STUCK_TIMEOUT_MS = 90_000;
  let lastStatus = '';
  let lastStatusChange = Date.now();

  while (Date.now() < deadline) {
    await sleep(POLL_MS);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx: any = await (read as any).getTransaction({ hash: txHash });
      const verdict = String(tx?.resultName ?? tx?.result_name ?? '').toUpperCase();
      const status = String(tx?.statusName ?? tx?.status_name ?? '').toUpperCase();
      if (status !== lastStatus) {
        lastStatus = status;
        lastStatusChange = Date.now();
      }
      onEvent?.({ phase: 'consensus', txHash, explorer: explorerLink, chainStatus: status });
      if (TERMINAL_STATUSES.has(status)) {
        if (status === 'CANCELED' || status === 'UNDETERMINED') {
          throw new Error(
            `validators did not reach consensus (${status}) — ask again in a moment`,
          );
        }
        if (!OK_RESULTS.has(verdict)) {
          throw new Error(
            `validators did not reach consensus (${verdict}) — ask again in a moment`,
          );
        }
        // accepted/finalized with agreement — the record lands shortly
      } else if (
        status.includes('TIMEOUT') &&
        Date.now() - lastStatusChange > STUCK_TIMEOUT_MS
      ) {
        throw new Error(
          `validators timed out (${status}) — the network is having a rough moment, try again`,
        );
      }
    } catch (e) {
      if (e instanceof Error && /consensus|timed out/.test(e.message)) throw e;
      // transient RPC issue — keep polling
    }

    try {
      const raw = (await (read as any).readContract({
        address: cfg.contract,
        functionName: 'get_latest',
        args: [symbol],
      })) as string;
      if (raw) {
        const record = JSON.parse(raw) as ChainRecord;
        if (record.question === question) {
          onEvent?.({ phase: 'success', txHash, explorer: explorerLink });
          return buildResponse(cfg, record, txHash, question, candles);
        }
      }
    } catch {
      // transient read issue — keep polling
    }
  }

  onEvent?.({ phase: 'failed', txHash, explorer: explorerLink, message: 'consensus timed out' });
  throw new Error('consensus timed out — the network may be congested, try again');
}

interface Facts {
  direction: 'bullish' | 'bearish' | 'neutral';
  s: number; // consensus support
  r: number; // consensus resistance
  lc: number; // last close
  t0: number; // window start (s)
  t1: number; // window end (s)
  win: Candle[];
  interval: number;
}

const consensusHlines = (f: Facts): OverlayAction[] => [
  { type: 'hline', price: f.s, style: 'dashed', tone: 'bullish', label: `Consensus support ${f.s}` },
  { type: 'hline', price: f.r, style: 'dashed', tone: 'bearish', label: `Consensus resistance ${f.r}` },
];

/** Intent-routed drawings — the LLM (under consensus) declares which lens the
 *  question asks for; keyword regexes remain only as a fallback for records
 *  written by older contract versions. */
function buildActions(question: string, f: Facts, intent?: string): OverlayAction[] {
  const q = question.toLowerCase();
  const k = intent && ['fib', 'scenario', 'risk', 'trend', 'structure', 'levels'].includes(intent)
    ? intent
    : '';
  const span = f.r - f.s;
  const tone = f.direction === 'bullish' ? 'bullish' : f.direction === 'bearish' ? 'bearish' : 'neutral';
  const t = (k: number) => f.t1 + k * f.interval;

  const hiC = f.win.reduce((a, c) => (c.high > a.high ? c : a), f.win[0]);
  const loC = f.win.reduce((a, c) => (c.low < a.low ? c : a), f.win[0]);

  if (k === 'fib' || (!k && /fib|retrace|retroceso/.test(q))) {
    const up = loC.time < hiC.time;
    return [
      {
        type: 'fib',
        from: up ? { time: loC.time, price: loC.low } : { time: hiC.time, price: hiC.high },
        to: up ? { time: hiC.time, price: hiC.high } : { time: loC.time, price: loC.low },
        tone: 'info',
      },
      {
        type: 'measure',
        from: { time: loC.time, price: loC.low },
        to: { time: hiC.time, price: hiC.high },
        tone: 'info',
      },
      ...consensusHlines(f),
    ];
  }

  if (k === 'scenario' || (!k && /scenario|possible|paths|what if|next|could|escenario|posible|caminos|futuro|siguiente|pasar/.test(q))) {
    return [
      {
        type: 'scenario',
        paths: [
          {
            label: 'Toward consensus resistance',
            tone: 'bullish',
            points: [
              { time: f.t1, price: f.lc },
              { time: t(5), price: f.lc + (f.r - f.lc) * 0.55 },
              { time: t(11), price: f.r },
            ],
          },
          {
            label: 'Toward consensus support',
            tone: 'bearish',
            points: [
              { time: f.t1, price: f.lc },
              { time: t(5), price: f.lc - (f.lc - f.s) * 0.55 },
              { time: t(11), price: f.s },
            ],
          },
          {
            label: 'Hold mid-range',
            tone: 'neutral',
            points: [
              { time: f.t1, price: f.lc },
              { time: t(6), price: f.lc + span * 0.06 },
              { time: t(12), price: f.lc - span * 0.05 },
            ],
          },
        ],
      },
      { type: 'zone', priceLow: f.s, priceHigh: f.r, from: f.t1, to: t(13), kind: 'uncertainty', label: 'Consensus range · all paths hypothetical' },
      ...consensusHlines(f),
    ];
  }

  if (k === 'risk' || (!k && /risk|danger|worst|volatil|riesgo|peligro|ca[ií]da|peor/.test(q))) {
    return [
      { type: 'zone', priceLow: f.s - span * 0.07, priceHigh: f.s + span * 0.07, kind: 'support', label: `Support risk floor ${f.s}` },
      { type: 'zone', priceLow: f.r - span * 0.07, priceHigh: f.r + span * 0.07, kind: 'resistance', label: `Resistance cap ${f.r}` },
      { type: 'zone', priceLow: f.lc - span * 0.18, priceHigh: f.lc + span * 0.18, from: f.t1, to: t(10), kind: 'risk', label: 'Near-term risk band' },
      { type: 'label', time: f.t1, price: f.lc, text: `Consensus: ${f.direction}`, tone, anchor: 'above' },
    ];
  }

  if (k === 'trend' || (!k && /trend|strength|weak|healthy|momentum|tendencia|fuerza|d[eé]bil|salud|impulso/.test(q))) {
    // least-squares fit over the analyzed window
    const n = f.win.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    f.win.forEach((c, i) => {
      sx += i; sy += c.close; sxy += i * c.close; sxx += i * i;
    });
    const m = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const b = (sy - m * sx) / n;
    return [
      {
        type: 'trendline',
        points: [
          { time: f.win[0].time, price: b },
          { time: f.win[n - 1].time, price: b + m * (n - 1) },
        ],
        style: 'solid',
        extend: 'right',
        tone,
        label: `Consensus trend: ${f.direction}`,
      },
      ...consensusHlines(f),
      { type: 'label', time: f.t1, price: f.lc, text: `Holding above ${f.s}`, tone, anchor: f.direction === 'bearish' ? 'below' : 'above' },
    ];
  }

  if (k === 'structure' || (!k && /structure|swing|pattern|estructura|patr[oó]n|r[eé]gimen/.test(q))) {
    return [
      { type: 'marker', time: hiC.time, position: 'above', shape: 'arrowDown', tone: 'bearish', text: 'Window high' },
      { type: 'marker', time: loC.time, position: 'below', shape: 'arrowUp', tone: 'bullish', text: 'Window low' },
      {
        type: 'trendline',
        points: [
          { time: loC.time, price: loC.low },
          { time: hiC.time, price: hiC.high },
        ],
        style: 'dashed',
        tone,
        label: `Dominant swing · ${f.direction}`,
      },
      { type: 'highlight_range', from: f.t0, to: f.t1, tone: 'info', label: 'Window analyzed by validators' },
      ...consensusHlines(f),
    ];
  }

  // levels / general: the classic consensus set
  return [
    ...consensusHlines(f),
    { type: 'zone', priceLow: f.s, priceHigh: f.r, kind: 'uncertainty', label: `Validated range · ${f.direction}` },
    { type: 'highlight_range', from: f.t0, to: f.t1, tone: f.direction === 'neutral' ? 'info' : tone, label: 'Window analyzed by validators' },
  ];
}

/** Chart drawings + card text assembled from the consensus-verified facts. */
function buildResponse(
  cfg: AppConfig,
  record: ChainRecord,
  txHash: `0x${string}`,
  question: string,
  candles: Candle[],
): AIResponse {
  const a = record.analysis ?? {};
  const direction = a.direction === 'bullish' || a.direction === 'bearish' ? a.direction : 'neutral';
  const support = typeof a.support === 'number' ? fin(a.support) : null;
  const resistance = typeof a.resistance === 'number' ? fin(a.resistance) : null;

  let actions: OverlayAction[] = [];
  if (support !== null && resistance !== null && support < resistance && candles.length >= 2) {
    const t0 = typeof a.first_time_s === 'number' && a.first_time_s > 0 ? a.first_time_s : candles[0].time;
    const t1 = typeof a.last_time_s === 'number' && a.last_time_s > 0 ? a.last_time_s : candles[candles.length - 1].time;
    const win = candles.filter((c) => c.time >= t0 && c.time <= t1);
    const facts: Facts = {
      direction,
      s: support,
      r: resistance,
      lc: typeof a.last_close === 'number' ? fin(a.last_close) : win[win.length - 1]?.close ?? support,
      t0,
      t1,
      win: win.length >= 2 ? win : candles.slice(-96),
      interval: candles[1].time - candles[0].time || 60,
    };
    actions = buildActions(question, facts, a.intent);
  }

  // the summary is the LLM's own words, agreed under consensus — shown
  // verbatim, no hardcoded footer in any language
  const summary = a.summary || 'Consensus analysis recorded on-chain.';

  return {
    summary,
    strip: a.strip || `${record.symbol} · ${record.timeframe} · Consensus: ${direction}`,
    actions,
    engine: 'genlayer',
    genlayer: {
      txHash,
      contract: cfg.contract,
      network: cfg.networkLabel,
      explorer: cfg.explorer ? `${cfg.explorer.replace(/\/$/, '')}/tx/${txHash}` : null,
      direction,
      support,
      resistance,
      seq: record.seq ?? null,
    },
  };
}
