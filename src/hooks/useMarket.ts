// Market subscription hook. Candle history lives in a mutable ref (the chart
// and AI read it directly); React state only carries the cheap signals the
// UI actually renders: snapshot version, latest tick, price, feed status.

import { useEffect, useRef, useState } from 'react';
import { subscribeMarket } from '../lib/binance';
import type { Candle, DataSource, FeedStatus, Symbol, Timeframe } from '../lib/types';

export interface Market {
  candlesRef: React.MutableRefObject<Candle[]>;
  snapshot: number;
  tick: Candle | null;
  source: DataSource;
  status: FeedStatus;
  lastPrice: number | null;
  priceDir: 'up' | 'down' | null;
}

export function useMarket(symbol: Symbol, timeframe: Timeframe): Market {
  const candlesRef = useRef<Candle[]>([]);
  const prevPrice = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState(0);
  const [tick, setTick] = useState<Candle | null>(null);
  const [source, setSource] = useState<DataSource>('live');
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [priceDir, setPriceDir] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    candlesRef.current = [];
    prevPrice.current = null;
    setTick(null);
    setLastPrice(null);
    setPriceDir(null);
    setStatus('connecting');

    const handle = subscribeMarket(symbol, timeframe, {
      onSnapshot(candles, src) {
        candlesRef.current = [...candles];
        const last = candles[candles.length - 1];
        prevPrice.current = last?.close ?? null;
        setSource(src);
        setLastPrice(last?.close ?? null);
        setSnapshot((v) => v + 1);
      },
      onUpdate(c) {
        const arr = candlesRef.current;
        if (!arr.length) return;
        const lastT = arr[arr.length - 1].time;
        if (c.time === lastT) arr[arr.length - 1] = c;
        else if (c.time > lastT) arr.push(c);
        else return;

        if (prevPrice.current !== null && c.close !== prevPrice.current) {
          setPriceDir(c.close > prevPrice.current ? 'up' : 'down');
        }
        prevPrice.current = c.close;
        setLastPrice(c.close);
        setTick(c);
      },
      onStatus: setStatus,
    });

    return () => handle.stop();
  }, [symbol, timeframe]);

  return { candlesRef, snapshot, tick, source, status, lastPrice, priceDir };
}
