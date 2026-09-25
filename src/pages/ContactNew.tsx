import { useState } from 'react';
import type { AddContactValue, AddMethodValue, ContactTier, ContactType } from '../types';
import {
  CONTACT_SAVE_FAILED_COPY, CONTACT_TYPE_LABELS, EMAIL_OPTIONAL_LABEL, KEYLESS_EXPLAINER,
  NAME_FIELD_LABEL, SAVE_CONTACT_LABEL, SAVING_LABEL, PHONE_OPTIONAL_LABEL,
  TIER_PICKER_SECTION_TITLE, TYPE_SECTION_TITLE, addingToContactsCopy, tierChipLabel,
} from '../lib/contacts-v2-copy';
import { EMPTY_NEW_CONTACT_DRAFT, planNewContact, type NewContactDraft } from '../lib/contacts-v2-new-contact';

interface Props {
  /** Whose address book this is when acting as a dependant; null for the owner. */
  subjectName: string | null;
  onCreate: (contact: AddContactValue, methods: Omit<AddMethodValue, 'itemId'>[]) => Promise<void>;
  onDone: () => void;
}

const TIERS: ContactTier[] = ['kin', 'kith', 'ken'];

export function ContactNew({ subjectName, onCreate, onDone }: Props) {
  const [draft, setDraft] = useState<NewContactDraft>(EMPTY_NEW_CONTACT_DRAFT);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set<K extends keyof NewContactDraft>(key: K, value: NewContactDraft[K]) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  async function submit() {
    const plan = planNewContact(draft);
    if (!plan.ok) { setError(plan.error); return; }
    setError('');
    setBusy(true);
    try {
      await onCreate(plan.contact, plan.methods);
      onDone();
    } catch {
      // I4: never the raw `Error.message` — `onCreate` throws whatever
      // `useContactsV2`'s mutator throws, a dev-diagnostic string, not
      // something to put in front of a user.
      setError(CONTACT_SAVE_FAILED_COPY);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-in" role="main">
      <div className="card section">
        {subjectName && <p className="field-hint">{addingToContactsCopy(subjectName)}</p>}
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

        <p className="field-hint" style={{ marginTop: 12 }}>{KEYLESS_EXPLAINER}</p>
        <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy}
          onClick={() => void submit()}>
          {busy ? SAVING_LABEL : SAVE_CONTACT_LABEL}
        </button>
      </div>
    </div>
  );
}
