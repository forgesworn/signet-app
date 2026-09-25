import { useState, useCallback, useMemo } from 'react';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { MiniIdBadge } from './MiniIdBadge';
import { QRCode } from './QRCode';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';
import { buildContactQR } from '../lib/contact-qr';
import { Icon } from './Icon';

const KEY_NAME = 'name';
const KEY_SHARE = 'share-avatar';

interface Props {
  resolved: ResolvedIdentity;
  badge: { tier: number; score: number; vouchCount: number } | null;
  /** Navigate to a deep page (e.g. MatchPass → venue-entry). */
  onNavigateDeepPage?: (page: string, opts?: { dependantId?: string; slotTarget?: string }) => void;
  /**
   * Enable / refresh contact-share avatar for this slot. Returns the stable
   * contact-share key to embed in the QR, or null (public-only / failed).
   */
  onEnableContactAvatarShare?: (target: string, depPubkey?: string) => Promise<string | null>;
  /**
   * Stop sharing the contact avatar for this slot (G1 coarse revocation):
   * clears the stable per-slot key locally + retracts the published pointer.
   * Re-enabling later mints a fresh key.
   */
  onStopContactAvatarShare?: (target: string, depPubkey?: string) => Promise<void>;
}

interface CustomField {
  key: string;
  label: string;
  description: string;
  checked: boolean;
  alwaysOn?: boolean;
}

/** A private (encrypted) avatar exists when all three blob fields are present. */
function hasPrivateAvatar(r: ResolvedIdentity): boolean {
  return !!(r.avatarHash && r.avatarBlossomUrl && r.avatarKey);
}

export function QRCard({ resolved, badge, onNavigateDeepPage, onEnableContactAvatarShare, onStopContactAvatarShare }: Props) {
  const tier = badge?.tier ?? 1;
  const [customFields, setCustomFields] = useState<CustomField[]>(() => buildCustomFields(resolved));
  // Stable contact-share key once enabled (seeded from the slot if already set).
  const [contactKey, setContactKey] = useState<string | null>(resolved.contactAvatarKey ?? null);
  const [enabling, setEnabling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [shareError, setShareError] = useState('');

  const privateAvatar = hasPrivateAvatar(resolved);
  const publicAvatar = resolved.publicProfile?.enabled === true;

  const npub = isValidHexKey(resolved.publicKey)
    ? encodeNpub(hexToBytes(resolved.publicKey))
    : resolved.publicKey;

  // qrData is DERIVED purely from the front-page pill state — no back face, no
  // activeType short-circuit. npub is always included (the identity); the name
  // pill adds the display name (only when a REAL name is set — never the
  // 'Persona'/'Natural Person' fallback, which would leak nothing useful and
  // doxx the fallback label); the share pill adds the contact-share avatar key.
  const qrData = useMemo(() => {
    const nameOn = customFields.find(f => f.key === KEY_NAME)?.checked;
    const shareOn = customFields.find(f => f.key === KEY_SHARE)?.checked;
    const name = nameOn && resolved.displayNameIsSet ? resolved.displayName : undefined;
    const avatarKey = shareOn ? (contactKey ?? undefined) : undefined;
    if (!name && !avatarKey) return npub;
    return buildContactQR({ pubkey: resolved.publicKey, name, avatarKey });
  }, [customFields, npub, resolved.publicKey, resolved.displayName, resolved.displayNameIsSet, contactKey]);

  const tierDisplay = resolved.isDependant ? 'Dependant' : `Tier ${tier}`;
  const isVerified = tier >= 2;

  const nameField = customFields.find(f => f.key === KEY_NAME);
  const shareField = customFields.find(f => f.key === KEY_SHARE);
  const shareActive = !!shareField?.checked;
  const shareKeyInHand = !!(resolved.contactAvatarKey || contactKey);

  // Shared enable/re-share path: uploads the CURRENT avatar, republishes the
  // pointer, and (on success) persists `contactAvatarStale: false`. Returns
  // true when a contact-share key is now in hand. On failure it surfaces the
  // error + unticks the share pill and returns false. Used by both first-time
  // enable (the share toggle) and the M3 stale re-share nudge.
  const runEnable = useCallback(async (): Promise<boolean> => {
    if (!onEnableContactAvatarShare || !resolved.slotTarget) return false;
    setEnabling(true);
    setShareError('');
    try {
      const key = await onEnableContactAvatarShare(resolved.slotTarget, resolved.dependantId);
      if (!key) {
        // Enable failed (public-only / no backend / relay). Revert the share
        // pill and surface the error under the pill row.
        setShareError('Could not enable avatar sharing. Untick it or try again.');
        setCustomFields(prev => prev.map(f => f.key === KEY_SHARE ? { ...f, checked: false } : f));
        return false;
      }
      setContactKey(key);
      return true;
    } catch {
      setShareError('Could not enable avatar sharing. Untick it or try again.');
      setCustomFields(prev => prev.map(f => f.key === KEY_SHARE ? { ...f, checked: false } : f));
      return false;
    } finally {
      setEnabling(false);
    }
  }, [onEnableContactAvatarShare, resolved.slotTarget, resolved.dependantId]);

  // Display Name is a PURE toggle — re-deriving qrData is synchronous.
  const toggleName = useCallback(() => {
    setShareError('');
    setCustomFields(prev => prev.map(f => f.key === KEY_NAME && !f.alwaysOn ? { ...f, checked: !f.checked } : f));
  }, []);

  // Share-avatar toggle. Turning ON when no key is in hand triggers the async
  // enable machine (the pill shows its loading state); the field is ticked
  // optimistically and reverted by runEnable on failure. Turning OFF just
  // unticks (revocation is the explicit "stop sharing" affordance below).
  const toggleShare = useCallback(async () => {
    setShareError('');
    const field = customFields.find(f => f.key === KEY_SHARE);
    if (!field) return;
    if (!field.checked) {
      setCustomFields(prev => prev.map(f => f.key === KEY_SHARE ? { ...f, checked: true } : f));
      if (!contactKey && privateAvatar) {
        await runEnable(); // reverts the pill itself on failure
      }
    } else {
      setCustomFields(prev => prev.map(f => f.key === KEY_SHARE ? { ...f, checked: false } : f));
    }
  }, [customFields, contactKey, privateAvatar, runEnable]);

  // G1 coarse revocation: clear the stable key locally + retract the published
  // pointer. On success reset local share state immediately — drop contactKey
  // and uncheck the share field so the QR stops embedding the key. Re-enabling
  // later mints a fresh key (App-side).
  const handleStopShare = useCallback(async () => {
    if (!onStopContactAvatarShare || !resolved.slotTarget) return;
    setStopping(true);
    setShareError('');
    try {
      await onStopContactAvatarShare(resolved.slotTarget, resolved.dependantId);
      setContactKey(null);
      setCustomFields(prev => prev.map(f => f.key === KEY_SHARE ? { ...f, checked: false } : f));
    } catch {
      setShareError('Could not stop sharing. Try again.');
    } finally {
      setStopping(false);
    }
  }, [onStopContactAvatarShare, resolved.slotTarget, resolved.dependantId]);

  const showStale = !!(resolved.contactAvatarKey && resolved.contactAvatarStale);

  return (
    <div className="qr-view">
      <div>
        <MiniIdBadge resolved={resolved} />
        <div className="qr-sharing">Tap to choose what your QR shares</div>
      </div>

      <div className="qr-box">
        <QRCode data={qrData} size={230} />
      </div>

      <div className="qr-tier-line">
        &#128737; {tierDisplay} &middot; {isVerified ? 'Verified' : 'Unverified'}
      </div>

      {/* Front-page include pills — what the QR carries. */}
      <div className="qr-includes">
        <span className="qr-pill locked" aria-disabled="true" title="Your Nostr identity — always included">
          &#128273; npub
        </span>

        <button
          type="button"
          className={`qr-pill${nameField?.checked ? ' active' : ''}`}
          onClick={toggleName}
        >
          {nameField?.checked ? '✓ ' : ''}Display Name
        </button>

        {privateAvatar && (
          <span className={`qr-pill-group${shareActive ? ' active' : ''}`}>
            <button
              type="button"
              className={`qr-pill${shareActive ? ' active' : ''}${enabling ? ' loading' : ''}`}
              onClick={toggleShare}
              disabled={enabling || stopping}
            >
              {enabling ? 'Enabling…' : (shareActive ? '✓ ' : '') + 'Share avatar'}
            </button>
            {shareActive && shareKeyInHand && onStopContactAvatarShare && (
              <button
                type="button"
                className="qr-pill-x"
                onClick={handleStopShare}
                disabled={stopping || enabling}
                title="Stop sharing my avatar"
                aria-label="Stop sharing my avatar"
              >
                {stopping ? '…' : <Icon name="x" size={14} />}
              </button>
            )}
          </span>
        )}

        {/* MatchPass stays a SEPARATE mode chip → venue-entry boarding pass. */}
        <button
          type="button"
          className="qr-pill mode"
          onClick={() => onNavigateDeepPage?.('venue-entry')}
        >
          &#127941; MatchPass
        </button>
      </div>

      {/* Inline share status / affordances — relocated from the retired back face. */}
      {shareError && (
        <div className="qr-share-note danger">{shareError}</div>
      )}
      {showStale && (
        <div className="qr-share-note warn">
          Shared avatar may be out of date.
          <button className="qr-share-link" onClick={runEnable} disabled={enabling}>
            {enabling ? 'Re-sharing…' : 'Re-share now'}
          </button>
        </div>
      )}
      {!privateAvatar && publicAvatar && (
        <div className="qr-share-note">Your profile picture is public — contacts always see it.</div>
      )}
    </div>
  );
}

function buildCustomFields(resolved: ResolvedIdentity): CustomField[] {
  const fields: CustomField[] = [
    // Display Name defaults ON — every user's QR now carries npub + name. The
    // qrData memo still omits the name when no REAL name is set, so a
    // nameless QR never advertises the 'Persona' fallback.
    { key: KEY_NAME, label: 'Display Name', description: resolved.displayName, checked: true },
  ];
  // "Share my avatar" only when a PRIVATE (encrypted) avatar exists. Public
  // kind-0 pictures need no key — contacts resolve them automatically.
  if (hasPrivateAvatar(resolved)) {
    fields.push({ key: KEY_SHARE, label: 'Share my avatar', description: 'Contacts see your latest picture (always-current)', checked: false });
  }
  return fields;
}
