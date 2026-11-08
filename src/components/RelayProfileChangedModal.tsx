/**
 * Asked before a first publish from a persona card would replace a public
 * profile made in another Nostr app (signet-app-internal#194). Bark and other
 * web clients sign kind-0 straight through the bunker, so the card does not
 * know about that edit.
 */
export type RelayProfileChoice = 'adopt' | 'replace' | 'cancel';

export const RELAY_PROFILE_CHANGED_COPY = {
  eyebrow: 'Public profile',
  title: 'This profile was changed in another app',
  body: (when: string) => `This persona's public profile was updated in another Nostr app on ${when}. Publishing your card now would replace that version.`,
  adopt: 'Use that version',
  adoptHint: 'Your card is filled in from it. Nothing is published.',
  replace: 'Replace it with my card',
  cancel: 'Cancel',
} as const;

interface Props {
  changedAt: number;
  onChoose: (choice: RelayProfileChoice) => void;
}

export function RelayProfileChangedModal({ changedAt, onChoose }: Props) {
  const when = new Date(changedAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const copy = RELAY_PROFILE_CHANGED_COPY;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="relay-profile-changed-title"
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'var(--scrim)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 16 }}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: 480, background: 'var(--bg-card)', borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'var(--shadow-lg)' }}
      >
        <div>
          <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 4 }}>
            {copy.eyebrow}
          </div>
          <h2 id="relay-profile-changed-title" style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.3 }}>{copy.title}</h2>
        </div>
        <p style={{ margin: 0 }}>{copy.body(when)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <button type="button" className="btn btn-primary" onClick={() => onChoose('adopt')}>{copy.adopt}</button>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: -4, textAlign: 'center' }}>{copy.adoptHint}</div>
          <button type="button" className="btn btn-secondary" onClick={() => onChoose('replace')}>{copy.replace}</button>
          <button type="button" className="btn btn-ghost" onClick={() => onChoose('cancel')}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}
