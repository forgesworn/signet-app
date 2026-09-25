import { useState, useEffect, type ReactNode } from 'react';
import { validateMnemonic, decodeNsec, getPublicKey, bytesToHex } from '../lib/signet';
import { fetchRestoreProfile, type RestoredProfile } from '../lib/profile-restore';
import { fetchPublicProfile } from '../lib/public-profile-publish';
import { isNativeApp } from '../lib/native';
import type { PublicProfileConfig } from '../types';
import { parseRestoreInput, RESTORE_ERROR_COPY } from '../lib/recovery-words';
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';

interface Props {
  onImport: (mnemonic: string, displayName: string, primaryKeypair: 'natural-person' | 'persona', isChild: boolean, guardianPubkey?: string) => Promise<void>;
  onImportLiteMnemonic: (mnemonic: string, liteIdentityName: string, displayName: string) => Promise<void>;
  /**
   * Profile-driven restore: relay had a kind-0 for the mnemonic's
   * derived pubkey(s). The parent builds the identity straight from the
   * profile and skips the manual name prompt.
   */
  onImportWithProfile?: (mnemonic: string, profile: RestoredProfile) => Promise<void>;
  /**
   * Phase C.1 — nsec import always lands in the persona slot now (no NP
   * route). The `opts` arg lets the caller seed `publicProfile` from an
   * existing kind-0 fetched at import time + whether to publish updates
   * from Signet going forward.
   */
  onImportNsec: (
    nsec: string,
    displayName: string,
    primaryKeypair: 'natural-person' | 'persona',
    opts?: { publishProfile?: boolean; existingProfile?: Partial<PublicProfileConfig>; existingEventId?: string; existingCreatedAt?: number; existingRelay?: string },
  ) => Promise<void>;
  onConnectHeartwood: (bunkerUri: string, displayName: string) => Promise<void>;
  onConnectNip07: (displayName: string) => Promise<void>;
  /** Child-device pair path. Parent navigates to PairChildOnboarding. */
  onStartChildPair?: () => void;
  /**
   * Create a brand-new Signet: one persona display name, then `SetupAuth`.
   * The real-name slot is created dormant (spec §4.2) — no real-name step, no
   * child question, no continuity question.
   */
  onCreate: (displayName: string) => Promise<void>;
}

type Flow = 'welcome' | 'create' | 'signet-restore' | 'nostr-native' | 'import' | 'import-lite' | 'import-nsec' | 'heartwood' | 'nip07';
type ImportStep = 'phrase' | 'fetching' | 'name-choice' | 'name' | 'done';
type LiteImportStep = 'phrase' | 'name' | 'done';
type HeartwoodStep = 'uri' | 'name' | 'connecting';

export function OnboardingApp({ onImport, onImportLiteMnemonic, onImportWithProfile, onImportNsec, onConnectHeartwood, onConnectNip07, onStartChildPair, onCreate }: Props) {
  const [flow, setFlow] = useState<Flow>('welcome');
  const [creating, setCreating] = useState(false);
  const [importStep, setImportStep] = useState<ImportStep>('phrase');
  const [liteImportStep, setLiteImportStep] = useState<LiteImportStep>('phrase');
  const [importProfileMissed, setImportProfileMissed] = useState(false);

  // Shared state
  const [displayName, setDisplayName] = useState('');
  const [primaryKeypair, setPrimaryKeypair] = useState<'natural-person' | 'persona'>('natural-person');
  const [isChild] = useState(false);
  const [guardianPubkey] = useState('');
  const [importWords, setImportWords] = useState('');
  // The BIP-39 mnemonic parsed out of importWords. importWords holds what the
  // user typed (recovery words, or a legacy 12-word backup); everything
  // downstream of the parse takes the mnemonic.
  const [importMnemonic, setImportMnemonic] = useState('');
  // Explicit user choice, never sniffed from the word count.
  const [legacyImport, setLegacyImport] = useState(false);
  const [liteImportWords, setLiteImportWords] = useState('');
  const [liteIdentityName, setLiteIdentityName] = useState('default');
  const [nsecInput, setNsecInput] = useState('');
  // Phase C.1: replaced the old `nsec → name-choice → name` 3-step flow
  // with `nsec → fetching → confirm`. The name-choice step (which routed to
  // NP slot for "real name") is removed — every nsec import lands in the
  // persona slot now. See per-persona public-profile design §4.2.1.
  const [nsecStep, setNsecStep] = useState<'nsec' | 'fetching' | 'confirm'>('nsec');
  const [nsecExistingProfile, setNsecExistingProfile] = useState<Partial<PublicProfileConfig> | null>(null);
  const [nsecExistingEventId, setNsecExistingEventId] = useState<string | undefined>(undefined);
  const [nsecExistingCreatedAt, setNsecExistingCreatedAt] = useState<number | undefined>(undefined);
  const [nsecPublishProfile, setNsecPublishProfile] = useState(false);
  const [nsecPicturePreviewShown, setNsecPicturePreviewShown] = useState(false);
  const [nsecConfiguredRelay, setNsecConfiguredRelay] = useState<string | null>(null);
  const [heartwoodStep, setHeartwoodStep] = useState<HeartwoodStep>('uri');
  const [bunkerUri, setBunkerUri] = useState('');
  const [heartwoodConnecting, setHeartwoodConnecting] = useState(false);
  const [nip07Detected, setNip07Detected] = useState(false);
  const [nip07Connecting, setNip07Connecting] = useState(false);
  const [nsecImporting, setNsecImporting] = useState(false);
  const [error, setError] = useState('');

  // Detect NIP-07 extension — may inject after page load
  useEffect(() => {
    const check = () => setNip07Detected(!!window.nostr);
    check();
    const timer = setTimeout(check, 500);
    return () => clearTimeout(timer);
  }, []);

  // --- Import flow ---
  const handleImportPhrase = async () => {
    const parsed = parseRestoreInput(importWords, legacyImport ? 'legacy-bip39' : 'recovery-words');
    if (!parsed.ok) {
      setError(
        parsed.reason === 'legacy-invalid'
          ? "That doesn't look right. Check you have exactly 12 words, separated by spaces."
          : RESTORE_ERROR_COPY[parsed.reason],
      );
      return;
    }
    const words = parsed.mnemonic;
    setImportMnemonic(words);
    setError('');
    setImportProfileMissed(false);

    // If the caller hasn't wired profile-restore, fall straight through to
    // the manual name-choice flow (keeps ApproveOnboarding's simpler path
    // from changing behaviour).
    if (!onImportWithProfile) {
      setImportStep('name-choice');
      return;
    }

    setImportStep('fetching');
    let profile: RestoredProfile | null = null;
    try {
      profile = await fetchRestoreProfile(words);
    } catch {
      profile = null;
    }
    if (profile) {
      await onImportWithProfile(words, profile);
      setImportWords('');
      setImportMnemonic('');
      return;
    }
    // No profile on the relay → fall back to the manual flow with a banner.
    setImportProfileMissed(true);
    setImportStep('name-choice');
  };

  const handleImportNameChoice = (choice: 'natural-person' | 'persona') => {
    setPrimaryKeypair(choice);
    setImportStep('name');
  };

  const handleImportComplete = async () => {
    if (!displayName.trim()) return;
    await onImport(importMnemonic, displayName.trim(), primaryKeypair, isChild, guardianPubkey || undefined);
    setImportWords('');
    setImportMnemonic('');
  };

  const handleCreateComplete = async () => {
    const name = displayName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError('');
    try {
      await onCreate(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your Signet — please try again');
      setCreating(false);
    }
  };

  const handleLiteImportPhrase = () => {
    const words = liteImportWords.trim().toLowerCase();
    if (!validateMnemonic(words)) {
      setError("That doesn't look right. Check you have exactly 12 words, separated by spaces.");
      return;
    }
    if (!liteIdentityName.trim()) {
      setError('Enter the identity name from Lite. If you did not change it, use default.');
      return;
    }
    setError('');
    setLiteImportStep('name');
  };

  const handleLiteImportComplete = async () => {
    if (!displayName.trim()) return;
    await onImportLiteMnemonic(liteImportWords.trim().toLowerCase(), liteIdentityName.trim(), displayName.trim());
    setLiteImportWords('');
  };

  // --- Import nsec flow (Phase C.1) ---
  //
  // Three steps now (was: nsec → name-choice → name):
  //   1. nsec     — paste + format validation
  //   2. fetching — derive pubkey, query relay for existing kind-0 (2s timeout)
  //   3. confirm  — display name input + info-card about Persona vs NP +
  //                 optional "Keep publishing my profile from Signet" checkbox
  //
  // Always lands in the persona slot. The "Use my real name → NP" route is
  // gone per the design — even users who want to publish under their real
  // name pick "Persona" with their real name as the display name.

  const handleNsecSubmit = async () => {
    const trimmed = nsecInput.trim();
    let pubkey: string;
    try {
      const skBytes = decodeNsec(trimmed);
      pubkey = getPublicKey(bytesToHex(skBytes));
    } catch {
      if (trimmed.toLowerCase().startsWith('npub1')) {
        setError("That's your public key — we need your nsec (private), or connect your extension.");
      } else {
        setError("That doesn't look like a valid Nostr private key. Check it starts with 'nsec1' and is complete.");
      }
      return;
    }
    setError('');
    setNsecStep('fetching');
    setNsecPicturePreviewShown(false);

    // Resolve the relay to query. For first-time users we don't have a
    // preferences record yet — fall back to the production default.
    // (Keep this in sync with src/lib/relay-service.ts.)
    const productionRelay = 'wss://relay.trotters.cc';
    // In the Capacitor APK the WebView origin IS localhost — that must not
    // select the dev relay. Only a real browser tab on a dev server does.
    const devRelay = typeof window !== 'undefined' && window.location?.hostname === 'localhost' && !isNativeApp()
      ? 'ws://localhost:7777' : null;
    const relayUrl = devRelay ?? productionRelay;
    setNsecConfiguredRelay(relayUrl);

    let found: { event: import('signet-protocol').NostrEvent; profile: Partial<PublicProfileConfig> } | null = null;
    try {
      found = await fetchPublicProfile(pubkey, relayUrl, 2000);
    } catch {
      found = null;
    }

    if (found) {
      setNsecExistingProfile(found.profile);
      setNsecExistingEventId(found.event.id);
      setNsecExistingCreatedAt(found.event.created_at);
      // Pre-fill display name from kind-0. parseKindZeroContent merges the
      // raw `name` field into `displayName` when no `display_name` exists,
      // so we only need to read displayName here.
      const seedName = found.profile.displayName || '';
      if (seedName) setDisplayName(seedName);
      setNsecPublishProfile(true);  // default-on when kind-0 was found
    } else {
      setNsecExistingProfile(null);
      setNsecExistingEventId(undefined);
      setNsecExistingCreatedAt(undefined);
      setNsecPublishProfile(false);  // default-off when no kind-0
    }
    setNsecStep('confirm');
  };

  const handleNsecComplete = async () => {
    if (!displayName.trim() || nsecImporting) return;
    // Always persona slot. Pass through whatever existing-kind-0 metadata we
    // found so the parent can seed publicProfile state correctly.
    const opts = nsecPublishProfile && nsecExistingProfile
      ? {
          publishProfile: true,
          existingProfile: nsecExistingProfile,
          existingEventId: nsecExistingEventId,
          existingCreatedAt: nsecExistingCreatedAt,
          existingRelay: nsecConfiguredRelay ?? undefined,
        }
      : nsecPublishProfile
      ? { publishProfile: true }  // wants to publish, but no kind-0 found yet
      : undefined;
    setNsecImporting(true);
    setError('');
    try {
      await onImportNsec(nsecInput.trim(), displayName.trim(), 'persona', opts);
      setNsecInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setNsecImporting(false);
    }
  };

  // --- NIP-07 flow ---
  const handleNip07Complete = async () => {
    if (!displayName.trim()) return;
    setNip07Connecting(true);
    setError('');
    try {
      await onConnectNip07(displayName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setNip07Connecting(false);
    }
  };

  // --- Heartwood flow ---
  function isValidBunkerUri(uri: string): boolean {
    // Accept either an unencoded `relay=wss://…` (the canonical form
    // Heartwood emits) or a URL-encoded `relay=wss%3A%2F%2F…` (the form
    // emitted by `buildPhoneBunkerUrl` on the phone side). Matches the
    // validator used in AdvancedSettings → "Pair my phone".
    return /^bunker:\/\/[0-9a-f]{64}\?.*relay=(wss:\/\/|wss%3a%2f%2f)/i.test(uri.trim());
  }

  const handleHeartwoodUri = () => {
    if (!isValidBunkerUri(bunkerUri)) {
      setError('Enter a valid bunker:// URI with a relay address.');
      return;
    }
    setError('');
    setHeartwoodStep('name');
  };

  const handleHeartwoodComplete = async () => {
    if (!displayName.trim()) return;
    setHeartwoodStep('connecting');
    setHeartwoodConnecting(true);
    setError('');
    try {
      await onConnectHeartwood(bunkerUri.trim(), displayName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setHeartwoodStep('name');
      setHeartwoodConnecting(false);
    }
  };

  // --- Render: compute the current stage's body ---
  const body = renderMobile();

  return body;

  // ============ Mobile branch ============
  function renderMobile(): ReactNode {
    if (flow === 'welcome') {
      return (
        <div className="page fade-in" role="main" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '80vh' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 36 }}>
              <BrandMark variant="stacked" size={136} />
            </div>
            <p style={{
              textTransform: 'uppercase', fontSize: '0.72rem', letterSpacing: '0.14em',
              color: 'var(--text-secondary)', marginBottom: 20,
            }}>
              Identity · Sovereignty · Community
            </p>
            <h1 style={{ marginBottom: 8, fontSize: '1.4rem' }}>Verified. Not identified.</h1>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              className="btn btn-primary"
              style={{ fontSize: '1.05rem', padding: '14px 20px' }}
              onClick={() => { setDisplayName(''); setError(''); setFlow('create'); }}
            >
              Create my Signet
            </button>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', margin: '-4px 0 4px' }}>
              under a minute · yours to back up
            </p>
            <button className="btn btn-secondary" onClick={() => setFlow('signet-restore')}>
              I already have a Signet
            </button>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: 12 }}>
              Just want to hold a Nostr key?{' '}
              <a
                href="https://lite.mysignet.app"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Signet Lite →
              </a>
            </p>
          </div>
        </div>
      );
    }

    if (flow === 'create') {
      return (
        <div className="page fade-in" role="main">
          <h1 style={{ marginBottom: 8 }}>Create my Signet</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
            This is your anonymous persona. You can add your real identity later, when
            something needs it.
          </p>
          {error && (
            <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}
          <label className="row-label" htmlFor="persona-name" style={{ fontWeight: 600 }}>
            What should we call you?
          </label>
          <input
            id="persona-name"
            className="input"
            type="text"
            placeholder="A name or handle — not your real name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value.slice(0, 100))}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            style={{ marginTop: 8 }}
          />
          <button
            className="btn btn-primary"
            onClick={handleCreateComplete}
            disabled={!displayName.trim() || creating}
            style={{ marginTop: 16 }}
          >
            {creating ? 'Creating…' : 'Continue'}
          </button>
          <button className="btn btn-ghost" onClick={() => setFlow('welcome')} style={{ marginTop: 8 }} disabled={creating}>
            Back
          </button>
        </div>
      );
    }

    if (flow === 'signet-restore') {
      return (
        <div className="page fade-in" role="main">
          <h1 style={{ marginBottom: 8 }}>I already have a Signet</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
            Restore your identity using your backup or an existing signing device.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button className="btn btn-primary" onClick={() => { setImportStep('phrase'); setError(''); setFlow('import'); }}>
              Enter my recovery words
            </button>
            <button className="btn btn-secondary" onClick={() => { setHeartwoodStep('uri'); setBunkerUri(''); setError(''); setFlow('heartwood'); }}>
              Connect a remote signer
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setLiteImportStep('phrase');
                setLiteImportWords('');
                setLiteIdentityName('default');
                setDisplayName('');
                setError('');
                setFlow('import-lite');
              }}
            >
              Restore from Signet Lite
            </button>
            {onStartChildPair && (
              <button className="btn btn-secondary" onClick={onStartChildPair}>
                I have a pairing code from my guardian
              </button>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '12px 0 0' }}>
              If you only need a signer for this key, Signet Lite is lighter.
            </p>
            <button
              className="btn btn-ghost"
              style={{ fontSize: '0.9rem', marginTop: 0 }}
              onClick={() => setFlow('nostr-native')}
            >
              Import a Nostr key (nsec / extension)
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => setFlow('welcome')} style={{ marginTop: 8 }}>
            Back
          </button>
        </div>
      );
    }

    if (flow === 'nostr-native') {
      return (
        <div className="page fade-in" role="main">
          <h1 style={{ marginBottom: 8 }}>Already on Nostr?</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
            Connect your existing Nostr identity to Signet.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {nip07Detected && (
              <button className="btn btn-primary" onClick={() => { setDisplayName(''); setError(''); setFlow('nip07'); }}>
                Connect Nostr extension
              </button>
            )}
            <button
              className={nip07Detected ? 'btn btn-secondary' : 'btn btn-primary'}
              onClick={() => { setNsecInput(''); setNsecStep('nsec'); setDisplayName(''); setError(''); setFlow('import-nsec'); }}
            >
              Paste your nsec
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => setFlow('signet-restore')} style={{ marginTop: 8 }}>
            Back
          </button>
        </div>
      );
    }

    if (flow === 'import') {
      if (importStep === 'phrase') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>
              {legacyImport ? 'Enter your older 12-word backup' : 'Enter your recovery words'}
            </h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              {legacyImport
                ? 'Type or paste your 12 words, separated by spaces.'
                : 'Your recovery words (19 or 31 words). Type or paste them, separated by spaces.'}
            </p>
            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}
            <textarea
              className="input"
              rows={4}
              placeholder={legacyImport ? '12 words separated by spaces' : '19 words separated by spaces'}
              value={importWords}
              onChange={e => setImportWords(e.target.value)}
              style={{ resize: 'none' }}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoFocus
            />
            <button
              className="btn btn-ghost"
              onClick={() => { setLegacyImport(!legacyImport); setError(''); }}
              style={{ marginTop: 8, fontSize: '0.85rem' }}
            >
              {legacyImport ? 'I have recovery words' : 'I have an older 12-word backup'}
            </button>
            <button className="btn btn-primary" onClick={handleImportPhrase} style={{ marginTop: 16 }}>
              Continue
            </button>
            <button className="btn btn-ghost" onClick={() => setFlow('signet-restore')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (importStep === 'fetching') {
        return (
          <div className="page fade-in" role="main" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '60vh', textAlign: 'center' }}>
            <h1 style={{ marginBottom: 8 }}>Restoring your Signet…</h1>
            <p style={{ color: 'var(--text-secondary)' }}>
              Checking the relay for your existing profile.
            </p>
          </div>
        );
      }

      if (importStep === 'name-choice') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>How do you want to appear?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              Do you want to use your real name, or a nickname?
            </p>
            {importProfileMissed && (
              <div style={{ padding: 12, background: 'var(--warning-light)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Couldn't reach your relay, or no existing profile was found — continue below to set up this device by hand.
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button className="btn btn-primary" onClick={() => handleImportNameChoice('natural-person')}>Use my real name</button>
              <button className="btn btn-secondary" onClick={() => handleImportNameChoice('persona')}>Use a nickname</button>
            </div>
            <button className="btn btn-ghost" onClick={() => setImportStep('phrase')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (importStep === 'name') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>What should we call you?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              Your name, a nickname, whatever you like. You can change it anytime.
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 24 }}>
              e.g. "Margaret Smith" or "DarkWolf99"
            </p>
            <input
              className="input"
              placeholder="Your name or nickname"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleImportComplete()}
              maxLength={100}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleImportComplete} disabled={!displayName.trim()} style={{ marginTop: 16 }}>
              Restore MySignet
            </button>
            <button className="btn btn-ghost" onClick={() => setImportStep('name-choice')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      return null;
    }

    if (flow === 'import-lite') {
      if (liteImportStep === 'phrase') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>Restore from Signet Lite</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              Use your Lite recovery phrase and identity name to keep the same Nostr account.
            </p>
            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}
            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Lite recovery phrase</label>
            <textarea
              className="input"
              rows={4}
              placeholder="word1 word2 word3 ..."
              value={liteImportWords}
              onChange={e => setLiteImportWords(e.target.value)}
              style={{ resize: 'none', marginTop: 4, marginBottom: 14 }}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoFocus
            />
            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Lite identity name</label>
            <input
              className="input"
              placeholder="default"
              value={liteIdentityName}
              onChange={e => setLiteIdentityName(e.target.value)}
              maxLength={100}
              style={{ marginTop: 4, marginBottom: 14 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn btn-primary" onClick={handleLiteImportPhrase}>
              Continue
            </button>
            <button className="btn btn-ghost" onClick={() => setFlow('signet-restore')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (liteImportStep === 'name') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>What should we call you?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              This name is shown on your migrated Persona. You can change it anytime.
            </p>
            <input
              className="input"
              placeholder="Your name or nickname"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLiteImportComplete()}
              maxLength={100}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleLiteImportComplete} disabled={!displayName.trim()} style={{ marginTop: 16 }}>
              Restore Lite Identity
            </button>
            <button className="btn btn-ghost" onClick={() => setLiteImportStep('phrase')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      return null;
    }

    if (flow === 'import-nsec') {
      if (nsecStep === 'nsec') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>Enter your Nostr private key</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              Paste your nsec key to import your existing Nostr account into Signet.
            </p>
            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}
            <textarea
              className="input"
              rows={3}
              placeholder="nsec1..."
              value={nsecInput}
              onChange={e => setNsecInput(e.target.value)}
              style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleNsecSubmit} style={{ marginTop: 16 }}>
              Continue
            </button>
            <button className="btn btn-ghost" onClick={() => setFlow('nostr-native')} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (nsecStep === 'fetching') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>Looking for your profile…</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              Checking Nostr for your existing profile.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--bg-secondary)', borderRadius: 'var(--radius)' }}>
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  border: '2px solid var(--accent)',
                  borderTopColor: 'transparent',
                  animation: 'authpin-spin 0.8s linear infinite',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>One moment…</span>
              <style>{`@keyframes authpin-spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        );
      }

      if (nsecStep === 'confirm') {
        const found = !!nsecExistingProfile;
        const previewUrl = nsecExistingProfile?.pictureUrl;
        const previewHostname = previewUrl ? (() => {
          try { return new URL(previewUrl).hostname; } catch { return previewUrl; }
        })() : '';
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>{found ? 'Welcome back to Nostr' : 'Importing your Nostr account'}</h1>
            {found ? (
              <>
                <p style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
                  We found your existing profile:
                </p>
                <div className="card section" style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
                    <div
                      style={{
                        width: 56, height: 56, borderRadius: '50%',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      {previewUrl && nsecPicturePreviewShown ? (
                        <img src={previewUrl} alt="Your profile picture" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>{previewUrl ? <Icon name="key" size={14} /> : '—'}</span>
                      )}
                    </div>
                    <div>
                      {/* PublicProfileConfig collapses `name` + `display_name` into a single
                          `displayName`. parseKindZeroContent prefers `display_name`,
                          falls back to `name` — so the field below is the unified handle. */}
                      <div style={{ fontWeight: 600 }}>{nsecExistingProfile?.displayName || 'Unnamed'}</div>
                    </div>
                  </div>
                  {nsecExistingProfile?.about && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
                      {nsecExistingProfile.about.slice(0, 200)}{(nsecExistingProfile.about.length > 200) ? '…' : ''}
                    </p>
                  )}
                  {previewUrl && !nsecPicturePreviewShown && (
                    <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--accent-light)', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--accent-text)' }}>
                      Profile picture is hosted at <strong>{previewHostname}</strong>. We'll fetch it only after you tap below.
                      <div style={{ marginTop: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setNsecPicturePreviewShown(true)}>Show picture</button>
                      </div>
                    </div>
                  )}
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
                  Your followers, posts, and follows are preserved — they're tied to your key, not to any one client.
                </p>
              </>
            ) : (
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
                Pick a display name for your new Persona. You can change it anytime.
              </p>
            )}

            <div className="card section" style={{ marginBottom: 16, background: 'var(--bg-secondary)' }}>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: '0.9rem' }}>About Personas vs. Natural Person</div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Even if you use your real name above, your imported Nostr account goes in your <strong>Persona</strong> slot.
                Your <strong>Natural Person</strong> is a separate key Signet reserves for signing official documents, ID and age verifications, venue entries, and other real-world verifications — the things you do as a physical person.
                Keeping them separate means anyone watching your posts can't automatically see what you've cryptographically vouched for in person, and vice versa.
              </p>
            </div>

            <div style={{ padding: 12, background: 'var(--warning-light)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', marginBottom: 16, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              <strong>Signet can't back this up — keep your nsec safe yourself.</strong>
            </div>

            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Display name</label>
            <input
              className="input"
              placeholder="Your name or nickname (e.g. Margaret Smith, DarkWolf99)"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleNsecComplete()}
              maxLength={100}
              autoFocus
              style={{ marginTop: 4, marginBottom: 14 }}
            />

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', marginBottom: 16, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={nsecPublishProfile}
                onChange={e => setNsecPublishProfile(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                {found ? 'Keep publishing my profile from Signet (recommended)' : 'Publish a public Nostr profile for this persona'}
                <br />
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  {found
                    ? `If you uncheck this, Signet won't touch your kind-0 — your existing profile stays as it was.`
                    : `You can turn this on later in Settings. Off by default.`}
                </span>
              </span>
            </label>

            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}

            <button className="btn btn-primary" onClick={handleNsecComplete} disabled={!displayName.trim() || nsecImporting} style={{ marginTop: 8 }}>
              {nsecImporting ? 'Importing...' : 'Import as Persona'}
            </button>
            <button className="btn btn-ghost" onClick={() => setNsecStep('nsec')} style={{ marginTop: 8 }} disabled={nsecImporting}>
              Back
            </button>
          </div>
        );
      }

      return null;
    }

    if (flow === 'nip07') {
      return (
        <div className="page fade-in" role="main">
          <h1 style={{ marginBottom: 8 }}>Sign with Browser Extension</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
            Your keys stay in your browser extension. Signet will ask it to sign events on your behalf.
          </p>
          {error && (
            <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}
          <input
            className="input"
            placeholder="Your name or nickname"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleNip07Complete()}
            maxLength={100}
            autoFocus
          />
          <button className="btn btn-primary" onClick={handleNip07Complete} disabled={!displayName.trim() || nip07Connecting} style={{ marginTop: 16 }}>
            {nip07Connecting ? 'Connecting...' : 'Connect Extension'}
          </button>
          <button className="btn btn-ghost" onClick={() => { setFlow('nostr-native'); setDisplayName(''); setError(''); }} disabled={nip07Connecting} style={{ marginTop: 8 }}>
            Back
          </button>
        </div>
      );
    }

    if (flow === 'heartwood') {
      if (heartwoodStep === 'uri') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>Connect your remote signer</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
              Paste the bunker:// connection from your phone, Heartwood device or other NIP-46 signer.
            </p>
            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}
            <textarea
              className="input"
              rows={3}
              placeholder="bunker://..."
              value={bunkerUri}
              onChange={e => { setBunkerUri(e.target.value); setError(''); }}
              style={{ resize: 'none', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleHeartwoodUri} disabled={!bunkerUri.trim()} style={{ marginTop: 16 }}>
              Continue
            </button>
            <button className="btn btn-ghost" onClick={() => { setFlow('signet-restore'); setBunkerUri(''); setError(''); }} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (heartwoodStep === 'name') {
        return (
          <div className="page fade-in" role="main">
            <h1 style={{ marginBottom: 8 }}>What should we call you?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>
              Your name as it should appear on your Signet identity.
            </p>
            {error && (
              <div style={{ padding: 8, background: 'var(--danger-light)', borderRadius: 'var(--radius-sm)', marginBottom: 12, color: 'var(--danger)', fontSize: '0.9rem' }}>
                {error}
              </div>
            )}
            <input
              className="input"
              placeholder="Your name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleHeartwoodComplete()}
              maxLength={100}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleHeartwoodComplete} disabled={!displayName.trim() || heartwoodConnecting} style={{ marginTop: 16 }}>
              {heartwoodConnecting ? 'Connecting...' : 'Connect'}
            </button>
            <button className="btn btn-ghost" onClick={() => setHeartwoodStep('uri')} disabled={heartwoodConnecting} style={{ marginTop: 8 }}>
              Back
            </button>
          </div>
        );
      }

      if (heartwoodStep === 'connecting') {
        return (
          <div className="page fade-in" role="main" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>Connecting to your signer...</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 8 }}>Approve the connection on your signer.</p>
          </div>
        );
      }

      return null;
    }

    return null;
  }
}
