// The chart is the AI's body: candles below, the AI's drawings projected on
// an overlay canvas above, both sharing one coordinate system every frame.

import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../lib/types';
import { formatPrice } from '../lib/types';
import { drawOverlays, type Mapper, type OverlayItem } from '../lib/overlayRenderer';

const UP = '#0ecb81';
const DOWN = '#f6465d';
const VOL_UP = 'rgba(14, 203, 129, 0.28)';
const VOL_DOWN = 'rgba(246, 70, 93, 0.28)';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

interface ChartViewProps {
  candlesRef: React.MutableRefObject<Candle[]>;
  snapshot: number; // bumps when a full candle set loads (symbol/tf change)
  tick: Candle | null;
  overlays: OverlayItem[];
  thinking: boolean;
}

export default function ChartView({ candlesRef, snapshot, tick, overlays, thinking }: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const revealRaf = useRef<number>(0);
  const revealing = useRef(false);
  const overlaysRef = useRef<OverlayItem[]>(overlays);
  overlaysRef.current = overlays;
  const reducedMotion = useRef(false);
  // price envelope of AI drawings beyond the real candles (ghost candles,
  // scenario paths…) — folded into the price scale's autoscale
  const futureRange = useRef<{ min: number; max: number } | null>(null);

  // ── chart lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#5c6b84',
        fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.05)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.05)' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.2 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        minBarSpacing: 0.02, // month-scale simulations need extreme zoom-out
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(45, 212, 191, 0.35)', width: 1, labelBackgroundColor: '#101827' },
        horzLine: { color: 'rgba(45, 212, 191, 0.35)', width: 1, labelBackgroundColor: '#101827' },
      },
      localization: { priceFormatter: formatPrice },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: 'rgba(14, 203, 129, 0.55)',
      wickDownColor: 'rgba(246, 70, 93, 0.55)',
      priceLineColor: 'rgba(45, 212, 191, 0.6)',
      priceLineStyle: LineStyle.Dotted,
      // widen autoscale to cover the AI's future drawings, which live on the
      // overlay canvas and are otherwise invisible to the price scale
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const base = original();
        const g = futureRange.current;
        if (!g) return base;
        if (!base?.priceRange) return { priceRange: { minValue: g.min, maxValue: g.max } };
        return {
          priceRange: {
            minValue: Math.min(base.priceRange.minValue, g.min),
            maxValue: Math.max(base.priceRange.maxValue, g.max),
          },
          margins: base.margins,
        };
      },
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.87, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    return () => {
      cancelAnimationFrame(revealRaf.current);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  // ── snapshot load with candle-sweep intro ────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const volume = volumeRef.current;
    const candles = candlesRef.current;
    if (!chart || !series || !volume || !candles.length) return;

    cancelAnimationFrame(revealRaf.current);

    const setSlice = (count: number) => {
      const arr = candlesRef.current;
      const slice = arr.slice(0, count);
      series.setData(slice.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
      volume.setData(
        slice.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? VOL_UP : VOL_DOWN,
        })),
      );
    };

    const n = candles.length;
    // window sized to the screen: ~9px per bar, 50–130 bars
    const el = containerRef.current;
    const targetBars = Math.min(130, Math.max(50, Math.floor((el?.clientWidth ?? 1200) / 9)));
    const windowFrom = Math.max(0, n - targetBars);

    if (reducedMotion.current || n < 40) {
      setSlice(n);
      chart.timeScale().setVisibleLogicalRange({ from: windowFrom, to: n + 10 });
      return;
    }

    // sweep: ~10 bars visible instantly, the rest draw in left → right
    revealing.current = true;
    const startCount = Math.max(1, windowFrom + 10);
    setSlice(startCount);
    chart.timeScale().setVisibleLogicalRange({ from: windowFrom, to: n + 10 });

    const t0 = performance.now();
    const DURATION = 900;
    const step = (now: number) => {
      const p = easeOutCubic(Math.min(1, (now - t0) / DURATION));
      const count = Math.round(startCount + (candlesRef.current.length - startCount) * p);
      setSlice(count);
      // re-pin the window: shiftVisibleRangeOnNewBar drags it right on every
      // appended bar, which would strand the candles at the left edge
      chart.timeScale().setVisibleLogicalRange({ from: windowFrom, to: candlesRef.current.length + 10 });
      if (p < 1) {
        revealRaf.current = requestAnimationFrame(step);
      } else {
        revealing.current = false;
      }
    };
    revealRaf.current = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(revealRaf.current);
      revealing.current = false;
    };
  }, [snapshot, candlesRef]);

  // ── live ticks ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!tick || revealing.current) return;
    seriesRef.current?.update({ ...tick, time: tick.time as UTCTimestamp });
    volumeRef.current?.update({
      time: tick.time as UTCTimestamp,
      value: tick.volume,
      color: tick.close >= tick.open ? VOL_UP : VOL_DOWN,
    });
  }, [tick]);

  // ── make room when the AI draws into the future ──────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const arr = candlesRef.current;
    if (!chart || !series || arr.length < 2) return;

    const interval = arr[1].time - arr[0].time || 60;
    const lastT = arr[arr.length - 1].time;
    let maxT = lastT;
    let pMin = Infinity;
    let pMax = -Infinity;
    const seePrice = (p: number) => {
      if (p < pMin) pMin = p;
      if (p > pMax) pMax = p;
    };
    const seePoint = (pt: { time: number; price: number }) => {
      maxT = Math.max(maxT, pt.time);
      if (pt.time > lastT) seePrice(pt.price);
    };
    // zones are excluded: their default `to` is the far future edge, and a
    // decorative band should never drag the viewport away from the candles
    for (const o of overlays) {
      const a = o.action;
      if (a.type === 'scenario') {
        for (const p of a.paths) for (const pt of p.points) seePoint(pt);
      } else if (a.type === 'ghost_candles') {
        for (const c of a.candles) {
          maxT = Math.max(maxT, c.time);
          seePrice(c.high);
          seePrice(c.low);
        }
      } else if (a.type === 'trendline' || a.type === 'path') {
        for (const pt of a.points) seePoint(pt);
      } else if (a.type === 'arrow' || a.type === 'measure') {
        seePoint(a.from);
        seePoint(a.to);
      } else if (a.type === 'box') {
        maxT = Math.max(maxT, a.to);
        if (a.to > lastT) {
          seePrice(a.priceLow);
          seePrice(a.priceHigh);
        }
      } else if (a.type === 'vline') {
        maxT = Math.max(maxT, a.time);
      }
    }

    // fold future drawing prices into the autoscale, and drop them on clear
    const hadFuture = futureRange.current !== null;
    futureRange.current = pMin < pMax ? { min: pMin, max: pMax } : null;
    series.priceScale().applyOptions({ autoScale: true });

    const ts = chart.timeScale();
    if (!overlays.length) {
      if (hadFuture) {
        // simulation cleared: restore the standard tail view
        const el = containerRef.current;
        const bars = Math.min(130, Math.max(50, Math.floor((el?.clientWidth ?? 1200) / 9)));
        ts.setVisibleLogicalRange({ from: Math.max(0, arr.length - bars), to: arr.length + 10 });
      }
      return;
    }
    if (maxT <= lastT) return;

    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const lastIndex = arr.length - 1;
    const needTo = lastIndex + Math.ceil((maxT - lastT) / interval) + 5;
    if (range.to >= needTo) return;

    const width = range.to - range.from;
    const futureBars = needTo - lastIndex;
    if (futureBars <= width * 0.6) {
      // small projection: slide right, keep the zoom level
      ts.setVisibleLogicalRange({ from: range.from + (needTo - range.to), to: needTo });
    } else {
      // long simulation (e.g. a month ahead): zoom out, keeping a slice of
      // the real tape on the left for context
      const from = Math.max(0, lastIndex - Math.max(40, Math.round(futureBars * 0.35)));
      ts.setVisibleLogicalRange({ from, to: needTo });
    }
  }, [overlays, candlesRef]);

  // ── overlay projection loop ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || overlays.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const chart = chartRef.current;
      const series = seriesRef.current;
      const arr = candlesRef.current;
      if (!chart || !series || arr.length < 2) return;

      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const t0 = arr[0].time;
      const interval = arr[1].time - arr[0].time || 60;
      const ts = chart.timeScale();
      const mapper: Mapper = {
        paneWidth: Math.max(0, w - chart.priceScale('right').width()),
        paneHeight: Math.max(0, h - ts.height()),
        interval,
        timeToX: (t) => ts.logicalToCoordinate(((t - t0) / interval) as Logical),
        priceToY: (p) => series.priceToCoordinate(p),
        barAt: (t) => {
          const i = Math.round((t - t0) / interval);
          if (i < 0) return null;
          return arr[Math.min(i, arr.length - 1)];
        },
      };

      drawOverlays(ctx, overlaysRef.current, mapper, now, reducedMotion.current);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [overlays.length > 0, candlesRef]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="chart-host">
      <canvas
        ref={canvasRef}
        className="overlay-canvas"
        style={{ opacity: overlays.length ? 1 : 0 }}
        aria-hidden="true"
      />
      {thinking && (
        <div className="scanline-track" aria-hidden="true">
          <div className="scanline" />
        </div>
      )}
    </div>
  );
}
