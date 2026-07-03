// The overlay engine. Every AI action is drawn here, on a canvas that sits
// on top of the chart and re-projects through the chart's own coordinate
// system every animation frame — so the AI's drawings pan, zoom and breathe
// with the candles. This is what makes the chart feel like the AI's body.

import type { Candle, OverlayAction, StrokeStyle, Tone, ZoneKind } from './types';

export interface OverlayItem {
  id: number;
  action: OverlayAction;
  addedAt: number; // performance.now() when the AI drew it
}

export interface Mapper {
  timeToX: (t: number) => number | null;
  priceToY: (p: number) => number | null;
  barAt: (t: number) => Candle | null;
  interval: number; // seconds per bar
  paneWidth: number;
  paneHeight: number;
}

const DASHES: Record<StrokeStyle, number[]> = {
  solid: [],
  dashed: [7, 5],
  dotted: [2, 4],
};

export const TONE_COLORS: Record<Tone, string> = {
  bullish: '#0ecb81',
  bearish: '#f6465d',
  neutral: '#94a3b8',
  warning: '#fbbf24',
  info: '#60a5fa',
};

// extended signal palette for paint_candles
const PAINT_COLORS: Record<string, string> = {
  ...TONE_COLORS,
  purple: '#a78bfa',
  pink: '#f472b6',
  orange: '#fb923c',
  cyan: '#22d3ee',
  white: '#e2e8f0',
};

const ZONE_COLORS: Record<ZoneKind, string> = {
  risk: '#fbbf24',
  uncertainty: '#60a5fa',
  support: '#0ecb81',
  resistance: '#f6465d',
};

const INK = '#e2e8f0';
const CHIP_BG = 'rgba(7, 11, 19, 0.88)';
const FONT = '500 11px Inter, ui-sans-serif, system-ui, sans-serif';
const FONT_SMALL = '600 10px Inter, ui-sans-serif, system-ui, sans-serif';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function hexAlpha(hex: string, alpha: number): string {
  const a = Math.round(clamp01(alpha) * 255).toString(16).padStart(2, '0');
  return hex + a;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// chips already placed this frame — later chips stack below instead of overlapping
let placedChips: { x: number; y: number; w: number; h: number }[] = [];

/** Label chip with a tone dot. Returns its rect for pointer lines. */
function chip(
  ctx: CanvasRenderingContext2D,
  mapper: Mapper,
  x: number,
  y: number,
  text: string,
  tone: string,
  align: 'center' | 'left' = 'center',
) {
  ctx.font = FONT;
  const padX = 8;
  const h = 20;
  const dot = 9;
  const w = ctx.measureText(text).width + padX * 2 + dot;
  let x0 = align === 'center' ? x - w / 2 : x;
  x0 = Math.min(Math.max(4, x0), Math.max(4, mapper.paneWidth - w - 4));
  // top clamp keeps chips out from under the floating top bar
  let y0 = Math.min(Math.max(64, y - h / 2), Math.max(64, mapper.paneHeight - h - 4));
  for (let tries = 0; tries < 6; tries++) {
    const hit = placedChips.find(
      (r) => x0 < r.x + r.w + 4 && x0 + w + 4 > r.x && y0 < r.y + r.h + 4 && y0 + h + 4 > r.y,
    );
    if (!hit) break;
    y0 = hit.y + hit.h + 6;
  }
  placedChips.push({ x: x0, y: y0, w, h });

  roundRectPath(ctx, x0, y0, w, h, 6);
  ctx.fillStyle = CHIP_BG;
  ctx.fill();
  ctx.strokeStyle = hexAlpha(tone, 0.45);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x0 + padX + 1.5, y0 + h / 2, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = tone;
  ctx.fill();

  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x0 + padX + dot, y0 + h / 2 + 0.5);

  return { x: x0, y: y0, w, h };
}

// ── individual action painters ──────────────────────────────────────────

function drawHighlight(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'highlight_range' }>,
  alpha: number,
) {
  const x1 = m.timeToX(a.from);
  const x2 = m.timeToX(a.to);
  if (x1 === null || x2 === null) return;
  const color = TONE_COLORS[a.tone];
  const left = Math.min(x1, x2);
  const w = Math.max(6, Math.abs(x2 - x1));

  ctx.globalAlpha = alpha;
  const grad = ctx.createLinearGradient(0, 0, 0, m.paneHeight);
  grad.addColorStop(0, hexAlpha(color, 0.14));
  grad.addColorStop(0.5, hexAlpha(color, 0.05));
  grad.addColorStop(1, hexAlpha(color, 0.12));
  ctx.fillStyle = grad;
  ctx.fillRect(left, 0, w, m.paneHeight);

  ctx.fillStyle = hexAlpha(color, 0.35);
  ctx.fillRect(left, 0, 1.5, m.paneHeight);
  ctx.fillRect(left + w - 1.5, 0, 1.5, m.paneHeight);

  if (a.label) chip(ctx, m, left + w / 2, 18, a.label, color);
  ctx.globalAlpha = 1;
}

function drawZone(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'zone' }>,
  alpha: number,
  now: number,
  reducedMotion: boolean,
) {
  const yTop = m.priceToY(a.priceHigh);
  const yBot = m.priceToY(a.priceLow);
  if (yTop === null || yBot === null) return;
  const x1 = a.from !== undefined ? m.timeToX(a.from) : 0;
  const x2 = a.to !== undefined ? m.timeToX(a.to) : m.paneWidth;
  const left = Math.max(0, Math.min(x1 ?? 0, x2 ?? m.paneWidth));
  const right = Math.min(m.paneWidth, Math.max(x1 ?? 0, x2 ?? m.paneWidth));
  const w = right - left;
  if (w <= 0) return;

  const color = ZONE_COLORS[a.kind];
  const pulse = reducedMotion ? 1 : 1 + 0.16 * Math.sin(now / 650);
  const h = Math.max(2, yBot - yTop);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(left, yTop, w, h);
  ctx.clip();

  ctx.fillStyle = hexAlpha(color, 0.09 * pulse);
  ctx.fillRect(left, yTop, w, h);

  // hatch texture for risk/uncertainty — identity beyond color alone
  if (a.kind === 'risk' || a.kind === 'uncertainty') {
    ctx.strokeStyle = hexAlpha(color, 0.14);
    ctx.lineWidth = 1;
    const gap = 9;
    for (let x = left - h; x < right; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, yBot);
      ctx.lineTo(x + h, yTop);
      ctx.stroke();
    }
  }
  ctx.restore();

  ctx.globalAlpha = alpha;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = hexAlpha(color, 0.4);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, yTop);
  ctx.lineTo(right, yTop);
  ctx.moveTo(left, yBot);
  ctx.lineTo(right, yBot);
  ctx.stroke();
  ctx.setLineDash([]);

  if (a.label) chip(ctx, m, left + 10, yTop + Math.min(16, h / 2), a.label, color, 'left');
  ctx.globalAlpha = 1;
}

function drawTrendline(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'trendline' }>,
  alpha: number,
  progress: number,
) {
  const pts = a.points
    .map((p) => ({ x: m.timeToX(p.time), y: m.priceToY(p.price) }))
    .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
  if (pts.length < 2) return;
  const color = TONE_COLORS[a.tone];

  // extend the line beyond its anchor points if requested
  const stroked = pts.slice();
  const extend = a.extend ?? 'none';
  if (extend === 'right' || extend === 'both') {
    const p1 = stroked[stroked.length - 2];
    const p2 = stroked[stroked.length - 1];
    const dx = p2.x - p1.x || 1;
    const k = (m.paneWidth + 20 - p2.x) / dx;
    if (k > 0) stroked.push({ x: p2.x + dx * k, y: p2.y + (p2.y - p1.y) * k });
  }
  if (extend === 'both') {
    const p1 = stroked[0];
    const p2 = stroked[1];
    const dx = p2.x - p1.x || 1;
    const k = (p1.x + 20) / dx;
    if (k > 0) stroked.unshift({ x: p1.x - dx * k, y: p1.y - (p2.y - p1.y) * k });
  }

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = hexAlpha(color, 0.55);
  ctx.shadowBlur = 9;
  ctx.setLineDash(DASHES[a.style] ?? []);

  strokePartialPath(ctx, stroked, progress);

  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  for (const p of [pts[0], pts[pts.length - 1]]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  if (a.label && progress > 0.85) {
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    const next = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)];
    const mx = (mid.x + next.x) / 2;
    const my = (mid.y + next.y) / 2;
    chip(ctx, m, mx, my - 18, a.label, color);
  }
  ctx.globalAlpha = 1;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'label' }>,
  alpha: number,
  rise: number,
) {
  const x = m.timeToX(a.time);
  const y = m.priceToY(a.price);
  if (x === null || y === null) return;
  const color = TONE_COLORS[a.tone];
  const dir = a.anchor === 'above' ? -1 : 1;
  const chipY = y + dir * 34 + rise * dir * -1;

  ctx.globalAlpha = alpha;
  // pointer stem from the price point to the chip
  ctx.strokeStyle = hexAlpha(color, 0.5);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x, y + dir * 6);
  ctx.lineTo(x, chipY - dir * 10);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = hexAlpha(color, 0.8);
  ctx.shadowBlur = 7;
  ctx.fill();
  ctx.shadowBlur = 0;

  chip(ctx, m, x, chipY, a.text, color);
  ctx.globalAlpha = 1;
}

function drawMarker(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'marker' }>,
  alpha: number,
) {
  const x = m.timeToX(a.time);
  const bar = m.barAt(a.time);
  if (x === null || !bar) return;
  const yBase = a.position === 'above' ? m.priceToY(bar.high) : m.priceToY(bar.low);
  if (yBase === null) return;
  const dir = a.position === 'above' ? -1 : 1;
  const y = yBase + dir * 14;
  const color = TONE_COLORS[a.tone];

  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.shadowColor = hexAlpha(color, 0.6);
  ctx.shadowBlur = 6;

  if (a.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexAlpha(color, 0.35);
    ctx.lineWidth = 3;
    ctx.stroke();
  } else {
    const up = a.shape === 'arrowUp';
    ctx.beginPath();
    ctx.moveTo(x, up ? y - 5 : y + 5);
    ctx.lineTo(x - 5, up ? y + 4 : y - 4);
    ctx.lineTo(x + 5, up ? y + 4 : y - 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  if (a.text) {
    ctx.font = FONT_SMALL;
    ctx.fillStyle = '#a9b7cc';
    ctx.textAlign = 'center';
    ctx.textBaseline = a.position === 'above' ? 'bottom' : 'top';
    ctx.fillText(a.text, x, y + dir * 9);
  }
  ctx.globalAlpha = 1;
}

function drawScenario(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'scenario' }>,
  alpha: number,
  progress: number,
) {
  a.paths.forEach((path, pi) => {
    const pts = path.points
      .map((p) => ({ x: m.timeToX(p.time), y: m.priceToY(p.price) }))
      .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
    if (pts.length < 2) return;
    const color = TONE_COLORS[path.tone];
    const pathProgress = clamp01(progress * 1.4 - pi * 0.18); // staggered unfurl
    if (pathProgress <= 0) return;

    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([6, 6]);
    ctx.shadowColor = hexAlpha(color, 0.5);
    ctx.shadowBlur = 8;

    const end = strokePartialPath(ctx, pts, pathProgress);

    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    if (end && pathProgress >= 1) {
      // arrowhead along the final segment
      const prev = pts[pts.length - 2];
      const last = pts[pts.length - 1];
      const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - 9 * Math.cos(ang - 0.42), last.y - 9 * Math.sin(ang - 0.42));
      ctx.lineTo(last.x - 9 * Math.cos(ang + 0.42), last.y - 9 * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      chip(ctx, m, last.x + 10, last.y, path.label, color, 'left');
    }
    ctx.globalAlpha = 1;
  });
}

function drawHline(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'hline' }>,
  alpha: number,
) {
  const y = m.priceToY(a.price);
  if (y === null) return;
  const color = TONE_COLORS[a.tone];
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = hexAlpha(color, 0.65);
  ctx.lineWidth = 1.5;
  ctx.setLineDash(DASHES[a.style] ?? []);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(m.paneWidth, y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (a.label) chip(ctx, m, 8, y - 14, a.label, color, 'left');
  ctx.globalAlpha = 1;
}

function drawVline(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'vline' }>,
  alpha: number,
) {
  const x = m.timeToX(a.time);
  if (x === null) return;
  const color = TONE_COLORS[a.tone];
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = hexAlpha(color, 0.55);
  ctx.lineWidth = 1.5;
  ctx.setLineDash(DASHES[a.style] ?? []);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, m.paneHeight);
  ctx.stroke();
  ctx.setLineDash([]);
  if (a.label) chip(ctx, m, x, 76, a.label, color);
  ctx.globalAlpha = 1;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'box' }>,
  alpha: number,
) {
  const x1 = m.timeToX(a.from);
  const x2 = m.timeToX(a.to);
  const yT = m.priceToY(a.priceHigh);
  const yB = m.priceToY(a.priceLow);
  if (x1 === null || x2 === null || yT === null || yB === null) return;
  const color = TONE_COLORS[a.tone];
  const left = Math.min(x1, x2);
  const w = Math.max(4, Math.abs(x2 - x1));
  const h = Math.max(4, yB - yT);

  ctx.globalAlpha = alpha;
  if (a.fill !== false) {
    ctx.fillStyle = hexAlpha(color, 0.08);
    ctx.fillRect(left, yT, w, h);
  }
  ctx.strokeStyle = hexAlpha(color, 0.6);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(left, yT, w, h);
  if (a.label) chip(ctx, m, left + 8, yT + 14, a.label, color, 'left');
  ctx.globalAlpha = 1;
}

function drawEllipse(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'ellipse' }>,
  alpha: number,
) {
  const x1 = m.timeToX(a.from);
  const x2 = m.timeToX(a.to);
  const yT = m.priceToY(a.priceHigh);
  const yB = m.priceToY(a.priceLow);
  if (x1 === null || x2 === null || yT === null || yB === null) return;
  const color = TONE_COLORS[a.tone];
  const cx = (x1 + x2) / 2;
  const cy = (yT + yB) / 2;
  const rx = Math.max(10, Math.abs(x2 - x1) / 2 + 8);
  const ry = Math.max(10, (yB - yT) / 2 + 8);

  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  if (a.fill !== false) {
    ctx.fillStyle = hexAlpha(color, 0.07);
    ctx.fill();
  }
  ctx.strokeStyle = hexAlpha(color, 0.7);
  ctx.lineWidth = 1.5;
  ctx.shadowColor = hexAlpha(color, 0.4);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (a.label) chip(ctx, m, cx, cy - ry - 14, a.label, color);
  ctx.globalAlpha = 1;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'arrow' }>,
  alpha: number,
  progress: number,
) {
  const x1 = m.timeToX(a.from.time);
  const y1 = m.priceToY(a.from.price);
  const x2 = m.timeToX(a.to.time);
  const y2 = m.priceToY(a.to.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return;
  const color = TONE_COLORS[a.tone];

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = hexAlpha(color, 0.5);
  ctx.shadowBlur = 8;
  const ex = x1 + (x2 - x1) * progress;
  const ey = y1 + (y2 - y1) * progress;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - 11 * Math.cos(ang - 0.4), ey - 11 * Math.sin(ang - 0.4));
  ctx.lineTo(ex - 11 * Math.cos(ang + 0.4), ey - 11 * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (a.label && progress > 0.85) {
    chip(ctx, m, (x1 + x2) / 2, (y1 + y2) / 2 - 16, a.label, color);
  }
  ctx.globalAlpha = 1;
}

/** Densify a polyline with quadratic midpoint smoothing. */
function smoothPoints(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const out: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const a = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    for (let s = 1; s <= 8; s++) {
      const t = s / 8;
      const u = 1 - t;
      out.push({
        x: u * u * a.x + 2 * u * t * p1.x + t * t * b.x,
        y: u * u * a.y + 2 * u * t * p1.y + t * t * b.y,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'path' }>,
  alpha: number,
  progress: number,
) {
  let pts = a.points
    .map((p) => ({ x: m.timeToX(p.time), y: m.priceToY(p.price) }))
    .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null);
  if (pts.length < 2) return;
  if (a.smooth) pts = smoothPoints(pts);
  const color = TONE_COLORS[a.tone];

  ctx.globalAlpha = alpha;
  if (a.fill && progress >= 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fillStyle = hexAlpha(color, 0.09);
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = hexAlpha(color, 0.5);
  ctx.shadowBlur = 8;
  ctx.setLineDash(DASHES[a.style] ?? []);
  strokePartialPath(ctx, pts, progress);
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  if (a.label && progress > 0.85) {
    const last = pts[pts.length - 1];
    chip(ctx, m, last.x + 10, last.y, a.label, color, 'left');
  }
  ctx.globalAlpha = 1;
}

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function drawFib(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'fib' }>,
  alpha: number,
) {
  const x1 = m.timeToX(a.from.time);
  const x2 = m.timeToX(a.to.time);
  if (x1 === null || x2 === null) return;
  const left = Math.max(0, Math.min(x1, x2));
  const color = TONE_COLORS[a.tone];
  const span = a.from.price - a.to.price; // level r sits at to + r*(from-to)

  ctx.globalAlpha = alpha;

  // golden pocket tint between 0.5 and 0.618
  const yG1 = m.priceToY(a.to.price + 0.5 * span);
  const yG2 = m.priceToY(a.to.price + 0.618 * span);
  if (yG1 !== null && yG2 !== null) {
    ctx.fillStyle = hexAlpha(color, 0.06);
    ctx.fillRect(left, Math.min(yG1, yG2), m.paneWidth - left, Math.abs(yG2 - yG1));
  }

  ctx.font = FONT_SMALL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const r of FIB_RATIOS) {
    const price = a.to.price + r * span;
    const y = m.priceToY(price);
    if (y === null) continue;
    const key = r === 0.5 || r === 0.618;
    ctx.strokeStyle = hexAlpha(color, key ? 0.5 : 0.28);
    ctx.lineWidth = key ? 1.5 : 1;
    ctx.setLineDash(r === 0 || r === 1 ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(m.paneWidth, y);
    ctx.stroke();
    ctx.fillStyle = hexAlpha(color, 0.85);
    ctx.fillText(
      `${r} · ${price >= 1000 ? price.toLocaleString('en-US', { maximumFractionDigits: 0 }) : price.toFixed(price >= 1 ? 2 : 4)}`,
      left + 6,
      y - 3,
    );
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function humanDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${min}m`;
  return `${min}m`;
}

function drawMeasure(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'measure' }>,
  alpha: number,
) {
  const x1 = m.timeToX(a.from.time);
  const y1 = m.priceToY(a.from.price);
  const x2 = m.timeToX(a.to.time);
  const y2 = m.priceToY(a.to.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return;
  const color = TONE_COLORS[a.tone];

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = hexAlpha(color, 0.75);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);

  // perpendicular end ticks
  const ang = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
  for (const [px, py] of [[x1, y1], [x2, y2]] as const) {
    ctx.beginPath();
    ctx.moveTo(px - 6 * Math.cos(ang), py - 6 * Math.sin(ang));
    ctx.lineTo(px + 6 * Math.cos(ang), py + 6 * Math.sin(ang));
    ctx.stroke();
  }

  const pctChange = ((a.to.price - a.from.price) / a.from.price) * 100;
  const bars = Math.round(Math.abs(a.to.time - a.from.time) / m.interval);
  const label = `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}% · ${bars} bars · ${humanDuration(Math.abs(a.to.time - a.from.time))}`;
  chip(ctx, m, (x1 + x2) / 2, (y1 + y2) / 2 - 16, label, color);
  ctx.globalAlpha = 1;
}

const TEXT_SIZES = { sm: '600 11px', md: '600 14px', lg: '700 19px' } as const;

function drawText(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'text' }>,
  alpha: number,
) {
  const x = m.timeToX(a.time);
  const y = m.priceToY(a.price);
  if (x === null || y === null) return;
  const color = TONE_COLORS[a.tone];
  ctx.globalAlpha = alpha;
  ctx.font = `${TEXT_SIZES[a.size] ?? TEXT_SIZES.md} Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 5;
  ctx.fillStyle = hexAlpha(color, 0.95);
  ctx.fillText(a.text, Math.min(Math.max(20, x), m.paneWidth - 20), Math.min(Math.max(70, y), m.paneHeight - 12));
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/** Repaint a span of real candles in a signal color, on top of the chart. */
function drawPaintCandles(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'paint_candles' }>,
  alpha: number,
) {
  const color = PAINT_COLORS[a.color] ?? PAINT_COLORS.warning;
  const x0 = m.timeToX(a.from);
  const x1 = m.timeToX(a.from + m.interval);
  if (x0 === null) return;
  const spacing = x1 !== null ? Math.abs(x1 - x0) : 8;
  const bw = Math.max(3, spacing * 0.72);

  ctx.globalAlpha = alpha;
  let topY: number | null = null;
  let midX = x0;
  let count = 0;
  for (let t = a.from; t <= a.to && count < 100; t += m.interval, count++) {
    const bar = m.barAt(t);
    if (!bar || bar.time !== t) continue;
    const x = m.timeToX(t);
    const yH = m.priceToY(bar.high);
    const yL = m.priceToY(bar.low);
    const yO = m.priceToY(bar.open);
    const yC = m.priceToY(bar.close);
    if (x === null || yH === null || yL === null || yO === null || yC === null) continue;

    ctx.shadowColor = hexAlpha(color, 0.6);
    ctx.shadowBlur = 7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();

    const top = Math.min(yO, yC);
    const h = Math.max(1.5, Math.abs(yC - yO));
    ctx.fillStyle = color;
    ctx.fillRect(x - bw / 2, top, bw, h);
    ctx.shadowBlur = 0;

    if (topY === null || yH < topY) topY = yH;
    midX = (x0 + x) / 2;
  }

  if (a.label && topY !== null) chip(ctx, m, midX, topY - 18, a.label, color);
  ctx.globalAlpha = 1;
}

/** Semi-transparent hypothetical candles sketched into the future. */
function drawGhostCandles(
  ctx: CanvasRenderingContext2D,
  m: Mapper,
  a: Extract<OverlayAction, { type: 'ghost_candles' }>,
  alpha: number,
  progress: number,
) {
  const first = a.candles[0];
  const x0 = m.timeToX(first.time);
  // ghosts may be spaced at any interval (e.g. daily candles on a 15m chart)
  const ghostInterval =
    a.candles.length > 1 ? Math.max(1, a.candles[1].time - first.time) : m.interval;
  const x1 = m.timeToX(first.time + ghostInterval);
  if (x0 === null) return;
  const spacing = x1 !== null ? Math.abs(x1 - x0) : 8;
  const bw = Math.max(3, spacing * 0.62);
  const visible = Math.max(1, Math.ceil(a.candles.length * progress));

  ctx.globalAlpha = alpha;
  let labelY: number | null = null;
  for (let i = 0; i < visible && i < a.candles.length; i++) {
    const c = a.candles[i];
    const x = m.timeToX(c.time);
    const yH = m.priceToY(c.high);
    const yL = m.priceToY(c.low);
    const yO = m.priceToY(c.open);
    const yC = m.priceToY(c.close);
    if (x === null || yH === null || yL === null || yO === null || yC === null) continue;
    const color = c.close >= c.open ? TONE_COLORS.bullish : TONE_COLORS.bearish;

    ctx.strokeStyle = hexAlpha(color, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();

    const top = Math.min(yO, yC);
    const h = Math.max(2, Math.abs(yC - yO));
    ctx.fillStyle = hexAlpha(color, 0.16);
    ctx.fillRect(x - bw / 2, top, bw, h);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = hexAlpha(color, 0.65);
    ctx.strokeRect(x - bw / 2, top, bw, h);
    ctx.setLineDash([]);

    if (i === 0 && labelY === null) labelY = yH;
  }

  if (a.label && labelY !== null && progress > 0.5) {
    chip(ctx, m, x0, labelY - 20, a.label, TONE_COLORS.info, 'left');
  }
  ctx.globalAlpha = 1;
}

/** Stroke a polyline up to `progress` (0..1) of its total length. */
function strokePartialPath(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  progress: number,
): boolean {
  if (progress <= 0) return false;
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lens.push(l);
    total += l;
  }
  let remaining = total * clamp01(progress);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const l = lens[i - 1];
    if (remaining >= l) {
      ctx.lineTo(pts[i].x, pts[i].y);
      remaining -= l;
    } else {
      const f = l === 0 ? 0 : remaining / l;
      ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f);
      remaining = 0;
      break;
    }
  }
  ctx.stroke();
  return progress >= 1;
}

// ── frame entry point ───────────────────────────────────────────────────

const ENTRY_MS = 480;
const SCENARIO_MS = 1400;
const STAGGER_MS = 110;

export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  items: OverlayItem[],
  mapper: Mapper,
  now: number,
  reducedMotion: boolean,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, mapper.paneWidth, mapper.paneHeight);
  ctx.clip();
  placedChips = [];

  items.forEach((item, idx) => {
    const isScenario = item.action.type === 'scenario' || item.action.type === 'ghost_candles';
    const dur = isScenario ? SCENARIO_MS : ENTRY_MS;
    const raw = reducedMotion ? 1 : clamp01((now - item.addedAt - idx * STAGGER_MS) / dur);
    if (raw <= 0) return;
    const eased = easeOutCubic(raw);

    switch (item.action.type) {
      case 'highlight_range':
        drawHighlight(ctx, mapper, item.action, eased);
        break;
      case 'zone':
        drawZone(ctx, mapper, item.action, eased, now, reducedMotion);
        break;
      case 'trendline':
        drawTrendline(ctx, mapper, item.action, Math.min(1, eased * 1.6), eased);
        break;
      case 'hline':
        drawHline(ctx, mapper, item.action, eased);
        break;
      case 'vline':
        drawVline(ctx, mapper, item.action, eased);
        break;
      case 'box':
        drawBox(ctx, mapper, item.action, eased);
        break;
      case 'ellipse':
        drawEllipse(ctx, mapper, item.action, eased);
        break;
      case 'arrow':
        drawArrow(ctx, mapper, item.action, Math.min(1, eased * 1.6), eased);
        break;
      case 'path':
        drawPath(ctx, mapper, item.action, Math.min(1, eased * 1.6), eased);
        break;
      case 'fib':
        drawFib(ctx, mapper, item.action, eased);
        break;
      case 'measure':
        drawMeasure(ctx, mapper, item.action, eased);
        break;
      case 'paint_candles':
        drawPaintCandles(ctx, mapper, item.action, eased);
        break;
      case 'ghost_candles':
        drawGhostCandles(ctx, mapper, item.action, Math.min(1, eased * 1.4), eased);
        break;
      case 'text':
        drawText(ctx, mapper, item.action, eased);
        break;
      case 'label':
        drawLabel(ctx, mapper, item.action, eased, (1 - eased) * 8);
        break;
      case 'marker':
        drawMarker(ctx, mapper, item.action, eased);
        break;
      case 'scenario':
        drawScenario(ctx, mapper, item.action, Math.min(1, eased * 1.6), eased);
        break;
    }
  });

  ctx.restore();
}
