import { useState, type ReactNode } from 'react';
import type { KnownPlace, KnownPlaceChannel } from '../types/known-places';
import type { Badge } from '../lib/known-place-badges';
import { placeLabel, placeTint, relativeTime, hostnameOf } from '../lib/known-place-label';
import { KnownPlaceBadgeGlyph } from './KnownPlaceBadgeGlyph';
import { canOpenPlace } from '../lib/known-place-open';
import { isNativeApp } from '../lib/native';
import { heartwoodMgmtErrorCopy } from '../lib/heartwood-mgmt-error-copy';

export type KnownPlaceIdentityType = 'persona' | 'natural-person' | 'extra' | 'dependant' | 'bot';

export interface KnownPlaceCtx {
  /** nip46: the paired client asks before each signature. */
  askToSign?: boolean;
  /** nip55: the grant for this caller AND this identity; null when there is none for this identity. */
  nip55Grant?: { allowAlways: boolean; denyAlways: boolean } | null;
  /** nip55: the app's grant is pinned to a different identity, which this row must not touch. */
  nip55OtherIdentity?: boolean;
  /** nip46: the paired-client list has not loaded, so whether this one asks is unknown (no auto badge or action). */
  loading?: boolean;
  /** The installed app's icon as a data URL from the phone's package manager (native only). */
  appIcon?: string | null;
  /** The installed app's own name from the phone's package manager (native only). */
  appLabel?: string;
  /** nip46: unix seconds the paired client was last seen. */
  lastSeenAt?: number;
  /** nip46: the app was handed to a Heartwood, which signs for it; the phone has no ask setting for it. */
  heartwoodHeld?: boolean;
}

export interface KnownPlaceActions {
  pin(id: string, pinned: boolean): void | Promise<void>;
  setAlias(id: string, alias: string): void | Promise<void>;
  setAuto(place: KnownPlace, value: 'always' | 'ask'): void | Promise<void>;
  open(place: KnownPlace): void | Promise<void>;
  forget(place: KnownPlace): void | Promise<void>;
  disconnect(place: KnownPlace): void | Promise<void>;
  revokeOnHeartwood(fingerprint: string): void | Promise<void>;
  /** An app handed to a Heartwood whose Disconnect failed: drop all its records and its row, here only. */
  forgetHandoffHere?(place: KnownPlace): void | Promise<void>;
}

export const FORGET_HANDOFF_HERE_COPY = 'Removes this app from this phone only. It may still sign on your Heartwood: remove it there in Sapwood.';

export const ASK_EACH_TIME_SUMMARY = 'Encrypts and decrypts for this app without asking; signing asks each time.';

const TYPE_WORDS: Record<KnownPlaceIdentityType, string> = {
  persona: 'Persona',
  'natural-person': 'Real identity',
  extra: 'Extra persona',
  dependant: 'Dependant',
  bot: 'Bot',
};
export const identityTypeWords = (t: KnownPlaceIdentityType) => TYPE_WORDS[t];

const SHORT_CHANNEL: Record<KnownPlaceChannel, string> = {
  'phone-app': 'phone app',
  browser: 'phone browser',
  'other-device': 'another device',
  nip46: 'Nostr Connect',
  nip55: 'phone app',
  unknown: '',
};

const CHANNEL_SENTENCE: Record<KnownPlaceChannel, string> = {
  'phone-app': 'Signed in from an app on this phone',
  browser: "Signed in from this phone's browser",
  'other-device': 'Signed in on another device, approved here',
  nip46: 'Paired over Nostr Connect',
  nip55: 'Asks this phone to sign, from an app on it',
  unknown: '',
};

export const HEARTWOOD_HELD_SIGNING = 'By your Heartwood, without asking this phone';

export const PAIRED_TO_OTHER_IDENTITY_COPY = 'This app is currently paired to a different identity.';

/** The one-line row summary: "<identity> · <channel> · <time>". */
export function placeSummary(place: KnownPlace, ctx: KnownPlaceCtx, identityName: string, last: number, now: number): string {
  if (place.kind === 'nip46' && ctx.askToSign) return ASK_EACH_TIME_SUMMARY;
  return [identityName, SHORT_CHANNEL[place.channel], relativeTime(last, now)].filter(Boolean).join(' · ');
}

function dateOf(secs: number): string {
  return new Date(secs * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

interface RowProps {
  place: KnownPlace;
  ctx: KnownPlaceCtx;
  identityName: string;
  identityType: KnownPlaceIdentityType;
  last: number;
  now: number;
  badges: Badge[];
  expanded: boolean;
  onToggle: () => void;
  actions: KnownPlaceActions;
}

/** One place: a summary line that expands in place into facts, then actions. */
export function KnownPlaceRow({ place, ctx, identityName, identityType, last, now, badges, expanded, onToggle, actions }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirm, setConfirm] = useState<'forget' | 'disconnect' | 'forget-here' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set once a Disconnect of an app handed to a Heartwood has failed, for any
  // reason (or an action found that Heartwood can't be managed from here).
  const [disconnectFailed, setDisconnectFailed] = useState(false);

  const label = placeLabel(place);
  const primary = badges[0] ?? null;
  const grant = place.kind === 'nip55' ? ctx.nip55Grant ?? null : null;
  const isAuto = place.kind === 'nip46' ? !ctx.loading && !ctx.askToSign : !!grant?.allowAlways;
  // No auto action until the client list has loaded; and a NIP-55 row acts only on a grant pinned to ITS identity.
  const canAuto = (place.kind === 'nip46' && !ctx.loading && !ctx.heartwoodHeld) || (place.kind === 'nip55' && grant !== null);
  const canDisconnect = place.kind === 'nip46' || (place.kind === 'nip55' && !ctx.nip55OtherIdentity);
  const openable = canOpenPlace(place, isNativeApp());
  const channelSentence = CHANNEL_SENTENCE[place.channel];

  const heartwoodHeld = place.kind === 'nip46' && !!ctx.heartwoodHeld;
  const run = async (fn: () => void | Promise<void>, opts: { disconnecting?: boolean } = {}) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      setError(heartwoodMgmtErrorCopy(e));
      // A Heartwood app whose Disconnect failed can still be forgotten here.
      if (heartwoodHeld && (opts.disconnecting || (e as { unmanaged?: unknown } | null)?.unmanaged === true)) {
        setDisconnectFailed(true); setConfirm(null);
      }
    } finally { setBusy(false); }
  };
  const canForgetHere = heartwoodHeld && disconnectFailed && !!actions.forgetHandoffHere;

  const approvedOn = place.signer === 'local' ? 'this phone'
    : place.signer === 'heartwood' ? 'your Heartwood'
    : place.signer === 'remote-signer' ? 'a remote signer'
    : place.signer === 'extension' ? 'a browser extension' : '';

  let otherLine: ReactNode = null;
  if (place.kind === 'nip55' && ctx.nip55OtherIdentity) otherLine = PAIRED_TO_OTHER_IDENTITY_COPY;
  else if (!openable) {
    if (place.channel === 'other-device') otherLine = 'Signed in on another device';
    else if (place.kind === 'nip46' || place.kind === 'nip55') otherLine = 'Paired app';
  }

  const knownAsParts = [
    place.name && place.name !== label && place.name !== place.nativePackage && place.name !== ctx.appLabel ? place.name : '',
    place.origin ? hostnameOf(place.origin) : '',
    place.nativePackage ? (ctx.appLabel ? `${ctx.appLabel} app` : 'Android app') : '',
  ].filter(Boolean);

  return (
    <li className={`kp-row${expanded ? ' kp-row--open' : ''}`} data-kp-row={place.id}>
      <button type="button" className="kp-row-head" aria-expanded={expanded} onClick={onToggle}>
        {ctx.appIcon
          ? <img className="kp-row-tile kp-row-tile--img" src={ctx.appIcon} alt="" aria-hidden="true" />
          : <span className="kp-row-tile" aria-hidden="true" style={{ background: placeTint(place) }}>{label.charAt(0).toUpperCase()}</span>}
        <span className="kp-row-text">
          <span className="kp-row-name">{label}</span>
          <span className="kp-row-summary">{placeSummary(place, ctx, identityName, last, now)}</span>
        </span>
        {primary && <span className="kp-row-badge" title={primary.label}><KnownPlaceBadgeGlyph badge={primary} /></span>}
      </button>

      {expanded && (
        <div className="kp-panel">
          <dl className="kp-facts">
            <div><dt>Identity</dt><dd>{identityName} · {identityTypeWords(identityType)}</dd></div>
            <div>
              <dt>Known as</dt>
              <dd>
                {knownAsParts.length > 0 ? knownAsParts.join(' · ') : label}
                {place.nativePackage && <span className="kp-fact-sub">{place.nativePackage}</span>}
              </dd>
            </div>
            {channelSentence && <div><dt>How</dt><dd>{channelSentence}</dd></div>}
            {approvedOn && <div><dt>Approved on</dt><dd>{approvedOn}</dd></div>}
            {(place.shared.handle || place.shared.picture) && (
              <div><dt>Shared</dt><dd>{[place.shared.handle && 'Your handle', place.shared.picture && 'Your picture'].filter(Boolean).join(' and ')}</dd></div>
            )}
            {place.kind === 'nip46' && ctx.askToSign && <div><dt>Signing</dt><dd>{ASK_EACH_TIME_SUMMARY}</dd></div>}
            {place.kind === 'nip46' && ctx.heartwoodHeld && <div><dt>Signing</dt><dd>{HEARTWOOD_HELD_SIGNING}</dd></div>}
            {grant?.denyAlways && <div><dt>Signing</dt><dd>Refused every time</dd></div>}
            <div><dt>First seen</dt><dd>{dateOf(place.firstAt)}</dd></div>
            <div><dt>Last used</dt><dd>{relativeTime(last, now)}</dd></div>
            <div><dt>Used</dt><dd>{place.uses} {place.uses === 1 ? 'time' : 'times'}</dd></div>
          </dl>

          {editing ? (
            <div className="kp-alias-edit">
              <input
                className="kp-input"
                aria-label="Alias"
                value={draft}
                maxLength={64}
                autoFocus
                placeholder="Call this something else"
                onChange={e => setDraft(e.target.value)}
              />
              <button type="button" className="btn btn-primary kp-btn" disabled={busy}
                onClick={() => void run(async () => { await actions.setAlias(place.id, draft.trim()); setEditing(false); })}>Save</button>
              <button type="button" className="btn btn-ghost kp-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          ) : (
            <div className="kp-alias">
              <span>{place.alias ? <>Alias: <strong>{place.alias}</strong></> : 'No alias'}</span>
              <button type="button" className="btn btn-ghost kp-btn" onClick={() => { setDraft(place.alias ?? ''); setEditing(true); }}>
                {place.alias ? 'Edit alias' : 'Add alias'}
              </button>
            </div>
          )}

          {confirm ? (
            <div className="kp-confirm" role="group" aria-label="Confirm">
              <p>{confirm === 'forget'
                ? 'Removes this from your phone. The site still has your account; sign out there too.'
                : confirm === 'forget-here' ? FORGET_HANDOFF_HERE_COPY
                : 'This app will have to pair again.'}</p>
              <button type="button" className="btn btn-danger kp-btn" disabled={busy}
                onClick={() => void run(async () => {
                  await (confirm === 'forget' ? actions.forget(place)
                    : confirm === 'forget-here' ? actions.forgetHandoffHere?.(place)
                    : actions.disconnect(place));
                  setConfirm(null);
                }, { disconnecting: confirm === 'disconnect' })}>
                {confirm === 'forget' ? 'Forget' : confirm === 'forget-here' ? 'Forget on this phone' : 'Disconnect'}
              </button>
              <button type="button" className="btn btn-ghost kp-btn" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <div className="kp-actions">
              <button type="button" className="btn btn-secondary kp-btn" disabled={busy}
                onClick={() => void run(() => actions.pin(place.id, !place.pinned))}>{place.pinned ? 'Unpin' : 'Pin'}</button>
              {canAuto && (
                <button type="button" className="btn btn-secondary kp-btn" disabled={busy}
                  onClick={() => void run(() => actions.setAuto(place, isAuto || grant?.denyAlways ? 'ask' : 'always'))}>
                  {grant?.denyAlways ? 'Ask each time' : isAuto ? 'Stop signing automatically' : 'Sign automatically'}
                </button>
              )}
              {openable && (
                <button type="button" className="btn btn-secondary kp-btn" disabled={busy}
                  onClick={() => void run(() => actions.open(place))}>Open</button>
              )}
              {place.kind === 'sign-in' && (
                <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm('forget')}>Forget</button>
              )}
              {canDisconnect && (
                <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm('disconnect')}>Disconnect</button>
              )}
              {canForgetHere && (
                <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm('forget-here')}>Forget on this phone</button>
              )}
            </div>
          )}
          {otherLine && !confirm && <p className="kp-note">{otherLine}</p>}
          {error && <p className="kp-error" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}

interface HeartwoodRowProps {
  fingerprint: string;
  label: string;
  boundIdentity: string;
  policySummary: string;
  expanded: boolean;
  onToggle: () => void;
  onRevoke: (fingerprint: string) => void | Promise<void>;
  /** False when the device is known not to support revoking; the action is then not offered. */
  canRevoke?: boolean;
}

/** An app paired straight to the Heartwood: read from the device, never stored. */
export function HeartwoodRow({ fingerprint, label, boundIdentity, policySummary, expanded, onToggle, onRevoke, canRevoke = true }: HeartwoodRowProps) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <li className={`kp-row${expanded ? ' kp-row--open' : ''}`} data-kp-row={`hw:${fingerprint}`}>
      <button type="button" className="kp-row-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="kp-row-tile kp-row-tile--hw" aria-hidden="true">{label.charAt(0).toUpperCase() || 'H'}</span>
        <span className="kp-row-text">
          <span className="kp-row-name">{label}</span>
          <span className="kp-row-summary">{boundIdentity} · {policySummary}</span>
        </span>
        <span className="kp-row-badge" title="Approved on Heartwood"><KnownPlaceBadgeGlyph badge={{ kind: 'heartwood', label: 'Approved on Heartwood' }} /></span>
      </button>
      {expanded && (
        <div className="kp-panel">
          <dl className="kp-facts">
            <div><dt>How</dt><dd>Paired straight to your Heartwood</dd></div>
            <div><dt>Identity</dt><dd>{boundIdentity}</dd></div>
            <div><dt>Rules</dt><dd>{policySummary}</dd></div>
          </dl>
          {!canRevoke ? null : confirm ? (
            <div className="kp-confirm" role="group" aria-label="Confirm">
              <p>Removes this app from the device.</p>
              <button type="button" className="btn btn-danger kp-btn" disabled={busy}
                onClick={async () => {
                  setBusy(true); setError('');
                  try { await onRevoke(fingerprint); setConfirm(false); } catch (e) { setError(heartwoodMgmtErrorCopy(e)); } finally { setBusy(false); }
                }}>Revoke</button>
              <button type="button" className="btn btn-ghost kp-btn" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          ) : (
            <div className="kp-actions">
              <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm(true)}>Revoke on Heartwood</button>
            </div>
          )}
          {error && <p className="kp-error" role="alert">{error}</p>}
        </div>
      )}
    </li>
  );
}
