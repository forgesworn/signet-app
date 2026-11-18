import { useEffect, useRef, useState } from 'react';
import { pinKenFromNip05 } from '@forgesworn/kenspeckle/ken';
import type { AddContactValue, AddMethodValue, ContactTier, ContactType } from '../types';
import {
  CONTACT_SAVE_FAILED_COPY, CONTACT_TYPE_LABELS, EMAIL_OPTIONAL_LABEL, KEYLESS_EXPLAINER,
  NAME_FIELD_LABEL, NIP05_CLEAR_LABEL, NIP05_FIELD_HINT, NIP05_FIELD_LABEL, NIP05_FOUND_LABEL,
  NEW_CONTACT_OWN_KEY_COPY, NIP05_LOOKING_UP_LABEL, NIP05_LOOKUP_LABEL, NIP05_PROFILE_NAME_LABEL, OPEN_CONTACT_LABEL,
  SAVE_CONTACT_LABEL, SAVING_LABEL, PHONE_OPTIONAL_LABEL,
  TIER_PICKER_SECTION_TITLE, TYPE_SECTION_TITLE, addingToContactsCopy, newContactKeyHeldCopy, tierChipLabel,
} from '../lib/contacts-v2-copy';
import { EMPTY_NEW_CONTACT_DRAFT, planNewContact, type NewContactDraft } from '../lib/contacts-v2-new-contact';
import { canonicalNip05 } from '../lib/nip05-check';
import {
  humaniseKenAddError, nameFromNip05, readProfileNamePref, validateNip05Shape, writeProfileNamePref,
} from '../lib/nip05-lookup';
import { fetchKind0Profiles, shortNpub } from '../lib/nostr-follows';
import { ConfirmMergeRefusedError } from '../lib/contacts-v2-key-holders';
import type { ExistingContact } from '../lib/contacts-v2-new-contact-save';
import { sanitizeDisplayName } from '../lib/text-sanitize';

/** What a successful NIP-05 lookup adds to a new contact. */
export interface NewContactKey {
  /** The 64-hex public key the address resolved to. */
  pubkey: string;
  /** The address in its canonical form (`_@domain` for a bare domain). */
  nip05: string;
}

interface Props {
  /** Whose address book this is when acting as a dependant; null for the owner. */
  subjectName: string | null;
  onCreate: (contact: AddContactValue, methods: Omit<AddMethodValue, 'itemId'>[], key?: NewContactKey) => Promise<void>;
  onDone: () => void;
  /** The key of the identity this contact is being added for (a lookup that resolves to it is refused). */
  ownerPubkeyHex?: string;
  /** Every key the user owns (persona, extras, Pro, the real identity if active): a lookup resolving to one is refused. */
  ownKeys?: readonly string[];
  /**
   * Relays for the profile-name lookup: the app's read relays; the fixed public
   * profile-lookup relays are added by `fetchKind0Profiles`. Never relays named
   * by the domain's nostr.json.
   */
  profileRelays?: readonly string[];
  /** The contact in this directory that holds `pubkey` now (a deleted or archived one counts), if any. */
  findExistingContact?: (pubkey: string) => ExistingContact | null;
  onOpenContact?: (contactId: string) => void;
}

// kenspeckle's resolver insists on a well-formed owner key; with none to hand
// it only loses the "that's your own key" check.
const NO_OWNER_KEY = '0'.repeat(63) + '1';

const TIERS: ContactTier[] = ['kin', 'kith', 'ken'];

export function ContactNew({ subjectName, onCreate, onDone, ownerPubkeyHex, ownKeys, profileRelays, findExistingContact, onOpenContact }: Props) {
  const [draft, setDraft] = useState<NewContactDraft>(EMPTY_NEW_CONTACT_DRAFT);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [address, setAddress] = useState('');
  const [found, setFound] = useState<NewContactKey | null>(null);
  // The save itself found the key already belongs to a contact (the write refused it).
  const [refused, setRefused] = useState<ExistingContact | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [useProfileName, setUseProfileName] = useState(readProfileNamePref);
  // Read when a result lands, so ticking or unticking mid-lookup is honoured.
  const useProfileNameRef = useRef(useProfileName);
  useProfileNameRef.current = useProfileName;
  // The name last put in the Name field by a lookup: only a Name that is still
  // empty or still that value is replaced, so typed text is never overwritten.
  const autoName = useRef('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Bumped whenever the address changes, the key is cleared or the page is
  // left, so a lookup in flight is ignored and starts no relay query.
  const lookupSeq = useRef(0);
  useEffect(() => () => { lookupSeq.current += 1; }, []);

  function set<K extends keyof NewContactDraft>(key: K, value: NewContactDraft[K]) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  function applyAutoName(name: string) {
    if (!name) return;
    const current = draftRef.current.displayName;
    if (current === '' || current === autoName.current) {
      autoName.current = name;
      draftRef.current = { ...draftRef.current, displayName: name };
      setDraft(d => ({ ...d, displayName: name }));
    }
  }

  function dropKey() {
    lookupSeq.current += 1;
    setFound(null);
    setRefused(null);
    setLookupBusy(false);
  }

  function changeAddress(value: string) {
    setAddress(value);
    setLookupError('');
    dropKey();
  }

  function changeUseProfileName(on: boolean) {
    setUseProfileName(on);
    writeProfileNamePref(on);
  }

  /**
   * Resolve the address with the same resolver the Ken form uses, then (if
   * ticked) the name from their profile. `null` means no key: the reason is on
   * screen, or the lookup was cancelled.
   */
  async function runLookup(): Promise<{ key: NewContactKey; held: boolean } | null> {
    const shapeError = validateNip05Shape(address);
    if (shapeError) { setLookupError(shapeError); return null; }
    const canonical = canonicalNip05(address)!;
    const seq = ++lookupSeq.current;
    const current = () => seq === lookupSeq.current;
    setLookupError('');
    setFound(null);
    setRefused(null);
    setLookupBusy(true);
    try {
      const entry = await pinKenFromNip05(canonical, ownerPubkeyHex || NO_OWNER_KEY, globalThis.fetch);
      if (!current()) return null;
      const pubkey = entry.pubkey.toLowerCase();
      if (ownKeys?.some(k => k.toLowerCase() === pubkey)) {
        setLookupError(NEW_CONTACT_OWN_KEY_COPY);
        return null;
      }
      const key = { pubkey, nip05: canonical };
      setFound(key);
      // A key that is already a contact is shown as that contact, not filled in again.
      if (findExistingContact?.(pubkey)) return { key, held: true };
      applyAutoName(nameFromNip05(canonical));
      if (useProfileNameRef.current) {
        const profileName = await profileNameFor(pubkey, profileRelays ?? []);
        if (current() && useProfileNameRef.current && profileName) applyAutoName(profileName);
      }
      return current() ? { key, held: false } : null;
    } catch (e) {
      if (current()) setLookupError(humaniseKenAddError(e, NEW_CONTACT_OWN_KEY_COPY));
      return null;
    } finally {
      if (current()) setLookupBusy(false);
    }
  }

  const existing = (found && findExistingContact ? findExistingContact(found.pubkey) : null) ?? refused;

  async function submit() {
    if (busy || lookupBusy) return;
    setError('');
    setBusy(true);
    try {
      let key = found;
      // An address with no key yet: look it up first. If that fails, nothing is
      // saved (clear the field to save without it), so an address is only ever
      // stored together with the key it resolved to.
      if (address.trim() && !key) {
        const result = await runLookup();
        if (!result || result.held) return;
        key = result.key;
      }
      const plan = planNewContact(draftRef.current, key?.nip05);
      if (!plan.ok) { setError(plan.error); return; }
      try {
        await onCreate(plan.contact, plan.methods, key ?? undefined);
        onDone();
      } catch (e) {
        if (e instanceof ConfirmMergeRefusedError && e.refusal.state !== 'removed-key') {
          setRefused({ contactId: e.refusal.contactId, displayName: e.refusal.displayName, state: e.refusal.state });
        } else {
          // I4: never the raw `Error.message` — `onCreate` throws whatever
          // `useContactsV2`'s mutator throws, a dev-diagnostic string, not
          // something to put in front of a user.
          setError(CONTACT_SAVE_FAILED_COPY);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in" role="main">
      <div className="card section">
        {subjectName && <p className="field-hint">{addingToContactsCopy(subjectName)}</p>}
        <label className="field-label" htmlFor="new-contact-nip05">{NIP05_FIELD_LABEL}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input id="new-contact-nip05" className="input input-sm" maxLength={200} autoCapitalize="none"
            inputMode="email" value={address} onChange={e => changeAddress(e.target.value)} />
          <button className="btn btn-secondary" disabled={!address.trim() || lookupBusy || busy}
            onClick={() => void runLookup()}>
            {lookupBusy ? NIP05_LOOKING_UP_LABEL : NIP05_LOOKUP_LABEL}
          </button>
        </div>
        <p className="field-hint">{NIP05_FIELD_HINT}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={useProfileName}
            onChange={e => changeUseProfileName(e.target.checked)} />
          {NIP05_PROFILE_NAME_LABEL}
        </label>
        {lookupError && <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{lookupError}</p>}
        {found && !existing && (
          <p role="status" className="field-hint">
            {NIP05_FOUND_LABEL}: {shortNpub(found.pubkey)}{' '}
            <button className="btn btn-ghost" onClick={dropKey}>{NIP05_CLEAR_LABEL}</button>
          </p>
        )}
        {existing && (
          <p role="status" className="field-hint">
            {newContactKeyHeldCopy(existing.displayName, existing.state)}{' '}
            {existing.state === 'active' && onOpenContact && (
              <button className="btn btn-secondary" onClick={() => onOpenContact(existing.contactId)}>
                {OPEN_CONTACT_LABEL}
              </button>
            )}{' '}
            <button className="btn btn-ghost" onClick={dropKey}>{NIP05_CLEAR_LABEL}</button>
          </p>
        )}

        <label className="field-label" htmlFor="new-contact-name">{NAME_FIELD_LABEL}</label>
        <input id="new-contact-name" className="input input-sm" maxLength={100}
          value={draft.displayName} onChange={e => set('displayName', e.target.value)} />

        <div className="section-title" style={{ marginTop: 16 }}>{TYPE_SECTION_TITLE}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['person', 'organisation'] as ContactType[]).map(t => (
            <button key={t} className={`btn ${draft.type === t ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => set('type', t)}>
              {CONTACT_TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 16 }}>{TIER_PICKER_SECTION_TITLE}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {TIERS.map(t => (
            <button key={t} className={`btn ${draft.tier === t ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => set('tier', t)}>
              {tierChipLabel(t)}
            </button>
          ))}
        </div>

        <label className="field-label" style={{ marginTop: 16 }} htmlFor="new-contact-phone">{PHONE_OPTIONAL_LABEL}</label>
        <input id="new-contact-phone" className="input input-sm" maxLength={200}
          value={draft.phone} onChange={e => set('phone', e.target.value)} />

        <label className="field-label" htmlFor="new-contact-email">{EMAIL_OPTIONAL_LABEL}</label>
        <input id="new-contact-email" className="input input-sm" maxLength={200}
          value={draft.email} onChange={e => set('email', e.target.value)} />

        {error && <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

        {!existing && !found && <p className="field-hint" style={{ marginTop: 12 }}>{KEYLESS_EXPLAINER}</p>}
        {!existing && (
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy || lookupBusy}
            onClick={() => void submit()}>
            {busy ? SAVING_LABEL : SAVE_CONTACT_LABEL}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Their name from the public kind-0 profile, read through the user's own
 * profile-lookup relays. Only the name is taken: the profile's picture,
 * banner and about are ignored and nothing contact-controlled is downloaded.
 * Any miss, timeout or error is just "no name".
 */
async function profileNameFor(pubkey: string, relays: readonly string[]): Promise<string> {
  if (relays.length === 0) return '';
  try {
    const profiles = await fetchKind0Profiles([pubkey], [...relays]);
    if (profiles === 'unreachable') return '';
    return sanitizeDisplayName(profiles.get(pubkey)?.displayName ?? '', 100);
  } catch {
    return '';
  }
}
