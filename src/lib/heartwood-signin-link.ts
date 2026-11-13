/**
 * "Sign in with Signet" with the site signing straight on the Heartwood that
 * holds the identity's key.
 *
 * On approval, when the user chooses it, this phone asks that Heartwood (over
 * the operator channel) to mint a client slot addressed to the identity
 * (`create_client_v2` with `identity`) and puts the `bunker://` link the device
 * returns in the sign-in response, where the site's SDK already looks for it.
 * The SDK connects to the device with its own persistent client key; the first
 * use binds the slot silently. My Signet can then be closed.
 *
 * Everything here is pure or runs on injected I/O, so the order of the steps
 * (which is what keeps a failure from leaving a live, unrecorded slot behind)
 * is tested without the app. The link holds the slot's secret: it is read from
 * the device's reply, checked, and handed on in the response. It is never
 * logged, stored or shown, and none of the errors here carry it.
 */
import { CAP_CLIENT_POLICY_V2, CAP_PAIRING_IDENTITY } from './heartwood-mgmt-types';
import type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';
import { hasCapability } from './heartwood-mgmt';
import type { CreateClientV2Reply, DeviceIdentity, HeartwoodMgmtClient } from './heartwood-mgmt';
import { handoffPolicy, findHeartwoodHolder, HandoffNoAnswerError, HANDOFF_NO_ANSWER_COPY, type HandoffHolder } from './heartwood-handoff';
import { HeartwoodCopyError, heartwoodMgmtErrorCopy } from './heartwood-mgmt-error-copy';
import { isNoSuchSlotError, isStaleClientSlotMessage } from './child-device-pairing';
import { isValidRelayUrl } from './relay-url';
import type { HeartwoodSignInLinkRecord } from './db';

/** Longest label this phone asks for. The firmware stores a label as given and sets no smaller limit that could be found. */
export const SIGN_IN_LINK_LABEL_MAX = 48;
const LABEL_PREFIX = 'mysignet:';
const SUFFIX_LEN = 8;

export const SIGN_IN_LINK_NO_ANSWER_COPY = "Your Heartwood didn't answer. Check it's on and online, then try again, or choose the other option.";
export const SIGN_IN_LINK_UNSUPPORTED_COPY = "This Heartwood's software can't give a site a direct link yet. Update it, or choose the other option.";
/** None of the managed Heartwoods holds the identity (every one answered): not a "didn't answer". */
export const SIGN_IN_LINK_UNAVAILABLE_COPY = "None of the Heartwoods this phone manages holds this identity. Add that Heartwood's operator key in Advanced settings, or choose the other option.";
export const SIGN_IN_LINK_SIGNER_MISMATCH_COPY = "This sign-in was signed by a different key than the one chosen, so no link was made. Try again, or choose the other option.";
export const SIGN_IN_LINK_NO_OPERATOR_COPY = "This phone no longer has the operator key for the Heartwood this site signs on. Add it in Advanced settings, or choose Forget on this phone and remove the link in Sapwood.";
export const SIGN_IN_LINK_CANT_CARRY_COPY = "This sign-in can't carry a link to your Heartwood. Choose the other option.";
/** The note under the Straight option when the request arrived by relay or QR, where nothing proves where it came from. */
export function signInLinkUnverifiedOriginCopy(host: string): string {
  return `My Signet can't confirm this request came from ${host}. Use this only if you started signing in on ${host} yourself.`;
}
/** What Forget on this phone says once a link's slot could not be taken off the Heartwood. */
export const SIGN_IN_LINK_FORGET_HERE_COPY = 'The link may still be on your Heartwood. You can remove it in Sapwood.';
/** A pending or unbound link older than this is taken off the device by the next reconcile pass. */
export const SIGNIN_LINK_UNBOUND_TTL_MS = 10 * 60 * 1000;
/** How long after a hand-over the app looks again at the slot it made. */
export const SIGNIN_LINK_RECONCILE_DELAY_MS = SIGNIN_LINK_UNBOUND_TTL_MS + 30_000;

/** A revoke that can't be attempted: this phone holds no operator key for the link's Heartwood. */
export class SignInLinkUnmanagedError extends HeartwoodCopyError {
  readonly unmanaged = true;
  constructor() {
    super(SIGN_IN_LINK_NO_OPERATOR_COPY);
    this.name = 'SignInLinkUnmanagedError';
  }
}

export const SIGN_IN_LINK_NOT_OFFERED_COPY = "Straight to my Heartwood isn't available for this identity. Choose the other option.";
export const SIGN_IN_LINK_MISMATCH_COPY = "Your Heartwood answered with a link this phone didn't ask for, so it wasn't used. Try again, or choose the other option.";
export const SIGN_IN_LINK_MISMATCH_KEPT_COPY = "Your Heartwood answered with a link this phone didn't ask for, and didn't confirm removing it. It's in Where you're known, where you can disconnect it, or remove it in Sapwood.";
export const SIGN_IN_LINK_NOT_SAVED_COPY = "This phone couldn't save the link, so it was undone on your Heartwood. Try again.";
export const SIGN_IN_LINK_NOT_SAVED_KEPT_COPY = "This phone couldn't save the link, and your Heartwood didn't confirm undoing it. Remove the site from your Heartwood in Sapwood, then try again.";

/** What must hold before "Straight to my Heartwood" is offered or honoured. */
export interface SignInLinkEligibility {
  signingMode: string | undefined;
  isPairedChild: boolean;
  childDirect: boolean;
  hasActiveDependant: boolean;
  /** Which kind of identity was picked; only the owner's own can be handed over. */
  selectionSource: 'guardian' | 'dependant' | undefined;
  /** An imported persona is not on the device, so no device can sign for it. */
  importedPersona: boolean;
  hasOperatorClient: boolean;
  /** The combined app-permission sign-in keeps its own answer. */
  combinedPermission: boolean;
  /** The picked identity's kind; the real identity (`natural-person`) is never handed over. */
  selectionKeypairType: string | undefined;
  /** The request has somewhere to put a link: the relay path or a redirect callback. */
  requestCanCarryLink: boolean;
}

/** The parts of a sign-in request that say how it travels. */
export interface SignInRequestShape { relay?: string; sessionPubkey?: string; callbackUrl?: string }

/** Arrived by relay or QR (cross-device): nothing about it proves where it came from. */
export function signInRequestIsRelay(r: SignInRequestShape): boolean {
  return !!(r.relay && r.sessionPubkey);
}

/** A link can only be sent by relay or to a redirect callback; a same-device BroadcastChannel answer has no place for it. */
export function signInRequestCanCarryLink(r: SignInRequestShape): boolean {
  return signInRequestIsRelay(r) || !!r.callbackUrl;
}

/** The key that signed the challenge must be the identity the link is for; anything else mints nothing. */
export function assertSignedByLinkPersona(signerPubkey: string, persona: string): void {
  if (signerPubkey.toLowerCase() !== persona.toLowerCase()) throw new HeartwoodCopyError(SIGN_IN_LINK_SIGNER_MISMATCH_COPY);
}

export function signInLinkOffered(i: SignInLinkEligibility): boolean {
  return i.signingMode === 'bunker'
    && !i.isPairedChild
    && !i.childDirect
    && !i.hasActiveDependant
    && i.selectionSource === 'guardian'
    && !i.importedPersona
    && i.hasOperatorClient
    && !i.combinedPermission
    && i.selectionKeypairType !== 'natural-person'
    && i.requestCanCarryLink;
}

/** The device can mint this only if it has not definitely said otherwise (a truncated status is unverified: try). */
export function signInLinkSupported(status: DeviceStatus | null): boolean {
  if (!status) return true;
  return hasCapability(status, CAP_CLIENT_POLICY_V2) !== false && hasCapability(status, CAP_PAIRING_IDENTITY) !== false;
}

/**
 * Whether "Straight to my Heartwood" is the pre-selected sign-in choice where it is offered. With
 * several managed Heartwoods the holder is found at approval, so it stays pre-selected; with one, it
 * is not pre-selected only when that device's status definitely lacks what a link needs (unknown = pre-select).
 */
export function signInLinkByDefault(operatorClientCount: number, primaryStatus: DeviceStatus | null): boolean {
  return operatorClientCount > 1 || signInLinkSupported(primaryStatus);
}

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LEN / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `mysignet:<host>:<8 hex>`, whole label at most {@link SIGN_IN_LINK_LABEL_MAX}.
 * The random suffix makes it unique on the device, so the slot can be found
 * again by it; the host is what is cut to fit, never the suffix.
 */
export function signInLinkLabel(origin: string, suffix: () => string = randomSuffix): string {
  let host = '';
  try { host = new URL(origin).hostname; } catch { /* no usable host */ }
  const room = SIGN_IN_LINK_LABEL_MAX - LABEL_PREFIX.length - 1 - SUFFIX_LEN;
  const clean = host.replace(/[^\p{L}\p{N}.-]/gu, '').slice(0, room) || 'site';
  const tail = suffix().toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(SUFFIX_LEN, '0').slice(0, SUFFIX_LEN);
  return `${LABEL_PREFIX}${clean}:${tail}`;
}

/**
 * What the site may ask of the slot: everything a hand-off allows, bound to the
 * identity. A sign-in request carries no permission list, so it is always wide.
 */
export function signInLinkPolicy(persona: string): SlotPolicyUpdate {
  return handoffPolicy(persona);
}

/** The identity and secret a `bunker://<pubkey>?...&secret=...` link carries; null unless both are well formed. */
export function parseBunkerLink(uri: string): { pubkey: string; hasSecret: boolean } | null {
  const m = /^bunker:\/\/([0-9a-fA-F]{64})\?(.*)$/i.exec(uri.trim());
  if (!m) return null;
  let secret = '';
  try { secret = new URLSearchParams(m[2]).get('secret') ?? ''; } catch { /* unreadable query */ }
  return { pubkey: m[1].toLowerCase(), hasSecret: secret.length > 0 };
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every(v => y.has(v));
}

/** The longest link the redirect callback will carry (`buildAuthCallbackUrl` drops anything over this). */
export const SIGN_IN_LINK_URI_MAX = 8192;

export type SignInLinkEcho =
  | { ok: true; slotIndex: number; secretFingerprint: string; bunkerUri: string }
  /** Never names a slot: on any mismatch the phone finds the slot by the label it chose. */
  | { ok: false; reason: string };

/** Every `relay` in the link must be one this app would open itself (`wss://`, or loopback `ws://`). */
function relaysAreSecure(uri: string): boolean {
  const q = uri.indexOf('?');
  if (q < 0) return true;
  try {
    return new URLSearchParams(uri.slice(q + 1)).getAll('relay').every(isValidRelayUrl);
  } catch {
    return false;
  }
}

/**
 * The security core: the device's answer is the slot that was asked for or it
 * is not used. The identity must match in BOTH `npub_hex` and the link's own
 * pubkey, so a link to some other identity can never reach a site. The label
 * must be the one asked for too: a reply about some other slot is not trusted,
 * and the caller revokes by label, never by the slot the reply names.
 */
export function checkSignInLinkEcho(reply: CreateClientV2Reply, expected: { persona: string; policy: SlotPolicyUpdate; label: string }): SignInLinkEcho {
  const persona = expected.persona.toLowerCase();
  const bad = (reason: string): SignInLinkEcho => ({ ok: false, reason });
  if (reply.slotIndex === null || !Number.isInteger(reply.slotIndex)) return bad('slot_index');
  if (reply.secretFingerprint.length === 0) return bad('secret_fingerprint');
  if (reply.label !== expected.label) return bad('label');
  if (reply.policyVersion !== 2) return bad('policy_version');
  if (reply.npubHex !== persona) return bad('npub_hex');
  if (reply.bunkerUri.length > SIGN_IN_LINK_URI_MAX) return bad('bunker_uri length');
  const link = parseBunkerLink(reply.bunkerUri);
  if (!link) return bad('bunker_uri');
  if (link.pubkey !== persona) return bad('bunker_uri identity');
  if (!link.hasSecret) return bad('bunker_uri secret');
  if (!relaysAreSecure(reply.bunkerUri)) return bad('bunker_uri relay');
  if (reply.allowedMethods === null || !sameSet(reply.allowedMethods, expected.policy.allowedMethods)) return bad('allowed_methods');
  if (reply.allowedKinds === null || !sameSet(reply.allowedKinds, expected.policy.allowedKinds)) return bad('allowed_kinds');
  if (reply.autoApprove !== expected.policy.autoApprove) return bad('auto_approve');
  return { ok: true, slotIndex: reply.slotIndex, secretFingerprint: reply.secretFingerprint, bunkerUri: reply.bunkerUri };
}

/** A link record whose slot the device has confirmed (not one still waiting for the mint's answer). */
export function isConfirmedSignInLink(r: HeartwoodSignInLinkRecord): boolean {
  return r.secretFingerprint.length > 0 && r.slotIndex !== undefined;
}

/**
 * Revoke a recorded link's slot. Resolves once it is gone from the device;
 * throws (so the caller keeps the record) otherwise.
 *
 * By slot index and fingerprint when the record has them. `no such slot` or
 * `stale_client_slot` is not proof it is gone (the slot may sit under another
 * index), and a record with no slot yet (the mint's answer never came) has
 * nothing to name: the device's own list decides, matched by the label this
 * phone chose. No slot with the label ⇒ gone. A listing that fails or can't be
 * fully read throws.
 */
export async function revokeSignInLinkSlot(p: {
  rec: Pick<HeartwoodSignInLinkRecord, 'label' | 'slotIndex' | 'secretFingerprint'>;
  revoke: (slot: { slotIndex: number; secretFingerprint: string }) => Promise<void>;
  /** The holding master's slots; must throw rather than return a partial list. */
  listClients: () => Promise<DeviceClientSlot[]>;
}): Promise<void> {
  const { rec } = p;
  if (rec.secretFingerprint && rec.slotIndex !== undefined) {
    try {
      await p.revoke({ slotIndex: rec.slotIndex, secretFingerprint: rec.secretFingerprint });
      return;
    } catch (e) {
      if (!isNoSuchSlotError(e) && !isStaleClientSlotMessage(e)) throw e;
    }
  }
  const holding = (await p.listClients()).filter(s => s.label === rec.label);
  for (const s of holding) await p.revoke({ slotIndex: s.slotIndex, secretFingerprint: s.secretFingerprint });
}

/** The Heartwood holding `persona`, or the plain-words error for why there is none. */
export async function findSignInHolder(params: {
  clients: readonly HeartwoodMgmtClient[];
  persona: string;
  cache?: Map<HeartwoodMgmtClient, DeviceIdentity[]>;
}): Promise<HandoffHolder> {
  let holder: HandoffHolder | null;
  try {
    holder = await findHeartwoodHolder(params.clients, params.persona, params.cache);
  } catch (e) {
    throw signInHolderError(e);
  }
  // Every device answered and none holds it: say that, not "didn't answer".
  if (!holder) throw new HeartwoodCopyError(SIGN_IN_LINK_UNAVAILABLE_COPY);
  return holder;
}

/** The hand-off's "didn't answer" copy points at Through My Signet; here the other option is just "the other option". */
export function signInHolderError(e: unknown): HeartwoodCopyError {
  if (e instanceof HandoffNoAnswerError) {
    if (e.message === HANDOFF_NO_ANSWER_COPY) return new HeartwoodCopyError(SIGN_IN_LINK_NO_ANSWER_COPY);
    return new HeartwoodCopyError(e.message.replace(/ Or choose Through My Signet\.$/, ' Or choose the other option.'));
  }
  if (e instanceof HeartwoodCopyError) return e;
  return new HeartwoodCopyError(heartwoodMgmtErrorCopy(e));
}

export interface SignInLinkIo {
  request: { origin: string; appName: string; persona: string };
  now: () => number;
  label: () => string;
  /** Throws a {@link HeartwoodCopyError} when no Heartwood holds the identity or none answers. */
  findHolder: () => Promise<{ deviceHex: string; targetHex: string }>;
  /** Throws when the device has definitely said it can't mint this. */
  ensureCapable: (holder: { deviceHex: string; targetHex: string }) => Promise<void>;
  /** Save or replace the record with this label. */
  putRecord: (rec: HeartwoodSignInLinkRecord) => Promise<void>;
  /** Remove the record with this label from the store. */
  dropRecord: (rec: HeartwoodSignInLinkRecord) => Promise<void>;
  /** {@link revokeSignInLinkSlot} on the right operator client; throws unless the slot is gone. */
  revokeRecord: (rec: HeartwoodSignInLinkRecord) => Promise<void>;
  mint: (holder: { deviceHex: string; targetHex: string }, label: string, policy: SlotPolicyUpdate) => Promise<CreateClientV2Reply>;
}

async function quietly(task: Promise<unknown>): Promise<void> {
  try { await task; } catch { /* best effort: what this guards is already as safe as it can be made */ }
}

/**
 * A "Straight to my Heartwood" sign-in, in an order that never leaves a live
 * slot this phone has no record of:
 *
 * 1. find the holder (and that it can mint this);
 * 2. save a pending record BEFORE anything changes on the device;
 * 3. mint (earlier links of the same site are left alone: several browsers
 *    may each hold one, and the reconcile reaps any that nothing uses);
 * 4. check the answer is the slot that was asked for, else revoke it (by label) and throw;
 * 5. record the slot's index and fingerprint.
 *
 * A record is dropped only once the slot is confirmed gone. A mint that got no
 * answer may still have made a slot: the record stays unless the device's own
 * list says there is none. Never falls back to a sign-in with no link.
 */
export async function runSignInLinkApproval(io: SignInLinkIo): Promise<{ record: HeartwoodSignInLinkRecord; bunkerUri: string }> {
  const { origin, appName, persona } = io.request;
  const holder = await io.findHolder();
  await io.ensureCapable(holder);

  const label = io.label();
  const pending: HeartwoodSignInLinkRecord = {
    origin, appName, persona: persona.toLowerCase(),
    deviceHex: holder.deviceHex, targetHex: holder.targetHex,
    label, secretFingerprint: '', createdAt: io.now(),
  };
  await io.putRecord(pending);

  const policy = signInLinkPolicy(persona);
  let reply: CreateClientV2Reply;
  try {
    reply = await io.mint(holder, label, policy);
  } catch (e) {
    // The device may have made the slot and told no one: its own list decides.
    let gone = false;
    try { await io.revokeRecord(pending); gone = true; } catch { /* can't tell: the record stays, and the next sign-in looks again */ }
    if (gone) await quietly(io.dropRecord(pending));
    throw e instanceof HeartwoodCopyError ? e : new HeartwoodCopyError(heartwoodMgmtErrorCopy(e));
  }

  const echo = checkSignInLinkEcho(reply, { persona, policy, label });
  if (!echo.ok) {
    // Whatever the reply named, the slot is found by the label this phone chose
    // (a reply about some other slot must not get that slot revoked).
    let removed = false;
    try { await io.revokeRecord(pending); removed = true; } catch { /* kept below */ }
    if (removed) {
      await quietly(io.dropRecord(pending));
      throw new HeartwoodCopyError(SIGN_IN_LINK_MISMATCH_COPY);
    }
    throw new HeartwoodCopyError(SIGN_IN_LINK_MISMATCH_KEPT_COPY);
  }

  const record: HeartwoodSignInLinkRecord = { ...pending, slotIndex: echo.slotIndex, secretFingerprint: echo.secretFingerprint };
  try {
    await io.putRecord(record);
  } catch {
    let removed = false;
    try { await io.revokeRecord(record); removed = true; } catch { /* kept below */ }
    if (removed) {
      await quietly(io.dropRecord(record));
      throw new HeartwoodCopyError(SIGN_IN_LINK_NOT_SAVED_COPY);
    }
    throw new HeartwoodCopyError(SIGN_IN_LINK_NOT_SAVED_KEPT_COPY);
  }
  return { record, bunkerUri: echo.bunkerUri };
}

/**
 * Undo a minted link whose sign-in was never delivered (Deny, withdrawn, a
 * failure after the mint). The record goes only once the slot is confirmed
 * gone; if it can't be, it stays so Where you're known can disconnect it.
 * Never throws.
 */
export async function abandonSignInLink(io: Pick<SignInLinkIo, 'revokeRecord' | 'dropRecord'>, record: HeartwoodSignInLinkRecord): Promise<void> {
  try {
    await io.revokeRecord(record);
  } catch {
    return;
  }
  await quietly(io.dropRecord(record));
}

/** What becomes of a minted link once the approval has run. */
export type SignInLinkFate = 'none' | 'keep' | 'abandon';

/**
 * A link minted for a sign-in that was never delivered (Deny, withdrawn, a
 * failure) is abandoned; one whose delivery was claimed is kept (a delivery
 * that then fails to publish is cleaned up by the reconcile: nobody binds it).
 */
export function signInLinkFate(p: { minted: HeartwoodSignInLinkRecord | null; delivered: boolean }): SignInLinkFate {
  if (!p.minted) return 'none';
  return p.delivered ? 'keep' : 'abandon';
}

/** Apply {@link signInLinkFate}: abandon what was never delivered. Never throws. */
export async function settleSignInLink(
  io: Pick<SignInLinkIo, 'revokeRecord' | 'dropRecord'>,
  p: { minted: HeartwoodSignInLinkRecord | null; delivered: boolean },
): Promise<SignInLinkFate> {
  const fate = signInLinkFate(p);
  if (fate === 'abandon' && p.minted) await abandonSignInLink(io, p.minted);
  return fate;
}

/** A slot nobody has bound: no current key and none authorised. */
export function isUnboundSlot(slot: Pick<DeviceClientSlot, 'currentPubkey' | 'authorizedPubkeys'>): boolean {
  return slot.currentPubkey === null && slot.authorizedPubkeys.length === 0;
}

export interface ReconcileIo {
  nowMs: () => number;
  /**
   * The slots of one Heartwood master, strictly read. Null when this phone has
   * no operator client for it; a throw means it did not answer. Either leaves
   * that target's records alone this pass.
   */
  listSlots: (target: { deviceHex: string; targetHex: string }) => Promise<DeviceClientSlot[] | null>;
  revokeSlot: (target: { deviceHex: string; targetHex: string }, slot: { slotIndex: number; secretFingerprint: string }) => Promise<void>;
  dropRecord: (rec: HeartwoodSignInLinkRecord) => Promise<void>;
}

export interface ReconcileResult { dropped: number; revoked: number; skipped: number }

/**
 * Bring the stored links in line with what the Heartwoods say. For each record,
 * with one `list_clients` per target per pass:
 * - its slot (by index and fingerprint, else by label) is not on the device: drop the record;
 * - the slot was never bound and the record is older than {@link SIGNIN_LINK_UNBOUND_TTL_MS}:
 *   revoke it, then drop the record (a slot nobody connected to is a grant with no owner);
 * - a pending record (the mint never answered) older than the TTL is found by label
 *   and treated the same, or dropped when there is no such slot; a younger one is a
 *   mint still in flight and is left alone;
 * - a target this phone has no operator for, or that does not answer, is left alone.
 * Never throws; a record whose revoke fails stays for the next pass.
 */
export async function reconcileSignInLinks(records: readonly HeartwoodSignInLinkRecord[], io: ReconcileIo): Promise<ReconcileResult> {
  const out: ReconcileResult = { dropped: 0, revoked: 0, skipped: 0 };
  const lists = new Map<string, DeviceClientSlot[] | null>();
  const now = io.nowMs();
  for (const rec of records) {
    try {
      const target = { deviceHex: rec.deviceHex, targetHex: rec.targetHex };
      const key = `${rec.deviceHex}:${rec.targetHex}`;
      if (!lists.has(key)) {
        try { lists.set(key, await io.listSlots(target)); } catch { lists.set(key, null); }
      }
      const slots = lists.get(key) ?? null;
      if (slots === null) { out.skipped++; continue; }
      const confirmed = isConfirmedSignInLink(rec);
      const ageMs = now - rec.createdAt * 1000;
      const old = ageMs >= SIGNIN_LINK_UNBOUND_TTL_MS;
      // A pending record may be a mint still on its way: not before the TTL.
      if (!confirmed && !old) { out.skipped++; continue; }
      const slot = (confirmed
        ? slots.find(s => s.slotIndex === rec.slotIndex && s.secretFingerprint === rec.secretFingerprint)
        : undefined) ?? slots.find(s => s.label === rec.label);
      if (!slot) {
        await io.dropRecord(rec);
        out.dropped++;
        continue;
      }
      if (old && isUnboundSlot(slot)) {
        await io.revokeSlot(target, { slotIndex: slot.slotIndex, secretFingerprint: slot.secretFingerprint });
        out.revoked++;
        await io.dropRecord(rec);
        out.dropped++;
        continue;
      }
      out.skipped++;
    } catch {
      out.skipped++;
    }
  }
  return out;
}

/** The part of a failed-delivery ack state that decides whether it survives a lock. */
export interface FailedAckLinkMark { status: string; carriesLink?: boolean }

/** A failed answer being retried holds the response, so a Straight link (a bearer secret) is marked; nothing else is. */
export function failedAckCarriesLink(p: { straightLink: boolean; bunkerUri: string | undefined }): { carriesLink?: true } {
  return p.straightLink && p.bunkerUri ? { carriesLink: true } : {};
}

/**
 * What the ack state becomes when the app locks: only a failed answer that carries a Straight link is
 * dropped; every other state, including another sign-in's failed delivery, is returned untouched.
 */
export function ackStateAfterLock<T extends FailedAckLinkMark>(prev: T | null): T | null {
  return prev && prev.status === 'failed' && prev.carriesLink ? null : prev;
}
