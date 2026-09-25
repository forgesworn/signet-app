import type { ContactOrigin } from '../lib/contact-origins';
import type { ContactCheck } from '../lib/contact-checks';
/**
 * One contact directory, loaded from its operation log.
 *
 * Mutators stamp operations with the next Lamport clock and persist them before
 * re-reducing the operation log to refresh
 * `records`/`effective`. The operation log is the sole source of truth — a
 * `contactRecordsV2` cache row is no longer written here (R-15: the store had
 * no reader; a re-reduce on load always rebuilds the same view for free, so
 * writing it cost a PBKDF2 encrypt per mutation to maintain nothing).
 *
 * Serialisation: mutations and reloads share the process-wide contacts queue
 * with family edits, imports and app proposals. Mutations read fresh storage
 * before allocating their clocks. A rejected mutation does not block the next.
 *
 * Actor identity is passed IN. App.tsx knows whether the active identity is the
 * owner, a guardian acting for a dependant, or a paired child; this hook does
 * not guess. The actor pubkey is the install's ONE stable actor id
 * (`stableActorPubkey`, R-ACTOR) — never the primary keypair.
 *
 * Failure contract: a mutator REJECTS when the scope is not ready (no
 * directory, no key, no actor) or when the built operation fails
 * `validateOperation`. It never resolves silently on a write that did not
 * happen — a caller cannot distinguish "saved" from "dropped" after the fact,
 * and `addContact` would otherwise hand back the id of a contact that does not
 * exist.
 *
 * Cost note: each mutation performs one 600k-iteration PBKDF2 encryption (the
 * operation), ~300 ms on a phone. That is per user action, not per render,
 * and loading a directory decrypts without re-encrypting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AddContactValue,
  AddIdentityValue,
  AddMethodValue,
  BlockValue,
  CeilingValue,
  ContactOperation,
  ContactRecord,
  ContactTier,
  EffectiveContact,
  NoteValue,
  SetLifecycleValue,
  UpdateMethodValue,
  VouchValue,
} from '../types';
import * as db from '../lib/db';
import { applyOperations, validateOperation } from '../lib/contacts-v2-reducer';
import { frontierOf, nextClock } from '../lib/contacts-v2-clock';
import { buildOperation, type MutationActor } from '../lib/contacts-v2-mutations';
import { newContactId, newOperationId } from '../lib/contacts-v2-ids';
import { resolveEffectiveDirectory, type EffectiveContext } from '../lib/contacts-v2-effective';
import { contactsMutationQueue, type SerialQueue } from '../lib/contacts-v2-queue';

export interface UseContactsV2Options {
  directoryId: string | null;
  ownerIdentityPubkey?: string;
  encryptionKey: string | null;
  actor: MutationActor | null;
  context: Omit<EffectiveContext, 'creatingActorRole'>;
  /**
   * Fired after a mutation has been persisted. The contacts v2 relay rail
   * (`useContactsV2Sync`) uses it as its change signal — without it nothing a
   * user does reaches the relay until the next unlock (ruling R3). Held in a
   * ref inside the hook, so passing a fresh closure does not re-create the
   * mutators.
   */
  onMutated?: () => void;
}

export interface UseContactsV2Result {
  records: ContactRecord[];
  effective: EffectiveContact[];
  loading: boolean;
  reload: () => Promise<void>;
  recogniseContact: (pubkey: string, displayName: string, ownerIdentityPubkey?: string, originMethod?: ContactOrigin['method']) => Promise<string>;
  addContact: (v: AddContactValue) => Promise<string>;
  renameContact: (contactId: string, displayName: string) => Promise<void>;
  setTier: (contactId: string, tier: ContactTier) => Promise<void>;
  setRoles: (contactId: string, roles: string[]) => Promise<void>;
  recordOrigin: (contactId: string, origin: Omit<ContactOrigin, 'ownerIdentityPubkey'>) => Promise<void>;
  removeOrigin: (contactId: string, id: string) => Promise<void>;
  recordCheck: (contactId: string, check: Omit<ContactCheck, 'id' | 'ownerIdentityPubkey'>) => Promise<void>;
  updateCheck: (contactId: string, check: Omit<ContactCheck, 'ownerIdentityPubkey'>) => Promise<void>;
  removeCheck: (contactId: string, id: string) => Promise<void>;
  setNote: (contactId: string, note: string) => Promise<void>;
  addIdentity: (contactId: string, v: Omit<AddIdentityValue, 'itemId'>) => Promise<string>;
  addContactMethod: (contactId: string, v: Omit<AddMethodValue, 'itemId'>) => Promise<string>;
  updateContactMethod: (contactId: string, v: UpdateMethodValue) => Promise<void>;
  removeItem: (contactId: string, itemId: string) => Promise<void>;
  vouch: (contactId: string, v: VouchValue) => Promise<void>;
  revokeVouch: (contactId: string, vouchOperationId: string) => Promise<void>;
  setCeiling: (contactId: string, v: CeilingValue) => Promise<void>;
  revokeCeiling: (contactId: string, guardianPubkey: string) => Promise<void>;
  block: (contactId: string, v: BlockValue) => Promise<void>;
  unblock: (contactId: string, blockOperationId: string) => Promise<void>;
  setLifecycle: (contactId: string, lifecycle: SetLifecycleValue['lifecycle']) => Promise<void>;
  reviewAppList: (contactId: string, grantId: string, accept: boolean) => Promise<void>;
  linkList: (contactId: string, ownerIdentityPubkey: string) => Promise<void>;
  unlinkList: (contactId: string, ownerIdentityPubkey: string) => Promise<void>;
  removeContact: (contactId: string) => Promise<void>;
  archiveContact: (contactId: string) => Promise<void>;
}

export function useContactsV2(opts: UseContactsV2Options): UseContactsV2Result {
  const { directoryId, encryptionKey, actor, context } = opts;
  const [records, setRecords] = useState<ContactRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const currentScope = useRef({ directoryId, encryptionKey });
  currentScope.current = { directoryId, encryptionKey };
  const loadedScope = useRef<{ directoryId: string | null; encryptionKey: string | null } | null>(null);
  const visibleRecords = useMemo(() => loadedScope.current?.directoryId === directoryId
    && loadedScope.current?.encryptionKey === encryptionKey ? records : [], [records, directoryId, encryptionKey]);
  const opsRef = useRef<ContactOperation[]>([]);
  const clockRef = useRef(0);
  // Every hook instance uses the same process-wide mutation queue.
  const queueRef = useRef<SerialQueue | null>(null);
  if (queueRef.current === null) queueRef.current = contactsMutationQueue;
  const onMutatedRef = useRef(opts.onMutated);
  onMutatedRef.current = opts.onMutated;

  const publish = useCallback((ops: ContactOperation[], directory: string, key: string) => {
    if (currentScope.current.directoryId !== directory || currentScope.current.encryptionKey !== key) return;
    loadedScope.current = { directoryId: directory, encryptionKey: key };
    const map = applyOperations(ops);
    const rows: ContactRecord[] = [];
    for (const record of map.values()) {
      if (record.directoryId === directory) rows.push(record);
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    setRecords(rows);
    return map;
  }, []);

  const reload = useCallback(async () => {
    // On the same queue as `mutate` so a reload can never interleave with an
    // in-flight mutation's read-clock/write-op sequence.
    return queueRef.current!.run(async () => {
      if (currentScope.current.directoryId !== directoryId || currentScope.current.encryptionKey !== encryptionKey) return;
      if (!directoryId || !encryptionKey) {
        opsRef.current = [];
        clockRef.current = 0;
        setRecords([]);
        setLoading(false);
        return;
      }
      const ops = await db.listContactOperationsV2(directoryId, encryptionKey);
      if (currentScope.current.directoryId !== directoryId || currentScope.current.encryptionKey !== encryptionKey) return;
      opsRef.current = ops;
      clockRef.current = frontierOf(ops).maxClock;
      publish(ops, directoryId, encryptionKey);
      setLoading(false);
    });
  }, [directoryId, encryptionKey, publish]);

  // A directory change must not leave the PREVIOUS directory's rows on screen
  // while the new one loads — they would read as this directory's contacts.
  // Runs before the reload effect below, so the clear lands first.
  const shownDirectoryRef = useRef(directoryId);
  useEffect(() => {
    if (shownDirectoryRef.current === directoryId) return;
    shownDirectoryRef.current = directoryId;
    setLoading(true);
    setRecords([]);
  }, [directoryId]);

  useEffect(() => { void reload(); }, [reload]);

  const mutate = useCallback(async (params: {
    contactId: string;
    action: ContactOperation['action'];
    value: unknown;
    itemId?: string;
    targetOperationId?: string;
    existingCheckOnly?: boolean;
  }): Promise<void> => {
    // Throw, never no-op: a silent return told the caller "done" for a write
    // that never happened, and `addContact` then handed back an id for a
    // contact that does not exist.
    if (!directoryId || !encryptionKey || !actor) {
      throw new Error(`contacts: cannot ${params.action} — contacts scope not ready`);
    }
    // Serialised: without this, two mutators fired without an intervening
    // await would both read `clockRef.current` before either write landed.
    return queueRef.current!.run(async () => {
      const currentOps = await db.listContactOperationsV2(directoryId, encryptionKey);
      if (params.action === 'record-origin') {
        const record = [...applyOperations(currentOps).values()].find(row => row.contactId === params.contactId || row.mergedContactIds?.includes(params.contactId));
        const origin = params.value as ContactOrigin;
        if (!record || record.lifecycle === 'removed') throw new Error('This contact is no longer available.');
        if ((record.origins?.length ?? 0) >= 64 && !record.origins?.some(old => old.id === origin.id)) throw new Error('This contact has 64 history records. Remove an old record first.');
      }
      if (params.action === 'record-check') {
        const record = [...applyOperations(currentOps).values()].find(row => row.contactId === params.contactId || row.mergedContactIds?.includes(params.contactId));
        const check = params.value as ContactCheck;
        if (!record || record.lifecycle === 'removed' || !record.identities.some(identity => identity.pubkey === check.identityPubkey)) throw new Error('This key is no longer in the contact.');
        if (params.existingCheckOnly && !record.checks?.some(old => old.id === check.id && old.ownerIdentityPubkey === check.ownerIdentityPubkey)) throw new Error('This check is no longer available.');
        if ((record.checks?.length ?? 0) >= 128 && !record.checks?.some(old => old.id === check.id)) throw new Error('This contact has 128 check records. Remove an old check before adding another.');
      }

      const clock = nextClock(clockRef.current, frontierOf(currentOps).maxClock);
      // Bump before any `await` — defence in depth alongside the queue above.
      clockRef.current = clock;
      const op: ContactOperation = { ...buildOperation({
        directoryId,
        contactId: params.contactId,
        action: params.action,
        value: params.value,
        clock,
        actor,
        now: Date.now(),
        operationId: newOperationId(),
        itemId: params.itemId,
        targetOperationId: params.targetOperationId,
      }), ...(opts.ownerIdentityPubkey ? { ownerIdentityPubkey: opts.ownerIdentityPubkey } : {}) };
      // Never persist an operation the reducer would drop — and say so, rather
      // than reporting success for a mutation that will never materialise.
      if (!validateOperation(op)) {
        throw new Error(`contacts: cannot ${params.action} — invalid operation`);
      }
      if (currentScope.current.directoryId !== directoryId || currentScope.current.encryptionKey !== encryptionKey) throw new Error('Contacts scope changed.');
      // Creation and its private history must survive or fail together.
      const owner = params.action === 'add' ? (params.value as AddContactValue).ownerIdentityPubkey : undefined;
      const batch = [op];
      if (owner && actor.actorRole !== 'app') {
        batch.push({ ...buildOperation({ directoryId, contactId: params.contactId,
          action: 'record-origin', value: { id: newContactId(), ownerIdentityPubkey: owner,
            method: 'manual', addedAt: op.createdAt }, clock: clock + 1, actor,
          now: op.createdAt, operationId: newOperationId() }), ownerIdentityPubkey: owner });
      }
      if (!batch.every(validateOperation)) throw new Error('Invalid contact history');
      if (batch.length === 1) await db.saveContactOperationV2(op, encryptionKey);
      else await db.saveContactOperationsV2(batch, encryptionKey);
      clockRef.current = batch[batch.length - 1].logicalClock;
      // M5: the operation is durable in the log the moment the line above
      // resolves — `onMutated` must fire even if the re-reduce below throws.
      try {
        // R-15: the `contactRecordsV2` cache has no reader. `useContactsV2`
        // reduces from the operation log on every load, `useFamilyContactsV2`
        // never wrote it, and the rail carries operations. Writing it cost a
        // PBKDF2 encrypt per mutation to maintain a view nothing consults —
        // and a stale write nobody reads is a trap for whoever eventually does.
        const ops = [...currentOps, ...batch];
        opsRef.current = ops;
        publish(ops, directoryId, encryptionKey);
      } finally {
        // R3: the operation is durable; tell the rail there is something to publish.
        onMutatedRef.current?.();
      }
    });
  }, [directoryId, encryptionKey, actor, publish, opts.ownerIdentityPubkey]);

  // Each of these returns its id only AFTER `mutate` resolves — `mutate` now
  // throws on a scope or validation failure, so an id coming back out of here
  // always names something that was persisted.
  const addContact = useCallback(async (v: AddContactValue): Promise<string> => {
    const contactId = newContactId();
    await mutate({ contactId, action: 'add', value: { ...v, ...(opts.ownerIdentityPubkey ? { ownerIdentityPubkey: opts.ownerIdentityPubkey } : {}) } });
    return contactId;
  }, [mutate, opts.ownerIdentityPubkey]);

  const recogniseContact = useCallback(async (pubkey: string, displayName: string, ownerIdentityPubkey = opts.ownerIdentityPubkey, originMethod?: ContactOrigin['method']): Promise<string> => {
    if (!directoryId || !encryptionKey || !actor || !ownerIdentityPubkey) throw new Error('Choose an identity list first.');
    return queueRef.current!.run(async () => {
      const current = await db.listContactOperationsV2(directoryId, encryptionKey);
      const key = pubkey.toLowerCase();
      const existing = [...applyOperations(current).values()].find(r => r.identities.some(i => i.pubkey === key));
      const contactId = existing?.contactId ?? newContactId();
      const clock = nextClock(0, frontierOf(current).maxClock);
      const now = Date.now();
      const make = (action: ContactOperation['action'], value: unknown, offset: number) => buildOperation({
        directoryId, contactId, action, value, clock: clock + offset, actor, now, operationId: newOperationId(),
      });
      const ops = existing && existing.lifecycle !== 'removed'
        ? [make('link-list', { ownerIdentityPubkey }, 0)]
        : [make('add', { type: existing?.type ?? 'person', displayName: existing?.displayName ?? displayName,
            tier: existing?.tier ?? 'ken', ownerIdentityPubkey }, 0),
          ...(!existing ? [make('add-identity', { itemId: newContactId(), pubkey: key, provenance: 'direct', verification: 'unverified' }, 1)] : [])];
      if (originMethod) {
        if ((existing?.origins?.length ?? 0) >= 64) throw new Error('This contact has 64 history records. Remove an old record first.');
        ops.push({ ...make('record-origin', { id: newContactId(), ownerIdentityPubkey,
          method: originMethod, addedAt: now }, ops.length), ownerIdentityPubkey });
      }
      if (!/^[0-9a-f]{64}$/.test(key) || !ops.every(validateOperation)) throw new Error('Invalid contact');
      if (currentScope.current.directoryId !== directoryId || currentScope.current.encryptionKey !== encryptionKey) throw new Error('Contacts scope changed.');
      await db.saveContactOperationsV2(ops, encryptionKey);
      opsRef.current = [...current, ...ops];
      clockRef.current = frontierOf(opsRef.current).maxClock;
      publish(opsRef.current, directoryId, encryptionKey);
      onMutatedRef.current?.();
      return contactId;
    });
  }, [directoryId, encryptionKey, actor, opts.ownerIdentityPubkey, publish]);

  const addIdentity = useCallback(async (contactId: string, v: Omit<AddIdentityValue, 'itemId'>): Promise<string> => {
    const itemId = newContactId();
    await mutate({ contactId, action: 'add-identity', itemId, value: { ...v, itemId } });
    return itemId;
  }, [mutate]);

  const addContactMethod = useCallback(async (contactId: string, v: Omit<AddMethodValue, 'itemId'>): Promise<string> => {
    const itemId = newContactId();
    await mutate({ contactId, action: 'add-method', itemId, value: { ...v, itemId } });
    return itemId;
  }, [mutate]);

  const effective = useMemo(
    () => resolveEffectiveDirectory(visibleRecords, context),
    [visibleRecords, context],
  );

  return {
    records: visibleRecords,
    effective,
    loading,
    reload,
    addContact,
    recogniseContact,
    renameContact: useCallback((contactId, displayName) => mutate({ contactId, action: 'rename', value: { displayName } }), [mutate]),
    setTier: useCallback((contactId, tier) => mutate({ contactId, action: 'set-tier', value: { tier } }), [mutate]),
    setRoles: useCallback((contactId, roles) => mutate({ contactId, action: 'set-roles', value: { roles } }), [mutate]),
    setNote: useCallback((contactId, note) => mutate({ contactId, action: 'note', value: { note } as NoteValue }), [mutate]),
    recordOrigin: useCallback((contactId, origin) => {
      if (!opts.ownerIdentityPubkey) throw new Error('Select the identity for this contact history.');
      return mutate({ contactId, action: 'record-origin', value: { ...origin, ownerIdentityPubkey: opts.ownerIdentityPubkey } });
    }, [mutate, opts.ownerIdentityPubkey]),
    removeOrigin: useCallback((contactId, id) => mutate({ contactId, action: 'remove-origin', value: { id } }), [mutate]),
    recordCheck: useCallback((contactId, check) => {
      if (!opts.ownerIdentityPubkey) throw new Error('Select the identity whose check you are recording.');
      return mutate({ contactId, action: 'record-check', value: { ...check, id: newContactId(), ownerIdentityPubkey: opts.ownerIdentityPubkey } });
    }, [mutate, opts.ownerIdentityPubkey]),
    updateCheck: useCallback((contactId, check) => {
      if (!opts.ownerIdentityPubkey) throw new Error('Select the identity whose check you are editing.');
      return mutate({ contactId, action: 'record-check', existingCheckOnly: true, value: { ...check, ownerIdentityPubkey: opts.ownerIdentityPubkey } });
    }, [mutate, opts.ownerIdentityPubkey]),
    removeCheck: useCallback((contactId, id) => mutate({ contactId, action: 'remove-check', value: { id } }), [mutate]),
    addIdentity,
    addContactMethod,
    updateContactMethod: useCallback((contactId, v) => mutate({ contactId, action: 'update-method', itemId: v.itemId, value: v }), [mutate]),
    removeItem: useCallback((contactId, itemId) => mutate({ contactId, action: 'remove-item', itemId, value: { itemId } }), [mutate]),
    vouch: useCallback((contactId, v) => mutate({ contactId, action: 'vouch', value: v }), [mutate]),
    revokeVouch: useCallback((contactId, vouchOperationId) => mutate({ contactId, action: 'revoke-vouch', value: {}, targetOperationId: vouchOperationId }), [mutate]),
    setCeiling: useCallback((contactId, v) => mutate({ contactId, action: 'ceiling', value: v }), [mutate]),
    revokeCeiling: useCallback((contactId, guardianPubkey) => mutate({ contactId, action: 'revoke-ceiling', value: { guardianPubkey } }), [mutate]),
    block: useCallback((contactId, v) => mutate({ contactId, action: 'block', value: v }), [mutate]),
    unblock: useCallback((contactId, blockOperationId) => mutate({ contactId, action: 'unblock', value: {}, targetOperationId: blockOperationId }), [mutate]),
    setLifecycle: useCallback((contactId, lifecycle) => mutate({ contactId, action: 'set-lifecycle', value: { lifecycle } }), [mutate]),
    reviewAppList: useCallback((contactId, grantId, accept) => mutate({ contactId, action: 'review-app-list', value: { grantId, accept } }), [mutate]),
    linkList: useCallback((contactId, ownerIdentityPubkey) => mutate({ contactId, action: 'link-list', value: { ownerIdentityPubkey } }), [mutate]),
    unlinkList: useCallback((contactId, ownerIdentityPubkey) => mutate({ contactId, action: 'unlink-list', value: { ownerIdentityPubkey } }), [mutate]),
    removeContact: useCallback((contactId) => mutate({ contactId, action: 'remove', value: {} }), [mutate]),
    archiveContact: useCallback((contactId) => mutate({ contactId, action: 'archive', value: {} }), [mutate]),
  };
}
