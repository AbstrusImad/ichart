// The front door — the living chart IS the landing. A full-viewport market
// animates behind the hero, cycling through the product's real powers
// (AI scan, consensus levels, fibonacci, scenario paths) while floating HUD
// fragments orbit the headline. And a hard gate: no wallet, no app.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AppConfig } from '../lib/genlayerClient';
import { LogoIcon, SparkIcon } from './icons';

interface LandingProps {
  config: AppConfig | null;
  hasWallet: boolean;
  busy: boolean;
  error: string | null;
  leaving: boolean;
  onConnect: () => void;
}

/* ── animated counters for the stats row ─────────────────────────────── */

function Counter({ to, suffix = '', delay }: { to: number; suffix?: string; delay: number }) {
  const [v, setV] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setV(to);
      return;
    }
    let raf = 0;
    const t = window.setTimeout(() => {
      const t0 = performance.now();
      const D = 1500;
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / D);
        setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, delay);
    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, [to, delay]);

  return (
    <b>
      {v.toLocaleString('en-US')}
      {suffix}
    </b>
  );
}

/* ── full-viewport living market ─────────────────────────────────────── */

function FullScene() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // cursor-reactive candles + click ripples
    const mouse = { x: -9999, y: -9999 };
    const ripples: { x: number; y: number; t0: number }[] = [];
    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    const onDown = (e: MouseEvent) => {
      ripples.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
      if (ripples.length > 6) ripples.shift();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerdown', onDown);

    let W = 0;
    let H = 0;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    window.addEventListener('resize', fit);

    // endless random walk
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const CW = 14; // px per candle
    const makeCandle = (open: number) => {
      const c = open + (rnd() - 0.485) * 26;
      return {
        o: open,
        c,
        h: Math.max(open, c) + rnd() * 14,
        l: Math.min(open, c) - rnd() * 14,
      };
    };
    const candles: { o: number; h: number; l: number; c: number }[] = [];
    let price = 400;
    for (let i = 0; i < 260; i++) {
      const k = makeCandle(price);
      candles.push(k);
      price = k.c;
    }

    let offset = 0;
    let vLo = 0;
    let vHi = 1;
    let last = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, now - last);
      last = now;

      if (!reduced) {
        offset += dt * 0.022; // gentle drift
        while (offset >= CW) {
          offset -= CW;
          const k = makeCandle(candles[candles.length - 1].c);
          candles.push(k);
          candles.shift();
        }
      }

      const visN = Math.ceil(W / CW) + 2;
      const vis = candles.slice(-visN);
      const lo = Math.min(...vis.map((k) => k.l));
      const hi = Math.max(...vis.map((k) => k.h));
      // smooth vertical scale so the tape never jumps
      vLo = vLo === 0 ? lo : vLo + (lo - vLo) * 0.02;
      vHi = vHi === 1 ? hi : vHi + (hi - vHi) * 0.02;
      const pad = (vHi - vLo) * 0.18 + 1;
      const y = (v: number) => ((vHi + pad - v) / (vHi - vLo + pad * 2)) * H;

      ctx.clearRect(0, 0, W, H);

      // recessive grid
      ctx.strokeStyle = 'rgba(148,163,184,0.05)';
      ctx.lineWidth = 1;
      for (let gy = 0; gy < H; gy += 90) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
        ctx.stroke();
      }

      for (let i = 0; i < vis.length; i++) {
        const k = vis[i];
        const x = W - (vis.length - i) * CW - offset + CW / 2;
        const up = k.c >= k.o;
        const color = up ? '#0ecb81' : '#f6465d';
        // candles near the cursor wake up: brighter, wider, glowing
        const dx = Math.abs(x - mouse.x);
        const f = dx < 150 ? 1 - dx / 150 : 0;
        if (f > 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 16 * f;
        }
        ctx.strokeStyle = color + (f > 0.3 ? 'cc' : '66');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y(k.h));
        ctx.lineTo(x, y(k.l));
        ctx.stroke();
        ctx.fillStyle = f > 0 ? color : color + 'cc';
        const top = y(Math.max(k.o, k.c));
        const bw2 = CW * (0.6 + 0.22 * f);
        ctx.fillRect(x - bw2 / 2, top, bw2, Math.max(1.5, y(Math.min(k.o, k.c)) - top));
        ctx.shadowBlur = 0;
      }

      // click ripples: an expanding wave of light through the market
      for (let ri = ripples.length - 1; ri >= 0; ri--) {
        const rp = ripples[ri];
        const age = now - rp.t0;
        if (age > 950) {
          ripples.splice(ri, 1);
          continue;
        }
        const p = age / 950;
        const radius = 40 + p * 540;
        const a = (1 - p) * 0.55;
        const glow = ctx.createRadialGradient(rp.x, rp.y, radius * 0.55, rp.x, rp.y, radius);
        glow.addColorStop(0, 'rgba(45,212,191,0)');
        glow.addColorStop(0.8, `rgba(45,212,191,${a * 0.16})`);
        glow.addColorStop(1, 'rgba(45,212,191,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(rp.x - radius, rp.y - radius, radius * 2, radius * 2);
        ctx.strokeStyle = `rgba(45,212,191,${a})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // last-price glow line
      const lp = y(vis[vis.length - 1].c);
      const lg = ctx.createLinearGradient(0, lp - 40, 0, lp + 40);
      lg.addColorStop(0, 'rgba(45,212,191,0)');
      lg.addColorStop(0.5, 'rgba(45,212,191,0.05)');
      lg.addColorStop(1, 'rgba(45,212,191,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(0, lp - 40, W, 80);
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = 'rgba(45,212,191,0.35)';
      ctx.beginPath();
      ctx.moveTo(0, lp);
      ctx.lineTo(W, lp);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── the demo reel: scan → consensus → fibonacci → scenarios ──────
      const CYCLE = 26000;
      const t = reduced ? CYCLE * 0.3 : (now % CYCLE) / CYCLE;
      const phase = Math.floor(t * 4);
      const pt = (t * 4) % 1;
      const env = Math.sin(Math.PI * pt); // fade in/out envelope
      const label = (text: string, x: number, ly: number, color: string) => {
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = color;
        ctx.fillText(text, x, ly);
      };
      const mid = y((vHi + vLo) / 2);
      const sup = y(vLo + (vHi - vLo) * 0.18);
      const res = y(vLo + (vHi - vLo) * 0.84);

      ctx.globalAlpha = env * 0.9;
      if (phase === 0) {
        // AI scanline
        const sx = pt * (W + 300) - 150;
        const g = ctx.createLinearGradient(sx - 130, 0, sx + 130, 0);
        g.addColorStop(0, 'rgba(45,212,191,0)');
        g.addColorStop(0.5, 'rgba(45,212,191,0.13)');
        g.addColorStop(1, 'rgba(45,212,191,0)');
        ctx.fillStyle = g;
        ctx.fillRect(sx - 130, 0, 260, H);
        ctx.globalAlpha = env * 0.7;
        label('reading the tape…', Math.min(Math.max(20, sx + 140), W - 140), 90, 'rgba(45,212,191,0.8)');
      } else if (phase === 1) {
        // consensus levels + validated range
        ctx.setLineDash([7, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(14,203,129,0.75)';
        ctx.beginPath();
        ctx.moveTo(0, sup);
        ctx.lineTo(W, sup);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(246,70,93,0.75)';
        ctx.beginPath();
        ctx.moveTo(0, res);
        ctx.lineTo(W, res);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(96,165,250,0.05)';
        ctx.fillRect(0, res, W, sup - res);
        label('consensus support · 5 validators agreed', 26, sup - 8, 'rgba(14,203,129,0.9)');
        label('consensus resistance', 26, res - 8, 'rgba(246,70,93,0.9)');
      } else if (phase === 2) {
        // fibonacci
        const ratios = [0, 0.236, 0.382, 0.5, 0.618, 1];
        for (const r of ratios) {
          const fy = res + (sup - res) * r;
          const key = r === 0.5 || r === 0.618;
          ctx.setLineDash(r === 0 || r === 1 ? [] : [5, 5]);
          ctx.strokeStyle = key ? 'rgba(96,165,250,0.6)' : 'rgba(96,165,250,0.3)';
          ctx.lineWidth = key ? 1.5 : 1;
          ctx.beginPath();
          ctx.moveTo(0, fy);
          ctx.lineTo(W, fy);
          ctx.stroke();
          label(String(r), 26, fy - 5, 'rgba(147,197,253,0.85)');
        }
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(96,165,250,0.05)';
        ctx.fillRect(0, res + (sup - res) * 0.5, W, (sup - res) * 0.118);
        label('fibonacci · golden pocket', 70, res + (sup - res) * 0.57, 'rgba(147,197,253,0.9)');
      } else {
        // scenario paths from the live edge
        const x0 = W - 60;
        const draw = (toY: number, color: string) => {
          ctx.setLineDash([7, 7]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(x0 - 240 * env, lp);
          ctx.quadraticCurveTo(x0 - 90 * env, lp, x0 - 200 * env + 200, lp + (toY - lp) * env);
          ctx.stroke();
          ctx.setLineDash([]);
        };
        draw(res, 'rgba(14,203,129,0.7)');
        draw(sup, 'rgba(246,70,93,0.7)');
        draw(mid, 'rgba(148,163,184,0.55)');
        label('hypothetical paths · not a forecast', W - 330, Math.min(res, lp) - 16, 'rgba(226,232,240,0.75)');
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', onDown);
    };
  }, []);

  return <canvas ref={ref} className="scene-canvas" aria-hidden="true" />;
}

/* ── live ticker tape ────────────────────────────────────────────────── */

interface Tick {
  s: string;
  price: string;
  pct: number;
}

function TickerTape() {
  const [ticks, setTicks] = useState<Tick[]>([]);

  useEffect(() => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
    )
      .then((r) => r.json())
      .then((rows: { symbol: string; lastPrice: string; priceChangePercent: string }[]) => {
        if (!Array.isArray(rows)) return;
        setTicks(
          rows.map((r) => ({
            s: r.symbol.replace('USDT', ''),
            price: Number(r.lastPrice).toLocaleString('en-US', { maximumFractionDigits: 2 }),
            pct: Number(r.priceChangePercent),
          })),
        );
      })
      .catch(() => undefined);
  }, []);

  if (!ticks.length) return null;
  const row = (key: string) => (
    <div className="tape-row" key={key} aria-hidden={key === 'b'}>
      {ticks.map((t) => (
        <span className="tape-item" key={key + t.s}>
          <b>{t.s}</b> {t.price}
          <i className={t.pct >= 0 ? 'up' : 'down'}>
            {t.pct >= 0 ? '+' : ''}
            {t.pct.toFixed(2)}%
          </i>
        </span>
      ))}
      <span className="tape-item tape-live">● LIVE FROM BINANCE</span>
    </div>
  );
  return <div className="ticker-tape">{row('a')}{row('b')}</div>;
}

/* ── roaming HUD cards: type in, hold, fade out, reappear elsewhere ──── */

interface RoamMsg {
  body: string;
  sub: string;
}

const HUD_SPOTS: CSSProperties[] = [
  { top: '15%', right: '5%' },
  { bottom: '25%', left: '4.5%' },
  { top: '40%', left: '5%' },
  { bottom: '16%', right: '7%' },
  { top: '13%', left: '23%' },
];

const CONSENSUS_MSGS: RoamMsg[] = [
  { body: 'Structure: bullish · support 61,108 · resistance 62,400', sub: '5 validators agreed independently' },
  { body: 'BTCUSDT 15m · +0.82% window · close 61,724', sub: 'consensus recorded on-chain · seq #2' },
  { body: 'Fibonacci 0.618 holding — golden pocket in play', sub: 'drawn by consensus on live candles' },
  { body: 'Risk concentrates at 61,108 — losing it opens the downside', sub: 'multi-validator verified · not a forecast' },
];

const RECEIPT_MSGS: RoamMsg[] = [
  { body: 'tx 0xc0d9…cE99 · MAJORITY_AGREE', sub: 'recorded on GenLayer Bradbury' },
  { body: '5/5 validators reran the analysis', sub: 'independent LLMs, one verdict' },
  { body: 'new record #7 · block 13,456,890', sub: 'public & auditable forever' },
  { body: 'leader rotated · consensus recovered', sub: 'Optimistic Democracy at work' },
];

function RoamingHud({
  messages,
  variant,
  posOffset,
  startDelay,
}: {
  messages: RoamMsg[];
  variant: 'consensus' | 'receipt';
  posOffset: number;
  startDelay: number;
}) {
  const [cycle, setCycle] = useState(0);
  const [typed, setTyped] = useState(0);
  const [stage, setStage] = useState<'wait' | 'in' | 'hold' | 'out'>('wait');

  const msg = messages[cycle % messages.length];
  const spot = HUD_SPOTS[(cycle + posOffset) % HUD_SPOTS.length];

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timers: number[] = [];
    let typer = 0;

    const begin = () => {
      setStage('in');
      if (reduced) {
        setTyped(msg.body.length);
        timers.push(window.setTimeout(hold, 100));
        return;
      }
      setTyped(0);
      let n = 0;
      typer = window.setInterval(() => {
        n += 1;
        setTyped(n);
        if (n >= msg.body.length) {
          window.clearInterval(typer);
          hold();
        }
      }, 26);
    };
    const hold = () => {
      setStage('hold');
      timers.push(
        window.setTimeout(() => {
          setStage('out');
          timers.push(
            window.setTimeout(() => {
              setCycle((c) => c + 1);
            }, 600),
          );
        }, 3400),
      );
    };

    timers.push(window.setTimeout(begin, cycle === 0 ? startDelay : 60));
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.clearInterval(typer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle]);

  if (stage === 'wait') return null;

  return (
    <div className={`hud roam ${stage}`} style={spot} aria-hidden="true">
      {variant === 'consensus' ? (
        <span className="hud-badge">GENLAYER · CONSENSUS</span>
      ) : (
        <span className="hud-check">✓</span>
      )}
      <p className={variant === 'receipt' ? 'mono' : undefined}>
        {msg.body.slice(0, typed)}
        {stage === 'in' && <span className="type-cursor" />}
      </p>
      <span className={`hud-sub ${typed >= msg.body.length ? 'shown' : ''}`}>{msg.sub}</span>
    </div>
  );
}

/* ── landing ─────────────────────────────────────────────────────────── */

export default function Landing({ config, hasWallet, busy, error, leaving, onConnect }: LandingProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // mouse spotlight
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      el.style.setProperty('--mx', `${e.clientX}px`);
      el.style.setProperty('--my', `${e.clientY}px`);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div ref={rootRef} className={`landing ${leaving ? 'leaving' : ''}`}>
      <FullScene />
      <div className="landing-veil" aria-hidden="true" />
      <div className="landing-spot" aria-hidden="true" />

      <header className="landing-brand lx-1">
        <LogoIcon size={30} />
        <span>iChart</span>
        <span className="brand-live">
          <span className="engine-dot" /> {config?.networkLabel ?? 'GenLayer'}
        </span>
      </header>

      {/* roaming HUD fragments: type in, hold, fade out, reappear elsewhere */}
      <RoamingHud messages={CONSENSUS_MSGS} variant="consensus" posOffset={0} startDelay={1400} />
      <RoamingHud messages={RECEIPT_MSGS} variant="receipt" posOffset={2} startDelay={3600} />

      <main className="landing-hero">
        <span className="landing-eyebrow lx-1">
          <span className="engine-dot" /> The first consensus-validated chart
        </span>

        <h1 className="landing-title">
          <span className="lx-2">Ask the market.</span>
          <br />
          <span className="lx-3 grad">Validators answer.</span>
        </h1>

        <p className="landing-sub lx-4">
          Every question you ask becomes an on-chain transaction. Independent AI validators
          each run the analysis, vote, and only a verified consensus gets drawn onto your
          live chart — as light.
        </p>

        <div className="landing-cta-row lx-5">
          {hasWallet ? (
            <button className="landing-cta" onClick={onConnect} disabled={busy || !config}>
              <span className="cta-ring" aria-hidden="true" />
              <SparkIcon size={18} />
              {busy ? 'Opening the door…' : 'Connect Wallet to Enter'}
            </button>
          ) : (
            <a className="landing-cta" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              <span className="cta-ring" aria-hidden="true" />
              Install MetaMask to Enter
            </a>
          )}
          {error && <p className="landing-error">{error}</p>}
          <p className="landing-hint">
            You sign every analysis · testnet GEN is free at the{' '}
            <a href={config?.faucet ?? 'https://testnet-faucet.genlayer.foundation/'} target="_blank" rel="noreferrer">
              faucet
            </a>
          </p>
        </div>

        <div className="landing-stats lx-6">
          <div>
            <Counter to={4221} delay={1000} />
            <span>chain id · Bradbury</span>
          </div>
          <div>
            <Counter to={5} suffix="+" delay={1250} />
            <span>validators per answer</span>
          </div>
          <div>
            <Counter to={100} suffix="%" delay={1500} />
            <span>answers recorded on-chain</span>
          </div>
        </div>
      </main>

      <TickerTape />
    </div>
  );
}
