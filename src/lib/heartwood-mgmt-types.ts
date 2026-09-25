/**
 * Shared types for the Heartwood operator channel (kind-24134 management
 * envelope) — consumed by the transport client (`heartwood-mgmt.ts`), the
 * C3 policy compiler (`policy-compiler.ts`) and the push/verdict hooks.
 * Field names mirror the firmware's `client_summary` /
 * `exact_policy_from_request` (heartwood-esp32 `common/src/mgmt.rs`,
 * `firmware/src/relay.rs`), camel-cased at the boundary.
 *
 * Design: the internal C3-compiler-output-rule doc, §3–§4.
 */

/** One row of `list_clients` — a client slot as the device reports it. */
export interface DeviceClientSlot {
  slotIndex: number;
  label: string;
  /** SHA-256 of the slot's raw secret — the stable, non-secret id every
   *  index-sensitive mutation must echo as `expected_secret_fingerprint`. */
  secretFingerprint: string;
  autoApprove: boolean;
  /** Derived device-side from `allowed_methods` containing `sign_event`. */
  signingApproved: boolean;
  /** True for every operator-installed (v2 exact) slot. */
  strictPermissions: boolean;
  currentPubkey: string | null;
  authorizedPubkeys: string[];
  allowedKinds: number[];
  allowedMethods: string[];
  escalate: boolean;
  petitionOnDeny: boolean;
  auditChildWrap: boolean;
  /** Lowercase hex64 identity the slot serves, or null. */
  boundIdentity: string | null;
}

/**
 * The replace-whole-slot policy the compiler emits and `update_client`
 * pushes. Every field is sent explicitly (absent = keep on the device);
 * `boundIdentity` is the one exception — omitted means "leave as is",
 * because the firmware cannot clear it via `update_client` anyway.
 */
export interface SlotPolicyUpdate {
  allowedMethods: string[];
  allowedKinds: number[];
  autoApprove: boolean;
  escalate: boolean;
  petitionOnDeny: boolean;
  auditChildWrap: boolean;
  boundIdentity?: string;
}

/** Parsed `get_status` (only what the app consumes). */
export interface DeviceStatus {
  /** `null` when the device sent a `truncated: true` minimal status —
   *  capabilities are then UNKNOWN, not unsupported. */
  capabilities: string[] | null;
  masterNpubHex: string;
  version?: string;
  slots?: number;
  truncated: boolean;
}

/** `get_status.capabilities` entries the app feature-detects on. */
export const CAP_CLIENT_POLICY_FLAGS = 'client_policy_flags_v1';
export const CAP_RESOLVE_APPROVAL = 'resolve_approval_v1';
export const CAP_PAIRING_IDENTITY = 'pairing_identity_v1';
export const CAP_MUTATION_CHALLENGE = 'mutation_challenge_v1';

/** Methods a strict (v2 exact) slot may list — `TOFU_SAFE_METHODS` in firmware. */
export const TOFU_SAFE_METHODS: readonly string[] = [
  'sign_event',
  'nip44_encrypt',
  'nip44_decrypt',
  'nip04_encrypt',
  'nip04_decrypt',
  'get_public_key',
];
