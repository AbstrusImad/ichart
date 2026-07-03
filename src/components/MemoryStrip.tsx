// The AI's presence: a slim strip that always tells you what the mind is
// doing — watching, reading, or speaking. Text crossfades on change.

export type StripMode = 'idle' | 'thinking' | 'insight' | 'error';

interface MemoryStripProps {
  text: string;
  mode: StripMode;
  engine?: 'genlayer';
}

export default function MemoryStrip({ text, mode, engine }: MemoryStripProps) {
  return (
    <div className={`memory-strip panel enter-2 ${mode}`} role="status" aria-live="polite">
      <span className="mind-dot" aria-hidden="true" />
      <span key={text} className="strip-text">
        {text}
        {mode === 'thinking' && (
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
      {mode === 'insight' && engine && <span className="engine-badge genlayer">GenLayer</span>}
    </div>
  );
}
