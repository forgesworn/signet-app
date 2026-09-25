/**
 * Approval screen for a contacts v2 grant.
 *
 * Three decisions are collected: which directory (the app may only ask for
 * "owner" or "a dependant" — it never names one), which capabilities, and how
 * stale a projection may get before the app must treat it as out of date.
 *
 * R-12: the request is the CEILING, not the default. Only `read:directory` is
 * pre-ticked; everything else is an explicit opt-in. Defaulting to whatever
 * the app asked for makes the ceiling the floor and turns the screen into a
 * confirmation dialog — and for `blocks.read` and contact-method permissions that is a
 * large thing to hand over by pressing the obvious button.
 *
 * The honesty line is not decoration. Revocation stops future projections and
 * cannot recall what the app already holds (exploration §5.6, spec §7.9), and
 * the person deciding has to know that before they decide, not after.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_STALENESS_SECONDS } from '@forgesworn/signet-contacts/wire';
import type { Capability, PairingRequestV2 } from '@forgesworn/signet-contacts/wire';
import { STALENESS_CHOICES } from '../types';
import {
  CONTACTS_GRANT_CAPABILITY_COPY, CONTACTS_GRANT_FRESHNESS_LABEL, CONTACTS_GRANT_HONESTY,
} from '../lib/contacts-v2-copy';
// M8: ONE definition of the picker option, beside the function that builds it.
import type { GrantDirectoryOption } from '../lib/contacts-grant-directories';


export interface GrantChoice {
  directoryId: string;
  ownerIdentityPubkey?: string;
  capabilities: Capability[];
  maxStalenessSeconds: number;
}

interface Props {
  request: PairingRequestV2;
  /** Owner directory first, then each managed dependant. */
  directories: GrantDirectoryOption[];
  onApprove: (choice: GrantChoice) => Promise<void>;
  onDeny: () => void;
}

const STALENESS_LABELS: Record<number, string> = {
  3600: 'Within the hour',
  21600: 'Within six hours',
  86400: 'Within a day',
  604800: 'Within a week',
};

/** R-12: the one capability a directory grant is meaningless without. */
const optionKey = (d: GrantDirectoryOption) => `${d.directoryId}/${d.ownerIdentityPubkey ?? ''}`;

const PRE_TICKED: Capability = 'signet.contacts.read:directory';

export function ContactsGrantApprove({ request, directories, onApprove, onDeny }: Props) {
  const dependants = useMemo(() => directories.filter((d) => d.directoryId !== 'owner'), [directories]);
  const owner = directories.find((d) => d.directoryId === 'owner');

  const defaultDirectory = request.directory === 'dependant' && dependants[0]
    ? optionKey(dependants[0])
    : owner ? optionKey(owner) : directories[0] ? optionKey(directories[0]) : '';

  const [directoryId, setDirectoryId] = useState(defaultDirectory);
  /**
   * B/I2: the default follows `directories` until the user touches the radio.
   *
   * `useState` captures the FIRST render's value, and on a mount-carrier entry
   * that render can happen before the dependant roster has resolved — so an
   * app that asked for a child's contacts settled on the OWNER's directory,
   * the larger disclosure of the two, and stayed there silently when the list
   * grew a moment later. R-33 holds both carriers until the roster loads, so
   * this is belt and braces; it also covers a roster that arrives late for any
   * other reason. Once the user has chosen, their choice stands.
   */
  const touchedRef = useRef(false);
  useEffect(() => {
    if (touchedRef.current) return;
    setDirectoryId(defaultDirectory);
  }, [defaultDirectory]);

  const chooseDirectory = (id: string) => { touchedRef.current = true; setDirectoryId(id); };
  const [capabilities, setCapabilities] = useState<Capability[]>(
    () => request.capabilities.filter((c) => c === PRE_TICKED),
  );
  const [maxStalenessSeconds, setMaxStalenessSeconds] = useState(DEFAULT_STALENESS_SECONDS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantsDependantWithNone = request.directory === 'dependant' && dependants.length === 0;

  function toggle(cap: Capability, checked: boolean) {
    // Functional update: two quick taps on different boxes both have to land,
    // and reading `capabilities` from the render closure loses the first.
    // Order follows the REQUEST, so the approved list matches what was shown.
    setCapabilities((current) => (checked
      ? request.capabilities.filter((c) => c === cap || current.includes(c))
      : current.filter((c) => c !== cap)));
  }

  const availableCapability = (cap: Capability) => !cap.startsWith('signet.contacts.invites:') || directories.find(d => optionKey(d) === directoryId)?.directoryId === 'owner';

  async function approve() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const picked = directories.find(d => optionKey(d) === directoryId);
      if (!picked) throw new Error('Choose an available identity list.');
      await onApprove({ directoryId: picked.directoryId, ...(picked.ownerIdentityPubkey ? { ownerIdentityPubkey: picked.ownerIdentityPubkey } : {}), capabilities: capabilities.filter(availableCapability), maxStalenessSeconds });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect — please try again');
      setBusy(false);
      return;
    }
    setBusy(false);
  }

  return (
    <div className="fade-in" role="main">
      <div className="section">
        <h2 style={{ marginBottom: 8 }}>Connect an app to your contacts</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 20 }}>
          <strong>{request.appName}</strong> is asking to use your contacts. Tick what it may do.
        </p>

        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
          <legend style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>What it may do</legend>
          {request.capabilities.some(cap => cap.startsWith('signet.contacts.invites:')) && !directoryId.startsWith('owner/') && <p>App invitations are currently available for your own identities only.</p>}
          {request.capabilities.map((cap) => (
            <label
              key={cap}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '0.9rem', marginBottom: 10, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                aria-label={CONTACTS_GRANT_CAPABILITY_COPY[cap]}
                checked={capabilities.includes(cap) && availableCapability(cap)}
                onChange={(e) => toggle(cap, e.target.checked)}
                disabled={busy || !availableCapability(cap)}
                style={{ marginTop: 3 }}
              />
              <span>{CONTACTS_GRANT_CAPABILITY_COPY[cap]}</span>
            </label>
          ))}
        </fieldset>

        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
          <legend style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>Whose contacts</legend>
          {wantsDependantWithNone && (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
              This app asked for a dependant&apos;s contacts, but you have no dependants set up. You can
              still connect it to your own.
            </p>
          )}
          {directories.map((d) => (
            <label
              key={optionKey(d)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem', marginBottom: 10, cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="contacts-grant-directory"
                aria-label={d.label}
                checked={directoryId === optionKey(d)}
                onChange={() => chooseDirectory(optionKey(d))}
                disabled={busy}
              />
              <span>{d.label}</span>
            </label>
          ))}
        </fieldset>

        <label style={{ display: 'block', fontWeight: 600, marginBottom: 8, fontSize: '0.9rem' }}>
          {CONTACTS_GRANT_FRESHNESS_LABEL}
          <select
            value={String(maxStalenessSeconds)}
            onChange={(e) => setMaxStalenessSeconds(Number(e.target.value))}
            disabled={busy}
            style={{ display: 'block', marginTop: 6, width: '100%' }}
          >
            {STALENESS_CHOICES.map((seconds) => (
              <option key={seconds} value={String(seconds)}>{STALENESS_LABELS[seconds] ?? `${seconds}s`}</option>
            ))}
          </select>
        </label>

        <div className="card" style={{ marginTop: 20, marginBottom: 20 }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            {CONTACTS_GRANT_HONESTY}
          </p>
        </div>

        {error && (
          <div
            className="card"
            style={{ background: 'var(--danger-light)', borderColor: 'var(--danger)', marginBottom: 16 }}
          >
            <p style={{ fontSize: '0.85rem', color: 'var(--danger)', marginBottom: 0 }}>{error}</p>
          </div>
        )}

        <button className="btn btn-primary" onClick={approve} disabled={busy || !capabilities.some(availableCapability)}>
          {busy ? 'Connecting…' : 'Approve'}
        </button>
        <button className="btn btn-ghost" onClick={onDeny} disabled={busy} style={{ marginTop: 8 }}>
          Deny
        </button>
      </div>
    </div>
  );
}
