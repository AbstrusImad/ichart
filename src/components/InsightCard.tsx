// The AI's written voice — a floating card that accompanies whatever it
// just drew on the chart.

import type { AIResponse } from '../lib/types';
import { CloseIcon, SparkIcon } from './icons';

interface InsightCardProps {
  insight: AIResponse & { prompt: string };
  onClear: () => void;
}

export default function InsightCard({ insight, onClear }: InsightCardProps) {
  return (
    <aside className="insight-card panel" aria-label="AI analysis">
      <header className="insight-head">
        <span className="insight-title">
          <SparkIcon size={14} />
          Chart insight
        </span>
        <span className="engine-badge genlayer">GenLayer · consensus</span>
        <button className="icon-btn" onClick={onClear} aria-label="Dismiss and clear overlays">
          <CloseIcon />
        </button>
      </header>
      <p className="insight-question">“{insight.prompt}”</p>
      <p className="insight-summary">{insight.summary}</p>
      {insight.genlayer && (
        <p className="insight-chain" title={`tx ${insight.genlayer.txHash}\ncontract ${insight.genlayer.contract}`}>
          Validated on {insight.genlayer.network} ·{' '}
          {insight.genlayer.explorer ? (
            <a href={insight.genlayer.explorer} target="_blank" rel="noreferrer">
              tx {insight.genlayer.txHash.slice(0, 10)}…{insight.genlayer.txHash.slice(-6)}
            </a>
          ) : (
            <>tx {insight.genlayer.txHash.slice(0, 10)}…{insight.genlayer.txHash.slice(-6)}</>
          )}
          {insight.genlayer.seq !== null ? ` · record #${insight.genlayer.seq}` : ''}
        </p>
      )}
      <footer className="insight-foot">
        {insight.actions.length} overlay{insight.actions.length === 1 ? '' : 's'} drawn · ask a follow-up below
      </footer>
    </aside>
  );
}
