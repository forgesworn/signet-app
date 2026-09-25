import { useStagedOnboarding } from '../hooks/useStagedOnboarding';

interface Props {
  siteName?: string;
  originHost: string;
  onCreate: (displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean) => Promise<void>;
  onImport: (mnemonic: string, displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean) => Promise<void>;
  onCancel: () => void;
  /**
   * `auth` = Sign-in-with-Signet redirect; `connect` = NIP-46 pairing request.
   * Affects consumer bar copy.
   */
  mode?: 'auth' | 'connect';
}

export function Onboarding({
  siteName,
  originHost,
  onCreate,
  onImport,
  onCancel,
  mode = 'auth',
}: Props) {
  const {
    stage, setStage,
    phrase, setPhrase,
    displayName, setDisplayName,
    acknowledged, setAcknowledged,
    legacyMode, toggleLegacyMode,
    busy,
    error,
    goBack,
    handleImportSubmit,
    handleCreateSubmit,
  } = useStagedOnboarding({ onCreate, onImport });

  const site = siteName || originHost;

  // Mobile layout
  const errorBox = error && (
    <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
      {error}
    </div>
  );

  if (stage === 'choice') {
    return (
      <div className="page fade-in" role="main">
        <div style={{ textAlign: 'center', marginBottom: 24, marginTop: 12 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            {mode === 'connect' ? `Connecting ${site} to your Signet` : `Signing in to ${site}`}
          </p>
          <h1 style={{ marginBottom: 12, fontSize: '1.75rem', lineHeight: 1.25 }}>
            Your Signet is yours for life.
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            A Signet is more like a passport than an account. Let's make sure we don't set up a second by accident.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button className="btn btn-primary" onClick={() => setStage('returning')} style={{ flexDirection: 'column', padding: 16, height: 'auto', alignItems: 'flex-start', textAlign: 'left' }}>
            <strong style={{ fontSize: '1rem' }}>I've used Signet before</strong>
            <span style={{ fontSize: '0.85rem', opacity: 0.85, marginTop: 4, fontWeight: 400 }}>
              Even on another device, a long time ago, or in another app.
            </span>
          </button>
          <button className="btn btn-secondary" onClick={() => setStage('first-ever')} style={{ flexDirection: 'column', padding: 16, height: 'auto', alignItems: 'flex-start', textAlign: 'left' }}>
            <strong style={{ fontSize: '1rem' }}>This is my very first Signet</strong>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 4, fontWeight: 400 }}>
              You've never set one up on any device, in any app.
            </span>
          </button>
        </div>

        <button className="btn btn-ghost" onClick={onCancel} style={{ marginTop: 24 }}>
          Cancel and return to {site}
        </button>
      </div>
    );
  }

  if (stage === 'returning') {
    return (
      <div className="page fade-in" role="main">
        <h1 style={{ marginBottom: 8 }}>Welcome back.</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
          {mode === 'connect'
            ? `To connect your Signet to ${site}, bring your Signet to this device by entering your recovery phrase. Your keys aren't on ${site} and they aren't on our servers — they're wherever you last set them up.`
            : `Your keys aren't on ${site} and they aren't on our servers — they're wherever you last set them up. Enter your recovery phrase to bring your Signet to this device.`
          }
        </p>

        <button className="btn btn-primary" onClick={() => setStage('enter-phrase')}>
          Enter my recovery phrase
        </button>

        <button className="btn btn-ghost" onClick={goBack} style={{ marginTop: 8 }}>
          Can't find it? Go back and start again
        </button>
      </div>
    );
  }

  if (stage === 'enter-phrase') {
    return (
      <div className="page fade-in" role="main">
        <h1 style={{ marginBottom: 8 }}>Restore from your recovery words</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
          {legacyMode
            ? 'Type the twelve-word backup you kept safe. It stays on this device — we don\'t have a copy.'
            : 'Type the words you kept safe. They stay on this device — we don\'t have a copy.'}
        </p>
        {errorBox}
        <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: 4 }}>
          {legacyMode ? 'Your older 12-word backup' : 'Your recovery words (19 or 31 words)'}
        </label>
        <textarea
          className="input"
          rows={4}
          placeholder={legacyMode ? '12 words separated by spaces' : '19 words separated by spaces'}
          value={phrase}
          onChange={e => setPhrase(e.target.value)}
          style={{ resize: 'none' }}
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoFocus
        />
        <button
          className="btn btn-ghost"
          onClick={toggleLegacyMode}
          style={{ marginTop: 8, fontSize: '0.85rem' }}
        >
          {legacyMode ? 'I have recovery words' : 'I have an older 12-word backup'}
        </button>
        <input
          className="input"
          style={{ marginTop: 12 }}
          placeholder="Your name or nickname"
          value={displayName}
          onChange={e => setDisplayName(e.target.value.slice(0, 100))}
          onKeyDown={e => e.key === 'Enter' && handleImportSubmit()}
          maxLength={100}
        />
        <button
          className="btn btn-primary"
          onClick={handleImportSubmit}
          disabled={busy || !phrase.trim() || !displayName.trim()}
          style={{ marginTop: 16 }}
        >
          {busy ? 'Restoring…' : 'Restore my Signet'}
        </button>
        <button className="btn btn-ghost" onClick={() => setStage('returning')} style={{ marginTop: 8 }}>
          Back
        </button>
      </div>
    );
  }

  if (stage === 'first-ever') {
    return (
      <div className="page fade-in" role="main">
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
          Before you begin
        </p>
        <h1 style={{ marginBottom: 16 }}>Let's begin your Signet</h1>

        <div style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.5 }}>
          <p style={{ marginBottom: 12 }}>
            One Signet is usually all you'll need — it follows you between apps and devices. You can add another later, but <strong>it's a bit of extra housekeeping</strong>.
          </p>
          <p style={{ marginBottom: 20 }}>
            You'll get a nineteen-word <strong>recovery phrase</strong>. Write it down somewhere safe — not on this device, not in a screenshot. It's the only way to get your Signet back if something goes wrong.
          </p>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginBottom: 16, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            I'll keep my recovery phrase <strong>somewhere safe</strong>. I know that losing it means losing this Signet.
          </span>
        </label>

        <button
          className="btn btn-primary"
          onClick={() => setStage('first-ever-name')}
          disabled={!acknowledged}
        >
          Begin my Signet
        </button>

        <button className="btn btn-ghost" onClick={goBack} style={{ marginTop: 8 }}>
          Wait — I might already have one
        </button>
      </div>
    );
  }

  if (stage === 'first-ever-name') {
    return (
      <div className="page fade-in" role="main">
        <h1 style={{ marginBottom: 8 }}>What should {site} call you?</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
          This display name is stored on this device only. You can change it later.
        </p>
        {errorBox}
        <input
          className="input"
          placeholder="Your name or nickname"
          value={displayName}
          onChange={e => setDisplayName(e.target.value.slice(0, 100))}
          onKeyDown={e => e.key === 'Enter' && handleCreateSubmit()}
          maxLength={100}
          autoFocus
        />
        <button
          className="btn btn-primary"
          onClick={handleCreateSubmit}
          disabled={busy || !displayName.trim()}
          style={{ marginTop: 16 }}
        >
          {busy ? 'Creating…' : 'Create my Signet'}
        </button>
        <button className="btn btn-ghost" onClick={() => setStage('first-ever')} style={{ marginTop: 8 }}>
          Back
        </button>
      </div>
    );
  }

  return null;
}
