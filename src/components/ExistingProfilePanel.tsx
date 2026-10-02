import { useState, type ReactNode } from 'react';
import type { PublicProfileConfig } from '../types';
import { safeImageOrLinkUrl } from '../lib/public-profile-publish';

/** Choice offered when an account turns out to be public already. */
export type ExistingProfileChoice = 'match' | 'private';

/** Hostname of a relay URL, for display; falls back to the raw string. */
export function relayHostLabel(url: string | undefined): string {
  if (!url) return 'the relay';
  try { return new URL(url).hostname; } catch { return url; }
}

interface Props {
  /** The parsed, validated profile that was found. */
  profile: Partial<PublicProfileConfig>;
  /** Present for the import flows, which offer match-or-keep-private. */
  choice?: ExistingProfileChoice;
  onChoice?: (choice: ExistingProfileChoice) => void;
  /** Extra lines under the profile (e.g. the "matching overwrites this card" warning). */
  children?: ReactNode;
  disabled?: boolean;
}

/**
 * "This account is already public on Nostr as <name>." — shown wherever Signet
 * has found a kind-0 for a key the user is importing or checking. The picture
 * is NEVER fetched until the user taps "Show picture" (the same preview-gated
 * rule as pasted picture URLs elsewhere); text only until then.
 */
export function ExistingProfilePanel({ profile, choice, onChoice, children, disabled }: Props) {
  const [showPicture, setShowPicture] = useState(false);
  const name = profile.displayName || 'an unnamed profile';
  const pictureUrl = profile.pictureUrl && safeImageOrLinkUrl(profile.pictureUrl) ? profile.pictureUrl : undefined;
  const pictureHost = pictureUrl ? relayHostLabel(pictureUrl) : '';

  return (
    <div role="group" aria-label="Existing Nostr profile" className="card section" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {pictureUrl && showPicture && (
          <img
            src={pictureUrl}
            alt="Profile picture"
            referrerPolicy="no-referrer"
            style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            This account is already public on Nostr as {name}.
          </div>
          {profile.about && (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', overflowWrap: 'anywhere' }}>
              {profile.about}
            </p>
          )}
        </div>
      </div>

      {pictureUrl && !showPicture && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--accent-light)', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem', color: 'var(--accent-text)' }}>
          The picture is hosted at <strong>{pictureHost}</strong>. My Signet fetches it only after you tap.
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPicture(true)}>Show picture</button>
          </div>
        </div>
      )}

      {onChoice && choice && (
        <div role="radiogroup" aria-label="What should My Signet do with it?" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.88rem', cursor: 'pointer' }}>
            <input
              type="radio"
              name="existing-profile-choice"
              checked={choice === 'match'}
              onChange={() => onChoice('match')}
              disabled={disabled}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>Match it in My Signet</strong>
              <br />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                My Signet takes this name, bio and picture for the persona. Nothing is published unless you edit and publish later.
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.88rem', cursor: 'pointer' }}>
            <input
              type="radio"
              name="existing-profile-choice"
              checked={choice === 'private'}
              onChange={() => onChoice('private')}
              disabled={disabled}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>Keep it private in My Signet</strong>
              <br />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                It&rsquo;s already public &mdash; My Signet can&rsquo;t take it back off Nostr.
              </span>
            </span>
          </label>
        </div>
      )}

      {children}
    </div>
  );
}
