// The command bar: how you speak to the chart. Free-form input and a
// clear-overlays escape hatch.

import { useRef, useState } from 'react';
import { EraseIcon, SendIcon, SparkIcon } from './icons';

interface CommandBarProps {
  thinking: boolean;
  hasOverlays: boolean;
  walletConnected: boolean;
  onAsk: (prompt: string) => void;
  onClear: () => void;
}

export default function CommandBar({
  thinking,
  hasOverlays,
  walletConnected,
  onAsk,
  onClear,
}: CommandBarProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (prompt: string) => {
    const clean = prompt.trim();
    if (!clean || thinking || !walletConnected) return;
    onAsk(clean);
    setValue('');
  };

  return (
    <div className="command-dock enter-3">
      <form
        className={`command-bar panel ${thinking ? 'thinking' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
      >
        <span className={`bar-spark ${thinking ? 'spin' : ''}`}>
          <SparkIcon size={17} />
        </span>
        <span
          className="engine-toggle genlayer engine-static"
          title="Every analysis is validated by GenLayer validator consensus and recorded on-chain"
        >
          <span className="engine-dot" aria-hidden="true" />
          GenLayer
        </span>
        <input
          ref={inputRef}
          className="command-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setValue('');
              onClear();
            }
          }}
          placeholder={
            !walletConnected
              ? 'Connect your wallet to ask — you sign every analysis'
              : thinking
                ? 'Validators are voting…'
                : 'Ask the chart anything…'
          }
          aria-label="Ask the chart"
          maxLength={300}
          disabled={thinking || !walletConnected}
        />
        {hasOverlays && (
          <button type="button" className="bar-btn ghost" onClick={onClear} title="Clear overlays (Esc)">
            <EraseIcon />
            <span className="bar-btn-label">Clear</span>
          </button>
        )}
        <button
          type="submit"
          className="bar-btn primary"
          disabled={thinking || !value.trim()}
          aria-label="Send question"
        >
          {thinking ? <span className="spinner" aria-hidden="true" /> : <SendIcon />}
        </button>
      </form>

      <p className="disclaimer">Educational market-structure analysis · Not financial advice</p>
    </div>
  );
}
