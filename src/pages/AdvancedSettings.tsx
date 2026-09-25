import { useState } from 'react';
import type { SignetIdentity, AppPreferences, RelayConfig } from '../types';
import { DEFAULT_BLOSSOM_URL } from '../lib/blossom';
import { defaultRelays, MAX_RELAYS } from '../lib/relay-service';
import { isValidRelayUrl } from '../lib/relay-url';
import { HeartwoodOperatorImport } from '../components/HeartwoodOperatorImport';
import { Icon } from '../components/Icon';
import type { OperatorImportOutcome } from '../hooks/useHeartwoodOperator';
import type { DeviceStatus } from '../lib/heartwood-mgmt-types';
import { describePushResult, type PolicyPushResult } from '../lib/policy-push';
import { shortDeviceLabel } from '../lib/heartwood-operator-import';

/** Operator-key + rules-push state bundle from App.tsx (C3, family-bunker §11.1.4/9). */
export interface HeartwoodOperatorSettingsProps {
  /** Public parts of the stored credential, or null when none. */
  credential: { deviceHex: string; relays: string[]; importedAt: number } | null;
  status: DeviceStatus | null;
  statusError: string | null;
  /** `null` = unverified (no/truncated status). */
  canPush: boolean | null;
  canVerdict: boolean | null;
  importLink: (text: string, pin?: string) => Promise<OperatorImportOutcome>;
  importPhrase: (words: string, deviceInput: string, relaysText: string) => Promise<OperatorImportOutcome>;
  forget: () => Promise<void>;
  push: {
    lastPushAt: number | null;
    lastResult: PolicyPushResult | null;
    pushing: boolean;
    pushNow: () => void;
  };
  /** Pre-filled link text (from a QR scan routed here). */
  initialImportText?: string;
}

interface Props {
  identity: SignetIdentity;
  preferences: AppPreferences;
  /** The user's relay set (multi-relay manager). */
  relays: RelayConfig[];
  /** Persist the full relay set. Keeps relayUrl=primary in sync upstream. */
  onSetRelays: (relays: RelayConfig[]) => void;
  /** Updates `AppPreferences.fallbackBunkerRelays` — dependant pair QRs. */
  onSetFallbackBunkerRelays?: (relays: string[]) => void;
  onConnectSigner?: (bunkerUri: string) => Promise<void>;
  onDisconnectSigner?: () => void;
  signingMode?: 'local' | 'bunker' | 'nip07' | 'paired-child';
  bunkerUri?: string;
  onNavigateBridge: () => void;
  onNavigateRoster?: () => void;
  onNavigateDeveloper?: () => void;
  /** Opens the "Migrate family to Heartwood" ceremony page. */
  onOpenMigration?: () => void;
  /**
   * Persist the default Blossom server URL — used by persona public-profile
   * picture/banner uploads (SlotProfileFields) and venue-entry photo
   * uploads (PhotoCapture). Empty string clears (disables uploads).
   */
  onSetDefaultBlossomUrl: (url: string) => Promise<void>;
  /**
   * Clear the user's saved Blossom URL so the resolver tracks
   * DEFAULT_BLOSSOM_URL again. Called by the "Restore to default" button.
   * Re-engages auto-update across future default rotations.
   */
  onResetDefaultBlossomUrl?: () => void;
  /**
   * Persist the user's consent to upload images to their chosen Blossom
   * server. Required (alongside a URL) before any upload proceeds.
   */
  onSetBlossomConsent: (consent: boolean) => Promise<void>;
  /** Heartwood operator key + rules push (absent on the paired-child surface). */
  heartwoodOperator?: HeartwoodOperatorSettingsProps;
}

export function AdvancedSettings({ identity, preferences, relays, onSetRelays, onSetFallbackBunkerRelays, onConnectSigner, onDisconnectSigner, signingMode, bunkerUri, onNavigateBridge, onNavigateRoster, onNavigateDeveloper, onOpenMigration, onSetDefaultBlossomUrl, onResetDefaultBlossomUrl, onSetBlossomConsent, heartwoodOperator }: Props) {
  const [confirmForgetOperator, setConfirmForgetOperator] = useState(false);
  const [forgettingOperator, setForgettingOperator] = useState(false);
  const relayList: RelayConfig[] = relays.length > 0 ? relays : defaultRelays();
  const [relayDraft, setRelayDraft] = useState('');
  const relayDraftValid = isValidRelayUrl(relayDraft.trim());
  const relayAtCap = relayList.length >= MAX_RELAYS;
  const relayDup = relayList.some(r => r.url === relayDraft.trim());
  const writeCount = relayList.filter(r => r.enabled && r.write).length;

  function updateRelay(url: string, patch: Partial<RelayConfig>) {
    onSetRelays(relayList.map(r => (r.url === url ? { ...r, ...patch } : r)));
  }
  function removeRelay(url: string) {
    onSetRelays(relayList.filter(r => r.url !== url));
  }
  function addRelay() {
    const url = relayDraft.trim();
    if (!isValidRelayUrl(url) || relayList.some(r => r.url === url) || relayList.length >= MAX_RELAYS) return;
    onSetRelays([...relayList, { url, enabled: true, read: true, write: true }]);
    setRelayDraft('');
  }
  // Blossom — fall-through resolver mirrors the relay block above. Absent
  // `defaultBlossomUrl` (the post-migration state for users who haven't
  // customised) means "track DEFAULT_BLOSSOM_URL across future rotations."
  // A literal string (including '') counts as Custom — empty string is the
  // user's deliberate-clear escape hatch (disables uploads).
  const effectiveBlossomDefault = DEFAULT_BLOSSOM_URL;
  const isCustomBlossom = typeof preferences.defaultBlossomUrl === 'string';
  const blossomUrlEffective = preferences.defaultBlossomUrl ?? effectiveBlossomDefault;
  const [editingBlossom, setEditingBlossom] = useState(false);
  const [blossomDraft, setBlossomDraft] = useState('');
  const [showBunkerInput, setShowBunkerInput] = useState(false);
  const [bunkerDraft, setBunkerDraft] = useState('');
  const [bunkerConnecting, setBunkerConnecting] = useState(false);
  const [bunkerError, setBunkerError] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // Phone-pairing flow shares the same `onConnectSigner` plumbing as
  // the Heartwood "Connect signer" section below, but keeps its own
  // input state so the two sections can be open simultaneously without
  // their drafts colliding.
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneConnecting, setPhoneConnecting] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const fallbackRelays = preferences.fallbackBunkerRelays ?? [];
  const [fallbackDraft, setFallbackDraft] = useState('');
  const fallbackDraftValid = isValidRelayUrl(fallbackDraft.trim());
  const fallbackAtCap = fallbackRelays.length >= 4;

  // URL scheme rule for Blossom (https everywhere, http only for localhost
  // / 127.0.0.1). Blossom is HTTP rather than WS so the shared
  // `isValidRelayUrl` helper doesn't fit. Empty clears the setting (Option
  // A: deliberate-blank disables uploads).
  function isValidBlossomUrl(url: string): boolean {
    if (url === '') return true;
    return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(url);
  }

  function isValidBunkerUri(uri: string): boolean {
    // Accept either an unencoded `relay=wss://…` (the canonical form
    // Heartwood emits) or a URL-encoded `relay=wss%3A%2F%2F…` (the form
    // emitted by `buildPhoneBunkerUrl` on the phone side, since
    // `encodeURIComponent` is the standard way to build query params).
    // `parseBunkerInput` from nostr-tools decodes both via URLSearchParams,
    // so both reach the connect handshake fine — the difference is purely
    // at the paste-time validator.
    return /^bunker:\/\/[0-9a-f]{64}\?.*relay=(wss:\/\/|wss%3a%2f%2f)/i.test(uri.trim());
  }

  function truncateBunkerUri(uri: string): string {
    if (uri.length <= 30) return uri;
    return `${uri.slice(0, 18)}...${uri.slice(-10)}`;
  }

  return (
    <div className="fade-in" role="main">
      {/* Identity Bridge */}
      <div className="card section">
        <div className="section-title">Identity Bridge</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          Link your real and anonymous identities with a ring signature proof.
        </p>
        <button className="btn btn-secondary" onClick={onNavigateBridge}>
          Open Identity Bridge
        </button>
      </div>

      {/* Developer diagnostics */}
      {onNavigateDeveloper && (
        <div className="card section">
          <div className="section-title">Developer</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Inspect inbound Sign-in-with-Signet requests. Useful when integrating a consumer.
          </p>
          <button className="btn btn-secondary" onClick={onNavigateDeveloper}>
            Auth request log
          </button>
        </div>
      )}

      {/* Authorised Roster */}
      {onNavigateRoster && (
        <div className="card section">
          <div className="section-title">Authorised Roster</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Publish a signed list of authorised pubkeys with roles. External apps can subscribe for staff authorisation.
          </p>
          <button className="btn btn-secondary" onClick={onNavigateRoster}>
            Manage Roster
          </button>
        </div>
      )}

      {/* Relays — multi-relay manager (2026-06-10). Publishes fan out to every
          enabled+write relay; reads merge across enabled+read relays. */}
      <div className="card section">
        <div className="section-title">Relays</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          The app publishes to every enabled relay with write on, and reads from every enabled relay with read on. The first enabled write relay is your primary (used for pairing codes and remote signing).
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
          {relayList.map((r, idx) => {
            const isPrimary = idx === relayList.findIndex(x => x.enabled && x.write);
            const isLastWrite = r.enabled && r.write && writeCount === 1;
            return (
              <div key={r.url} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: '0.82rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                    {r.url.replace(/^wss:\/\//, '')}
                    {isPrimary && <span style={{ marginLeft: 6, fontSize: '0.65rem', color: 'var(--accent)', fontWeight: 600 }}>PRIMARY</span>}
                  </span>
                  <button
                    onClick={() => removeRelay(r.url)}
                    aria-label={`Delete ${r.url}`}
                    title={isLastWrite ? 'Cannot delete your only write relay' : `Delete ${r.url}`}
                    disabled={isLastWrite}
                    style={{ background: 'none', border: 'none', cursor: isLastWrite ? 'not-allowed' : 'pointer', color: isLastWrite ? 'var(--text-muted)' : 'var(--danger)', padding: '2px 6px', flexShrink: 0 }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                  <label
                    title={isLastWrite ? 'Cannot disable your only write relay' : undefined}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: isLastWrite ? 'not-allowed' : 'pointer' }}
                  >
                    <input type="checkbox" checked={r.enabled} disabled={isLastWrite} onChange={e => updateRelay(r.url, { enabled: e.target.checked })} />
                    Enabled
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', cursor: r.enabled ? 'pointer' : 'not-allowed', opacity: r.enabled ? 1 : 0.5 }}>
                    <input
                      type="checkbox"
                      checked={!r.write}
                      disabled={!r.enabled || isLastWrite}
                      onChange={e => updateRelay(r.url, { write: !e.target.checked, read: true })}
                    />
                    Read-only
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {!relayAtCap ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={relayDraft}
              onChange={e => setRelayDraft(e.target.value)}
              placeholder="wss://relay.example.com"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-secondary"
              disabled={!relayDraftValid || relayDup}
              onClick={addRelay}
              style={{ flexShrink: 0, width: 'auto', padding: '4px 12px' }}
            >
              Add
            </button>
          </div>
        ) : (
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>Maximum of {MAX_RELAYS} relays.</p>
        )}

        <button
          className="btn btn-ghost"
          onClick={() => onSetRelays(defaultRelays())}
          style={{ marginTop: 10, width: 'auto', padding: '4px 12px', fontSize: '0.8rem' }}
        >
          Restore defaults
        </button>
      </div>

      {/* Image hosting (Blossom). Persona profile picture/banner uploads
          and venue-entry photo uploads both go through the configured
          server here. Mirrors the Relay block above — fall-through default
          + Custom/Default badge + "Restore to default" affordance so users
          who haven't customised stay tracking future rotations. */}
      <div className="card section">
        <div className="section-title">
          Image hosting (Blossom){' '}
          <span style={{ fontSize: '0.7rem', fontWeight: 500, color: isCustomBlossom ? 'var(--warning)' : 'var(--text-secondary)', marginLeft: 8 }}>
            {isCustomBlossom ? 'Custom' : 'Default'}
          </span>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          Blossom servers host pictures you upload — your persona's public profile picture / banner, your in-app avatar, and your venue-entry photo.
        </p>
        {!editingBlossom ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontSize: '0.85rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
                {blossomUrlEffective === '' ? '(uploads disabled)' : blossomUrlEffective}
              </span>
              <button className="btn btn-secondary" onClick={() => { setBlossomDraft(blossomUrlEffective); setEditingBlossom(true); }} style={{ flexShrink: 0, width: 'auto', padding: '4px 12px' }}>
                Edit
              </button>
            </div>
            {isCustomBlossom && (
              <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'var(--warning-light)', border: '1px solid var(--warning)' }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                  You're on a custom Blossom server. If we update the recommended default later, this won't change automatically — you'd stay on <span style={{ fontFamily: 'var(--font-mono)' }}>{blossomUrlEffective === '' ? '(uploads disabled)' : blossomUrlEffective.replace(/^https?:\/\//, '')}</span>.
                </p>
                {onResetDefaultBlossomUrl && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => onResetDefaultBlossomUrl()}
                    style={{ marginTop: 8, width: 'auto', padding: '4px 12px', fontSize: '0.8rem' }}
                  >
                    Restore to default ({effectiveBlossomDefault.replace(/^https?:\/\//, '')})
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div>
            <input
              className="input"
              value={blossomDraft}
              onChange={e => setBlossomDraft(e.target.value)}
              placeholder="https://blossom.example.com"
              autoFocus
            />
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '6px 2px 0', lineHeight: 1.4 }}>
              Saving a custom server disables auto-update — future default changes won't reach you until you Restore to default. Leave blank to disable uploads.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" onClick={async () => {
                const url = blossomDraft.trim();
                if (!isValidBlossomUrl(url)) return;
                await onSetDefaultBlossomUrl(url);
                setEditingBlossom(false);
              }} disabled={!isValidBlossomUrl(blossomDraft.trim())} style={{ flex: 1 }}>
                Save
              </button>
              <button className="btn btn-ghost" onClick={() => setEditingBlossom(false)} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: '0.85rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={preferences.blossomConsent === true}
            onChange={async e => { await onSetBlossomConsent(e.target.checked); }}
          />
          <span>Allow uploading images to my chosen Blossom server</span>
        </label>
      </div>

      {/* Fallback relays for dependant pairing */}
      {onSetFallbackBunkerRelays && (
        <div className="card section">
          <div className="section-title">Pairing fallback relays</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Baked into pair QRs alongside your primary relay. If a child's network blocks the main one, their device tries these next.
          </p>
          {fallbackRelays.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {fallbackRelays.map((r) => (
                <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontSize: '0.85rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{r}</span>
                  <button
                    className="btn btn-ghost"
                    onClick={() => onSetFallbackBunkerRelays(fallbackRelays.filter(x => x !== r))}
                    style={{ flexShrink: 0, width: 'auto', padding: '4px 12px', color: 'var(--danger)' }}
                    aria-label={`Remove ${r}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          {!fallbackAtCap ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                value={fallbackDraft}
                onChange={e => setFallbackDraft(e.target.value)}
                placeholder="wss://fallback.example.com"
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-secondary"
                disabled={!fallbackDraftValid || fallbackRelays.includes(fallbackDraft.trim())}
                onClick={() => {
                  const url = fallbackDraft.trim();
                  if (!isValidRelayUrl(url)) return;
                  if (fallbackRelays.includes(url)) return;
                  onSetFallbackBunkerRelays([...fallbackRelays, url]);
                  setFallbackDraft('');
                }}
                style={{ flexShrink: 0, width: 'auto', padding: '4px 12px' }}
              >
                Add
              </button>
            </div>
          ) : (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
              Maximum of 4 fallback relays.
            </p>
          )}
        </div>
      )}

      {/* Pair my phone — recommended path while phone-as-bunker is the
          gold standard (Heartwood is paused pending a NIP discussion on
          persona derivation). The UX wraps the same `onConnectSigner`
          handler that the Heartwood section below uses, so both surfaces
          flow through the App.tsx backup-gate + mnemonic-strip path. */}
      {(signingMode === 'local' || signingMode === undefined) && onConnectSigner && (
        <div className="card section">
          <div className="section-title">Pair my phone</div>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Recommended. Make your phone the signer for this desktop. Each sign
            request still pops on your phone for approval.
          </p>
          <ol style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 12px 0', paddingLeft: 20 }}>
            <li>On your phone, open Settings → Security → turn <strong>the Bunker</strong> on.</li>
            <li>Copy or scan the Bunker URL shown there.</li>
            <li>Paste it below and tap <strong>Pair</strong>.</li>
          </ol>
          {!identity.backedUp ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', margin: 0 }}>
              Back up your recovery words first (Settings → Security → Backup Words).
              Pairing clears MySignet's stored copy of your recovery phrase.
            </p>
          ) : (
            <>
              <input
                className="input"
                value={phoneDraft}
                onChange={e => { setPhoneDraft(e.target.value); setPhoneError(''); }}
                placeholder="bunker://..."
                disabled={phoneConnecting}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={!isValidBunkerUri(phoneDraft) || phoneConnecting}
                  onClick={async () => {
                    if (!isValidBunkerUri(phoneDraft)) return;
                    setPhoneConnecting(true);
                    setPhoneError('');
                    try {
                      await onConnectSigner(phoneDraft.trim());
                      setPhoneDraft('');
                    } catch (err) {
                      setPhoneError(err instanceof Error ? err.message : 'Pairing failed');
                    } finally {
                      setPhoneConnecting(false);
                    }
                  }}
                  style={{ flex: 1 }}
                >
                  {phoneConnecting ? 'Pairing...' : 'Pair'}
                </button>
              </div>
              {phoneError && (
                <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginTop: 8 }}>
                  {phoneError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Migrate family to Heartwood — family-bunker migration ceremony
          (§11.1.3). Two entry states: pre-migration (local signing), gated
          behind the same backup requirement as "Pair my phone" above since
          it also strips local key material once verified; and
          post-partial-migration (bunker mode) as a "finish the family"
          re-entry — any dependant not yet moved onto the Heartwood signer
          can still be enrolled from here. */}
      {(signingMode === 'local' || signingMode === undefined || signingMode === 'bunker') && onOpenMigration && (
        <div className="card section">
          <div className="section-title">Migrate family to Heartwood</div>
          {signingMode === 'bunker' ? (
            <>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                Finish enrolling any family members still signing locally onto your Heartwood signer.
              </p>
              <button className="btn btn-secondary" onClick={onOpenMigration}>
                Continue migration
              </button>
            </>
          ) : !identity.backedUp ? (
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', margin: 0 }}>
              Back up your recovery words first (Settings → Security → Backup Words).
              Migration removes local key material from this device.
            </p>
          ) : (
            <>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                Move your identity and your family's identities onto a Heartwood signer, all at once.
              </p>
              <button className="btn btn-secondary" onClick={onOpenMigration}>
                Start migration
              </button>
            </>
          )}
        </div>
      )}

      {/* Heartwood operator key — C3 policy push + C4 verdicts over the
          kind-24134 operator channel (family-bunker §11.1.4/9). Shown once
          the family signs on a Heartwood (or whenever a key is on file). */}
      {heartwoodOperator && (signingMode === 'bunker' || heartwoodOperator.credential || heartwoodOperator.initialImportText) && (
        heartwoodOperator.credential ? (
          <div className="card section">
            <div className="section-title">Heartwood operator key</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
              Manages device <code>{shortDeviceLabel(heartwoodOperator.credential.deviceHex)}</code> over {heartwoodOperator.credential.relays.length}{' '}
              relay{heartwoodOperator.credential.relays.length === 1 ? '' : 's'}. Family rules push automatically when they change; family asks can be answered from the Bunker tab.
            </p>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
              <div>
                Device: {heartwoodOperator.status
                  ? `${heartwoodOperator.status.version ? `firmware ${heartwoodOperator.status.version} · ` : ''}${
                    heartwoodOperator.canPush === true ? 'rules push supported' : heartwoodOperator.canPush === false ? 'rules push NOT supported — update firmware' : 'rules push unverified'
                  } · ${
                    heartwoodOperator.canVerdict === true ? 'verdicts supported' : heartwoodOperator.canVerdict === false ? 'verdicts NOT supported' : 'verdicts unverified'
                  }`
                  : heartwoodOperator.statusError
                    ? `unreachable (${heartwoodOperator.statusError.slice(0, 80)})`
                    : 'checking…'}
              </div>
              <div>
                Last push: {heartwoodOperator.push.pushing
                  ? 'in progress…'
                  : heartwoodOperator.push.lastPushAt && heartwoodOperator.push.lastResult
                    ? `${new Date(heartwoodOperator.push.lastPushAt).toLocaleTimeString()} — ${describePushResult(heartwoodOperator.push.lastResult)}`
                    : 'not yet this session'}
              </div>
              {heartwoodOperator.push.lastResult?.errors.map((e, i) => (
                <div key={i} style={{ color: 'var(--danger)' }}>{e.slice(0, 160)}</div>
              ))}
              {heartwoodOperator.push.lastResult?.warnings.map((w, i) => (
                <div key={`w${i}`} style={{ color: 'var(--warning)' }}>{w.slice(0, 160)}</div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary"
                disabled={heartwoodOperator.push.pushing}
                onClick={() => heartwoodOperator.push.pushNow()}
                style={{ flex: 1 }}
              >
                {heartwoodOperator.push.pushing ? 'Pushing…' : 'Push rules now'}
              </button>
              {!confirmForgetOperator ? (
                <button className="btn btn-ghost" onClick={() => setConfirmForgetOperator(true)} style={{ flex: 1 }}>
                  Forget
                </button>
              ) : null}
            </div>
            {confirmForgetOperator && (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 8 }}>
                  This phone will stop pushing family rules and answering family asks. Re-import the link from Sapwood to restore it.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" disabled={forgettingOperator} onClick={async () => {
                    setForgettingOperator(true);
                    try { await heartwoodOperator.forget(); } finally { setForgettingOperator(false); setConfirmForgetOperator(false); }
                  }} style={{ flex: 1 }}>
                    {forgettingOperator ? 'Forgetting…' : 'Forget key'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setConfirmForgetOperator(false)} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <HeartwoodOperatorImport
            key={heartwoodOperator.initialImportText ?? ''}
            title="Heartwood operator key"
            intro="Paste the Manage from your phone link from Sapwood (Settings → Phone). Lets this phone answer family asks and push the family rules to the device."
            onImportLink={heartwoodOperator.importLink}
            onImportPhrase={heartwoodOperator.importPhrase}
            initialText={heartwoodOperator.initialImportText}
          />
        )
      )}

      {/* Remote Signer */}
      <div className="card section">
        <div className="section-title">Remote Signer</div>
        {signingMode === 'nip07' ? (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Signing via browser extension (NIP-07).
            </p>
            {!confirmDisconnect ? (
              <button className="btn btn-secondary" onClick={() => setConfirmDisconnect(true)} style={{ marginTop: 8 }}>
                Disconnect extension
              </button>
            ) : (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 8 }}>
                  This will disconnect your browser extension. You will need to restore your identity to sign locally again.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" onClick={() => {
                    setConfirmDisconnect(false);
                    onDisconnectSigner?.();
                  }} style={{ flex: 1 }}>
                    Disconnect
                  </button>
                  <button className="btn btn-secondary" onClick={() => setConfirmDisconnect(false)} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : signingMode === 'bunker' ? (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Connected to Heartwood signer.
            </p>
            {bunkerUri && (
              <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                {truncateBunkerUri(bunkerUri)}
              </span>
            )}
            {!confirmDisconnect ? (
              <button className="btn btn-secondary" onClick={() => setConfirmDisconnect(true)} style={{ marginTop: 8 }}>
                Disconnect signer
              </button>
            ) : (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 8 }}>
                  This will disconnect your Heartwood device. You'll need to restore your identity from your recovery phrase to sign locally again.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" onClick={() => {
                    setConfirmDisconnect(false);
                    onDisconnectSigner?.();
                  }} style={{ flex: 1 }}>
                    Disconnect
                  </button>
                  <button className="btn btn-secondary" onClick={() => setConfirmDisconnect(false)} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
              Advanced. Connect a Heartwood device or other NIP-46 signer with a
              <code style={{ margin: '0 4px' }}>bunker://</code>
              URI. For pairing your phone, use the section above.
            </p>
            {!showBunkerInput ? (
              <button className="btn btn-secondary" onClick={() => {
                if (!identity.backedUp) {
                  setBunkerError('Back up your recovery phrase before connecting a signer. Once connected, MySignet clears its stored copy of your recovery phrase.');
                  return;
                }
                setBunkerError('');
                setShowBunkerInput(true);
              }}>
                Connect signer
              </button>
            ) : (
              <div>
                <input
                  className="input"
                  value={bunkerDraft}
                  onChange={e => { setBunkerDraft(e.target.value); setBunkerError(''); }}
                  placeholder="bunker://..."
                  autoFocus
                  disabled={bunkerConnecting}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn btn-primary"
                    disabled={!isValidBunkerUri(bunkerDraft) || bunkerConnecting}
                    onClick={async () => {
                      if (!isValidBunkerUri(bunkerDraft)) return;
                      setBunkerConnecting(true);
                      setBunkerError('');
                      try {
                        await onConnectSigner?.(bunkerDraft.trim());
                        setShowBunkerInput(false);
                        setBunkerDraft('');
                      } catch (err) {
                        setBunkerError(err instanceof Error ? err.message : 'Connection failed');
                      } finally {
                        setBunkerConnecting(false);
                      }
                    }}
                    style={{ flex: 1 }}
                  >
                    {bunkerConnecting ? 'Connecting...' : 'Connect'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => { setShowBunkerInput(false); setBunkerDraft(''); setBunkerError(''); }} disabled={bunkerConnecting} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {bunkerError && (
              <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginTop: 8 }}>
                {bunkerError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
