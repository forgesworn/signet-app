import { useState } from 'react';
import type { KindredTier } from '@forgesworn/kenspeckle';
import { QRCode } from './QRCode';
import { sharePolicyFor } from '../lib/contacts-rolodex';
import { encodeNpub, hexToBytes, isValidHexKey } from '../lib/signet';

interface Props {
  pubkey: string;
  /** The contact's tier — determines whether a confirm gate is shown. */
  tier: KindredTier;
  displayName: string;
}

/**
 * Share-QR section for a contact detail view.
 *
 * ken  → one-tap: Share button immediately reveals the QR (public figures;
 *        their key is already public-domain by definition).
 * kin/kith → confirm gate: Share button shows a consent prompt before the
 *        QR — sharing a privately-verified person's key with a third party
 *        requires their agreement.
 *
 * The gate logic comes from `sharePolicyFor` (contacts-rolodex) — the single
 * source of truth, so a future policy change updates one place.
 */
export function ContactShareQR({ pubkey, tier, displayName }: Props) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'qr'>('idle');

  const { needsConfirm } = sharePolicyFor({ tier });

  const npub = isValidHexKey(pubkey)
    ? encodeNpub(hexToBytes(pubkey))
    : pubkey;

  function handleShare() {
    if (needsConfirm) {
      setStep('confirm');
    } else {
      setStep('qr');
    }
  }

  function handleConfirm() {
    setStep('qr');
  }

  function handleCancel() {
    setStep('idle');
  }

  if (step === 'idle') {
    return (
      <div className="card section" style={{ textAlign: 'center' }}>
        <div className="section-title" style={{ marginBottom: 8 }}>Share contact</div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Share {displayName}'s Nostr public key as a QR code so others can add them.
        </p>
        <button className="btn btn-secondary" onClick={handleShare} style={{ width: 'auto' }}>
          Show share QR
        </button>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="card section" style={{ borderColor: 'var(--warning)' }}>
        <div className="section-title" style={{ marginBottom: 8 }}>Share their key?</div>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
          You're about to share {displayName}'s public key with someone else. Only do this
          if they're OK with it — their npub lets others find and contact them on Nostr.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleConfirm} style={{ flex: 1 }}>
            Yes, show QR
          </button>
          <button className="btn btn-secondary" onClick={handleCancel} style={{ flex: 1 }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // step === 'qr'
  return (
    <div className="card section" style={{ textAlign: 'center' }}>
      <div className="section-title" style={{ marginBottom: 8 }}>Share QR — {displayName}</div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <QRCode data={npub} size={220} />
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          wordBreak: 'break-all',
          marginBottom: 12,
        }}
      >
        {npub}
      </div>
      <button className="btn btn-ghost" onClick={handleCancel} style={{ width: 'auto' }}>
        Close QR
      </button>
    </div>
  );
}
