import { uncheckedAppConnection } from '../lib/contact-app-notice';
import { ContactOrigins } from '../components/ContactOrigins';
import type { ContactOrigin } from '../lib/contact-origins';
import { ContactChecks } from '../components/ContactChecks';
import type { ContactCheck } from '../lib/contact-checks';
import type { ContactIdentityList } from '../lib/contacts-v2-identity-lists';
import { contactBelongsToList } from '../lib/contacts-v2-membership';
import { useEffect, useState } from 'react';
import type { Contact, ContactMethodKind, ContactTier, EffectiveContact, SignetIdentity, AddMethodValue } from '../types';
import { ContactTierChip } from '../components/ContactTierChip';
import { ContactShare } from '../components/ContactShare';
import { SignetWords } from '../components/SignetWords';
import { getActivePubkey, shortNpub } from '../lib/signet';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import {
  ADD_A_ROLE_LABEL, ADD_LABEL, ADD_METHOD_LABEL, BLOCK_BOUNDARY_COPY, BLOCK_LABEL,
  BLOCK_REASON_FIELD_LABEL, BLOCK_SECTION_TITLE, CANCEL_LABEL, CONTACT_ACTION_FAILED_COPY,
  CONTACT_TYPE_LABELS, IDENTITIES_SECTION_TITLE, IDENTITY_PROVENANCE_LABELS,
  IDENTITY_VERIFICATION_LABELS, KEY_CONTROL_LABEL, KEYLESS_EXPLAINER, KEYLESS_MARKER,
  METHODS_SECTION_TITLE, METHOD_KIND_FIELD_LABEL, METHOD_LABEL_FIELD_LABEL,
  METHOD_PRIVACY_HINT, METHOD_VALUE_FIELD_LABEL, NAME_FIELD_LABEL, NOTE_SECTION_TITLE,
  NO_ROLES_YET, REMOVE_CONTACT_LABEL, REMOVE_LABEL, ROLES_SECTION_TITLE, ROLE_HINT,
  SAVE_LABEL, SAVE_NOTE_LABEL, TIER_HINT, TIER_SECTION_TITLE, UNBLOCK_LABEL,
  blockConfirmLabel, blockedLine, effectiveTierLine, removeContactConfirmCopy,
  removeRoleAriaLabel, tierChipLabel,
} from '../lib/contacts-v2-copy';
import type { ActorRights } from '../lib/contacts-v2-rights';
import {
  BLOCK_REASON_MAX, METHOD_KINDS, METHOD_KIND_LABELS, METHOD_LABEL_MAX, METHOD_VALUE_MAX,
  NOTE_MAX, ROLE_MAX, addRole, normaliseBlockReason, normaliseNote, removeRole,
  validateMethodDraft, type DetailSection, type LegacyMatch,
} from '../lib/contacts-v2-detail';

interface Props {
  onRecordOrigin?: (origin: Omit<ContactOrigin, 'ownerIdentityPubkey'>) => Promise<void>;
  onRemoveOrigin?: (id: string) => Promise<void>;
  checkOwnerIdentityPubkey?: string;
  onUpdateCheck?: (check: Omit<ContactCheck, 'ownerIdentityPubkey'>) => Promise<void>;
  onRecordCheck?: (check: Omit<ContactCheck, 'id' | 'ownerIdentityPubkey'>) => Promise<void>;
  onRemoveCheck?: (id: string) => Promise<void>;
  lists?: ContactIdentityList[];
  onReviewAppList?: (grantId: string, accept: boolean) => Promise<void>;
  onLinkList?: (key: string) => Promise<void>;
  onUnlinkList?: (key: string) => Promise<void>;
  contact: EffectiveContact;
  identity: SignetIdentity;
  rights: ActorRights;
  sections: DetailSection[];
  legacy: LegacyMatch;
  /** The matching legacy `contacts` row, when one exists — drives the verification words. */
  legacyContact?: Contact;
  actorPubkey: string;
  guardianName: string | null;
  wordCount?: number;
  onRename: (displayName: string) => Promise<void>;
  onSetTier: (tier: ContactTier) => Promise<void>;
  onAddRole: (roles: string[]) => Promise<void>;
  onRemoveRole: (roles: string[]) => Promise<void>;
  onAddMethod: (value: Omit<AddMethodValue, 'itemId'>) => Promise<void>;
  onMethodSharingChange?: (itemId: string, grantable: boolean) => Promise<void>;
  onRemoveItem: (itemId: string) => Promise<void>;
  onSetNote: (note: string) => Promise<void>;
  onBlock: (reason?: string) => Promise<void>;
  onUnblock: () => Promise<void>;
  onRemove: () => Promise<void>;
  onOpenKenDetail: (pubkey: string) => void;
}

const TIERS: ContactTier[] = ['kin', 'kith', 'ken'];

/**
 * Which card a mutation failure belongs to — `run()` stamps every rejection
 * with one of these so the error renders next to the action that failed,
 * mirroring the older `methodError` local-validation pattern rather than a
 * single page-wide banner. Covers all nine `useContactsV2` mutators: `roles`
 * is shared by add-role and remove-role (both compile to `setRoles`),
 * `identities`/`methods` are shared by their own add/remove pairs, and
 * `block` is shared by block and unblock.
 */
type ActionScope = 'rename' | 'identities' | 'methods' | 'roles' | 'tier' | 'note' | 'block' | 'remove';

export function ContactDetail(props: Props) {
  const { contact, rights, sections, legacy, legacyContact, actorPubkey, guardianName } = props;
  const has = (s: DetailSection) => sections.includes(s);

  // M10: the name/note drafts used to seed from `contact` once, on mount,
  // and never again — an external rename (another device, a family-manager
  // vouch/rename) landing while this page was open left the input showing
  // stale text with a live, misleading Save button. `nameTouched`/
  // `noteTouched` track whether THIS instance has typed into the field;
  // the effects below re-seed only while untouched, so a genuine in-progress
  // edit is never clobbered by an incoming prop change.
  const [name, setName] = useState(contact.displayName);
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (!nameTouched) setName(contact.displayName);
  }, [contact.displayName, nameTouched]);

  const [roleDraft, setRoleDraft] = useState('');
  const [methodKind, setMethodKind] = useState<ContactMethodKind>('phone');
  const [methodLabel, setMethodLabel] = useState('');
  const [methodValue, setMethodValue] = useState('');
  const [methodError, setMethodError] = useState('');
  const [note, setNote] = useState(contact.notes ?? '');
  const [noteTouched, setNoteTouched] = useState(false);
  useEffect(() => {
    if (!noteTouched) setNote(contact.notes ?? '');
  }, [contact.notes, noteTouched]);

  const [blockOpen, setBlockOpen] = useState(false);
  const [blockReason, setBlockReason] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ scope: ActionScope; message: string } | null>(null);

  const appConnection = props.checkOwnerIdentityPubkey ? uncheckedAppConnection(contact, props.checkOwnerIdentityPubkey) : null;
  const blocked = blockedLine(contact, actorPubkey, guardianName);

  // A rejected mutator (the hook throws on an invalid op or a not-ready
  // scope) must not become a silent unhandled rejection — under the
  // no-console rule there would be nothing on screen and nothing logged.
  // `scope` decides which card renders the error, alongside the existing
  // per-section `methodError` pattern for client-side validation failures.
  async function run(scope: ActionScope, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      setActionError(null);
    } catch {
      setActionError({ scope, message: CONTACT_ACTION_FAILED_COPY });
    } finally {
      setBusy(false);
    }
  }

  function errorFor(scope: ActionScope) {
    return actionError?.scope === scope
      ? <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{actionError.message}</p>
      : null;
  }

  function submitMethod() {
    const parsed = validateMethodDraft({ kind: methodKind, label: methodLabel, value: methodValue });
    if (!parsed.ok) { setMethodError(parsed.error); return; }
    setMethodError('');
    void run('methods', async () => {
      await props.onAddMethod(parsed.value);
      setMethodLabel('');
      setMethodValue('');
    });
  }

  return (
    <div className="fade-in" role="main">
      {appConnection && <div className="card section" role="status">
        <p>Added via {appConnection.appName}, not checked. Compare your verification words with this person.</p>
        {appConnection.canUndo && rights.canRemove && <button className="btn btn-ghost" disabled={busy}
          onClick={() => void run('remove', props.onRemove)}>Undo app connection</button>}
      </div>}
      {props.lists && rights.canRename && <div className="card section">
        <h2>Identity lists</h2>
        {contact.appIntroductions?.filter(i => i.status === 'pending').map(i => <div key={i.grantId}>
          <p>{i.appName || 'An app'} proposed “{i.displayName}” for {props.lists?.find(l => l.ownerIdentityPubkey === i.ownerIdentityPubkey)?.label ?? 'another identity'}. Link this contact? The app receives its supplied fields and fields you add under that identity.</p>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run('identities', () => props.onReviewAppList!(i.grantId, true))}>Confirm link</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('identities', () => props.onReviewAppList!(i.grantId, false))}>Reject link</button>
        </div>)}
        {!contact.primaryIdentityPubkey && <p>Choose a list for this unassigned contact.</p>}
        <p className="field-hint">Linked lists share this contact’s fields. Removing it from its last list removes the contact, but keeps any block.</p>
        {props.lists.map(list => {
          const linked = contactBelongsToList(contact, list.ownerIdentityPubkey);
          return <div key={list.ownerIdentityPubkey} className="row">
            <span>{list.label}{contact.primaryIdentityPubkey === list.ownerIdentityPubkey ? ' · Primary' : ''}</span>
            <button className="btn btn-ghost btn-sm" disabled={busy || (!linked && contact.identities.length === 0 && !!contact.primaryIdentityPubkey)}
              onClick={() => void run('identities', () => linked
                ? props.onUnlinkList!(list.ownerIdentityPubkey) : props.onLinkList!(list.ownerIdentityPubkey))}>
              {linked ? 'Remove from this list' : 'Add to this list'}
            </button>
          </div>;
        })}
        {actionError?.scope === 'identities' && <p role="alert">{actionError.message}</p>}
      </div>}
      <div className="card section">
        <h1 style={{ marginBottom: 6 }}>{contact.displayName}</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <ContactTierChip
            tier={contact.effectiveTier}
            source={contact.tierSource}
            guardianName={guardianName}
            blocked={contact.blocked}
          />
          <span className="row-sub">{effectiveTierLine(contact, guardianName)}</span>
        </div>
        {blocked && <p className="row-sub" style={{ marginTop: 6 }}>{blocked}</p>}
        {contact.type === 'organisation' && <p className="row-sub" style={{ marginTop: 6 }}>{CONTACT_TYPE_LABELS.organisation}</p>}
        {rights.canRename && (
          <div className="row" style={{ marginTop: 12 }}>
            <input
              className="input input-sm"
              aria-label={NAME_FIELD_LABEL}
              value={name}
              maxLength={100}
              onChange={e => { setName(e.target.value); setNameTouched(true); }}
            />
            <button
              className="btn btn-ghost btn-sm"
              disabled={busy || sanitizeDisplayName(name, 100) === contact.displayName}
              onClick={() => void run('rename', () => props.onRename(sanitizeDisplayName(name, 100)))}
            >
              {SAVE_LABEL}
            </button>
          </div>
        )}
        {errorFor('rename')}
      </div>

      {has('identities') && (
        <div className="card section">
          <div className="section-title">{IDENTITIES_SECTION_TITLE}</div>
          {contact.identities.length === 0 ? (
            <>
              <p className="row-sub">{KEYLESS_MARKER}</p>
              <p className="field-hint">{KEYLESS_EXPLAINER}</p>
            </>
          ) : contact.identities.map(id => (
            <div className="row" key={id.itemId}>
              <span className="row-main">
                <span className="row-label mono">{shortNpub(id.pubkey)}</span>
                <span className="row-sub">
                  {IDENTITY_VERIFICATION_LABELS[id.verification]}
                  {` · ${IDENTITY_PROVENANCE_LABELS[id.provenance]}`}
                </span>
              </span>
              {legacy.hasKenEntry && (
                <button className="btn btn-ghost btn-sm" onClick={() => props.onOpenKenDetail(id.pubkey)}>
                  {KEY_CONTROL_LABEL}
                </button>
              )}
              {rights.canAddIdentity && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('identities', () => props.onRemoveItem(id.itemId))}>
                  {REMOVE_LABEL}
                </button>
              )}
            </div>
          ))}
          {errorFor('identities')}
        </div>
      )}

      {has('methods') && (
        <div className="card section">
          <div className="section-title">{METHODS_SECTION_TITLE}</div>
          {contact.contactMethods.map(m => (
            <div className="row" key={m.itemId}>
              <span className="row-main">
                <span className="row-label">{m.label || METHOD_KIND_LABELS[m.kind]}</span>
                <span className="row-sub">{m.value}</span>
              </span>
              {rights.canEditMethods && props.onMethodSharingChange && <label>
                <input type="checkbox" checked={m.sharingPolicy === 'grantable'} disabled={busy}
                  onChange={e => void run('methods', () => props.onMethodSharingChange!(m.itemId, e.target.checked))} />
                Allow apps with permission to read {m.label || METHOD_KIND_LABELS[m.kind]}
              </label>}
              {rights.canEditMethods && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('methods', () => props.onRemoveItem(m.itemId))}>
                  {REMOVE_LABEL}
                </button>
              )}
            </div>
          ))}
          {rights.canEditMethods && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <label className="field-label" htmlFor="method-kind">{METHOD_KIND_FIELD_LABEL}</label>
              <select
                id="method-kind"
                className="input input-sm"
                value={methodKind}
                onChange={e => setMethodKind(e.target.value as ContactMethodKind)}
              >
                {METHOD_KINDS.map(k => <option key={k} value={k}>{METHOD_KIND_LABELS[k]}</option>)}
              </select>
              <label className="field-label" htmlFor="method-label">{METHOD_LABEL_FIELD_LABEL}</label>
              <input id="method-label" className="input input-sm" maxLength={METHOD_LABEL_MAX}
                value={methodLabel} onChange={e => setMethodLabel(e.target.value)} />
              <label className="field-label" htmlFor="method-value">{METHOD_VALUE_FIELD_LABEL}</label>
              <input id="method-value" className="input input-sm" maxLength={METHOD_VALUE_MAX}
                value={methodValue} onChange={e => setMethodValue(e.target.value)} />
              {methodError && <p role="alert" className="field-hint" style={{ color: 'var(--danger)' }}>{methodError}</p>}
              <button className="btn btn-secondary" disabled={busy} onClick={submitMethod}>{ADD_METHOD_LABEL}</button>
              <p className="field-hint">{METHOD_PRIVACY_HINT}</p>
            </div>
          )}
          {errorFor('methods')}
        </div>
      )}

      {has('roles') && (
        <div className="card section">
          <div className="section-title">{ROLES_SECTION_TITLE}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {contact.roles.map(r => (
              <span key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 12, background: 'var(--bg-secondary)', fontSize: '0.8rem' }}>
                {r}
                {rights.canEditRoles && (
                  <button aria-label={removeRoleAriaLabel(r)} className="btn btn-ghost btn-sm" disabled={busy}
                    onClick={() => void run('roles', () => props.onRemoveRole(removeRole(contact.roles, r)))}>×</button>
                )}
              </span>
            ))}
            {contact.roles.length === 0 && <span className="row-sub">{NO_ROLES_YET}</span>}
          </div>
          {rights.canEditRoles && (
            <div className="row">
              <input className="input input-sm" aria-label={ADD_A_ROLE_LABEL} maxLength={ROLE_MAX}
                value={roleDraft} onChange={e => setRoleDraft(e.target.value)} />
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('roles', async () => {
                await props.onAddRole(addRole(contact.roles, roleDraft));
                setRoleDraft('');
              })}>{ADD_LABEL}</button>
            </div>
          )}
          <p className="field-hint">{ROLE_HINT}</p>
          {errorFor('roles')}
        </div>
      )}

      {has('tier') && (
        <div className="card section">
          <div className="section-title">{TIER_SECTION_TITLE}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {TIERS.map(t => (
              <button key={t} className={`btn ${contact.tier === t ? 'btn-primary' : 'btn-secondary'}`}
                disabled={busy} onClick={() => void run('tier', () => props.onSetTier(t))}>
                {tierChipLabel(t)}
              </button>
            ))}
          </div>
          <p className="field-hint">{TIER_HINT}</p>
          {errorFor('tier')}
        </div>
      )}

      {has('note') && (
        <div className="card section">
          <div className="section-title">{NOTE_SECTION_TITLE}</div>
          {rights.canEditNote ? (
            <>
              <textarea className="input input-sm" aria-label={NOTE_SECTION_TITLE} rows={3} maxLength={NOTE_MAX}
                value={note} onChange={e => { setNote(e.target.value); setNoteTouched(true); }} />
              <button className="btn btn-ghost btn-sm" disabled={busy}
                onClick={() => void run('note', () => props.onSetNote(normaliseNote(note)))}>{SAVE_NOTE_LABEL}</button>
              {errorFor('note')}
            </>
          ) : (
            <p className="row-sub">{contact.notes}</p>
          )}
        </div>
      )}

      {legacy.hasSharedSecret && legacyContact && (
        <SignetWords
          sharedSecret={legacyContact.sharedSecret}
          myPubkey={getActivePubkey(props.identity)}
          theirPubkey={legacyContact.pubkey}
          wordCount={props.wordCount}
        />
      )}

      {contact.sharedContexts?.map((shared, index) => <div className="card section" key={index}>
        <h2>Shared by {guardianName || shared.guardianPubkey.slice(0, 12)}</h2>
        <p className="field-hint">{new Date(shared.receivedAt).toLocaleDateString()}. These are the sender’s records, not your own checks.</p>
        {shared.tier && <p>Sender’s tier: {shared.tier}</p>}
        {shared.blocked !== undefined && <p>Blocked by sender: {shared.blocked ? 'Yes' : 'No'}</p>}
        {shared.checkRecords?.map((check, index) => <p key={index}>{check.pubkey.slice(0, 12)}: {check.method} · {new Date(check.checkedAt).toLocaleDateString()}</p>)}
        {shared.checks?.map(check => <p key={check.pubkey}>{check.pubkey.slice(0, 12)}: {check.verification}{check.verifiedAt !== undefined ? ` · ${new Date(check.verifiedAt).toLocaleDateString()}` : ''}</p>)}
      </div>)}
      <ContactChecks key={contact.contactId + (props.checkOwnerIdentityPubkey ?? '')}
        checks={(contact.checks ?? []).filter(check => !props.checkOwnerIdentityPubkey || check.ownerIdentityPubkey === props.checkOwnerIdentityPubkey)}
        identities={contact.identities}
        onUpdate={rights.canEditNote ? props.onUpdateCheck : undefined}
        onRecord={rights.canEditNote ? props.onRecordCheck : undefined}
        onRemove={rights.canEditNote ? props.onRemoveCheck : undefined} />
      <ContactOrigins origins={(contact.origins ?? []).filter(origin => !props.checkOwnerIdentityPubkey || origin.ownerIdentityPubkey === props.checkOwnerIdentityPubkey)}
        knownSince={contact.createdAt} onSave={rights.canEditNote ? props.onRecordOrigin : undefined} onRemove={rights.canEditNote ? props.onRemoveOrigin : undefined} />
      <ContactShare contact={contact} />

      {has('block') && (
        <div className="card section">
          <div className="section-title">{BLOCK_SECTION_TITLE}</div>
          {contact.blocked ? (
            <>
              <button className="btn btn-secondary" disabled={busy || !rights.canUnblock}
                onClick={() => void run('block', props.onUnblock)}>{UNBLOCK_LABEL}</button>
              {rights.unblockBlockedReason && <p className="field-hint">{rights.unblockBlockedReason}</p>}
            </>
          ) : !blockOpen ? (
            <button className="btn btn-secondary" disabled={busy || !rights.canBlock}
              onClick={() => setBlockOpen(true)}>{BLOCK_LABEL}</button>
          ) : (
            <>
              <label className="field-label" htmlFor="block-reason">{BLOCK_REASON_FIELD_LABEL}</label>
              <input id="block-reason" className="input input-sm" maxLength={BLOCK_REASON_MAX}
                value={blockReason} onChange={e => setBlockReason(e.target.value)} />
              <p className="field-hint">{BLOCK_BOUNDARY_COPY}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => void run('block', () => props.onBlock(normaliseBlockReason(blockReason)))}>
                  {blockConfirmLabel(contact.displayName)}
                </button>
                <button className="btn btn-secondary" onClick={() => setBlockOpen(false)}>{CANCEL_LABEL}</button>
              </div>
            </>
          )}
          {errorFor('block')}
        </div>
      )}

      {has('remove') && (
        <div style={{ marginTop: 24 }}>
          <p className="field-hint">Removing this contact here removes it from every identity list. Any block stays in place.</p>
          {!confirmRemove ? (
            <button className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={() => setConfirmRemove(true)}>
              {REMOVE_CONTACT_LABEL}
            </button>
          ) : (
            <div className="card" style={{ borderColor: 'var(--danger)' }}>
              <p style={{ marginBottom: 12, fontSize: '0.9rem' }}>
                {removeContactConfirmCopy(contact.displayName)}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" style={{ flex: 1 }} disabled={busy}
                  onClick={() => void run('remove', props.onRemove)}>{REMOVE_LABEL}</button>
                <button className="btn btn-secondary" style={{ flex: 1 }}
                  onClick={() => setConfirmRemove(false)}>{CANCEL_LABEL}</button>
              </div>
              {errorFor('remove')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
