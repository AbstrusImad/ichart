import { useEffect, useRef, useState } from 'react';
import type { DataSource, FeedStatus, Symbol, Timeframe } from '../lib/types';
import { SYMBOLS, TIMEFRAMES, formatPrice } from '../lib/types';
import { LogoIcon } from './icons';

interface TopBarProps {
  symbol: Symbol;
  timeframe: Timeframe;
  onSymbol: (s: Symbol) => void;
  onTimeframe: (t: Timeframe) => void;
  lastPrice: number | null;
  priceDir: 'up' | 'down' | null;
  changePct: number | null;
  source: DataSource;
  status: FeedStatus;
  walletAddress: string | null;
  walletBusy: boolean;
  balance: number | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function TopBar({
  symbol,
  timeframe,
  onSymbol,
  onTimeframe,
  lastPrice,
  priceDir,
  changePct,
  source,
  status,
  walletAddress,
  walletBusy,
  balance,
  onConnect,
  onDisconnect,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // close the wallet menu on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const copyAddress = () => {
    if (!walletAddress) return;
    navigator.clipboard?.writeText(walletAddress).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <header className="topbar enter-1">
      <div className="brand panel">
        <LogoIcon />
        <span className="brand-name">
          iChart<span className="brand-dot">·</span>
          <span className="brand-tag">living chart</span>
        </span>
      </div>

      <nav className="pills panel" aria-label="Symbol">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            className={`pill ${s === symbol ? 'active' : ''}`}
            onClick={() => onSymbol(s)}
            aria-pressed={s === symbol}
          >
            {s.replace('USDT', '')}
          </button>
        ))}
      </nav>

      <nav className="pills panel" aria-label="Timeframe">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.id}
            className={`pill ${t.id === timeframe ? 'active' : ''}`}
            onClick={() => onTimeframe(t.id)}
            aria-pressed={t.id === timeframe}
          >
            {t.id}
          </button>
        ))}
      </nav>

      <div className="ticker panel">
        <span className={`ticker-price ${priceDir ?? ''}`}>
          {lastPrice !== null ? formatPrice(lastPrice) : '——'}
        </span>
        {changePct !== null && (
          <span
            className={`ticker-change ${changePct >= 0 ? 'up' : 'down'}`}
            title="Change across the loaded window"
          >
            {changePct >= 0 ? '+' : ''}
            {changePct.toFixed(2)}%
          </span>
        )}
        <span className={`feed-badge ${source} ${status}`}>
          <span className="feed-dot" aria-hidden="true" />
          {source === 'live' ? (status === 'streaming' ? 'LIVE' : status === 'connecting' ? 'SYNC' : 'STALL') : 'DEMO'}
        </span>
      </div>

      {walletAddress ? (
        <div className="wallet-menu-host" ref={menuRef}>
          <button
            className={`wallet-chip panel ${menuOpen ? 'open' : ''}`}
            title={walletAddress}
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <span className="wallet-dot" aria-hidden="true" />
            <span className="wallet-addr">
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}
            </span>
            {balance !== null && <span className="wallet-balance">{balance.toFixed(2)} GEN</span>}
            <span className={`wallet-caret ${menuOpen ? 'up' : ''}`} aria-hidden="true" />
          </button>

          {menuOpen && (
            <div className="wallet-menu panel" role="menu">
              <button className="wm-row wm-copy" onClick={copyAddress} role="menuitem">
                <span className="wm-label">Address</span>
                <span className="wm-value mono">
                  {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
                </span>
                <span className="wm-hint">{copied ? 'Copied ✓' : 'Click to copy'}</span>
              </button>
              <div className="wm-row">
                <span className="wm-label">GEN balance</span>
                <span className="wm-balance">
                  {balance !== null ? balance.toFixed(4) : '—'} <i>GEN</i>
                </span>
                <span className="wm-hint">Bradbury testnet · pays your analyses</span>
              </div>
              <button
                className="wm-disconnect"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDisconnect();
                }}
              >
                Disconnect wallet
              </button>
            </div>
          )}
        </div>
      ) : (
        <button className="wallet-connect panel" onClick={onConnect} disabled={walletBusy}>
          {walletBusy ? 'Connecting…' : 'Connect Wallet'}
        </button>
      )}
    </header>
  );
}
