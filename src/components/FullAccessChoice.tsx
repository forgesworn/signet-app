import { useRef, useState } from 'react';
import {
  FULL_ACCESS_COPY,
  cardLines,
  separatelyHint,
  type BundleFailure,
  type BundleRunResult,
  type BundleSuccess,
  type OwnerStyle,
} from '../lib/heartwood-one-hold';

/**
 * The full-screen, warning-style choice shown before the Heartwood is asked for
 * full access (one-hold pairing spec A1, A10, A11). Used by onboarding, by the
 * existing-install offer and by the "approve again" and "back to Everyday"
 * paths in Settings.
 *
 * The bundle is sent ONLY from the "Set up with one hold" tap, never in the
 * background and never retried by itself: a retry is another tap on "Try
 * again". The card drawn here uses the same lines, word for word, as the
 * Heartwood's own FULL ACCESS card (the Heartwood pages its five words at rest, two at a time, and they are drawn in the same pages), so the owner matches them rather than
 * interprets them.
 */
export interface FullAccessChoiceProps {
  /** The five check words for this install's client key (W1). */
  words: readonly string[];
  /** The pairing's label, when known. A placeholder line stands in when not, so the drawing has the Heartwood's line count. */
  label?: string | null;
  /** True when `act_as` will include the real identity. */
  includeRealName: boolean;
  /**
   * The real name is in the grant only because older backups still sign with
   * it, not because the owner set one up. Say so, so `PERSONA + REAL NAME` is
   * not a surprise.
   */
  realNameForLegacyBackups?: boolean;
  initialStyle?: OwnerStyle;
  /** Run ONE bundle. Called from the tap only. */
  onRun: (style: OwnerStyle) => Promise<BundleRunResult>;
  /** The hold worked. */
  onApproved: (reply: BundleSuccess, style: OwnerStyle) => void;
  /** "Approve each thing separately" (or "Not now" in Settings), or a pairing problem the owner has read. */
  onSeparately: () => void;
  /** Back out of the whole flow (onboarding only). */
  onBack?: () => void;
  /** Label for the secondary button. */
  separatelyLabel?: string;
  /** Show the "separately" explanation. Onboarding only. */
  showSeparatelyHint?: boolean;
  /** Label of the button that follows a pairing-problem message. */
  continueLabel?: string;
  /**
   * What to show when the device refuses with nothing to say (a full approval
   * list, a malformed bundle). When absent the flow carries straight on to
   * "separately", as today's flow requires.
   */
  silentMessage?: string;
}

type Phase =
  | { kind: 'choose' }
  | { kind: 'running' }
  | { kind: 'problem'; failure: BundleFailure };

export function FullAccessChoice({
  words, label, includeRealName, realNameForLegacyBackups = false, initialStyle = 'everyday', onRun, onApproved, onSeparately, onBack,
  separatelyLabel = FULL_ACCESS_COPY.separately, showSeparatelyHint = false, continueLabel = 'Continue', silentMessage,
}: FullAccessChoiceProps) {
  const [style, setStyle] = useState<OwnerStyle>(initialStyle);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  // One bundle in flight at a time: a double tap must not send two.
  const inFlight = useRef(false);

  const lines = cardLines({ words, label, realName: includeRealName, style });

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase({ kind: 'running' });
    try {
      const out = await onRun(style);
      if (out.ok) { onApproved(out.reply, style); return; }
      if (out.failure.action === 'silent' && !silentMessage) { onSeparately(); return; }
      setPhase({ kind: 'problem', failure: out.failure.action === 'silent' ? { ...out.failure, message: silentMessage ?? '' } : out.failure });
    } finally {
      inFlight.current = false;
    }
  }

  const running = phase.kind === 'running';
  const problem = phase.kind === 'problem' ? phase.failure : null;
  const canRetry = problem !== null && problem.action === 'retry';

  return (
    <div className="page fade-in" role="main">
      <div
        className="card section"
        style={{ background: 'var(--warning-light)', borderColor: 'var(--warning)' }}
      >
        <h1 style={{ marginBottom: 8, fontSize: '1.3rem' }}>{FULL_ACCESS_COPY.heading}</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>{FULL_ACCESS_COPY.covers}</p>
        {includeRealName && realNameForLegacyBackups && (
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>{FULL_ACCESS_COPY.realNameForLegacyBackups}</p>
        )}
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>{FULL_ACCESS_COPY.expect}</p>

        <div
          role="img"
          aria-label={`The card your Heartwood will show: ${lines.header}. ${lines.wordPages.map(p => `${p.label}: ${p.words}`).join('; ')}. ${lines.scope}, ${lines.powers.join(', ')}, ${lines.compare}. When every page has shown the last line changes to ${lines.hold}. While you hold, it shows ${lines.holdScreen.labelKnown ? lines.holdScreen.label : 'the name of this pairing'} and all five words: ${lines.holdScreen.words.join('; ')}.`}
          data-testid="full-access-card"
          style={{
            fontFamily: 'var(--font-mono)', fontSize: '0.85rem', lineHeight: 1.5, textAlign: 'center', overflowWrap: 'anywhere',
            background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            overflow: 'hidden', marginBottom: 12,
          }}
        >
          <div style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)', fontWeight: 700, padding: '4px 8px' }}>
            {lines.header}
          </div>
          <div style={{ padding: '8px 8px 10px' }}>
            {lines.wordPages.map(p => (
              <div
                key={p.label}
                data-testid="full-access-word-page"
                style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 12, padding: '0 4px' }}
              >
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{p.label}</span>
                <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{p.words}</span>
              </div>
            ))}
            <div style={{ marginTop: 6 }}>{lines.scope}</div>
            {lines.powers.map(p => <div key={p}>{p}</div>)}
            <div data-testid="full-access-hint" style={{ color: 'var(--text-muted)' }}>{lines.compare}</div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.4, margin: '4px 0 0' }}>
              {FULL_ACCESS_COPY.cardHintChange(lines.hold)}
            </p>
            <div data-testid="full-access-hold-screen" style={{ borderTop: '1px dashed var(--border)', marginTop: 8, paddingTop: 8 }}>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 4px' }}>{FULL_ACCESS_COPY.holdScreenHeading}</p>
              <div style={lines.holdScreen.labelKnown ? undefined : { color: 'var(--text-muted)' }}>{lines.holdScreen.label}</div>
              {lines.holdScreen.words.map(w => <div key={w} style={{ fontWeight: 700, fontSize: '1.1rem' }}>{w}</div>)}
            </div>
          </div>
        </div>

        <p style={{ color: 'var(--text-primary)', fontWeight: 600, lineHeight: 1.5, marginBottom: 16 }}>{FULL_ACCESS_COPY.warning}</p>

        <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
          <legend style={{ fontWeight: 600, marginBottom: 8 }}>{FULL_ACCESS_COPY.styleHeading}</legend>
          {(['everyday', 'careful'] as const).map(s => {
            const c = FULL_ACCESS_COPY[s];
            return (
              <label key={s} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' }}>
                <input
                  type="radio" name="owner-style" value={s} checked={style === s}
                  onChange={() => setStyle(s)} style={{ marginTop: 4 }}
                />
                <span>
                  <strong>{c.name}</strong>{c.tag ? ` (${c.tag})` : ''}
                  <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.45 }}>{c.body}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {running && (
          <p role="status" style={{ fontWeight: 600, lineHeight: 1.5, marginBottom: 12 }}>{FULL_ACCESS_COPY.holding}</p>
        )}
        {problem && problem.message && (
          <div role="alert" style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
            {problem.message}
          </div>
        )}

        {problem && !canRetry ? (
          <button className="btn btn-primary" onClick={onSeparately}>{continueLabel}</button>
        ) : (
          <>
            <button className="btn btn-primary" onClick={() => void run()} disabled={running}>
              {running ? 'Waiting for your Heartwood…' : canRetry ? FULL_ACCESS_COPY.tryAgain : FULL_ACCESS_COPY.setUp}
            </button>
            <button className="btn btn-secondary" onClick={onSeparately} disabled={running} style={{ marginTop: 8 }}>
              {separatelyLabel}
            </button>
            {showSeparatelyHint && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.45, marginTop: 8 }}>
                {separatelyHint()}
              </p>
            )}
          </>
        )}
        {onBack && !running && (
          <button className="btn btn-ghost" onClick={onBack} style={{ marginTop: 8 }}>Back</button>
        )}
      </div>
    </div>
  );
}
