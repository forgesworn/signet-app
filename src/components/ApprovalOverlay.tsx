import { useState } from 'react';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import type { AuthRequest, LoginRequest } from '../lib/qr-router';
import type { ConsumerHint, KeypairToken } from '../types';
import { shortNpub } from '../lib/signet';
import { SharePreview } from './SharePreview';
import { PairedChildApprovalWaiting } from './PairedChildApprovalWaiting';

interface Props {
  /** The auth or login request we're prompting about */
  request: AuthRequest | LoginRequest;
  /** Human-readable name of the requesting site */
  siteName: string;
  /** Identity that will sign — sourced from the carousel's active row */
  activeIdentity: ResolvedIdentity;
  /** Consumer-supplied hint from the URL (accept/prefer/accept_reason). */
  consumerHint: ConsumerHint | null;
  /**
   * When true, the overlay cannot approve an NP selection directly — it
   * pushes the user to the full picker where the inline confirmation lives.
   */
  requireNpConfirmation: boolean;
  /** Switch to the full picker page. Used by filter-mismatch + NP-ceiling. */
  onOpenFullPicker: () => void;
  onApprove: () => void;
  onDeny: () => void;
  /**
   * True on the paired-child surface — swap the action row for a status
   * panel once the kid has tapped Approve, so the kid understands they're
   * waiting on the guardian (not on the app). See
   * `PairedChildApprovalWaiting` for the progressive-disclosure rules.
   */
  isPairedChild?: boolean;
}

const VALID_AGE_RANGES = ['0-3', '4-7', '8-12', '13-17', '18+'];

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Map a carousel row's identity type to a policy token family. */
function tokenForIdentity(type: string): KeypairToken {
  if (type === 'Natural Person') return 'natural-person';
  if (type === 'Persona') return 'persona';
  if (type === 'Dependant') return 'natural-person'; // carousel always surfaces dep's NP row
  return 'extra-persona';
}

export function ApprovalOverlay({
  request,
  siteName,
  activeIdentity,
  consumerHint,
  requireNpConfirmation,
  onOpenFullPicker,
  onApprove,
  onDeny,
  isPairedChild = false,
}: Props) {
  // Local approving flag — App.tsx owns the actual signEvent lifecycle but
  // doesn't surface a loading state down to the overlay. Tracking it here
  // lets us show the kid-aware waiting panel without restructuring the
  // upstream handler. On success the overlay unmounts via navigation; on
  // failure (rare for the carousel quick-approve path because it falls
  // through to the full picker via initialError) we stay in approving:true
  // until the parent component navigates away, which is the same shape as
  // pre-existing behaviour.
  const [approving, setApproving] = useState(false);
  const isLogin = request.type === 'signet-login-request';
  const loginReq = request as LoginRequest;
  const ageRange = isLogin
    && typeof loginReq.requiredAgeRange === 'string'
    && VALID_AGE_RANGES.includes(loginReq.requiredAgeRange)
    ? loginReq.requiredAgeRange
    : null;

  const photoUrl = activeIdentity.photoHash && activeIdentity.blossomUrl
    ? `${activeIdentity.blossomUrl}/${activeIdentity.photoHash}`
    : null;
  const npub = shortNpub(activeIdentity.publicKey);
  const initials = getInitials(activeIdentity.displayName || activeIdentity.type);

  // Is the current carousel row allowed by the consumer hint?
  const activeToken = tokenForIdentity(activeIdentity.type);
  const hintFilters = !!consumerHint && consumerHint.allow.length > 0;
  const activeAllowed = !hintFilters || consumerHint!.allow.includes(activeToken);

  // NP-ceiling blocks one-tap approve from the overlay — user must confirm
  // via the full picker (which has the inline confirmation UI).
  const npCeilingBlocks = activeToken === 'natural-person' && requireNpConfirmation;

  const caption = consumerHint?.reason
    ?? (hintFilters
        ? (consumerHint!.allow.includes('persona')
            ? 'This site asked for a persona'
            : consumerHint!.allow.includes('extra-persona')
              ? 'This site asked for an extra persona'
              : null)
        : null);

  return (
    <div className="approval-overlay">
      <div className="approval-card">
        <h3>Sign in with Signet</h3>
        <p className="approval-site">
          <span className="approval-site-name">{siteName}</span> wants to verify your identity
        </p>

        {caption && (
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              padding: '6px 10px',
              background: 'var(--bg-secondary)',
              borderLeft: '3px solid var(--accent)',
              borderRadius: 4,
              margin: '8px 0',
            }}
          >
            {caption}
          </div>
        )}

        <div className="approval-identity">
          <div className="approval-avatar">
            {photoUrl
              ? <img src={photoUrl} alt="" referrerPolicy="no-referrer" />
              : <span className="approval-avatar-initials">{initials}</span>
            }
          </div>
          <div className="approval-identity-info">
            <div className="approval-identity-name">
              {activeIdentity.displayName
                ? activeIdentity.displayName.slice(0, 50)
                : activeIdentity.type}
            </div>
            <div className="approval-identity-type">{activeIdentity.type}</div>
            <div className="approval-identity-npub">{npub}</div>
          </div>
        </div>

        <div className="approval-shared">
          <div className="approval-shared-title">What will be shared</div>
          <SharePreview
            pubkey={activeIdentity.publicKey}
            selectedDisplayName={activeIdentity.displayName || null}
            selectedToken={activeToken}
            ageRange={ageRange}
            shareHandle={true}
            compact
          />
        </div>

        {activeIdentity.publicProfile?.enabled && (
          // §6.8 correlation hint. The site can look up the persona's kind-0
          // on Nostr — name, picture, bio. Helps the user realise "this
          // persona is the public one." Absent when publicProfile is off.
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--text-secondary)',
              padding: '8px 10px',
              background: 'var(--accent-light)',
              borderLeft: '3px solid var(--accent)',
              borderRadius: 4,
              marginTop: 8,
            }}
            data-testid="approval-public-profile-hint"
          >
            ℹ This site can look up your public Nostr profile
            {activeIdentity.displayName ? (<> (<strong>{activeIdentity.displayName.slice(0, 30)}</strong>)</>) : null}
            {' '}for this persona.
          </div>
        )}

        {!activeAllowed && (
          <div
            style={{
              fontSize: '0.85rem',
              padding: '10px 12px',
              background: 'var(--warning-light)',
              border: '1px solid var(--warning)',
              borderRadius: 6,
              marginTop: 8,
            }}
          >
            This site didn't ask for this identity. Pick a different one to continue.
          </div>
        )}

        {approving && isPairedChild ? (
          <div style={{ marginTop: 12 }}>
            <PairedChildApprovalWaiting onCancel={() => { setApproving(false); onDeny(); }} />
          </div>
        ) : (
          <div className="approval-actions">
            <button className="approval-btn-deny" onClick={onDeny} disabled={approving}>Deny</button>
            {!activeAllowed || npCeilingBlocks ? (
              <button className="approval-btn-approve" onClick={onOpenFullPicker} disabled={approving}>
                {!activeAllowed ? 'Choose identity' : 'Confirm'}
              </button>
            ) : (
              <button
                className="approval-btn-approve"
                onClick={() => { setApproving(true); onApprove(); }}
                disabled={approving}
              >
                {approving ? 'Signing…' : 'Approve'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
