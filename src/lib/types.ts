// Shared domain types for the living chart.

export interface Candle {
  time: number; // unix seconds (bar open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Tone = 'bullish' | 'bearish' | 'neutral' | 'warning' | 'info';
export type ZoneKind = 'risk' | 'uncertainty' | 'support' | 'resistance';

export interface PricePoint {
  time: number;
  price: number;
}

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type PaintColor = Tone | 'purple' | 'pink' | 'orange' | 'cyan' | 'white';

export interface GhostCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type OverlayAction =
  | { type: 'highlight_range'; from: number; to: number; tone: Tone; label?: string }
  | {
      type: 'zone';
      priceLow: number;
      priceHigh: number;
      from?: number;
      to?: number;
      kind: ZoneKind;
      label?: string;
    }
  | {
      type: 'trendline';
      points: PricePoint[];
      style: StrokeStyle;
      extend?: 'none' | 'right' | 'both';
      tone: Tone;
      label?: string;
    }
  | { type: 'hline'; price: number; style: StrokeStyle; tone: Tone; label?: string }
  | { type: 'vline'; time: number; style: StrokeStyle; tone: Tone; label?: string }
  | {
      type: 'box';
      from: number;
      to: number;
      priceLow: number;
      priceHigh: number;
      tone: Tone;
      fill?: boolean;
      label?: string;
    }
  | {
      type: 'ellipse';
      from: number;
      to: number;
      priceLow: number;
      priceHigh: number;
      tone: Tone;
      fill?: boolean;
      label?: string;
    }
  | { type: 'arrow'; from: PricePoint; to: PricePoint; tone: Tone; label?: string }
  | { type: 'measure'; from: PricePoint; to: PricePoint; tone: Tone }
  | { type: 'fib'; from: PricePoint; to: PricePoint; tone: Tone }
  | {
      type: 'path';
      points: PricePoint[];
      style: StrokeStyle;
      smooth?: boolean;
      fill?: boolean;
      tone: Tone;
      label?: string;
    }
  | { type: 'paint_candles'; from: number; to: number; color: PaintColor; label?: string }
  | { type: 'ghost_candles'; candles: GhostCandle[]; label?: string }
  | { type: 'text'; time: number; price: number; text: string; size: 'sm' | 'md' | 'lg'; tone: Tone }
  | { type: 'label'; time: number; price: number; text: string; tone: Tone; anchor: 'above' | 'below' }
  | {
      type: 'marker';
      time: number;
      position: 'above' | 'below';
      shape: 'arrowUp' | 'arrowDown' | 'circle';
      tone: Tone;
      text?: string;
    }
  | { type: 'scenario'; paths: { label: string; tone: Tone; points: PricePoint[] }[] };

export interface GenLayerMeta {
  txHash: string;
  contract: string;
  network: string;
  explorer: string | null;
  direction: string | null;
  support: number | null;
  resistance: number | null;
  seq: number | null;
}

export interface AIResponse {
  summary: string;
  strip: string;
  actions: OverlayAction[];
  engine: 'genlayer';
  genlayer?: GenLayerMeta;
}

export type AIStatus = 'idle' | 'thinking' | 'error';
export type DataSource = 'live' | 'demo';
export type FeedStatus = 'connecting' | 'streaming' | 'stalled';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const TIMEFRAMES = [
  { id: '1m', seconds: 60 },
  { id: '5m', seconds: 300 },
  { id: '15m', seconds: 900 },
  { id: '1h', seconds: 3600 },
  { id: '4h', seconds: 14400 },
  { id: '1d', seconds: 86400 },
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number]['id'];

export const DEMO_PROMPTS = [
  'Explain the last 30 candles.',
  'Show risk zones.',
  'Find market structure changes.',
  'Show possible scenarios.',
  'Draw the Fibonacci retracement.',
  'Mark candlestick patterns.',
  'Simplify this chart.',
  'What changed recently?',
] as const;

export function tfSeconds(tf: Timeframe): number {
  return TIMEFRAMES.find((t) => t.id === tf)?.seconds ?? 900;
}

export function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}
