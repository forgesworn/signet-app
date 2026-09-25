/**
 * Heartwood operator channel client — the kind-24134 management envelope
 * (family-bunker C3, the internal C3-compiler-output-rule doc,
 * §4). Mirrors Sapwood's `relay-transport.ts`, which is the ground truth for
 * the wire shape; the firmware side is heartwood-esp32 `firmware/src/relay.rs`
 * (`handle_mgmt_event` → `dispatch_mgmt`) and `common/src/mgmt.rs`.
 *
 * Envelope (verbatim):
 * - Request: kind 24134, `tags: [['p', deviceHex]]`, content = NIP-44 v2 of
 *   `{ id, method, params, mutation_challenge? }` under
 *   `ck = getConversationKey(operatorSk, deviceHex)`, signed by the operator
 *   key. `mutation_challenge` is TOP-LEVEL (not in params) and present only
 *   on mutations. `id` = 32 hex chars from 16 random bytes, fresh on EVERY
 *   publish — the device suppresses a repeated inner id, so reuse can never
 *   recover a lost reply.
 * - Reply: kind 24134, `tags: [['p', operatorPub]]`, authored by the DEVICE
 *   master pubkey, content NIP-44 under the same ck; plaintext
 *   `{ id, result } | { id, error }`. `created_at` may be the request's or
 *   the send time — the subscription only filters `since = now - 60`.
 * - Silent drops (no reply ever): non-operator author, decrypt failure,
 *   non-JSON, empty/replayed id. Hence every request has a timeout.
 *
 * Read-only methods go straight out. Everything else is a mutation: fetch a
 * one-time `get_management_challenge`, then send with `mutation_challenge`.
 * Mutations are serialised through a promise queue so a challenge-fetch →
 * mutate pair can never interleave with another. A stale challenge is
 * surfaced as an Error and NEVER retried here — another manager may have
 * revoked/recreated the slot in between; the caller decides.
 */
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { publishEvent, subscribeEvents } from './relay-service';
import type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';

export type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';
export {
  CAP_CLIENT_POLICY_FLAGS,
  CAP_RESOLVE_APPROVAL,
  CAP_PAIRING_IDENTITY,
  CAP_MUTATION_CHALLENGE,
  TOFU_SAFE_METHODS,
} from './heartwood-mgmt-types';

/** Management envelope kind (distinct from NIP-46's 24133). */
export const MGMT_KIND = 24134;

/** Default round-trip budget: operator network → relay → signer link. */
export const DEFAULT_MGMT_TIMEOUT_MS = 35_000;

/** Reply subscription looks this far back — replies may be stamped with the
 *  request's `created_at`, so a small window is needed; never tighter. */
const REPLY_SINCE_SLACK_S = 60;

/** Bound on ciphertext we'll hand to NIP-44 decrypt (a full `get_status`
 *  with the audit ring is a few KB; the firmware itself degrades anything
 *  that won't fit its heap). */
const MAX_REPLY_CONTENT_CHARS = 128 * 1024;

/** Verdict window bounds — mirror `heartwood_common::escalate`. */
export const VERDICT_WINDOW_DEFAULT_S = 600;
export const VERDICT_WINDOW_MAX_S = 3600;

const HEX64 = /^[0-9a-f]{64}$/;

/** Reviewed read-only management methods (no challenge). Unknown future
 *  methods fail CLOSED as mutations until reviewed on both sides. */
const READ_ONLY_MANAGEMENT_METHODS: ReadonlySet<string> = new Set([
  'get_management_challenge',
  'get_network_config',
  'list_clients',
  'list_identities',
  'get_status',
]);

export function requiresMutationChallenge(method: string): boolean {
  return !READ_ONLY_MANAGEMENT_METHODS.has(method);
}

/** Another manager mutated the device between our challenge fetch and our
 *  mutation. Nothing was applied; refresh state and (caller's choice) retry. */
export function isStaleChallengeError(message: string): boolean {
  return /stale_management_challenge/i.test(message);
}

/** Errors a caller may reasonably retry after refreshing state / a short
 *  pause. Deliberately excludes `stale_client_slot` (the slot credential
 *  changed — needs a fresh `list_clients`, not a blind retry). */
export function isRetryableMgmtError(message: string): boolean {
  return isStaleChallengeError(message)
    || /device low on memory/i.test(message)
    || /signer is busy with another approval/i.test(message);
}

/** Transport seam — the real one rides relay-service; tests inject a fake
 *  that stands in for relays AND the device. */
export interface MgmtTransport {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  /** Returns an unsubscribe. */
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}

/** relay-service-backed transport: `publishEvent` to the credential's
 *  relays + the live `subscribeEvents` helper for the reply channel. */
export function defaultMgmtTransport(): MgmtTransport {
  return {
    publish: (event, relays) => publishEvent(event, { relays }),
    subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
  };
}

/** Unpredictable 128-bit inner request id. */
export function newMgmtRequestId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build the plaintext inner request exactly as the firmware parses it. */
export function mgmtRequestPayload(
  id: string,
  method: string,
  params: Record<string, unknown>,
  mutationChallenge?: string,
): Record<string, unknown> {
  return {
    id,
    method,
    params,
    ...(mutationChallenge ? { mutation_challenge: mutationChallenge } : {}),
  };
}

export interface MgmtCredential {
  /** Operator secret key, 64 hex. */
  skHex: string;
  /** Device master pubkey, 64 hex — the reply author and request `p` tag. */
  deviceHex: string;
  relays: string[];
}

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class HeartwoodMgmtClient {
  readonly operatorPub: string;
  readonly deviceHex: string;
  readonly relays: string[];
  private readonly transport: MgmtTransport;
  private sk: Uint8Array;
  private ck: Uint8Array;
  private unsubscribe: (() => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(cred: MgmtCredential, transport: MgmtTransport = defaultMgmtTransport()) {
    const deviceHex = (cred.deviceHex ?? '').toLowerCase();
    if (!HEX64.test(deviceHex)) throw new Error('device pubkey must be 64 hex chars');
    if (typeof cred.skHex !== 'string' || !HEX64.test(cred.skHex.toLowerCase())) {
      throw new Error('operator secret must be 64 hex chars');
    }
    if (!Array.isArray(cred.relays) || cred.relays.length === 0) {
      throw new Error('at least one relay is required');
    }
    this.deviceHex = deviceHex;
    this.relays = [...cred.relays];
    this.sk = hexToBytes(cred.skHex.toLowerCase());
    this.operatorPub = getPublicKey(this.sk);
    this.ck = nip44.utils.getConversationKey(this.sk, this.deviceHex);
    this.transport = transport;
  }

  /** True once `start()` has run and `stop()` has not. */
  get isOpen(): boolean {
    return this.unsubscribe !== null && !this.closed;
  }

  /** Open the reply subscription. Idempotent. */
  start(): void {
    if (this.closed) throw new Error('transport closed');
    if (this.unsubscribe) return;
    const since = Math.floor(Date.now() / 1000) - REPLY_SINCE_SLACK_S;
    this.unsubscribe = this.transport.subscribe(
      [{ kinds: [MGMT_KIND], '#p': [this.operatorPub], since }],
      this.relays,
      (ev) => this.routeEvent(ev),
    );
  }

  /** Close the subscription, reject every in-flight request, and zeroize the
   *  operator key material. The client is unusable afterwards. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error('transport closed');
    for (const id of [...this.pending.keys()]) this.removePending(id)?.reject(err);
    try { this.unsubscribe?.(); } catch { /* already gone */ }
    this.unsubscribe = null;
    this.sk.fill(0);
    this.ck.fill(0);
  }

  /** Send a management request and await the device's decrypted reply.
   *  Handles the read-only vs mutation distinction itself: a mutation is
   *  queued, fetches a fresh one-time challenge, then sends with it. */
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_MGMT_TIMEOUT_MS;
    if (!requiresMutationChallenge(method)) {
      return this.requestRaw(method, params, timeoutMs) as Promise<T>;
    }
    const run = () => this.sendReplaySafe(method, params, timeoutMs);
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result as Promise<T>;
  }

  private async sendReplaySafe(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    let discovered: Record<string, unknown>;
    try {
      discovered = await this.requestRaw('get_management_challenge', {}, timeoutMs);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/unknown method.*get_management_challenge/i.test(message)) {
        throw new Error('signer firmware is too old for replay-safe remote changes; update it before pushing policy');
      }
      throw e;
    }
    const challenge = typeof discovered.challenge === 'string' ? discovered.challenge.toLowerCase() : '';
    if (discovered.version !== 1 || !HEX64.test(challenge)) {
      throw new Error('signer did not return a valid management challenge; nothing was changed');
    }
    // The mutation itself is sent exactly once. A stale-challenge error
    // propagates verbatim (see isStaleChallengeError) — never auto-retried.
    return this.requestRaw(method, params, timeoutMs, challenge);
  }

  private requestRaw(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    mutationChallenge?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('transport closed'));
    if (!this.unsubscribe) return Promise.reject(new Error('not started'));
    // Fresh inner id per publish — never reused, even across attempts.
    const id = newMgmtRequestId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.removePending(id)) return;
        reject(new Error(`timeout waiting for device (${method})`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });

      let event: NostrEvent;
      try {
        const plaintext = JSON.stringify(mgmtRequestPayload(id, method, params, mutationChallenge));
        event = finalizeEvent(
          {
            kind: MGMT_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', this.deviceHex]],
            content: nip44.encrypt(plaintext, this.ck),
          },
          this.sk,
        ) as unknown as NostrEvent;
      } catch (e) {
        this.removePending(id);
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const fail = (message: string) => {
        // The reply may already have landed (fake transports answer inline);
        // a late publish verdict must not clobber a settled request.
        if (!this.removePending(id)) return;
        reject(new Error(message));
      };
      let published: Promise<{ ok: boolean; message: string }>;
      try {
        published = this.transport.publish(event, this.relays);
      } catch (e) {
        fail(e instanceof Error ? e.message : 'failed to publish to any relay');
        return;
      }
      published.then(
        (r) => { if (!r || !r.ok) fail('failed to publish to any relay'); },
        (e) => fail(e instanceof Error ? e.message : 'failed to publish to any relay'),
      );
    });
  }

  private removePending(id: string): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(id);
    return p;
  }

  private routeEvent(ev: NostrEvent): void {
    if (this.closed) return;
    if (!ev || typeof ev !== 'object') return;
    // Only the device master authors replies on this channel. Anything else
    // p-tagged to the operator is noise (or an impersonation attempt whose
    // ciphertext would fail under our ck anyway) — drop before decrypting.
    if (ev.pubkey !== this.deviceHex) return;
    if (ev.kind !== MGMT_KIND) return;
    if (typeof ev.content !== 'string' || ev.content.length === 0 || ev.content.length > MAX_REPLY_CONTENT_CHARS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(nip44.decrypt(ev.content, this.ck));
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string') return;
    const p = this.removePending(parsed.id);
    if (!p) return; // unknown / already-settled id — ignore
    if (typeof parsed.error === 'string') {
      p.reject(new Error(parsed.error));
      return;
    }
    if ('error' in parsed && parsed.error !== undefined && parsed.error !== null) {
      p.reject(new Error(`device error (${p.method})`));
      return;
    }
    p.resolve(isRecord(parsed.result) ? parsed.result : {});
  }
}

// ─── Typed helpers ───────────────────────────────────────────────────────────

/** `get_status` → DeviceStatus. A `truncated: true` minimal status carries
 *  no capabilities array; that reads as UNKNOWN (`null`), not unsupported. */
export async function getStatus(c: HeartwoodMgmtClient): Promise<DeviceStatus> {
  const r = await c.request('get_status');
  const truncated = r.truncated === true;
  const masterNpubHex = typeof r.master_npub_hex === 'string' ? r.master_npub_hex.toLowerCase() : '';
  let capabilities: string[] | null;
  if (truncated) {
    capabilities = null;
  } else if (Array.isArray(r.capabilities)) {
    capabilities = r.capabilities.filter((x): x is string => typeof x === 'string');
  } else {
    // Older firmware never advertised capabilities — genuinely unsupported.
    capabilities = [];
  }
  const status: DeviceStatus = { capabilities, masterNpubHex, truncated };
  if (typeof r.version === 'string') status.version = r.version;
  if (typeof r.slots === 'number' && Number.isFinite(r.slots)) status.slots = r.slots;
  return status;
}

/** `null` = unknown (truncated status); otherwise a definite yes/no. */
export function hasCapability(s: DeviceStatus, cap: string): boolean | null {
  if (s.capabilities === null) return null;
  return s.capabilities.includes(cap);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}
function isKindArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isInteger(x) && x >= 0);
}
/** Family flags default false when absent (older firmware) but a PRESENT
 *  non-boolean marks the row malformed. */
function optBool(v: unknown): boolean | undefined {
  if (v === undefined) return false;
  return typeof v === 'boolean' ? v : undefined;
}

/** Parse one `client_summary` row; undefined ⇒ malformed (dropped). */
export function parseDeviceClientSlot(row: unknown): DeviceClientSlot | undefined {
  if (!isRecord(row)) return undefined;
  const slotIndex = row.slot_index;
  if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex) || slotIndex < 0) return undefined;
  if (typeof row.secret_fingerprint !== 'string' || row.secret_fingerprint.length === 0) return undefined;
  if (typeof row.auto_approve !== 'boolean') return undefined;
  if (typeof row.signing_approved !== 'boolean') return undefined;
  if (typeof row.strict_permissions !== 'boolean') return undefined;
  if (!(row.current_pubkey === null || row.current_pubkey === undefined || typeof row.current_pubkey === 'string')) return undefined;
  if (!isStringArray(row.authorized_pubkeys)) return undefined;
  if (!isKindArray(row.allowed_kinds)) return undefined;
  if (!isStringArray(row.allowed_methods)) return undefined;
  const escalate = optBool(row.escalate);
  const petitionOnDeny = optBool(row.petition_on_deny);
  const auditChildWrap = optBool(row.audit_child_wrap);
  if (escalate === undefined || petitionOnDeny === undefined || auditChildWrap === undefined) return undefined;
  let boundIdentity: string | null;
  if (row.bound_identity === null || row.bound_identity === undefined) boundIdentity = null;
  else if (typeof row.bound_identity === 'string' && HEX64.test(row.bound_identity.toLowerCase())) boundIdentity = row.bound_identity.toLowerCase();
  else return undefined;
  return {
    slotIndex,
    label: typeof row.label === 'string' ? row.label : '',
    secretFingerprint: row.secret_fingerprint,
    autoApprove: row.auto_approve,
    signingApproved: row.signing_approved,
    strictPermissions: row.strict_permissions,
    currentPubkey: typeof row.current_pubkey === 'string' ? row.current_pubkey : null,
    authorizedPubkeys: [...row.authorized_pubkeys],
    allowedKinds: [...row.allowed_kinds],
    allowedMethods: [...row.allowed_methods],
    escalate,
    petitionOnDeny,
    auditChildWrap,
    boundIdentity,
  };
}

/** `list_clients` → `{ clients: [...] }`, snake_case → camelCase, malformed
 *  rows dropped. */
export async function listClients(c: HeartwoodMgmtClient): Promise<DeviceClientSlot[]> {
  const r = await c.request('list_clients');
  if (!Array.isArray(r.clients)) return [];
  const out: DeviceClientSlot[] = [];
  for (const row of r.clients) {
    const slot = parseDeviceClientSlot(row);
    if (slot) out.push(slot);
  }
  return out;
}

function policyWireFields(p: SlotPolicyUpdate): Record<string, unknown> {
  return {
    allowed_methods: [...p.allowedMethods],
    allowed_kinds: [...p.allowedKinds],
    auto_approve: p.autoApprove,
    escalate: p.escalate,
    petition_on_deny: p.petitionOnDeny,
    audit_child_wrap: p.auditChildWrap,
    ...(p.boundIdentity !== undefined ? { bound_identity: p.boundIdentity.toLowerCase() } : {}),
  };
}

/** `update_client` with EVERY policy field explicit (absent = keep on the
 *  device, which is exactly the drift the compiler exists to prevent). The
 *  slot's `secretFingerprint` is echoed as `expected_secret_fingerprint` so
 *  a slot re-minted under the same index (`stale_client_slot`) is refused. */
export async function updateClientPolicy(
  c: HeartwoodMgmtClient,
  slot: { slotIndex: number; secretFingerprint: string },
  p: SlotPolicyUpdate,
): Promise<void> {
  if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 0) throw new Error('slotIndex must be a non-negative integer');
  if (typeof slot.secretFingerprint !== 'string' || slot.secretFingerprint.length === 0) throw new Error('secretFingerprint is required');
  const r = await c.request('update_client', {
    slot_index: slot.slotIndex,
    expected_secret_fingerprint: slot.secretFingerprint,
    ...policyWireFields(p),
  });
  if (r.updated !== true) throw new Error('update_client did not confirm the update');
  if (r.slot_index !== slot.slotIndex) throw new Error('update_client confirmed a different slot');
}

export type VerdictAction = 'approve-once' | 'approve-remember' | 'deny';

export interface VerdictResult {
  park: 'live' | 'expired';
  applied: 'completed' | 'window' | 'policy' | 'none';
}

const VERDICT_ACTIONS: ReadonlySet<string> = new Set(['approve-once', 'approve-remember', 'deny']);
const VERDICT_PARK: ReadonlySet<string> = new Set(['live', 'expired']);
const VERDICT_APPLIED: ReadonlySet<string> = new Set(['completed', 'window', 'policy', 'none']);

/** Client-side mirror of `escalate::clamp_window`: unset/0 → default,
 *  otherwise capped at the max. */
export function clampVerdictWindow(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return VERDICT_WINDOW_DEFAULT_S;
  return Math.min(VERDICT_WINDOW_MAX_S, Math.floor(seconds));
}

/** C4 verdict — `resolve_approval` (flags under `params.policy.*` here,
 *  unlike `update_client`). Every case resolves cleanly on the device: an
 *  unknown/expired park is a no-op with an honest `applied`, never an error. */
export async function resolveApproval(
  c: HeartwoodMgmtClient,
  params: { park: string; action: VerdictAction; windowSeconds?: number; policy?: SlotPolicyUpdate },
): Promise<VerdictResult> {
  if (typeof params.park !== 'string' || params.park.length === 0) throw new Error('park id is required');
  if (!VERDICT_ACTIONS.has(params.action)) throw new Error('action must be approve-once, approve-remember or deny');
  if (params.action === 'approve-remember' && !params.policy) throw new Error('approve-remember requires a policy');
  const wire: Record<string, unknown> = {
    park: params.park,
    action: params.action,
    window: clampVerdictWindow(params.windowSeconds),
  };
  if (params.policy) wire.policy = policyWireFields(params.policy);
  const r = await c.request('resolve_approval', wire);
  const park = r.park;
  const applied = r.applied;
  if (typeof park !== 'string' || !VERDICT_PARK.has(park) || typeof applied !== 'string' || !VERDICT_APPLIED.has(applied)) {
    throw new Error('malformed resolve_approval reply');
  }
  return { park: park as VerdictResult['park'], applied: applied as VerdictResult['applied'] };
}
