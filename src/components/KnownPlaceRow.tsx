import { useState, type ReactNode } from 'react';
import type { KnownPlace, KnownPlaceChannel } from '../types/known-places';
import type { Badge } from '../lib/known-place-badges';
import { placeLabel, placeTint, relativeTime, hostnameOf } from '../lib/known-place-label';
import { KnownPlaceBadgeGlyph } from './KnownPlaceBadgeGlyph';

export type KnownPlaceIdentityType = 'persona' | 'natural-person' | 'extra' | 'dependant' | 'bot';

export interface KnownPlaceCtx {
  /** nip46: the paired client asks before each signature. */
  askToSign?: boolean;
  /** nip55: the grant for this caller and this identity, if any. */
  nip55Grant?: { allowAlways: boolean; denyAlways: boolean } | null;
  /** nip46: unix seconds the paired client was last seen. */
  lastSeenAt?: number;
}

export interface KnownPlaceActions {
  pin(id: string, pinned: boolean): void | Promise<void>;
  setAlias(id: string, alias: string): void | Promise<void>;
  setAuto(place: KnownPlace, value: 'always' | 'ask'): void | Promise<void>;
  open(place: KnownPlace): void | Promise<void>;
  forget(place: KnownPlace): void | Promise<void>;
  disconnect(place: KnownPlace): void | Promise<void>;
  revokeOnHeartwood(fingerprint: string): void | Promise<void>;
}

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

export function canOpenPlace(place: KnownPlace): boolean {
  return (place.channel === 'phone-app' && !!place.nativePackage) || (place.channel === 'browser' && !!place.origin);
}

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
  const [confirm, setConfirm] = useState<'forget' | 'disconnect' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const label = placeLabel(place);
  const primary = badges[0] ?? null;
  const grant = place.kind === 'nip55' ? ctx.nip55Grant ?? null : null;
  const isAuto = place.kind === 'nip46' ? !ctx.askToSign : !!grant?.allowAlways;
  const canAuto = place.kind === 'nip46' || place.kind === 'nip55';
  const channelSentence = CHANNEL_SENTENCE[place.channel];

  const run = async (fn: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch { setError('That did not work. Try again.'); } finally { setBusy(false); }
  };

  const approvedOn = place.signer === 'local' ? 'this phone'
    : place.signer === 'heartwood' ? 'your Heartwood'
    : place.signer === 'remote-signer' ? 'a remote signer'
    : place.signer === 'extension' ? 'a browser extension' : '';

  let otherLine: ReactNode = null;
  if (!canOpenPlace(place)) {
    if (place.channel === 'other-device') otherLine = 'Signed in on another device';
    else if (place.kind === 'nip46' || place.kind === 'nip55') otherLine = 'Paired app';
  }

  return (
    <li className={`kp-row${expanded ? ' kp-row--open' : ''}`} data-kp-row={place.id}>
      <button type="button" className="kp-row-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="kp-row-tile" aria-hidden="true" style={{ background: placeTint(place) }}>{label.charAt(0).toUpperCase()}</span>
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
                {place.name && place.name !== label ? `${place.name} · ` : ''}
                {place.origin ? hostnameOf(place.origin) : ''}
                {place.nativePackage ? `${place.origin ? ' · ' : ''}Android app ${place.nativePackage}` : ''}
                {!place.origin && !place.nativePackage && !place.name ? label : ''}
              </dd>
            </div>
            {channelSentence && <div><dt>How</dt><dd>{channelSentence}</dd></div>}
            {approvedOn && <div><dt>Approved on</dt><dd>{approvedOn}</dd></div>}
            {(place.shared.handle || place.shared.picture) && (
              <div><dt>Shared</dt><dd>{[place.shared.handle && 'Your handle', place.shared.picture && 'Your picture'].filter(Boolean).join(' and ')}</dd></div>
            )}
            {place.kind === 'nip46' && ctx.askToSign && <div><dt>Signing</dt><dd>{ASK_EACH_TIME_SUMMARY}</dd></div>}
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
                : 'This app will have to pair again.'}</p>
              <button type="button" className="btn btn-danger kp-btn" disabled={busy}
                onClick={() => void run(async () => { await (confirm === 'forget' ? actions.forget(place) : actions.disconnect(place)); setConfirm(null); })}>
                {confirm === 'forget' ? 'Forget' : 'Disconnect'}
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
              {canOpenPlace(place) && (
                <button type="button" className="btn btn-secondary kp-btn" disabled={busy}
                  onClick={() => void run(() => actions.open(place))}>Open</button>
              )}
              {place.kind === 'sign-in' && (
                <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm('forget')}>Forget</button>
              )}
              {canAuto && (
                <button type="button" className="btn btn-ghost kp-btn kp-btn--danger" onClick={() => setConfirm('disconnect')}>Disconnect</button>
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
}

/** An app paired straight to the Heartwood: read from the device, never stored. */
export function HeartwoodRow({ fingerprint, label, boundIdentity, policySummary, expanded, onToggle, onRevoke }: HeartwoodRowProps) {
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
          {confirm ? (
            <div className="kp-confirm" role="group" aria-label="Confirm">
              <p>Removes this app from the device.</p>
              <button type="button" className="btn btn-danger kp-btn" disabled={busy}
                onClick={async () => {
                  setBusy(true); setError('');
                  try { await onRevoke(fingerprint); setConfirm(false); } catch { setError('That did not work. Try again.'); } finally { setBusy(false); }
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
