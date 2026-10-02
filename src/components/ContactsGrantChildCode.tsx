import { useEffect, useMemo, useState } from 'react';
import { pairingRequestExpiresAtSec, pairingUriForRequestV2, type PairingRequestV2 } from '../lib/companion-pair-v2';
import {
  CONTACTS_GRANT_CHILD_CODE_TITLE, CONTACTS_GRANT_CHILD_CODE_EXPLAINER, CONTACTS_GRANT_CHILD_CODE_QR_LABEL,
  CONTACTS_GRANT_CHILD_CODE_PAIRING_CODE_COPY, CONTACTS_GRANT_CHILD_CODE_EXPIRED_COPY,
  CONTACTS_GRANT_CHILD_CODE_UNAVAILABLE_COPY, CONTACTS_GRANT_DISMISS_LABEL,
  contactsGrantChildCodeAppLine, contactsGrantChildCodeExpiryCopy,
} from '../lib/contacts-v2-copy';
import { QRCode } from './QRCode';

/** How often the expiry line re-reads the clock. */
const TICK_MS = 5000;

/**
 * Shown on a paired-child install when a contacts pairing request reaches it.
 * The child's phone cannot approve it (R-8); the guardian's My Signet can, so
 * the request is shown as a code for that phone to scan. Full width, a card.
 */
export function ContactsGrantChildCode({ request, onDismiss }: {
  request: PairingRequestV2;
  onDismiss: () => void;
}) {
  const uri = useMemo(() => pairingUriForRequestV2(request), [request]);
  const expiresAtMs = pairingRequestExpiresAtSec(request) * 1000;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [request]);

  const secondsLeft = Math.ceil((expiresAtMs - now) / 1000);
  const expired = secondsLeft <= 0;

  return (
    <div
      role="region"
      aria-label={CONTACTS_GRANT_CHILD_CODE_TITLE}
      style={{
        width: '100%', boxSizing: 'border-box', background: 'var(--bg-secondary)',
        padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center',
      }}
    >
      <h3 style={{ margin: 0 }}>{CONTACTS_GRANT_CHILD_CODE_TITLE}</h3>
      <p style={{ margin: 0, fontSize: 14, overflowWrap: 'anywhere' }}>
        <strong>{contactsGrantChildCodeAppLine(request.appName)}</strong>
      </p>
      {expired ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          {CONTACTS_GRANT_CHILD_CODE_EXPIRED_COPY}
        </p>
      ) : uri ? (
        <>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{CONTACTS_GRANT_CHILD_CODE_EXPLAINER}</p>
          <div role="img" aria-label={CONTACTS_GRANT_CHILD_CODE_QR_LABEL}>
            <QRCode data={uri} size={240} />
          </div>
          <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            {contactsGrantChildCodeExpiryCopy(secondsLeft)}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{CONTACTS_GRANT_CHILD_CODE_PAIRING_CODE_COPY}</p>
        </>
      ) : (
        <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          {CONTACTS_GRANT_CHILD_CODE_UNAVAILABLE_COPY}
        </p>
      )}
      <button onClick={onDismiss} className="btn btn-ghost" style={{ fontSize: 13, padding: '4px 12px' }}>
        {CONTACTS_GRANT_DISMISS_LABEL}
      </button>
    </div>
  );
}
