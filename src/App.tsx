import { useCallback, useEffect, useRef, useState } from 'react';
import ChartView from './components/ChartView';
import TopBar from './components/TopBar';
import MemoryStrip, { type StripMode } from './components/MemoryStrip';
import CommandBar from './components/CommandBar';
import InsightCard from './components/InsightCard';
import ConsensusPanel, { type ConsensusState } from './components/ConsensusPanel';
import Landing from './components/Landing';
import { useMarket } from './hooks/useMarket';
import { runConsensusAnalysis } from './lib/analysis';
import {
  connectWallet,
  forgetWallet,
  getGenBalance,
  hasWallet,
  reconnectWallet,
  type AppConfig,
  type WalletSession,
} from './lib/genlayerClient';
import type { AIResponse, AIStatus, Symbol, Timeframe } from './lib/types';
import type { OverlayItem } from './lib/overlayRenderer';

let overlaySeq = 1;

export default function App() {
  const [symbol, setSymbol] = useState<Symbol>('BTCUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const market = useMarket(symbol, timeframe);

  // app config (contract address, network) — public, served by the backend
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  // the user's wallet — the ONLY door into the app, and every analysis is
  // THEIR transaction
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [landingLeaving, setLandingLeaving] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  // silent session restore: if the wallet already authorized this site,
  // walk straight back into the app on refresh — no popups
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    reconnectWallet(config).then((session) => {
      if (!session || cancelled) return;
      setWallet(session);
      getGenBalance(config, session.address).then(setBalance).catch(() => setBalance(null));
    });
    return () => {
      cancelled = true;
    };
  }, [config]);

  const connect = useCallback(async () => {
    if (!config) return;
    setWalletBusy(true);
    setWalletError(null);
    try {
      const session = await connectWallet(config);
      getGenBalance(config, session.address).then(setBalance).catch(() => setBalance(null));
      // cinematic hand-off: the market zooms in and swallows the landing
      setLandingLeaving(true);
      window.setTimeout(() => {
        setWallet(session);
        setLandingLeaving(false);
      }, 900);
    } catch (e) {
      let msg = e instanceof Error ? e.message : 'wallet connection failed';
      if (/user rejected|denied/i.test(msg)) msg = 'Connection rejected in your wallet — try again.';
      setWalletError(msg);
    } finally {
      setWalletBusy(false);
    }
  }, [config]);

  // if the wallet disconnects, the door closes again
  useEffect(() => {
    if (!hasWallet()) return;
    const eth = window.ethereum as unknown as {
      on?: (ev: string, cb: (accounts: string[]) => void) => void;
      removeListener?: (ev: string, cb: (accounts: string[]) => void) => void;
    };
    const onAccounts = (accounts: string[]) => {
      if (!accounts || accounts.length === 0) {
        forgetWallet();
        setWallet(null);
      }
    };
    eth.on?.('accountsChanged', onAccounts);
    return () => eth.removeListener?.('accountsChanged', onAccounts);
  }, []);

  const [aiStatus, setAiStatus] = useState<AIStatus>('idle');
  const [aiError, setAiError] = useState<string | null>(null);
  const [insight, setInsight] = useState<(AIResponse & { prompt: string }) | null>(null);
  const [overlays, setOverlays] = useState<OverlayItem[]>([]);
  const [txState, setTxState] = useState<ConsensusState | null>(null);
  const errorTimer = useRef<number>(0);
  const successTimer = useRef<number>(0);

  const [thinkingMins, setThinkingMins] = useState(0);
  useEffect(() => {
    if (aiStatus !== 'thinking') {
      setThinkingMins(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(
      () => setThinkingMins(Math.floor((Date.now() - started) / 60_000)),
      15_000,
    );
    return () => window.clearInterval(id);
  }, [aiStatus]);

  const clearAll = useCallback(() => {
    setOverlays([]);
    setInsight(null);
  }, []);

  const disconnect = useCallback(() => {
    forgetWallet();
    setWallet(null);
    setBalance(null);
    setTxState(null);
    clearAll();
  }, [clearAll]);

  const changeSymbol = (s: Symbol) => {
    clearAll();
    setSymbol(s);
  };
  const changeTimeframe = (t: Timeframe) => {
    clearAll();
    setTimeframe(t);
  };

  const ask = useCallback(
    async (prompt: string) => {
      if (!config || !wallet || market.candlesRef.current.length < 20 || aiStatus === 'thinking') return;

      window.clearTimeout(errorTimer.current);
      window.clearTimeout(successTimer.current);
      setAiError(null);
      setAiStatus('thinking');
      setOverlays([]);
      const startedAt = Date.now();
      setTxState({ progress: { phase: 'signing' }, startedAt, prompt });

      try {
        const res = await runConsensusAnalysis(
          config,
          wallet,
          symbol,
          timeframe,
          prompt,
          market.candlesRef.current,
          (progress) => setTxState({ progress, startedAt, prompt }),
        );
        const t0 = performance.now();
        setOverlays(res.actions.map((action) => ({ id: overlaySeq++, action, addedAt: t0 })));
        setInsight({ ...res, prompt });
        setAiStatus('idle');
        getGenBalance(config, wallet.address).then(setBalance).catch(() => undefined);
        // keep the ✓ success state visible briefly, then hand off to the card
        successTimer.current = window.setTimeout(() => setTxState(null), 3200);
      } catch (e) {
        setInsight(null);
        setAiStatus('error');
        let msg = e instanceof Error ? e.message : 'analysis failed';
        if (/insufficient|funds|balance/i.test(msg)) {
          msg = `not enough GEN to pay for the transaction — get free testnet GEN at ${config.faucet}`;
        } else if (/user rejected|denied/i.test(msg)) {
          msg = 'transaction rejected in your wallet';
        }
        setAiError(msg);
        // the panel stays up in its failed state with a Try-again button
        setTxState((prev) =>
          prev
            ? { ...prev, progress: { ...prev.progress, phase: 'failed', message: msg } }
            : { progress: { phase: 'failed', message: msg }, startedAt, prompt },
        );
        errorTimer.current = window.setTimeout(() => {
          setAiStatus('idle');
          setAiError(null);
        }, 10000);
      }
    },
    [config, wallet, symbol, timeframe, aiStatus, market.candlesRef],
  );

  const retryTx = useCallback(() => {
    const prompt = txState?.prompt;
    setTxState(null);
    setAiStatus('idle');
    setAiError(null);
    if (prompt) window.setTimeout(() => ask(prompt), 50);
  }, [txState, ask]);

  const dismissTx = useCallback(() => {
    setTxState(null);
    setAiStatus('idle');
    setAiError(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearAll]);

  const stripMode: StripMode =
    aiStatus === 'thinking' ? 'thinking' : aiStatus === 'error' ? 'error' : insight ? 'insight' : 'idle';
  const stripText =
    stripMode === 'thinking'
      ? `GenLayer consensus · validators are fetching + voting on ${symbol} · ${timeframe}${thinkingMins > 0 ? ` · ${thinkingMins}m` : ''}`
      : stripMode === 'error'
        ? `${aiError ?? 'something went wrong'}`
        : stripMode === 'insight' && insight?.strip
          ? insight.strip
          : stripMode === 'insight'
            ? `${symbol} · ${timeframe} · Consensus recorded on-chain`
            : wallet
              ? `Watching ${symbol} · ${timeframe} · Waiting for your question.`
              : hasWallet()
                ? `Connect your wallet to wake the chart — analyses are validated on ${config?.networkLabel ?? 'GenLayer'}`
                : 'Install MetaMask to use iChart — every analysis is a consensus transaction you sign';

  const first = market.candlesRef.current[0];
  const changePct =
    first && market.lastPrice !== null ? ((market.lastPrice - first.close) / first.close) * 100 : null;

  const loading = market.snapshot === 0;

  // hard gate: no wallet, no app
  if (!wallet) {
    return (
      <Landing
        config={config}
        hasWallet={hasWallet()}
        busy={walletBusy || landingLeaving}
        error={walletError}
        leaving={landingLeaving}
        onConnect={connect}
      />
    );
  }

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true">
        <div className="aurora-blob a" />
        <div className="aurora-blob b" />
      </div>

      <TopBar
        symbol={symbol}
        timeframe={timeframe}
        onSymbol={changeSymbol}
        onTimeframe={changeTimeframe}
        lastPrice={market.lastPrice}
        priceDir={market.priceDir}
        changePct={changePct}
        source={market.source}
        status={market.status}
        walletAddress={wallet?.address ?? null}
        walletBusy={walletBusy}
        balance={balance}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <MemoryStrip text={stripText} mode={stripMode} engine={insight ? 'genlayer' : undefined} />

      <main className="stage">
        <ChartView
          candlesRef={market.candlesRef}
          snapshot={market.snapshot}
          tick={market.tick}
          overlays={overlays}
          thinking={aiStatus === 'thinking'}
        />
        {loading && (
          <div className="stage-veil" role="status">
            <span className="spinner large" aria-hidden="true" />
            <span>Connecting to market…</span>
          </div>
        )}
        {insight && !txState && <InsightCard insight={insight} onClear={clearAll} />}
        {txState && <ConsensusPanel state={txState} onRetry={retryTx} onDismiss={dismissTx} />}
      </main>

      <CommandBar
        thinking={aiStatus === 'thinking'}
        hasOverlays={overlays.length > 0 || insight !== null}
        walletConnected={wallet !== null}
        onAsk={ask}
        onClear={clearAll}
      />
    </div>
  );
}
