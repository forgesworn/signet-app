/**
 * Shared "import your Heartwood operator key" card (family-bunker
 * §11.1.4/9, C3 design §5). Rendered by the migration wizard's done stage
 * and by Advanced settings so both surfaces are one component.
 *
 * Paste-first: the Sapwood "Manage from your phone" link (`#/import?…`).
 * A PIN field appears only when the pasted link turns out to be
 * PIN-protected (`eop=`) — the hook reports `{ needsPin }`. A recovery-
 * phrase fallback (words + device npub/hex + relay URL(s)) sits behind a
 * text toggle for the case where the link isn't to hand.
 *
 * All resolution/validation is in `lib/heartwood-operator-import.ts`; this
 * component only owns field state.
 */

import { useState } from 'react';
import type { OperatorImportOutcome } from '../hooks/useHeartwoodOperator';
import { HEARTWOOD_OPERATOR_PIN_MIN } from '../lib/heartwood-operator';

export interface HeartwoodOperatorImportProps {
  onImportLink: (text: string, pin?: string) => Promise<OperatorImportOutcome>;
  onImportPhrase: (words: string, deviceInput: string, relaysText: string) => Promise<OperatorImportOutcome>;
  /** Called after a successful import (either path). */
  onImported?: () => void;
  /** Optional "Skip" affordance (wizard). */
  onSkip?: () => void;
  /** Pre-filled link text (e.g. from a QR scan). */
  initialText?: string;
  /** Section heading; defaults to the wizard's card title. */
  title?: string;
  /** Lead copy; defaults to the wizard's card copy. */
  intro?: string;
}

const DEFAULT_TITLE = 'Enable remote approvals & rules';
const DEFAULT_INTRO = 'Scan the Manage from your phone QR in Sapwood (Settings → Phone) or paste the link. Lets this phone answer family asks and push the family rules to the device. Optional — skip and do it later in Advanced settings.';

export function HeartwoodOperatorImport({
  onImportLink, onImportPhrase, onImported, onSkip, initialText, title, intro,
}: HeartwoodOperatorImportProps) {
  const [mode, setMode] = useState<'link' | 'phrase'>('link');
  const [text, setText] = useState(initialText ?? '');
  const [pin, setPin] = useState('');
  const [needsPin, setNeedsPin] = useState(false);
  const [words, setWords] = useState('');
  const [device, setDevice] = useState('');
  const [relays, setRelays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleOutcome = (r: OperatorImportOutcome) => {
    if ('imported' in r) {
      setError('');
      setPin('');
      setNeedsPin(false);
      onImported?.();
      return;
    }
    if ('needsPin' in r) {
      setNeedsPin(true);
      setError(pin ? '' : 'This link is PIN-protected — enter the PIN Sapwood showed you.');
      return;
    }
    setError(r.error);
  };

  async function submitLink() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      handleOutcome(await onImportLink(text, needsPin ? pin : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  async function submitPhrase() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      handleOutcome(await onImportPhrase(words, device, relays));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  const linkReady = text.trim().length > 0 && (!needsPin || pin.trim().length >= HEARTWOOD_OPERATOR_PIN_MIN);
  const phraseReady = words.trim().length > 0 && device.trim().length > 0 && relays.trim().length > 0;

  return (
    <div className="card section">
      <div className="section-title">{title ?? DEFAULT_TITLE}</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
        {intro ?? DEFAULT_INTRO}
      </p>

      {error && (
        <div role="alert" style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {mode === 'link' ? (
        <>
          <textarea
            className="input"
            rows={3}
            placeholder="https://…/#/import?op=…  or  #/import?eop=ncryptsec1…"
            value={text}
            onChange={(e) => { setText(e.target.value); setError(''); setNeedsPin(false); setPin(''); }}
            style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            disabled={busy}
            aria-label="Heartwood handoff link"
          />
          {needsPin && (
            <input
              className="input"
              type="password"
              inputMode="numeric"
              placeholder={`PIN (at least ${HEARTWOOD_OPERATOR_PIN_MIN} characters)`}
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(''); }}
              style={{ marginTop: 8 }}
              autoComplete="one-time-code"
              disabled={busy}
              autoFocus
              aria-label="Link PIN"
            />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!linkReady || busy}
              onClick={() => { void submitLink(); }}
              style={{ flex: 1 }}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
            {onSkip && (
              <button type="button" className="btn btn-secondary" onClick={onSkip} disabled={busy} style={{ flex: 1 }}>
                Skip
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setMode('phrase'); setError(''); }}
            disabled={busy}
            style={{ marginTop: 6, fontSize: '0.8rem', padding: '4px 0', width: '100%' }}
          >
            Paste recovery phrase instead
          </button>
        </>
      ) : (
        <>
          <textarea
            className="input"
            rows={3}
            placeholder="operator recovery phrase (12 or 24 words)"
            value={words}
            onChange={(e) => { setWords(e.target.value); setError(''); }}
            style={{ resize: 'none' }}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            disabled={busy}
            aria-label="Operator recovery phrase"
          />
          <input
            className="input"
            placeholder="Device address (npub1…)"
            value={device}
            onChange={(e) => { setDevice(e.target.value); setError(''); }}
            style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label="Device address"
          />
          <input
            className="input"
            placeholder="wss://relay.example (comma-separated for more)"
            value={relays}
            onChange={(e) => { setRelays(e.target.value); setError(''); }}
            style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label="Device relays"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!phraseReady || busy}
              onClick={() => { void submitPhrase(); }}
              style={{ flex: 1 }}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
            {onSkip && (
              <button type="button" className="btn btn-secondary" onClick={onSkip} disabled={busy} style={{ flex: 1 }}>
                Skip
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setMode('link'); setError(''); }}
            disabled={busy}
            style={{ marginTop: 6, fontSize: '0.8rem', padding: '4px 0', width: '100%' }}
          >
            Paste the link instead
          </button>
        </>
      )}
    </div>
  );
}
