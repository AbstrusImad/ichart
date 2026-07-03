// Live transaction panel: walks the user through sign → submit → validator
// voting → explicit success/failure, with the real chain status and a
// running clock. This is the heartbeat of every consensus analysis.

import { useEffect, useState } from 'react';
import type { TxProgressEvent } from '../lib/analysis';
import { CloseIcon } from './icons';

const CHAIN_STATUS_LABELS: Record<string, string> = {
  UNINITIALIZED: 'Queued on the network',
  PENDING: 'Queued on the network',
  ACTIVATED: 'Activated — selecting validators',
  PROPOSING: 'Leader running the analysis',
  COMMITTING: 'Validators committing votes',
  REVEALING: 'Votes being revealed',
  ACCEPTED: 'Consensus reached — settling',
  FINALIZED: 'Finalized',
  LEADER_TIMEOUT: 'Leader timed out — rotating',
  VALIDATORS_TIMEOUT: 'Validators slow — retrying',
};

export interface ConsensusState {
  progress: TxProgressEvent;
  startedAt: number;
  prompt: string;
}

interface ConsensusPanelProps {
  state: ConsensusState;
  onRetry: () => void;
  onDismiss: () => void;
}

function StepDot({ status }: { status: 'done' | 'active' | 'todo' | 'failed' }) {
  if (status === 'done') return <span className="step-dot done">✓</span>;
  if (status === 'failed') return <span className="step-dot failed">✕</span>;
  if (status === 'active') return <span className="step-dot active" />;
  return <span className="step-dot todo" />;
}

export default function ConsensusPanel({ state, onRetry, onDismiss }: ConsensusPanelProps) {
  const { progress, startedAt } = state;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  const phase = progress.phase;
  const failed = phase === 'failed';
  const success = phase === 'success';

  const signStatus = phase === 'signing' ? 'active' : failed && !progress.txHash ? 'failed' : 'done';
  const submitStatus =
    phase === 'signing' ? 'todo' : progress.txHash ? 'done' : failed ? 'failed' : 'active';
  const voteStatus =
    phase === 'consensus'
      ? 'active'
      : success
        ? 'done'
        : failed && progress.txHash
          ? 'failed'
          : phase === 'submitted'
            ? 'active'
            : 'todo';

  const chainLabel = progress.chainStatus
    ? (CHAIN_STATUS_LABELS[progress.chainStatus] ?? progress.chainStatus.toLowerCase())
    : 'Broadcasting…';

  return (
    <aside className={`consensus-panel panel ${failed ? 'failed' : ''} ${success ? 'success' : ''}`}>
      <header className="cp-head">
        <span className="cp-title">Consensus transaction</span>
        <span className="cp-clock">{clock}</span>
        {failed && (
          <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
            <CloseIcon />
          </button>
        )}
      </header>

      <ol className="cp-steps">
        <li className={signStatus}>
          <StepDot status={signStatus} />
          <span>Sign in your wallet</span>
        </li>
        <li className={submitStatus}>
          <StepDot status={submitStatus} />
          <span>
            Submit to the network
            {progress.txHash && (
              <>
                {' · '}
                {progress.explorer ? (
                  <a href={progress.explorer} target="_blank" rel="noreferrer">
                    tx {progress.txHash.slice(0, 8)}…{progress.txHash.slice(-4)}
                  </a>
                ) : (
                  <>tx {progress.txHash.slice(0, 8)}…{progress.txHash.slice(-4)}</>
                )}
              </>
            )}
          </span>
        </li>
        <li className={voteStatus}>
          <StepDot status={voteStatus} />
          <span>
            Validators vote
            {voteStatus === 'active' && <em className="cp-status"> · {chainLabel}</em>}
          </span>
        </li>
      </ol>

      {success && (
        <div className="cp-result ok" role="status">
          ✓ Consensus reached — analysis recorded on-chain
        </div>
      )}
      {failed && (
        <div className="cp-result bad" role="alert">
          <p>✕ {progress.message ?? 'transaction failed'}</p>
          <div className="cp-actions">
            <button className="bar-btn primary" onClick={onRetry}>
              Try again
            </button>
            <button className="bar-btn ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
