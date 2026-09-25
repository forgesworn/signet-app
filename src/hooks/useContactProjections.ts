import { contactsForGrant } from '../lib/contacts-v2-grant-scope';
/**
 * Publish each active grant's projection when its directory changes.
 *
 * Timing follows the personas rail rather than the exploration's six-hour slot:
 * a 6–91 s jittered delay (`computePublishDelayMs`). The §7 review note is
 * explicit that a six-hour slot is also a six-hour data-loss window — contacts
 * added at a meetup, phone lost that evening, gone — and that the shipped
 * debounce+jitter is the defensible middle. It spreads two devices' publishes
 * without holding the only copy of a change for a quarter of a day.
 *
 * `safetyToken` bypasses the jitter entirely AND the hash-dedupe below. Block,
 * Unblock and revocation publish at once: safety and authority changes take
 * priority over timing privacy (exploration §7, spec §7.9) — "at once" also
 * means the degenerate case where the projection happens to hash identically
 * to the last one already out (nothing else about the directory changed)
 * still goes out, rather than being silently absorbed by the efficiency
 * optimisation the dedupe exists for. The caller decides what counts — this
 * hook only honours the distinction.
 *
 * R-4: the body is sealed with `sealVaultPayload`, wrapped to the APP's pubkey
 * rather than to self, so a projection is padded into the same size buckets as
 * every other rail. A bare NIP-44 ciphertext would leak the directory's size,
 * and with the hash-dedupe below a relay would learn exactly when a directory
 * changed and roughly by how much.
 *
 * R-8: `enabled` is false on a paired-child install. A kid's device must not
 * publish its own `dependant:<id>` directory to a rail only the guardian can
 * revoke.
 *
 * R-30: the consumer now orders projections by `frontier.publishedAt` FIRST,
 * with `maxClock` only as the same-second tiebreak — a Lamport clock measures
 * how much of the owner's log a DEVICE has seen, not how recent the snapshot
 * is, so a block published from a device that had not yet merged the other
 * device's recent operations used to be refused wholesale. That makes
 * `publishedAt` a real publish moment rather than decoration: it comes from
 * `nextProjectionStamp`, which is monotonic per grant across every caller in
 * the process, and a stale or zeroed value would now simply lose.
 *
 * R-29: an unchanged directory is still republished once a grant is halfway
 * through its own staleness window — see `keepaliveDue` below.
 *
 * Everything is best-effort. A relay failure leaves `lastProjectionHash`
 * unwritten (so the next run retries) but DOES record
 * `lastPublishState: 'failed'`, so the connected-apps list can say so; nothing
 * throws out of the effect.
 */
import { useEffect, useRef, useState } from 'react';
import { PROJECTION_KIND, buildProjection, projectionEventTemplate, projectionTag } from '@forgesworn/signet-contacts/wire';
import type { ContactProjectionV2 } from '@forgesworn/signet-contacts/wire';
import type { AppGrantV2 } from '../types';
import * as db from '../lib/db';
import { applyOperations } from '../lib/contacts-v2-reducer';
import { resolveEffectiveDirectory, type EffectiveContext } from '../lib/contacts-v2-effective';
import { buildContactProjection, hashProjection } from '../lib/contact-projection';
import { sealVaultPayload } from '../lib/vault-envelope';
import { LocalSigningBackend } from '../lib/signing-backend';
import { fetchNewestFromRelays, publishToRelays } from '../lib/sync-relays';
import { computePublishDelayMs } from '../lib/personas-sync';
import { isValidRelayUrl } from '../lib/relay-url';

/** R-14: App composes these from the landed `familyDirectoryRefs` +
 *  `scopeEffectiveContext`. Nothing here builds a directory list of its own. */
export interface ProjectionDirectory {
  directoryId: string;
  /** Local roster only; never placed in a projection. */
  ownerIdentityPubkeys?: readonly string[];
  context: Omit<EffectiveContext, 'creatingActorRole'>;
}

export interface UseContactProjectionsOptions {
  enabled: boolean;
  encryptionKey: string | null;
  relays: { read: string[]; write: string[] };
  /**
   * MUST be a memoised (stable-identity) array. It sits in the effect's
   * dependency list by reference (R-14) — a fresh array literal on every
   * render re-arms the publish timer on every render, including the ones
   * this hook's own state updates (`setPublishing`/`setPublished`/
   * `setLastRunAt`) cause, and it never gets a chance to fire.
   */
  directories: ProjectionDirectory[];
  /** `AppPreferences.contactsDeviceId` — stamped into every frontier (C13). */
  deviceId: string | null;
  changeToken: string;
  safetyToken: string;
}

function nowSec(): number { return Math.floor(Date.now() / 1000); }

/**
 * R-24, fix round 2 (item I): the per-grant monotonic stamp is MODULE scope,
 * not hook-private. Round 1 held it in a per-hook-instance ref, which is fine
 * for two publishes from the SAME hook but does nothing for a grant whose
 * projection is also published from a totally different call site — Task
 * 22's revoke handler calls `publishProjectionForGrant` directly, with its
 * own idea of `now`. A revocation racing a live projection must never carry
 * a `created_at` at or behind the live one just because it was minted by a
 * different caller; sharing this map across every caller in the process is
 * what closes that gap.
 *
 * NOT reset on identity change (round 1 did this; dropped here): `Math.max`
 * already can't go backwards on its own, so a reset buys nothing but the
 * ability to accidentally repeat a stamp this process has already used for
 * the grant.
 */
const lastProjectionStamp = new Map<string, number>();

/**
 * Mirrors `contacts-v2-grants-rail.ts`'s own `normaliseNow` (same file, same
 * reasoning): a `now` that isn't plausible integer seconds falls back to the
 * real clock rather than being used as-is, so a caller bug can't poison the
 * shared chain with a value every later publish — from ANY caller — would
 * then have to exceed forever.
 */
function normaliseNow(now: number): number {
  return (Number.isInteger(now) && now > 0 && now < 1e11) ? now : nowSec();
}

/**
 * The one function that reads or advances the shared chain. `now` defaults
 * to the real clock; a caller may pass its own (as `publishProjectionForGrant`
 * does, seeding from `projection.issuedAt`) and — per the module doc above —
 * a `now` that is behind what this grant has already published under is
 * simply ignored in favour of `prev + 1`.
 */
export function nextProjectionStamp(grantId: string, now: number = nowSec()): number {
  const candidate = normaliseNow(now);
  const prev = lastProjectionStamp.get(grantId) ?? 0;
  const t = Math.max(candidate, prev + 1);
  lastProjectionStamp.set(grantId, t);
  return t;
}

/**
 * A-I4: the floor a revocation tombstone must be stamped above.
 *
 * Projections and the tombstone share ONE replaceable slot (`d =
 * projectionTag(grantId)`) and the SDK reads it newest-first, so a tombstone
 * the relay ranks OLDER than the live projection is one the consumer will
 * never be handed — it goes on reading the directory it already has until its
 * own staleness window runs out. `nextProjectionStamp` alone cannot prevent
 * that: the chain is per PROCESS, and a fresh-start device (or a second device
 * whose clock trails the publishing one) has an empty chain and stamps plain
 * wall clock.
 *
 * So: read what is actually in the slot first, best-effort, and return
 * `max(now, live.created_at + 1)` as the floor. Bounded at
 * `LIVE_STAMP_READ_MS` and swallowed whole — an unreachable relay, a slow one,
 * or no event at all all fall back to the local chain, which is exactly the
 * pre-existing behaviour. Revocation must never be delayed or refused by a
 * relay read that is only ever an optimisation.
 */
const LIVE_STAMP_READ_MS = 3000;

export async function liveProjectionStampFloor(
  grant: AppGrantV2, relays: string[],
): Promise<number> {
  const now = nowSec();
  if (relays.length === 0) return now;
  try {
    const read = fetchNewestFromRelays(
      {
        kinds: [PROJECTION_KIND], authors: [grant.railPubkey],
        '#d': [projectionTag(grant.grantId)], limit: 1,
      },
      relays,
      grant.railPubkey,
    ).then((r) => r.event);
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), LIVE_STAMP_READ_MS);
    });
    const live = await Promise.race([read, timeout]);
    const created = live?.created_at;
    return typeof created === 'number' && Number.isFinite(created)
      ? Math.max(now, Math.floor(created) + 1)
      : now;
  } catch {
    return now;
  }
}

/**
 * B-Critical: the frontier's `deviceId` for a tombstone, from the grant row
 * when this device has no contacts device id of its own. A revoke must never
 * bail for want of a 32-hex label, and the rail pubkey's first 32 characters
 * are 32 lowercase hex by construction, stable, and already known to the app
 * on the other end — an honest stand-in for "the device that revoked this
 * grant" rather than a reason to publish nothing.
 */
export function tombstoneDeviceId(grant: AppGrantV2, deviceId: string | null | undefined): string {
  return (deviceId && /^[0-9a-f]{32}$/.test(deviceId)) ? deviceId : grant.railPubkey.slice(0, 32);
}

/**
 * Seal, sign and publish one grant's projection. The rail backend is built
 * INSIDE the try (C2): a corrupt `railPrivateKey` must fail only THIS grant —
 * constructing it outside would throw out of the function entirely, past the
 * caller's per-grant handling, aborting every remaining grant and directory
 * in the run with no `'failed'` ever recorded for any of them. `rail?.destroy()`
 * in `finally` covers both outcomes: a real rail that ran, and a construction
 * that never produced one.
 *
 * R-24, fix round 2 (item I): `created_at` is minted from the SHARED chain
 * (`nextProjectionStamp`), seeded with `projection.issuedAt` — not trusted
 * verbatim. Round 1 used `projection.issuedAt` directly on the theory that
 * the caller had already stamped it from the same source; that only holds
 * when this hook is the ONLY caller. A different caller for the same grant —
 * this hook processing a later grant in the same pass, or Task 22's revoke
 * handler building its own projection with its own `now` — may have already
 * advanced the chain past whatever `now` this particular projection was
 * built with, so this function re-derives the actual value to publish under
 * rather than assuming the embedded one is still current. `issuedAt` and
 * `frontier.publishedAt` inside the SEALED body are therefore no longer
 * guaranteed to equal the outer event's `created_at` — both remain
 * independently monotonic per grant, which is what each side (the relay's
 * tie-break on `created_at`, the SDK consumer's own check on
 * `frontier.publishedAt`) actually needs.
 */
export async function publishProjectionForGrant(
  grant: AppGrantV2, projection: ContactProjectionV2, relays: string[],
): Promise<{ ok: boolean; eventId?: string; hash: string; state: 'ok' | 'truncated' | 'failed' }> {
  const hash = hashProjection(projection);
  let rail: LocalSigningBackend | undefined;
  try {
    rail = new LocalSigningBackend(grant.railPrivateKey);
    // R-4: padded envelope, content key wrapped to the app rather than to self.
    const content = await sealVaultPayload(
      buildProjection(projection), rail, { recipientPubkey: grant.appPubkey },
    );
    if (content === null) return { ok: false, hash, state: 'failed' };
    const createdAt = nextProjectionStamp(grant.grantId, projection.issuedAt);
    const template = projectionEventTemplate(rail.activePublicKeyHex, grant.grantId, createdAt, content);
    const signed = await rail.signEvent(template);
    const ok = await publishToRelays(signed, relays);
    if (!ok) return { ok: false, eventId: signed.id, hash, state: 'failed' };
    return { ok: true, eventId: signed.id, hash, state: projection.truncated === true ? 'truncated' : 'ok' };
  } catch {
    return { ok: false, hash, state: 'failed' };
  } finally {
    rail?.destroy();
  }
}

/**
 * R-29: the keepalive.
 *
 * A grant's projection carries `expiresAt = issuedAt + maxStalenessSeconds`,
 * and the consumer flips `isFresh` false at that moment and can never flip it
 * back on its own — a re-fetch of the same replaceable event is refused as
 * not-newer. Before this, nothing ever republished an UNCHANGED directory: the
 * effect only ran on a change token, and the hash dedupe would have skipped it
 * even if it had. So a directory nobody edits went permanently stale, and the
 * approval screen's freshness picker ("How fresh must its copy be?") chose
 * nothing but how quickly that happened — an hour on the shortest setting.
 *
 * A grant is republished once it is halfway through its own window. Half,
 * rather than at expiry, so one failed publish still has a whole window's worth
 * of retries before the app actually goes stale; and per grant, off that
 * grant's own `maxStalenessSeconds`, because the owner chose the window per
 * app. The dedupe is bypassed for a keepalive — the whole point is to
 * republish content that has not changed.
 *
 * The timer is armed from the run itself rather than from an interval: the
 * effect's dependencies do not change on their own, so the cycle has to be
 * self-sustaining. `KEEPALIVE_MIN_MS` keeps a misconfigured (or tiny) window
 * from becoming a busy loop; `KEEPALIVE_MAX_MS` keeps a seven-day window from
 * parking a single timer that a backgrounded phone will never honour anyway,
 * so the check re-runs at least hourly and the real decision is made from the
 * stored `lastProjectionAt` each time.
 */
const KEEPALIVE_MIN_MS = 60_000;
const KEEPALIVE_MAX_MS = 3_600_000;

/** True when this grant is at or past half its own staleness window. */
export function keepaliveDue(
  grant: Pick<AppGrantV2, 'lastProjectionAt' | 'maxStalenessSeconds'>, now: number,
): boolean {
  const last = grant.lastProjectionAt;
  if (typeof last !== 'number' || !Number.isFinite(last)) return false;
  return now - last >= grant.maxStalenessSeconds / 2;
}

/** Milliseconds until this grant's next keepalive, floored at zero. */
export function keepaliveDelayMs(
  grant: Pick<AppGrantV2, 'lastProjectionAt' | 'maxStalenessSeconds'>, now: number,
): number {
  const last = grant.lastProjectionAt;
  if (typeof last !== 'number' || !Number.isFinite(last)) return 0;
  return Math.max(0, (last + grant.maxStalenessSeconds / 2 - now) * 1000);
}

/**
 * Whether this grant may arm a keepalive timer at all.
 *
 * A keepalive keeps a SUCCESSFUL publish from expiring. A grant that has never
 * published — or whose last attempt failed — has nothing to keep alive, and
 * arming one for it would re-run the whole directory (a full operation-log
 * decrypt, a reduce, a seal, a relay attempt) every `KEEPALIVE_MIN_MS` for as
 * long as the app stays unlocked, with no backoff and nothing to show for it.
 * A failed publish retries through `changeToken` / `safetyToken` and the
 * jitter, which is where retry policy belongs.
 *
 * `lastProjectionAt` is written ONLY on a successful publish, so its absence
 * already means "never published". The `'failed'` check covers the other
 * shape: a grant that published once and has been failing since, whose
 * `lastProjectionAt` is real but stale.
 *
 * `'truncated'` IS armable. It is a successful publish — `publishProjectionForGrant`
 * only returns it with `ok: true`, and the row's `lastProjectionAt` was
 * written — so its `expiresAt` is ticking exactly like an `'ok'` one's, and a
 * large stable directory is precisely the case that would otherwise go
 * permanently stale. (The ruling's wording was `!== 'ok'`; `!== 'failed'` is
 * what matches its stated reason, which names failed publishes and the
 * absence of backoff.)
 */
export function keepaliveArmable(
  grant: Pick<AppGrantV2, 'lastProjectionAt' | 'lastPublishState'>,
): boolean {
  const last = grant.lastProjectionAt;
  if (typeof last !== 'number' || !Number.isFinite(last)) return false;
  return grant.lastPublishState !== 'failed';
}

/** One grant as the keepalive decision sees it. */
export type KeepaliveCandidate =
  Pick<AppGrantV2, 'lastProjectionAt' | 'maxStalenessSeconds' | 'lastPublishState'>;

/**
 * The whole arming decision for one run: the delay to set a timer for, or
 * `null` for "arm nothing".
 *
 * Pure, and exported, because it is the only part of the keepalive that can be
 * tested honestly. Whether a `setTimeout` FIRES is not observable in this
 * suite — the surrounding tests switch between real and fake timers to let
 * real PBKDF2 work resolve, so a timer armed during a real-timer window is not
 * driven by a later `advanceTimersByTime`. The decision, though, is entirely a
 * function of the grants the run saw, and that is where every rule lives:
 *
 * - a grant with nothing to keep alive is skipped (`keepaliveArmable`);
 * - `null` when NO grant qualifies — not a fallback delay, which is what
 *   `Math.max(MIN, Infinity)` would silently have produced;
 * - otherwise the soonest grant's delay, clamped to
 *   `[KEEPALIVE_MIN_MS, KEEPALIVE_MAX_MS]` so a tiny window cannot become a
 *   busy loop and a seven-day one still re-checks hourly against the stored
 *   `lastProjectionAt` rather than parking a timer a backgrounded phone would
 *   never honour.
 */
export function keepaliveDelayForRun(
  grants: Iterable<KeepaliveCandidate>, now: number,
): number | null {
  let soonest = Infinity;
  for (const g of grants) {
    if (!keepaliveArmable(g)) continue;
    soonest = Math.min(soonest, keepaliveDelayMs(g, now));
  }
  if (!Number.isFinite(soonest)) return null;
  return Math.min(KEEPALIVE_MAX_MS, Math.max(KEEPALIVE_MIN_MS, soonest));
}

export function useContactProjections({
  enabled, encryptionKey, relays, directories, deviceId, changeToken, safetyToken,
}: UseContactProjectionsOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** R-29: the per-grant keepalive timer — see `KEEPALIVE_*` above. */
  const keepaliveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const queuedRef = useRef(false);
  // `null` until the first effect run, so a first mount is never "immediate".
  const lastSafetyRef = useRef<string | null>(null);
  // Set whenever a safety-triggered run is scheduled or coalesced into a
  // queued one, and consumed (read then cleared) at the START of whichever
  // `run()` actually executes next — never at the "already running, queue it"
  // early return, so the bypass survives coalescing regardless of which
  // effect invocation's closure ends up doing the work. A safety publish
  // (block/unblock/revoke) has to go out even in the degenerate case where
  // the projection content happens to be byte-identical to the last one this
  // app already has — "publish at once" (module docstring) means the dedupe
  // optimisation stands down too, not just the jitter.
  const bypassDedupeRef = useRef(false);
  // Fix round 2 (item C): replaces round 1's per-closure `cancelled` boolean.
  // `genRef` advances by one on every effect (re-)run; a `run()` closure
  // captures its OWN `gen` at definition time and is stale the moment
  // `genRef.current` moves past it — checked before the seal/publish and
  // before every grant-row write, same as `cancelled` was. The difference is
  // `runRef`: it always holds the LATEST effect invocation's `run`, and the
  // "restart a queued run" line in `finally` calls THAT, unconditionally —
  // not the finishing run's own (possibly stale) closure. Round 1's bug: run
  // A in flight, a token changes (cleanup marks A stale, a NEW effect B sets
  // up and its own timer fires immediately, finds `runningRef` still true and
  // only sets `queuedRef`), A resolves and reaches `finally` — checking A's
  // OWN staleness there refused the restart entirely, silently dropping B's
  // (often safety-critical) publish. Calling `runRef.current()` instead means
  // whichever invocation is CURRENT always gets the retry, regardless of
  // which invocation happened to be the one finishing.
  const genRef = useRef(0);
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const [publishing, setPublishing] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [published, setPublished] = useState(0);

  useEffect(() => {
    // Fix round 2 (item C): this invocation's generation, bumped
    // UNCONDITIONALLY — before either early-return guard below — so an
    // in-flight run from a PREVIOUS invocation is correctly recognised as
    // stale even when this invocation itself has nothing to do (disabled,
    // key gone, no write relay). Leaving the bump behind an early return
    // would let a run started while enabled outlive a transition to
    // disabled without ever noticing.
    const gen = ++genRef.current;
    const isStale = (): boolean => genRef.current !== gen;

    if (!enabled || !encryptionKey || !deviceId) return;
    if (relays.write.length === 0 || directories.length === 0) return;

    // Read and update the safety marker INSIDE the effect, never during
    // render: under StrictMode a render runs twice, and a flag computed there
    // is consumed by the first pass and gone by the second.
    const immediate = lastSafetyRef.current !== null && lastSafetyRef.current !== safetyToken;
    lastSafetyRef.current = safetyToken;
    if (immediate) bypassDedupeRef.current = true;

    // `isStale()` is true the moment a NEWER effect invocation has set up
    // (`genRef.current` has moved past `gen`) — checked before the
    // seal/publish and before every grant-row write, same three checkpoints
    // round 1's `cancelled` covered. What changed is the restart at the
    // bottom of `finally`: it no longer asks "am I (the finishing run) still
    // current" — it always calls `runRef.current()`, so a queued request
    // left behind by a NEWER, still-current invocation is honoured via THAT
    // invocation's own `run`, not lost because the run that happened to
    // finish first was stale.

    async function run(): Promise<void> {
      // Round-2 re-review (Task 28, item 12): a stale invocation's `run` does
      // no work at all — not even the first `listContactOperationsV2` decrypt.
      // The restart in `finally` calls `runRef.current`, which always holds
      // the LATEST invocation's closure, so a genuinely queued run still
      // fires; the only closure this guard turns away is one whose effect has
      // already been cleaned up (an unmount bumps `genRef` too), which would
      // otherwise decrypt the whole operation log for a component that is
      // gone. It also means a stale run never marks `queuedRef`, so it cannot
      // leave a request behind that only it would have served.
      if (isStale()) return;
      if (runningRef.current) { queuedRef.current = true; return; }
      runningRef.current = true;
      const bypassDedupe = bypassDedupeRef.current;
      bypassDedupeRef.current = false;
      setPublishing(true);
      // R-29: every active grant this run saw, with the `lastProjectionAt` it
      // ends the run on — the stored one when nothing was published, the fresh
      // stamp when something was. One timer is armed from the soonest of them
      // at the end, rather than one timer per grant.
      const seen = new Map<string, {
        lastProjectionAt?: number;
        maxStalenessSeconds: number;
        lastPublishState?: AppGrantV2['lastPublishState'];
      }>();
      try {
        for (const directory of directories) {
          // B/M2: the only `isStale()` checkpoints used to be inside the
          // per-grant block, so a directory with no active grants `continue`d
          // without one — after a lock, the run went on decrypting every
          // remaining directory's grant list with the captured key before it
          // could return.
          if (isStale()) return;
          const grants = await db.listContactGrantsV2ForDirectory(directory.directoryId, encryptionKey!);
          const active = grants.filter((g) => !g.revokedAt);
          if (active.length === 0) continue;

          const ops = await db.listContactOperationsV2(directory.directoryId, encryptionKey!);
          const records = [...applyOperations(ops).values()];
          const effective = resolveEffectiveDirectory(records, {
            ...directory.context, creatingActorRole: undefined,
          });

          for (const grant of active) {
            seen.set(grant.grantId, {
              lastProjectionAt: grant.lastProjectionAt,
              maxStalenessSeconds: grant.maxStalenessSeconds,
              lastPublishState: grant.lastPublishState,
            });
            // R-17: `AppGrantV2.appLabels` carries the label's own
            // last-writer-wins clock (`AppLabelEntry.updatedAt`) so the
            // grants rail can reconcile a rename; the projection builder
            // only ever needs the current text.
            const appLabels: Record<string, string> = {};
            for (const [scopedId, entry] of Object.entries(grant.appLabels)) {
              appLabels[scopedId] = entry.label;
            }
            // R-24: one stamp from the shared (module-scope, fix round 2)
            // chain, used for `frontier.publishedAt`/`issuedAt` here;
            // `publishProjectionForGrant` draws its OWN stamp from the same
            // chain for the event `created_at` (see its docstring for why
            // the two are no longer required to be numerically equal).
            const t = nextProjectionStamp(grant.grantId);
            const projection = buildContactProjection({
              grantId: grant.grantId,
              capabilities: grant.capabilities,
              contacts: contactsForGrant(grant, !directory.ownerIdentityPubkeys || directory.ownerIdentityPubkeys.includes(grant.ownerIdentityPubkey ?? '') ? effective : [], ops),
              frontier: {
                maxClock: 0, opCount: 0,
                publishedAt: t, deviceId: grant.grantId,
              },
              appLabels,
              issuedAt: t,
              maxStalenessSeconds: grant.maxStalenessSeconds,
            });
            const hash = hashProjection(projection);
            // R-29: a grant halfway through its own staleness window is
            // republished even when nothing changed — that is the whole point
            // of a keepalive, so the dedupe stands down for it exactly as it
            // does for a safety publish.
            const keepalive = keepaliveDue(grant, t);
            if (!bypassDedupe && !keepalive && hash === grant.lastProjectionHash) continue;

            // I2: publish to every valid configured write relay AND the
            // grant's own relay (the one the app actually reads, fixed at
            // pairing) — a write-relay-set edit after pairing must not orphan
            // an existing grant on a relay nobody in `relays.write` covers.
            const validWrite = relays.write.filter(isValidRelayUrl);
            const targets = Array.from(new Set(
              isValidRelayUrl(grant.relay) ? [...validWrite, grant.relay] : validWrite,
            ));

            if (isStale()) return;
            // B/M3: `active` was filtered once per directory, so "this grant
            // has not been revoked" was decided before every await in between
            // — and the only thing keeping a live projection from landing on
            // top of a revocation tombstone was a React commit happening to
            // arrive during the relay call. Re-read the row HERE, through the
            // same serial grant-write queue the revoke handler's own write
            // goes through, so a revoke that has already been queued is
            // visible rather than raced. The mutate writes nothing.
            // Fails CLOSED: the flag starts false and is only ever set from
            // inside the mutate, which a forgotten row never reaches (the
            // update resolves `null` without calling it) and a failed read
            // never reaches either. Not publishing a grant that is still live
            // costs one delayed update; publishing over a tombstone costs the
            // app its revocation.
            let stillActive = false;
            await db.updateContactGrantV2(grant.grantId, encryptionKey!, (current) => {
              stillActive = !current.revokedAt;
              return null;
            }).catch(() => { /* a row that cannot be read is not one to publish */ });
            if (!stillActive || isStale()) continue;

            const res = await publishProjectionForGrant(grant, projection, targets);
            if (isStale()) return;

            // R-22 (Task 28): the "revoke may have raced this run" re-read and
            // the write-back are now ONE queued read-modify-write inside
            // `db.ts` (`updateContactGrantV2`), rather than a separate
            // `getContactGrantV2` followed by a whole-row `saveContactGrantV2`
            // that clobbered whatever a proposal batch or a rail merge wrote in
            // between. The mutate is synchronous, returns `null` for a grant
            // revoked (or forgotten) mid-run so nothing is resurrected, and
            // touches ONLY this hook's own three fields. I3: `updatedAt` is the
            // grants rail's LWW key for USER-meaningful edits — a
            // publish-state-only write must never bump it, which spreading
            // `current` unchanged is what guarantees.
            if (!res.ok) {
              if (isStale()) return;
              // R-5: the failure is recorded, so a permanently unpublishable
              // grant is distinguishable from a quiet one. The hash is NOT
              // written, so the next change retries.
              await db.updateContactGrantV2(grant.grantId, encryptionKey!, (current) => (
                current.revokedAt ? null : { ...current, lastPublishState: 'failed' }
              ));
              continue;
            }
            if (isStale()) return;
            // `wrote` is set by the mutate itself rather than inferred from the
            // return value: `updateContactGrantV2` hands back the CURRENT row
            // both when it wrote and when the mutate declined, and only an
            // actual write should count as a published projection.
            let wrote = false;
            await db.updateContactGrantV2(grant.grantId, encryptionKey!, (current) => {
              if (current.revokedAt) return null;
              wrote = true;
              return {
                ...current,
                lastProjectionHash: res.hash,
                lastProjectionAt: t,
                lastPublishState: res.state,
              };
            });
            if (wrote) {
              setPublished((n) => n + 1);
              seen.set(grant.grantId, {
                lastProjectionAt: t,
                maxStalenessSeconds: grant.maxStalenessSeconds,
                lastPublishState: res.state,
              });
            }
          }
        }
        setLastRunAt(Date.now());
      } catch {
        // Non-fatal: local IDB stays authoritative and the next change retries.
      } finally {
        runningRef.current = false;
        setPublishing(false);
        // R-29: arm the next keepalive from whatever this run actually saw.
        // Nothing else re-arms the effect — its dependencies do not move on
        // their own — so this is what keeps an unedited directory fresh.
        if (keepaliveRef.current) { clearTimeout(keepaliveRef.current); keepaliveRef.current = null; }
        if (!isStale()) {
          // The whole decision is `keepaliveDelayForRun` — see its docstring.
          // `null` means arm nothing, which is the case for a run whose grants
          // have never published or whose last publish failed.
          const delay = keepaliveDelayForRun(seen.values(), nowSec());
          if (delay !== null) {
            keepaliveRef.current = setTimeout(() => {
              keepaliveRef.current = null;
              void runRef.current();
            }, delay);
          }
        }
        // Fix round 2 (item C): unconditional — `runRef.current` is always
        // the LATEST invocation's `run`, whether or not THIS run is the one
        // that happens to be finishing. A stale run restarting itself would
        // reprocess with a closure the caller has already moved on from; not
        // restarting anything, ever, if the finishing run happened to be
        // stale is what silently dropped a queued safety publish before.
        if (queuedRef.current) { queuedRef.current = false; void runRef.current(); }
      }
    }

    runRef.current = run;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; void run(); },
      immediate ? 0 : computePublishDelayMs());

    return () => {
      // On a genuine unmount no NEW effect invocation ever runs to bump
      // `genRef` itself, so this run's own staleness would never be noticed
      // without bumping it here too. On a dependency-driven re-run this is
      // redundant with the next invocation's own bump at the top — harmless,
      // `isStale()` only ever tests inequality.
      genRef.current += 1;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (keepaliveRef.current) { clearTimeout(keepaliveRef.current); keepaliveRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, encryptionKey, deviceId, relays.write.join(','), directories, changeToken, safetyToken]);

  return { publishing, lastRunAt, published };
}
