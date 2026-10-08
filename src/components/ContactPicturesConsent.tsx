import {
  PICTURES_CONSENT_ACCEPT_LABEL, PICTURES_CONSENT_BODY, PICTURES_CONSENT_DECLINE_LABEL, PICTURES_CONSENT_TITLE,
} from '../lib/contacts-v2-copy';

/**
 * The consent step shown before ANY contact profile picture is downloaded —
 * every time, for the follows import and for "Refresh pictures". Nothing is
 * fetched until "Download pictures" is tapped.
 */
export function ContactPicturesConsent({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="contact-pictures-consent-title" className="card section" style={{ margin: '0 0 12px' }}>
      <div id="contact-pictures-consent-title" className="section-title">{PICTURES_CONSENT_TITLE}</div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 12px', lineHeight: 1.5 }}>
        {PICTURES_CONSENT_BODY}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={onAccept}>{PICTURES_CONSENT_ACCEPT_LABEL}</button>
        <button className="btn btn-ghost" onClick={onDecline}>{PICTURES_CONSENT_DECLINE_LABEL}</button>
      </div>
    </div>
  );
}
