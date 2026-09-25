import { useState } from 'react';
import { Icon } from './Icon';

interface Props {
  /**
   * 'guardian' = top-level carousel (guardian or solo user). Offers both
   * Add persona and Add dependant.
   * 'child' = inside a dependant's child-mode ring. Persona-only — a
   * dependant has no dependants of their own.
   * 'paired-child' = the dependant's OWN paired-child install. No
   * actions — kids can't create personas themselves (no derivation, no
   * signing material). The card explains that the guardian manages
   * personas for them, with the guardian's display name woven in when
   * available. See the internal issue tracker — persona-inventory-sync follow-up.
   */
  context: 'guardian' | 'child' | 'paired-child';
  /**
   * Create a persona with the given display name. Caller is responsible
   * for freshAuth gating and any extra work (saving the new identity,
   * announcing it on the active relay, etc.). Throws on failure so the
   * card can surface a retry message. Ignored in paired-child context.
   */
  onAddPersona: (displayName: string) => Promise<void>;
  /**
   * Opens the full Add Dependant flow. Guardian context only — ignored
   * in child / paired-child contexts. The target page handles its own
   * auth gating.
   */
  onAddDependant?: () => void;
  /**
   * Guardian display name for the paired-child empty-state copy. When
   * the kid's app has cached it (via the kind-30078 status sync), the
   * copy reads "Ask <name>"; otherwise it falls back to a generic
   * "Ask your guardian". paired-child context only.
   */
  guardianName?: string;
}

export function AddCard({ context, onAddPersona, onAddDependant, guardianName }: Props) {
  // Paired-child surface — informational only, no actions. The kid
  // can't create personas on their own device because all signing
  // material lives on the guardian's device (or upstream signer). Any
  // new persona has to be derived guardian-side and synced over the
  // persona-inventory rail.
  if (context === 'paired-child') {
    const asker = guardianName ? guardianName : 'your guardian';
    return (
      <div className="add-view">
        <div
          aria-hidden
          style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'var(--bg-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-secondary)', marginBottom: 16,
          }}
        >
          <Icon name="key" size={32} />
        </div>
        <h2 style={{ marginBottom: 8, textAlign: 'center' }}>Personas are managed for you</h2>
        <p style={{
          fontSize: '0.95rem', color: 'var(--text-secondary)',
          marginBottom: 0, textAlign: 'center', maxWidth: 320, lineHeight: 1.5,
        }}>
          New personas are added by {asker}. Ask them if you'd like one for a specific game, chat, or space — they can set it up on their phone and it'll appear here.
        </p>
      </div>
    );
  }

  const [mode, setMode] = useState<'choose' | 'persona-name'>('choose');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmitPersona() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a display name.');
      return;
    }
    if (trimmed.length > 100) {
      setError('Name must be 100 characters or fewer.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onAddPersona(trimmed);
      setMode('choose');
      setName('');
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not add persona. Try again.');
    } finally {
      setSaving(false);
    }
  }

  function cancelPersona() {
    setMode('choose');
    setName('');
    setError('');
  }

  const guardian = context === 'guardian';

  return (
    // Deliberately NOT `.settings-view`. That class is listed in the swipe
    // gesture's INTERACTIVE_ZONE_SELECTOR (see useSwipeGesture.ts), which
    // forced a 400ms long-press on every touch inside this card — fine for
    // the dense-button settings view, but this card has large blank regions
    // around two centred buttons and the user needs to swipe out of it.
    // `.add-view` carries the identical visual shell but is absent from the
    // selector, so swipes on blank card area engage immediately. The inner
    // `<button>` elements still match the selector and retain the
    // long-press-to-swipe escape hatch.
    <div className="add-view">
      <div
        aria-hidden
        style={{
          width: 72, height: 72, borderRadius: '50%',
          background: 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, color: 'var(--text-secondary)', marginBottom: 16,
        }}
      >
        +
      </div>

      {mode === 'choose' ? (
        <>
          <h2 style={{ marginBottom: 8, textAlign: 'center' }}>Add</h2>
          <p style={{
            fontSize: '0.9rem', color: 'var(--text-secondary)',
            marginBottom: 20, textAlign: 'center', maxWidth: 320, lineHeight: 1.4,
          }}>
            {guardian && onAddDependant
              ? "Spin up an anonymous persona for yourself, or add someone you look after."
              : guardian
              ? "Spin up an anonymous persona for yourself."
              : "Spin up an anonymous persona for the games, chats, and spaces where you don't want your real name."}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320 }}>
            <button
              className="btn btn-primary"
              onClick={() => setMode('persona-name')}
              style={{ width: '100%' }}
            >
              Add persona
            </button>
            {guardian && onAddDependant && (
              <button
                className="btn btn-secondary"
                onClick={onAddDependant}
                style={{ width: '100%' }}
              >
                Add someone you look after
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <h2 style={{ marginBottom: 8, textAlign: 'center' }}>Name this persona</h2>
          <p style={{
            fontSize: '0.85rem', color: 'var(--text-secondary)',
            marginBottom: 16, textAlign: 'center', maxWidth: 320, lineHeight: 1.4,
          }}>
            Just a label for you — nobody outside sees it unless you tell them.
          </p>
          <div style={{ width: '100%', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="input"
              value={name}
              onChange={e => { setName(e.target.value); if (error) setError(''); }}
              placeholder="e.g. CryptoAlice"
              autoFocus
              maxLength={100}
              disabled={saving}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmitPersona();
                if (e.key === 'Escape') cancelPersona();
              }}
            />
            {error && (
              <div style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</div>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSubmitPersona}
              disabled={saving || !name.trim()}
              style={{ width: '100%' }}
            >
              {saving ? 'Saving…' : 'Create persona'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={cancelPersona}
              disabled={saving}
              style={{ width: '100%' }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
