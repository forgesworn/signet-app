/**
 * Inbound app proposals.
 *
 * Backlog fetch on unlock plus a resident live subscription per active grant,
 * mirroring `useAuditLog`'s one-shot shape and `useEscalations`' live
 * subscription idiom. Each grant has its own replaceable proposal event under a
 * tag bound to that app, so the filter is exact and the author is pinned.
 *
 * Conversion, not application, is what this hook decides: `onAddKen` is handed
 * to Phase B's contacts mutator by App.tsx, and a rename writes `appLabels` on
 * the grant — an app-local rename never touches the owner's own record, which
 * is the whole point of `rename-app-label` being a separate capability from a
 * real rename the owner performs.
 *
 * `seenOperationIds` is persisted on the grant immediately after a batch is
 * applied. A replay is then a no-op even across an app restart, and a partially
 * applied batch cannot re-run its accepted half on the next unlock. That
 * persist is NOT conditional on the effect still being current: an applied
 * outcome has already changed the contact log, so its id has to be remembered
 * whether or not a grant-set change superseded the run that applied it. See
 * `liveKeyRef`.
 */
import { useEffect, useRef, useState } from 'react';
import { parseProposalBatch, proposalFilter } from '@forgesworn/signet-contacts/wire';
import type { AddKenValue, NostrFilterLike } from '@forgesworn/signet-contacts/wire';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import * as db from '../lib/db';
import { fetchEvents, subscribeEvents } from '../lib/relay-service';
import { LocalSigningBackend } from '../lib/signing-backend';
import { rememberOperationIds, validateProposalBatch } from '../lib/contact-proposals';
import { createSerialQueue } from '../lib/contacts-v2-queue';
import { MAX_ENVELOPE_CHARS } from '../lib/vault-envelope';
import { isValidRelayUrl } from '../lib/relay-url';
import { MAX_APP_LABELS_PER_GRANT } from '../types';

/**
 * Translate the SDK's structural filter into signet-protocol's `NostrFilter`.
 *
 * `NostrFilterLike` carries an index signature for tag queries, which will not
 * assign to `NostrFilter` — and an `as never` cast to silence that would also
 * silence a real mismatch, such as a `'#d'` that never reached the relay. Copy
 * the fields we actually use, and nothing else goes over the wire by accident.
 */
function toNostrFilter(filter: NostrFilterLike): NostrFilter {
  const out: NostrFilter = {};
  if (Array.isArray(filter.kinds)) out.kinds = [...filter.kinds];
  if (Array.isArray(filter.authors)) out.authors = [...filter.authors];
  if (typeof filter.limit === 'number') out.limit = filter.limit;
  const dTags = (filter as { '#d'?: unknown })['#d'];
  if (Array.isArray(dTags)) out['#d'] = dTags.filter((t): t is string => typeof t === 'string');
  return out;
}

/**
 * A/I2: the relays this grant's proposals are actually read from — the
 * configured read pool plus the grant's own relay, deduped, each validated for
 * scheme. Exported so its behaviour is testable without a relay.
 */
export function proposalReadTargets(read: readonly string[], grantRelay: string): string[] {
  const valid = read.filter(isValidRelayUrl);
  return Array.from(new Set(isValidRelayUrl(grantRelay) ? [...valid, grantRelay] : valid));
}

export interface UseContactProposalsOptions {
  /** R-8: false on a paired-child install. */
  enabled: boolean;
  encryptionKey: string | null;
  relays: { read: string[]; write: string[] };
  /** Changes whenever the grant set changes, so the effect re-runs. */
  grantsToken: string;
  directoryScopedIds: (directoryId: string, grantId: string) => Promise<Map<string, string>>;
  onAddKen: (directoryId: string, value: AddKenValue, appName: string, grantId: string) => Promise<AddKenOutcome>;
  onRenameAppLabel: (grantId: string, scopedContactId: string, label: string) => Promise<void>;
}

/**
 * R-28: what the caller's `add-ken` apply actually did, as this hook needs to
 * account for it.
 *
 * `'existing'` is an ACCEPTANCE, not a rejection: the key the app asked for is
 * in the directory, which is the state the app wanted, and the id is remembered
 * so a replay stays a no-op. `'refused'` is final (a directory this device does
 * not own, an unusable key) and is likewise remembered — retrying it would
 * never succeed. `'directory-full'` is the one outcome that is NOT remembered:
 * the ceiling can move (the owner removes app-added contacts), so the proposal
 * is counted as rejected now and reconsidered if the app sends it again.
 */
export type AddKenOutcome = 'created' | 'existing' | 'refused' | 'directory-full';

export function useContactProposals({
  enabled, encryptionKey, relays, grantsToken, directoryScopedIds, onAddKen, onRenameAppLabel,
}: UseContactProposalsOptions) {
  const [lastInboxAt, setLastInboxAt] = useState<number | null>(null);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  // M2: a validation rejection (bad shape, replay, capability, stale label,
  // over the label cap) is a DIFFERENT outcome from the caller's own apply
  // callback throwing. The latter is counted here instead, and — unlike a
  // validation rejection — is retried (see `seenEvents.delete` below).
  const [applyFailed, setApplyFailed] = useState(0);

  // Callbacks in refs: App.tsx rebuilds them on every render, and putting them
  // in the dep array would tear down and rebuild every subscription each time.
  const cbRef = useRef({ directoryScopedIds, onAddKen, onRenameAppLabel });
  cbRef.current = { directoryScopedIds, onAddKen, onRenameAppLabel };

  /**
   * The LIVE unlock key, tracked independently of any one effect run.
   *
   * Cancellation and persistence are different questions. `cancelled` says
   * "this effect run is superseded — stop starting new work", and a grant-set
   * change (an approval, a revoke, a forget, a rail merge) sets it routinely.
   * But a batch that has ALREADY applied its outcomes has changed the contact
   * log through the caller's own callbacks; refusing to write its
   * `seenOperationIds` then leaves those operations applied and unremembered,
   * so the next run re-applies them. The write itself is safe to make in any
   * case — it goes through `updateContactGrantV2`, which re-reads the row
   * inside the shared grant-write queue and declines a no-op.
   *
   * The ONE thing that must abort the persist is the unlock key changing
   * underneath it: writing a row encrypted to a key the app no longer holds
   * (or, worse, to a different identity's key) is not a stale write, it is a
   * corrupt one. So the guard is keyed on `encryptionKey`, not on the effect.
   */
  const liveKeyRef = useRef(encryptionKey);
  liveKeyRef.current = encryptionKey;

  useEffect(() => {
    if (!enabled || !encryptionKey) return;

    let cancelled = false;
    const unsubscribes: Array<() => void> = [];
    const seenEvents = new Set<string>();
    // R-18: one serial queue per grant. Two live proposal events for the
    // SAME grant landing in the same tick would otherwise both read the
    // grant's `seenOperationIds`/`appLabels` before either write lands, and
    // the second write would silently clobber the first's — the same
    // read-modify-write hazard `createSerialQueue` was built to close for
    // `useContactsV2`. A DIFFERENT grant gets its own queue and is untouched
    // by another grant's in-flight work.
    const queues = new Map<string, ReturnType<typeof createSerialQueue>>();
    function queueFor(grantId: string) {
      let queue = queues.get(grantId);
      if (!queue) {
        queue = createSerialQueue();
        queues.set(grantId, queue);
      }
      return queue;
    }

    /** The unlock key has not changed underneath this run — see `liveKeyRef`.
     *  The only condition under which an applied batch must NOT be persisted. */
    const keyStillLive = (): boolean => liveKeyRef.current === encryptionKey;

    async function processEvent(grantId: string, event: NostrEvent, eventId: string): Promise<void> {
      if (cancelled) return;

      // R-17: bind the event to its grant BEFORE anything downstream (decrypt,
      // validate, apply) ever runs — re-checked on every single event, backlog
      // or live, so a grant revoked mid-session stops accepting immediately
      // rather than only at the next subscribe.
      const grant = await db.getContactGrantV2(grantId, encryptionKey!);
      if (!grant || grant.revokedAt || !grant.ownerIdentityPubkey || cancelled) return;
      // Author pin: a relay may answer with anything, and only the app bound
      // into this grant may speak on its proposal tag.
      if (event.pubkey?.toLowerCase() !== grant.appPubkey.toLowerCase()) return;

      // A/M3: refuse an oversized envelope BEFORE the decrypt. The SDK's own
      // opener caps at `MAX_ENVELOPE_CHARS` first; this path handed
      // `event.content` straight to `nip44Decrypt`, bounded only by the relay's
      // 131 072-byte message cap. Post-migration that decrypt is a NIP-46
      // round-trip through an ESP32, so an app (or a relay) can make each one
      // as expensive as it likes for free.
      if (typeof event.content !== 'string' || event.content.length > MAX_ENVELOPE_CHARS) return;

      const rail = new LocalSigningBackend(grant.railPrivateKey);
      let plaintext: string;
      try {
        plaintext = await rail.nip44Decrypt(grant.appPubkey, event.content);
      } catch {
        return;
      } finally {
        rail.destroy();
      }
      const batch = parseProposalBatch(plaintext);
      if (!batch || cancelled) return;

      // Task 28, item 7: `directoryScopedIds` is the CALLER's callback and can
      // throw (a failed decrypt, a directory that is not loaded yet). Left
      // unguarded it rejected the queued task itself — an unhandled rejection
      // out of a hook whose contract everywhere else is "never throw", and a
      // failure the owner was never told about. Counted as an apply failure
      // (the same bucket as a throwing `onAddKen`, for the same reason: it is
      // the caller's own code failing, not a validation rejection) and the
      // event is dropped from `seenEvents` so a later re-delivery retries it.
      let scoped: Map<string, string>;
      try {
        scoped = await cbRef.current.directoryScopedIds(grant.directoryId, grant.grantId);
      } catch {
        seenEvents.delete(eventId);
        if (!cancelled) setApplyFailed((n) => n + 1);
        return;
      }
      if (cancelled) return;

      const outcomes = validateProposalBatch(batch, {
        grantId: grant.grantId,
        capabilities: grant.capabilities,
        seenOperationIds: new Set(grant.seenOperationIds),
        knownScopedIds: new Set(scoped.keys()),
        now: Math.floor(Date.now() / 1000),
        // R-19: proposal acceptance uses the PROPOSAL clock, not the
        // projection-freshness one. `grant.maxStalenessSeconds` governs how
        // stale a PROJECTION the app publishes may be — a different clock
        // for a different purpose — so `maxAgeSeconds` is deliberately left
        // unset here and the validator's own SDK default
        // (`MAX_STALENESS_SECONDS`, 7 days) applies.
      });

      const appliedIds: string[] = [];
      // R-17: this hook is the enforcing writer for `appLabels`. `labels` is
      // the WORKING map for this batch — it starts as the grant as read, so
      // the in-batch stale-clock and cap guards below see both what is stored
      // and what earlier outcomes in this same batch have already done. All
      // outcomes only ever touch THIS grant's own directory
      // (`grant.directoryId`), never a sibling grant's.
      const labels = { ...grant.appLabels };
      // ...and `appliedLabels` is what actually gets PERSISTED: only the
      // renames THIS batch accepted, folded into the row as it stands at write
      // time rather than written over it.
      //
      // `labels` is a snapshot taken before the callbacks ran, so writing it
      // wholesale published this run's view of every OTHER label too. A
      // superseded run A (X→"a" at t=100) persisting after a newer run B
      // (X→"b" at t=200) regressed X to "a" — and bumped `updatedAt`, so the
      // regression then won the grants rail's last-writer comparison on every
      // other device as well. The stale-clock guard could not catch it: it
      // compares against the snapshot, which by then is exactly the stale
      // thing. The real comparison has to happen inside the mutate, against
      // `current`.
      const appliedLabels: Record<string, { label: string; updatedAt: number }> = {};
      let acceptedCount = 0;
      let rejectedCount = 0;
      let applyFailedCount = 0;
      let sawApplyFailure = false;

      for (const outcome of outcomes) {
        // BREAK, not return: cancellation stops NEW work — no further apply,
        // no further callback — but it must not skip the persist below for
        // the outcomes that have already been applied. Returning here left
        // real contact operations written and unremembered, so the next run
        // re-applied them.
        if (cancelled) break;
        // A `replay` outcome is excluded from `rejectedCount`: the SDK now
        // resends a proposal still waiting in every batch until it is either
        // accepted or the app gives up on it, so a repeated `operationId` is
        // this device having already answered it, not the batch being
        // refused. Every other `ProposalRejectReason` is a genuine refusal
        // and still counts.
        if (outcome.kind === 'rejected') {
          if (outcome.reason !== 'replay') rejectedCount += 1;
          continue;
        }

        if (outcome.kind === 'rename-app-label') {
          const existingEntry = labels[outcome.scopedContactId];
          // Stale-label guard (R-17): a rename whose clock is at or before the
          // stored entry's is a replay or a reorder, and must never regress a
          // label that has already moved on. Not remembered in
          // `seenOperationIds` — the comparison is against the grant's
          // CURRENT stored entry, so a later replay of the same operationId
          // is rejected identically and harmlessly, whether or not the label
          // has since moved further forward.
          if (existingEntry && existingEntry.updatedAt >= outcome.updatedAt) {
            rejectedCount += 1;
            continue;
          }
          // Label-cap guard (R-17): a 17th DISTINCT scoped id is refused
          // outright, never silently evicting an existing label to make room.
          // Renaming a scoped id already tracked never grows the count, so it
          // is exempt from the cap regardless of how full the map is.
          if (!existingEntry && Object.keys(labels).length >= MAX_APP_LABELS_PER_GRANT) {
            rejectedCount += 1;
            continue;
          }
        }

        try {
          if (outcome.kind === 'add-ken') {
            const applied = await cbRef.current.onAddKen(
              grant.directoryId, { pubkey: outcome.pubkey, displayName: outcome.displayName }, grant.appName, grant.grantId,
            );
            // R-28(b): the directory's app-created ceiling is the one refusal
            // worth retrying, so it is neither remembered nor counted as an
            // acceptance. Everything else is final either way.
            if (applied === 'directory-full') { rejectedCount += 1; continue; }
            if (applied === 'refused') { rejectedCount += 1; appliedIds.push(outcome.operationId); continue; }
          } else {
            await cbRef.current.onRenameAppLabel(grant.grantId, outcome.scopedContactId, outcome.label);
            // Only recorded after the caller's own write succeeds — a failed
            // application must not poison the in-memory map that gets
            // persisted below.
            const entry = { label: outcome.label, updatedAt: outcome.updatedAt };
            labels[outcome.scopedContactId] = entry;
            appliedLabels[outcome.scopedContactId] = entry;
          }
          appliedIds.push(outcome.operationId);
          acceptedCount += 1;
        } catch {
          // M2: the caller's own apply callback threw — a DIFFERENT failure
          // mode from a validation rejection, counted separately below. An
          // id that failed to apply is never remembered, so the next fetch
          // retries it regardless.
          sawApplyFailure = true;
          applyFailedCount += 1;
        }
      }

      // M2: drop the whole EVENT from `seenEvents` on any apply failure, so a
      // later re-delivery (a fresh backlog fetch, or the relay re-sending the
      // same replaceable event) retries it. Any operationId that DID apply
      // earlier in this same batch keeps its place in `appliedIds` /
      // `seenOperationIds` below, so a retry only re-attempts the ids that
      // actually failed — the rest are correctly seen as replays.
      if (sawApplyFailure) seenEvents.delete(eventId);

      // `keyStillLive()`, not `!cancelled`: anything in `appliedIds` has
      // already been applied by the caller's own callback, so its id has to be
      // remembered whether or not this effect run has been superseded. The
      // write is idempotent (`updateContactGrantV2` re-reads and declines a
      // no-op), and a grant revoked mid-batch is still refused by the mutate.
      if (appliedIds.length > 0 && keyStillLive()) {
        // R-22 (Task 28): the read-modify-write runs inside `db.ts`'s own
        // single grant-write queue, so a projection publish or a rail merge
        // touching the SAME row mid-flight cannot lose this batch's replay
        // memory (and this batch cannot lose theirs). The mutate below is
        // synchronous and touches ONLY this hook's own fields —
        // `seenOperationIds` and `appLabels` — spreading everything else
        // from the freshly-read `current`. The per-grant queue above stays:
        // it serialises the whole validate→apply→write pipeline (including
        // the caller's `onAddKen`/`onRenameAppLabel`), which the db-level
        // queue neither sees nor could serialise.
        await db.updateContactGrantV2(grant.grantId, encryptionKey!, (current) => {
          if (current.revokedAt) return null;
          const nextSeenOperationIds = rememberOperationIds(current.seenOperationIds, appliedIds);
          const seenChanged = nextSeenOperationIds.length !== current.seenOperationIds.length
            || nextSeenOperationIds.some((id, i) => id !== current.seenOperationIds[i]);
          // FOLD this batch's accepted renames into the row as it stands
          // right now — never write the pre-run snapshot over it. Each entry
          // re-runs the stale-clock guard against `current`, which is the
          // only comparison that can see a newer run's work, and the 16-label
          // cap is likewise counted against `current` rather than against a
          // count that may since have moved.
          const nextAppLabels = { ...current.appLabels };
          let labelsChanged = false;
          for (const [scopedId, entry] of Object.entries(appliedLabels)) {
            const existing = nextAppLabels[scopedId];
            // A newer label already on the row wins. `>=` not `>`: equal
            // clocks are not newer, same rule as the in-batch guard.
            if (existing && existing.updatedAt >= entry.updatedAt) continue;
            if (!existing && Object.keys(nextAppLabels).length >= MAX_APP_LABELS_PER_GRANT) continue;
            nextAppLabels[scopedId] = entry;
            labelsChanged = true;
          }
          // M4: even though something in THIS batch was accepted, the write
          // against the row as it stands right now may still be a no-op — skip
          // it rather than rewriting an identical snapshot.
          if (!seenChanged && !labelsChanged) return null;
          return {
            ...current,
            appLabels: nextAppLabels,
            seenOperationIds: nextSeenOperationIds,
            // Fix round 1, minor 5: `updatedAt` is the GRANTS RAIL's
            // last-writer-wins clock, and it moves only for something the
            // rail actually carries. `appLabels` is on the wire, so a rename
            // earns a bump. `seenOperationIds` is DEVICE-LOCAL by design
            // (R-2/S6 — a second device runs its own replay window) and is
            // excluded from `WireGrantV2` at the type level; bumping the
            // clock for it would let one device win every LWW comparison
            // purely by receiving proposals, silently reverting a genuine
            // rename made on another device that happened to be quieter.
            // Same rule the projections hook already follows for its
            // publish-state-only writes (I3).
            ...(labelsChanged ? { updatedAt: Date.now() } : {}),
          };
        });
      }
      // The COUNTERS stay behind `cancelled`, unlike the persist above. They
      // are display-only, an unmount is one of the things that sets this flag,
      // and the next run recounts what it sees — none of which is true of the
      // row write, which is the only durable consequence in this function.
      if (!cancelled) {
        if (acceptedCount > 0) setAccepted((n) => n + acceptedCount);
        if (rejectedCount > 0) setRejected((n) => n + rejectedCount);
        if (applyFailedCount > 0) setApplyFailed((n) => n + applyFailedCount);
      }
    }

    function handleEvent(grantId: string, event: NostrEvent): Promise<void> {
      if (cancelled || typeof event.id !== 'string' || seenEvents.has(event.id)) return Promise.resolve();
      const eventId = event.id;
      seenEvents.add(eventId);
      // R-18: the read→validate→apply→write pipeline for this event is ONE
      // queued task on this grant's own queue. The task calls the CALLER's
      // `onAddKen`/`onRenameAppLabel` (their own hooks/queues) but never
      // re-enters this hook's queue itself — the queue is not re-entrant.
      return queueFor(grantId).run(() => processEvent(grantId, event, eventId));
    }

    void (async () => {
      try {
        const grants = (await db.listContactGrantsV2(encryptionKey!)).filter((g) => !g.revokedAt && !!g.ownerIdentityPubkey);
        if (cancelled) return;
        for (const grant of grants) {
          const filter = toNostrFilter(proposalFilter(grant.appPubkey, grant.grantId));
          // A/I2: read relays UNION this grant's own relay. `grant.relay` is
          // fixed at pairing from `relays.write[0]`, and it is the ONLY relay
          // the SDK ever publishes a proposal to — but `resolveSyncRelays`
          // derives `read` and `write` from independent per-relay flags, so a
          // user whose first write relay is write-only had a proposal wire
          // that was silently dead in one direction: every proposal published,
          // none ever fetched, no error anywhere. The publish side already
          // unions the two (`contactsGrantPublishTargets`); this is the mirror.
          const targets = proposalReadTargets(relays.read, grant.relay);
          if (targets.length === 0) continue;
          // M3: deliberately no `since` — this is a REPLACEABLE event
          // (`limit: 1`, one `d`-tagged slot per app per grant), not a log to
          // page through. Proposal freshness is enforced AFTER decrypt, by
          // the validator's own `createdAt` check against `now`.
          const backlog = await fetchEvents([filter], { relays: targets });
          if (cancelled) return;
          for (const event of backlog) await handleEvent(grant.grantId, event);
          if (cancelled) return;
          unsubscribes.push(subscribeEvents([filter], targets, (event) => {
            void handleEvent(grant.grantId, event);
          }));
        }
        if (!cancelled) setLastInboxAt(Date.now());
      } catch {
        // Non-fatal: the next unlock or grant change retries the whole inbox.
        if (!cancelled) setLastInboxAt(Date.now());
      }
    })();

    return () => {
      cancelled = true;
      for (const stop of unsubscribes) { try { stop(); } catch { /* already closed */ } }
      unsubscribes.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, encryptionKey, relays.read.join(','), grantsToken]);

  return { lastInboxAt, accepted, rejected, applyFailed };
}
