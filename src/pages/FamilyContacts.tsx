import { ContactShareFields } from '../components/ContactShareFields';
import { defaultShareFields, type ContactShareFields as ShareFields } from '../lib/contact-share-fields';
import type { ContactIdentityList } from '../lib/contacts-v2-identity-lists';
import type { ShareStep } from '../lib/contacts-v2-family-ops';
import { useState } from 'react';
import type { AddIdentityValue, ContactTier } from '../types';
import { ContactTierChip } from '../components/ContactTierChip';
import {
  FAMILY_CONTACTS_APPLY_FAILED_COPY, FAMILY_CONTACTS_DIRECTORIES_HINT,
  FAMILY_CONTACTS_DIRECTORIES_TITLE, FAMILY_CONTACTS_EMPTY_TEXT, FAMILY_CONTACTS_EMPTY_TITLE,
  FAMILY_CONTACTS_LOADING_COPY, BACK_LABEL, CANCEL_LABEL, CONFIRM_LABEL, NO_CEILING_LABEL,
  SHARE_WITH_DEPENDANTS_LABEL, bulkSectionTitle, ceilingFieldLabel, coGuardianCeilingHintCopy,
  directoryCoverageCopy, roleFieldLabel, tierChipLabel, vouchForLabel,
} from '../lib/contacts-v2-copy';
import { cellActionLabel, cellActions, cellSummary, type CellAction } from '../lib/contacts-v2-cell-actions';
import { coGuardianCeilingIsStricter, type ManagerDirectory, type ManagerRow } from '../lib/contacts-v2-manager-rows';
import { planShare, planVouch, type DirectoryTarget } from '../lib/contacts-v2-family-ops';
import { newContactId } from '../lib/contacts-v2-ids';
import { ownBlocks } from '../lib/contacts-v2-rights';
import type { FamilyOpRequest } from '../hooks/useFamilyContactsV2';
import { Icon } from '../components/Icon';

interface Props {
  identityListsByDirectory?: Record<string, ContactIdentityList[]>;
  rows: ManagerRow[];
  directories: ManagerDirectory[];
  actorPubkey: string;
  /** The acting guardian's Natural Person pubkey — the author of every vouch and ceiling. */
  guardianPubkey: string;
  guardianName: string | null;
  loading: boolean;
  error: string | null;
  onApply: (requests: FamilyOpRequest[]) => Promise<void>;
  onBack: () => void;
}

type Bulk =
  | { kind: 'share'; selected: Record<string, boolean> }
  | { kind: 'vouch'; tier: ContactTier; selected: Record<string, boolean>; roles: Record<string, string> };

const CEILINGS: Array<'ken' | 'kith' | 'kin' | 'none'> = ['ken', 'kith', 'kin', 'none'];

/** At least one directory checked — an empty-selection Confirm has nothing to apply. */
function bulkHasSelection(b: Bulk): boolean {
  return Object.values(b.selected).some(Boolean);
}

/**
 * The manager never fabricates a source record: every bulk action reads the
 * row's owner-side (or first present) record, so "share Dave" always means a
 * real record the guardian actually holds.
 */
/**
 * C0: `planShare`/`planVouch` (contacts-v2-family-ops.ts) deliberately stay
 * pure and deterministic — their output also drives the plan-preview text on
 * every render, so they never mint randomness. Each `ShareStep`/`VouchStep`
 * therefore hands back identities with NO `itemId`, the same shape
 * `shareableIdentities` builds them in. The itemId is minted HERE, once per
 * real request build, the same way `contactId` already is a few lines below
 * — never inside the plan. Skipping this left `value` with no `itemId` on
 * every `add-identity` request this page built, which `validateOperation`
 * rejects outright (HEX32 `itemId` is required), so sharing or vouching a
 * KEYED contact always failed at the reducer with the generic banner.
 */
function addIdentityRequests(
  directoryId: string,
  contactId: string,
  identities: Omit<AddIdentityValue, 'itemId'>[],
): FamilyOpRequest[] {
  return identities.map(id => ({
    directoryId, contactId, action: 'add-identity', value: { ...id, itemId: newContactId() },
  }));
}

function sourceFor(row: ManagerRow, directories: ManagerDirectory[]) {
  for (const dir of directories) {
    const cell = row.cells.find(c => c.directoryId === dir.directoryId);
    if (!cell?.present || !cell.contactId) continue;
    const record = dir.contacts.find(c => c.contactId === cell.contactId);
    if (record) return record;
  }
  return null;
}

export function FamilyContacts({ identityListsByDirectory,
  rows, directories, actorPubkey, guardianPubkey, guardianName, loading, error, onApply, onBack,
}: Props) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  const dependantDirs = directories.filter(d => !d.isOwner);

  const [shareFields, setShareFields] = useState<ShareFields | null>(null);
  const [targetLists, setTargetLists] = useState<Record<string, string>>({});

  function targetsFor(row: ManagerRow, selected: Record<string, boolean>, roles?: Record<string, string>): DirectoryTarget[] {
    return directories
      .filter(d => selected[d.directoryId])
      .map(d => {
        const cell = row.cells.find(c => c.directoryId === d.directoryId);
        return {
          directoryId: d.directoryId,
          ownerIdentityPubkey: targetLists[d.directoryId] ?? identityListsByDirectory?.[d.directoryId]?.[0]?.ownerIdentityPubkey,
          label: d.label,
          contactId: cell?.contactId ?? null,
          ...(roles?.[d.directoryId] ? { role: roles[d.directoryId] } : {}),
        };
      });
  }

  /**
   * The exact disclosure copy `confirmBulk` is about to act on — sourced
   * from `planShare`/`planVouch` themselves (never reconstructed here) so
   * the guardian reads the same "what does and doesn't travel" text the
   * plan was built from. Empty until at least one directory is selected.
   */
  function planPreviewText(row: ManagerRow, b: Bulk): string {
    const source = sourceFor(row, directories);
    if (!source) return '';
    const targets = targetsFor(row, b.selected, b.kind === 'vouch' ? b.roles : undefined);
    if (targets.length === 0) return '';
    if (b.kind === 'share') return planShare({ source, targets, fields: shareFields ?? undefined, guardianPubkey }).confirmText;
    return planVouch({
      source,
      guardianPubkey,
      ownerDirectoryId: directories.find(d => d.isOwner)?.directoryId ?? 'owner',
      tier: b.tier,
      targets,
      fields: shareFields ?? undefined,
    }).confirmText;
  }

  async function run(requests: FamilyOpRequest[]) {
    if (requests.length === 0) return;
    setBusy(true);
    setLocalError('');
    try {
      await onApply(requests);
      setBulk(null);
    } catch {
      // I3: never the raw rejection — a validator/IDB/decrypt message is a
      // dev-diagnostic string, not something to put in front of a user.
      setLocalError(FAMILY_CONTACTS_APPLY_FAILED_COPY);
    } finally {
      setBusy(false);
    }
  }

  function confirmBulk(row: ManagerRow) {
    const source = sourceFor(row, directories);
    if (!source || !bulk) return;
    const requests: FamilyOpRequest[] = [];

    const appendSharedFields = (step: ShareStep, contactId: string) => {
      const existing = directories.find(d => d.directoryId === step.directoryId)?.contacts.find(c => c.contactId === contactId);
      if (step.ownerIdentityPubkey && !step.add) requests.push({ directoryId: step.directoryId, contactId, action: 'link-list', value: { ownerIdentityPubkey: step.ownerIdentityPubkey } });
      for (const method of step.methods ?? []) {
        if (existing?.contactMethods.some(m => m.kind === method.kind && m.value === method.value)) continue;
        requests.push({ directoryId: step.directoryId, contactId, action: 'add-method', value: { ...method, itemId: newContactId() } });
      }
      if (step.note !== undefined && !existing?.notes) requests.push({ directoryId: step.directoryId, contactId, action: 'note', value: { note: step.note } });
      if (step.context && step.directoryId !== source.directoryId) {
        requests.push({ directoryId: step.directoryId, contactId, action: 'receive-share', value: step.context });
        requests.push({ directoryId: source.directoryId, contactId: source.contactId, action: 'record-share', value: { directoryId: step.directoryId, contactId } });
      }
    };

    if (bulk.kind === 'share') {
      for (const step of planShare({ source, targets: targetsFor(row, bulk.selected), fields: shareFields ?? undefined, guardianPubkey }).steps) {
        const contactId = step.contactId ?? newContactId();
        if (step.add) requests.push({ directoryId: step.directoryId, contactId, action: 'add', value: step.add });
        requests.push(...addIdentityRequests(step.directoryId, contactId, step.identities));
        appendSharedFields(step, contactId);
      }
    } else {
      const plan = planVouch({
        source,
        guardianPubkey,
        ownerDirectoryId: directories.find(d => d.isOwner)?.directoryId ?? 'owner',
        tier: bulk.tier,
        targets: targetsFor(row, bulk.selected, bulk.roles),
        fields: shareFields ?? undefined,
      });
      for (const step of plan.steps) {
        const contactId = step.contactId ?? newContactId();
        if (step.add) requests.push({ directoryId: step.directoryId, contactId, action: 'add', value: step.add });
        requests.push(...addIdentityRequests(step.directoryId, contactId, step.identities));
        appendSharedFields(step, contactId);
        if (step.kind === 'vouch' && step.vouch) {
          requests.push({ directoryId: step.directoryId, contactId, action: 'vouch', value: step.vouch });
        } else if (step.kind === 'own-directory') {
          if (step.ownTier) requests.push({ directoryId: step.directoryId, contactId, action: 'set-tier', value: { tier: step.ownTier } });
          if (step.roles) requests.push({ directoryId: step.directoryId, contactId, action: 'set-roles', value: { roles: step.roles } });
        }
      }
    }
    void run(requests);
  }

  function cellAction(row: ManagerRow, directoryId: string, action: CellAction) {
    const cell = row.cells.find(c => c.directoryId === directoryId);
    const source = sourceFor(row, directories);
    if (!cell || !source) return;
    const contactId = cell.contactId ?? newContactId();
    const dir = directories.find(d => d.directoryId === directoryId);

    if (action === 'add-here') {
      const step = planShare({ source, targets: [{ directoryId, label: dir?.label ?? directoryId, contactId: null }] }).steps[0];
      const requests: FamilyOpRequest[] = [{ directoryId, contactId, action: 'add', value: step.add! }];
      requests.push(...addIdentityRequests(directoryId, contactId, step.identities));
      void run(requests);
      return;
    }
    if (action === 'remove-here') { void run([{ directoryId, contactId, action: 'remove', value: {} }]); return; }
    if (action === 'block-here') { void run([{ directoryId, contactId, action: 'block', value: { scope: { kind: 'contact' } } }]); return; }
    if (action === 'unblock-here') {
      const record = dir?.contacts.find(c => c.contactId === contactId);
      if (!record) return;
      // M1: lift every active block this actor applied, not just the first
      // — `cellActions` only offers this button when `blockedByActor` is
      // true (every active block on the record is this actor's), so more
      // than one own block is a real case, not a defensive guard.
      const mine = ownBlocks(record, actorPubkey);
      if (mine.length === 0) return;
      void run(mine.map(b => ({
        directoryId, contactId, action: 'unblock', value: {}, targetOperationId: b.operationId,
      })));
    }
  }

  if (loading) {
    return <div className="fade-in" role="main"><p className="empty-state-text">{FAMILY_CONTACTS_LOADING_COPY}</p></div>;
  }

  return (
    <div className="fade-in" role="main">
      {(error || localError) && (
        <div className="card section" role="alert" style={{ borderColor: 'var(--danger)' }}>
          {/* I3: the hook's `error` can be a raw IDB/decrypt string — map
              both it and a local apply failure through the same generic
              copy, never the underlying message. */}
          {FAMILY_CONTACTS_APPLY_FAILED_COPY}
        </div>
      )}

      <div className="card section">
        <div className="section-title">{FAMILY_CONTACTS_DIRECTORIES_TITLE}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {directories.map(d => <span key={d.directoryId} className="row-meta">{d.label}</span>)}
        </div>
        <p className="field-hint">{FAMILY_CONTACTS_DIRECTORIES_HINT}</p>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state" style={{ paddingTop: 48 }}>
          <div className="empty-state-icon"><Icon name="users" size={36} /></div>
          <h3 className="empty-state-title">{FAMILY_CONTACTS_EMPTY_TITLE}</h3>
          <p className="empty-state-text">{FAMILY_CONTACTS_EMPTY_TEXT}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map(row => (
            <div key={row.rowKey}>
              <button
                className="row row-button"
                style={{ padding: '12px 16px' }}
                onClick={() => { setOpenRow(openRow === row.rowKey ? null : row.rowKey); setBulk(null); }}
                aria-expanded={openRow === row.rowKey}
              >
                <span className="row-main">
                  <span className="row-label">{row.displayName}</span>
                  <span className="row-sub">
                    {directoryCoverageCopy(row.cells.filter(c => c.present).length, directories.length)}
                  </span>
                </span>
                <span className="row-chevron" aria-hidden="true">&rsaquo;</span>
              </button>

              {openRow === row.rowKey && (
                <div style={{ padding: '0 16px 16px' }}>
                  {directories.map(dir => {
                    const cell = row.cells.find(c => c.directoryId === dir.directoryId)!;
                    // I5: `cellActions` can offer 'set-ceiling' for a present
                    // non-owner cell, but this page has no handler for it —
                    // the `<select>` rendered below (aria-label
                    // `Ceiling for …`) IS the ceiling control. Filtered here,
                    // in the page, rather than in `contacts-v2-cell-actions.ts`
                    // (Task 11's module, out of scope for this fix).
                    const actions = cellActions(cell, {
                      isOwnerDirectory: dir.isOwner,
                      rowHasIdentities: row.identityPubkeys.length > 0,
                    }).filter(a => a !== 'set-ceiling');
                    // R-CEILING-DISPLAY: the select shows and edits ONLY the
                    // acting guardian's own ceiling — never `ceilingMaxTier`,
                    // which can be a co-guardian's cap this actor has no
                    // authority to change.
                    const showCeilingHint = !dir.isOwner && cell.present
                      && coGuardianCeilingIsStricter(cell);
                    return (
                      <div key={dir.directoryId}>
                        <div className="row">
                          <span className="row-main">
                            <span className="row-label">{dir.label}</span>
                            <span className="row-sub">
                              {cell.localName ? `${cell.localName} · ${cellSummary(cell)}` : cellSummary(cell)}
                            </span>
                          </span>
                          <span className="row-meta" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {cell.present && cell.effectiveTier && (
                              <ContactTierChip
                                tier={cell.effectiveTier}
                                source={cell.tierSource ?? undefined}
                                guardianName={guardianName}
                                blocked={cell.blocked}
                                compact
                              />
                            )}
                            {actions.map(a => (
                              <button key={a} className="btn btn-ghost btn-sm" disabled={busy}
                                onClick={() => cellAction(row, dir.directoryId, a)}>
                                {cellActionLabel(a)}
                              </button>
                            ))}
                            {!dir.isOwner && cell.present && (
                              <select
                                className="input input-sm"
                                aria-label={ceilingFieldLabel(dir.label)}
                                disabled={busy}
                                value={cell.actorCeilingMaxTier ?? ''}
                                onChange={e => {
                                  const raw = e.target.value;
                                  // I3: the blank option must REVOKE the actor's
                                  // own ceiling, not send `{ maxTier: '' }` —
                                  // that fails `validateOperation` outright
                                  // (`isCeilingTier('')` is false), so there was
                                  // no way to lift a ceiling once set.
                                  if (raw === '') {
                                    void run([{
                                      directoryId: dir.directoryId,
                                      contactId: cell.contactId!,
                                      action: 'revoke-ceiling',
                                      value: { guardianPubkey },
                                    }]);
                                    return;
                                  }
                                  const maxTier = raw as 'ken' | 'kith' | 'kin' | 'none';
                                  void run([{
                                    directoryId: dir.directoryId,
                                    contactId: cell.contactId!,
                                    action: 'ceiling',
                                    value: { guardianPubkey, maxTier },
                                  }]);
                                }}
                              >
                                <option value="">{NO_CEILING_LABEL}</option>
                                {CEILINGS.map(c => <option key={c} value={c}>{tierChipLabel(c)}</option>)}
                              </select>
                            )}
                          </span>
                        </div>
                        {showCeilingHint && (
                          <p className="field-hint" style={{ padding: '0 0 8px' }}>
                            {coGuardianCeilingHintCopy(cell.ceilingMaxTier!)}
                          </p>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" disabled={busy}
                      onClick={() => { setShareFields(null); setBulk({ kind: 'share', selected: {} }); }}>
                      {SHARE_WITH_DEPENDANTS_LABEL}
                    </button>
                    <button className="btn btn-secondary" disabled={busy}
                      onClick={() => { setShareFields(null); setBulk({ kind: 'vouch', tier: 'kin', selected: {}, roles: {} }); }}>
                      {vouchForLabel('kin')}
                    </button>
                    <button className="btn btn-ghost" disabled={busy}
                      onClick={() => { setShareFields(null); setBulk({ kind: 'vouch', tier: 'kith', selected: {}, roles: {} }); }}>
                      {vouchForLabel('kith')}
                    </button>
                  </div>

                  {bulk && (
                    <div className="card section" style={{ marginTop: 12 }}>
                      <div className="section-title">{bulkSectionTitle(bulk)}</div>
                      {(bulk.kind === 'share' ? dependantDirs : directories).map(dir => (
                        <div className="row" key={dir.directoryId}>
                          <label className="row-main" htmlFor={`sel-${dir.directoryId}`}>
                            <span className="row-label">{dir.label}</span>
                          </label>
                          <input
                            id={`sel-${dir.directoryId}`}
                            type="checkbox"
                            aria-label={dir.label}
                            checked={!!bulk.selected[dir.directoryId]}
                            onChange={e => setBulk(b => b && ({
                              ...b, selected: { ...b.selected, [dir.directoryId]: e.target.checked },
                            }))}
                          />
                          {bulk.selected[dir.directoryId] && identityListsByDirectory?.[dir.directoryId] && <select className="input input-sm"
                            aria-label={`Identity list for ${dir.label}`} value={targetLists[dir.directoryId] ?? identityListsByDirectory[dir.directoryId][0]?.ownerIdentityPubkey}
                            onChange={e => setTargetLists(previous => ({ ...previous, [dir.directoryId]: e.target.value }))}>
                            {identityListsByDirectory[dir.directoryId].map(l => <option key={l.ownerIdentityPubkey} value={l.ownerIdentityPubkey}>{l.label}</option>)}
                          </select>}
                          {bulk.kind === 'vouch' && bulk.selected[dir.directoryId] && (
                            <input
                              className="input input-sm"
                              aria-label={roleFieldLabel(dir.label)}
                              maxLength={40}
                              value={bulk.roles[dir.directoryId] ?? ''}
                              onChange={e => setBulk(b => (b && b.kind === 'vouch') ? ({
                                ...b, roles: { ...b.roles, [dir.directoryId]: e.target.value },
                              }) : b)}
                            />
                          )}
                        </div>
                      ))}
                      {sourceFor(row, directories) && <ContactShareFields contact={sourceFor(row, directories)!}
                        value={shareFields ?? defaultShareFields(sourceFor(row, directories)!, true)} onChange={setShareFields} />}
                      <p className="field-hint">{planPreviewText(row, bulk)}</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" disabled={busy || !bulkHasSelection(bulk)}
                          onClick={() => confirmBulk(row)}>{CONFIRM_LABEL}</button>
                        <button className="btn btn-secondary" onClick={() => setBulk(null)}>{CANCEL_LABEL}</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-ghost" style={{ marginTop: 16 }} onClick={onBack}>{BACK_LABEL}</button>
    </div>
  );
}
